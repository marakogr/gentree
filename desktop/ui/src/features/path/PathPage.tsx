import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Badge,
  Card,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowFitRegular,
  ArrowSwapRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { pathApi, personsApi, mediaApi } from "../../api/client";
import type {
  Gender,
  KinshipDescriptor,
  MediaItem,
  PathResult,
  Person,
  PersonDetail,
} from "../../api/types";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty";
import { IconButton } from "../../components/ui/icon-button";
import { describeChain, formatKinship } from "../../i18n/kinship";
import type { Locale } from "../../i18n";
import { useAsyncAction } from "../../lib/useAsyncAction";
import PersonCard from "../persons/PersonCard";
import PersonForm from "../persons/PersonForm";
import PersonSearch from "../persons/PersonSearch";
import type { PersonNavigationAction } from "../persons/actions";
import { displayName } from "../persons/helpers";
import { initialsFromName, photosByPerson } from "../media/helpers";
import {
  chainName,
  edgesFromPath,
  pathChainLinks,
  stepWordKey,
} from "./labels";
import {
  SCALE_BOUNDS,
  ZOOM_STEP,
  centeredOffset,
  fitScale,
  layoutPath,
  zoomAtPoint,
  type PathView,
} from "./layout";
import "./path.css";

const PERSON_LIMIT = 1000;
const MAX_ALTERNATIVES = 2;
/** Pointer travel (px) that turns a press into a pan instead of a click. */
const PAN_THRESHOLD = 4;
/** Elements that keep their own click handling instead of dragging the canvas. */
const NO_PAN_SELECTOR =
  "button, a, input, textarea, select, label, [role='button'], [data-path-no-pan]";

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

type Props = {
  projectId: string;
  /** Switches the app to the tree tab with `personId` as the root. */
  onOpenInGraph: (personId: string) => void;
  /** Shell navigation used by the person card actions. */
  onNavigate?: (action: PersonNavigationAction, personId: string) => void;
};

type Editing = { person: Person; version: string };

// Fluent buttons are single-line by default: route options stack a label, a
// term and a distance, and the zoom buttons sit tight together.
const useStyles = makeStyles({
  routeButton: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    "& .btn-label": {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: tokens.spacingVerticalXXS,
      width: "100%",
      minWidth: 0,
    },
  },
  zoom: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    marginInlineStart: tokens.spacingHorizontalXS,
  },
  zoomValue: {
    color: tokens.colorNeutralForeground1,
    fontVariantNumeric: "tabular-nums",
  },
  muted: {
    color: tokens.colorNeutralForeground2,
  },
  term: {
    color: tokens.colorBrandForeground1,
  },
  meta: {
    margin: 0,
    color: tokens.colorNeutralForeground2,
  },
});

export default function PathPage({
  projectId,
  onOpenInGraph,
  onNavigate,
}: Props) {
  const { t, i18n } = useTranslation(["path", "person", "common", "enums"]);
  const locale = (i18n.language === "en" ? "en" : "ru") as Locale;
  const styles = useStyles();

  const [persons, setPersons] = useState<Person[]>([]);
  const [photos, setPhotos] = useState<Map<string, MediaItem>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [result, setResult] = useState<PathResult | null>(null);
  const [kinship, setKinship] = useState<KinshipDescriptor | null>(null);
  const [routeIndex, setRouteIndex] = useState(0);
  const [samePerson, setSamePerson] = useState(false);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const { busy, error, run } = useAsyncAction();
  const [view, setView] = useState<PathView>({
    scale: 1,
    offset: { x: 0, y: 0 },
  });
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<PanState | null>(null);

  const loadPersons = useCallback(async () => {
    if (projectId === "") return;
    const [page, media] = await Promise.all([
      personsApi.list({ limit: PERSON_LIMIT, sort: "name" }),
      mediaApi.list().catch(() => [] as MediaItem[]),
    ]);
    setPersons(page.items.map((item) => item.entity));
    setPhotos(photosByPerson(media));
    setLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void run(loadPersons);
  }, [run, loadPersons]);

  const personsById = useMemo(
    () => new Map(persons.map((person) => [person.id, person])),
    [persons],
  );

  const genderOf = useCallback(
    (personId: string): Gender =>
      personsById.get(personId)?.gender ?? "UNKNOWN",
    [personsById],
  );

  const nameOf = useCallback(
    (personId: string) => {
      const person = personsById.get(personId);
      return person ? displayName(person, t("person:unknownName")) : undefined;
    },
    [personsById, t],
  );

  const resetResult = () => {
    setResult(null);
    setKinship(null);
    setRouteIndex(0);
    setSamePerson(false);
  };

  const find = () => {
    if (fromId === "" || toId === "") return;
    if (fromId === toId) {
      resetResult();
      setSamePerson(true);
      return;
    }
    setSamePerson(false);
    void run(async () => {
      const [path, descriptor] = await Promise.all([
        pathApi.find(fromId, toId),
        pathApi.kinship(fromId, toId),
      ]);
      setResult(path);
      setKinship(descriptor);
      setRouteIndex(0);
    });
  };

  const swap = () => {
    setFromId(toId);
    setToId(fromId);
    resetResult();
  };

  const openPerson = (id: string) => {
    void run(async () => {
      setDetail(await personsApi.get(id));
    });
  };

  const startEdit = (person: Person, version: string) => {
    setEditing({ person, version });
    setFormOpen(true);
  };

  const reload = async () => {
    await loadPersons();
    if (fromId !== "" && toId !== "" && fromId !== toId) {
      const [path, descriptor] = await Promise.all([
        pathApi.find(fromId, toId),
        pathApi.kinship(fromId, toId),
      ]);
      setResult(path);
      setKinship(descriptor);
      setRouteIndex(0);
    }
  };

  const saved = (person: Person) => {
    void run(async () => {
      setFormOpen(false);
      setEditing(null);
      await reload();
      setDetail(await personsApi.get(person.id));
    });
  };

  const remove = (current: PersonDetail) => {
    if (!window.confirm(t("person:deleteConfirm"))) return;
    const removedId = current.person.entity.id;
    void run(async () => {
      await personsApi.delete(removedId, current.person.version);
      setDetail(null);
      if (removedId === fromId) setFromId("");
      if (removedId === toId) setToId("");
      resetResult();
      await loadPersons();
    });
  };

  /** Primary route first, then up to two alternatives (never nested). */
  const routes = useMemo<PathResult[]>(() => {
    if (!result?.found) return [];
    const alternatives = (result.alternatives ?? []).slice(0, MAX_ALTERNATIVES);
    return [result, ...alternatives];
  }, [result]);

  const activeRoute = routes[routeIndex] ?? routes[0] ?? null;

  const layout = useMemo(
    () =>
      activeRoute
        ? layoutPath(activeRoute.path, activeRoute.commonAncestorId)
        : null,
    [activeRoute],
  );

  /** Scale plus translation applied to the canvas inside the viewport. */
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null || layout === null) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width <= 0 || height <= 0 || layout.width <= 0) return;
    const scale = fitScale(layout.width, layout.height, width, height);
    setView({
      scale,
      offset: centeredOffset(layout.width, layout.height, width, height, scale),
    });
  }, [layout]);

  // Every new layout (another route, a reload, another pair) starts fitted.
  useEffect(() => {
    panRef.current = null;
    setPanning(false);
    fit();
  }, [fit]);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const point = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };
    setView((current) =>
      zoomAtPoint(current.scale, current.offset, point, factor),
    );
  }, []);

  const zoomTo = useCallback((scale: number) => {
    const viewport = viewportRef.current;
    if (viewport === null || scale <= 0) return;
    const point = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };
    setView((current) =>
      zoomAtPoint(
        current.scale,
        current.offset,
        point,
        scale / current.scale,
      ),
    );
  }, []);

  // Native listener: React's onWheel is passive, so the page would scroll.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // clientLeft/Top skip the 1px border so the point is in canvas space.
      const point = {
        x: event.clientX - rect.left - viewport.clientLeft,
        y: event.clientY - rect.top - viewport.clientTop,
      };
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView((current) =>
        zoomAtPoint(current.scale, current.offset, point, factor),
      );
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [layout]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(NO_PAN_SELECTOR) !== null
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.offset.x,
      originY: view.offset.y,
      moved: false,
    };
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.moved) {
      // Below the threshold the press stays a click on the viewport.
      if (Math.hypot(dx, dy) < PAN_THRESHOLD) return;
      pan.moved = true;
      setPanning(true);
    }
    setView((current) => ({
      scale: current.scale,
      offset: { x: pan.originX + dx, y: pan.originY + dy },
    }));
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  };

  const links = useMemo(
    () =>
      activeRoute ? pathChainLinks(activeRoute.path, genderOf) : [],
    [activeRoute, genderOf],
  );

  /** Primary keeps the structural descriptor; alternatives are described. */
  const routeTerms = useMemo(
    () =>
      routes.map((route, index) => {
        if (index === 0 && kinship) {
          return formatKinship(kinship, locale, nameOf);
        }
        const edges = edgesFromPath(route.path, genderOf);
        return edges.length > 0 ? describeChain(edges, locale) : null;
      }),
    [routes, kinship, locale, genderOf, nameOf],
  );

  const term = routeTerms[routeIndex] ?? routeTerms[0] ?? null;

  const fullName = (personId: string): string => {
    if (personId === "") return t("person:unknownName");
    const person = personsById.get(personId);
    return person ? displayName(person, t("person:unknownName")) : personId;
  };

  const fromName = fullName(fromId);
  const toName = fullName(toId);

  const originId = activeRoute?.path[0]?.personId ?? fromId;
  const originName =
    originId !== "" && personsById.has(originId)
      ? chainName(personsById.get(originId), t("person:unknownName"))
      : fromName;

  const ancestor = useMemo(() => {
    const id = activeRoute?.commonAncestorId;
    return id ? personsById.get(id) : undefined;
  }, [activeRoute, personsById]);

  const targetId = detail?.person.entity.id ?? (toId !== "" ? toId : fromId);
  const zoomPercent = Math.round(view.scale * 100);

  return (
    <>
      <div className="card-head">
        <h1 className="page-title">{t("path:title")}</h1>
        {term ? (
          <Badge appearance="tint" color="brand">
            {t("path:kinshipLabel", { term })}
          </Badge>
        ) : null}
      </div>

      <section className="panel path-page">
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {t(`errors.${error.code}`, {
                defaultValue: t("errors.UNKNOWN"),
              })}
            </MessageBarBody>
          </MessageBar>
        ) : null}

        {!loaded ? <Spinner size="tiny" label={t("common:loading")} /> : null}

        {loaded && persons.length === 0 ? (
          <EmptyState compact text={t("path:emptyProject")} />
        ) : null}

        {persons.length > 0 ? (
          <>
            <div className="path-pickers">
              <PersonSearch
                id="path-from"
                label={t("path:fromLabel")}
                persons={persons}
                photos={photos}
                value={fromId}
                placeholder={t("path:pickPlaceholder")}
                disabled={busy}
                onChange={(id) => {
                  setFromId(id);
                  resetResult();
                }}
              />
              <Button
                className="path-swap"
                variant="secondary"
                aria-label={t("path:swap")}
                title={t("path:swap")}
                disabled={busy}
                onClick={swap}
              >
                <ArrowSwapRegular aria-hidden="true" />
              </Button>
              <PersonSearch
                id="path-to"
                label={t("path:toLabel")}
                persons={persons}
                photos={photos}
                value={toId}
                placeholder={t("path:pickPlaceholder")}
                disabled={busy}
                onChange={(id) => {
                  setToId(id);
                  resetResult();
                }}
              />
            </div>

            <div className="actions">
              <Button
                variant="primary"
                disabled={busy || fromId === "" || toId === ""}
                onClick={find}
              >
                {t("path:find")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || targetId === ""}
                onClick={() => onOpenInGraph(targetId)}
              >
                {t("path:openInGraph")}
              </Button>

              <div
                className={styles.zoom}
                role="group"
                aria-label={t("path:zoomLabel")}
              >
                <IconButton
                  label={t("path:zoomOut")}
                  disabled={
                    busy || layout === null || view.scale <= SCALE_BOUNDS.min
                  }
                  onClick={() => zoomBy(1 / ZOOM_STEP)}
                >
                  <ZoomOutRegular />
                </IconButton>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.zoomValue}
                  aria-label={t("path:zoomReset", { percent: zoomPercent })}
                  disabled={busy || layout === null}
                  onClick={() => zoomTo(1)}
                >
                  {zoomPercent}%
                </Button>
                <IconButton
                  label={t("path:zoomIn")}
                  disabled={
                    busy || layout === null || view.scale >= SCALE_BOUNDS.max
                  }
                  onClick={() => zoomBy(ZOOM_STEP)}
                >
                  <ZoomInRegular />
                </IconButton>
                <IconButton
                  label={t("path:fit")}
                  disabled={busy || layout === null}
                  onClick={fit}
                >
                  <ArrowFitRegular />
                </IconButton>
              </div>
            </div>

            {samePerson ? (
              <MessageBar intent="warning">
                <MessageBarBody>{t("path:samePerson")}</MessageBarBody>
              </MessageBar>
            ) : null}
          </>
        ) : null}

        {result && !result.found ? (
          <MessageBar intent="info">
            <MessageBarBody>{t("path:notFound")}</MessageBarBody>
          </MessageBar>
        ) : null}

        {activeRoute?.found && layout ? (
          <>
            <Card className="path-result">
              <div className="path-result-head">
                <h3
                  className="path-result-title"
                  aria-label={t("path:resultTitle", {
                    from: fromName,
                    to: toName,
                    term: term ?? t("path:kinshipUnknown"),
                  })}
                >
                  <Text
                    as="span"
                    size={400}
                    weight="semibold"
                    className="path-result-name"
                  >
                    {fromName}
                  </Text>
                  <Text
                    as="span"
                    size={400}
                    className={mergeClasses("path-result-arrow", styles.muted)}
                    aria-hidden="true"
                  >
                    →
                  </Text>
                  <Text
                    as="span"
                    size={400}
                    weight="semibold"
                    className="path-result-name"
                  >
                    {toName}
                  </Text>
                  <Text
                    as="span"
                    size={400}
                    className={mergeClasses("path-result-dash", styles.muted)}
                    aria-hidden="true"
                  >
                    —
                  </Text>
                  <Text
                    as="span"
                    size={700}
                    weight="bold"
                    className={mergeClasses("path-result-term", styles.term)}
                  >
                    {term ?? t("path:kinshipUnknown")}
                  </Text>
                </h3>
              </div>

              {links.length > 0 ? (
                <p className="path-chain">
                  <Text as="span" weight="medium" className="path-chain-person">
                    {originName}
                  </Text>
                  {links.map((link, index) => (
                    <span
                      className="path-chain-link"
                      key={`${index}-${link.personId}`}
                    >
                      <Text
                        as="span"
                        className={mergeClasses(
                          "path-chain-arrow",
                          styles.muted,
                        )}
                        aria-hidden="true"
                      >
                        →
                      </Text>
                      <Text
                        as="span"
                        className={mergeClasses("path-chain-step", styles.muted)}
                      >
                        {t(`path:${stepWordKey(link.direction, link.gender)}`)}
                      </Text>
                      <Text
                        as="span"
                        weight="medium"
                        className="path-chain-person"
                      >
                        {chainName(
                          personsById.get(link.personId),
                          t("person:unknownName"),
                        )}
                      </Text>
                    </span>
                  ))}
                </p>
              ) : null}

              {routes.length > 1 ? (
                <div
                  className="path-routes"
                  role="group"
                  aria-label={t("path:routesLabel")}
                >
                  {routes.map((route, index) => (
                    <Button
                      key={`route-${index}`}
                      variant={index === routeIndex ? "primary" : "secondary"}
                      aria-pressed={index === routeIndex}
                      className={mergeClasses(
                        "path-route",
                        index === routeIndex && "path-route-active",
                        styles.routeButton,
                      )}
                      onClick={() => setRouteIndex(index)}
                    >
                      <Text
                        as="span"
                        size={200}
                        weight="semibold"
                        className="path-route-name"
                      >
                        {index === 0
                          ? t("path:primaryRoute")
                          : t("path:alternativeRoute", { number: index })}
                      </Text>
                      <Text
                        as="span"
                        weight="semibold"
                        className="path-route-term"
                      >
                        {routeTerms[index] ?? t("path:kinshipUnknown")}
                      </Text>
                      <Text as="span" size={200} className="path-route-length">
                        {t("path:distance", { count: route.length })}
                      </Text>
                    </Button>
                  ))}
                </div>
              ) : null}

              <div className="actions path-summary">
                <Text size={200} className={styles.meta}>
                  {t("path:distance", { count: activeRoute.length })}
                </Text>
                {ancestor ? (
                  <Badge appearance="tint" color="brand">
                    {t("path:commonAncestor", {
                      name: displayName(ancestor, t("person:unknownName")),
                    })}
                  </Badge>
                ) : null}
                {activeRoute.commonAncestorId === null ? (
                  <Text size={200} className={styles.meta}>
                    {t("path:noCommonAncestor")}
                  </Text>
                ) : null}
              </div>
            </Card>

            <div
              className={
                panning
                  ? "path-viewport path-viewport-pan path-panning"
                  : "path-viewport path-viewport-pan"
              }
              ref={viewportRef}
              role="group"
              aria-label={t("path:diagramLabel")}
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onLostPointerCapture={endPan}
            >
              {/* Panning is a translate on the outer layer; zooming is CSS
                  `zoom` on the inner one, so Chromium re-rasterises node text
                  at the target size instead of stretching a cached bitmap. */}
              <div
                className="path-canvas"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `translate(${view.offset.x}px, ${view.offset.y}px)`,
                }}
              >
                <div
                  className="path-canvas-zoom"
                  style={{
                    width: layout.width,
                    height: layout.height,
                    zoom: view.scale,
                  }}
                >
                  <svg
                    className="path-edges"
                    width={layout.width}
                    height={layout.height}
                    aria-hidden="true"
                  >
                    {layout.edges.map((edge) => {
                      const from = layout.nodes[edge.fromIndex];
                      const to = layout.nodes[edge.toIndex];
                      const labelX = (from.x + from.width + to.x) / 2;
                      const labelY = (from.y + to.y) / 2 + from.height / 2 - 6;
                      return (
                        <g key={`${edge.fromIndex}-${edge.toIndex}`}>
                          <path
                            d={edge.path}
                            className={`path-edge ${edge.direction.toLowerCase()}`}
                          />
                          <text
                            x={labelX}
                            y={labelY}
                            className="path-edge-label"
                            textAnchor="middle"
                          >
                            {t(`enums:edgeDirection.${edge.direction}`)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>

                  {layout.nodes.map((node) => {
                    const person = personsById.get(node.personId);
                    const name = person
                      ? displayName(person, t("person:unknownName"))
                      : t("person:unknownName");
                    const photo = photos.get(node.personId);
                    const classes = ["path-node"];
                    if (node.index === layout.commonAncestorIndex) {
                      classes.push("ancestor");
                    }
                    if (
                      node.index === 0 ||
                      node.index === layout.nodes.length - 1
                    ) {
                      classes.push("endpoint");
                    }
                    if (node.personId === targetId) classes.push("selected");
                    return (
                      <button
                        key={`${node.index}-${node.personId}`}
                        type="button"
                        className={classes.join(" ")}
                        style={{
                          left: node.x,
                          top: node.y,
                          width: node.width,
                          height: node.height,
                        }}
                        disabled={busy}
                        onClick={() => openPerson(node.personId)}
                      >
                        <span className="path-node-avatar" aria-hidden="true">
                          <span className="path-node-avatar-initials">
                            {initialsFromName(name)}
                          </span>
                          {photo ? (
                            <img
                              src={convertFileSrc(photo.path)}
                              alt=""
                              loading="lazy"
                              draggable={false}
                              onError={(event) => {
                                event.currentTarget.style.visibility =
                                  "hidden";
                              }}
                            />
                          ) : null}
                        </span>
                        <span className="path-node-body">
                          <span className="path-node-name">{name}</span>
                          <span className="path-node-meta">
                            {t(`enums:gender.${person?.gender ?? "UNKNOWN"}`)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <Text as="p" size={200} className={styles.meta}>
              {t("path:clickHint")}
            </Text>
          </>
        ) : null}
      </section>

      {formOpen ? (
        <PersonForm
          key={editing?.person.id ?? "new"}
          initial={editing?.person ?? null}
          version={editing?.version ?? null}
          onSaved={saved}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onReload={() => {
            setFormOpen(false);
            setEditing(null);
            void run(reload);
          }}
        />
      ) : null}

      {detail ? (
        <PersonCard
          detail={detail}
          onBack={() => setDetail(null)}
          onEdit={() =>
            startEdit(detail.person.entity, detail.person.version)
          }
          onDelete={() => remove(detail)}
          onChanged={() => {
            void run(async () => {
              setDetail(await personsApi.get(detail.person.entity.id));
              await reload();
            });
          }}
          onNavigate={onNavigate}
        />
      ) : null}
    </>
  );
}
