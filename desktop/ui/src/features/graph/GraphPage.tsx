import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Button,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDownRegular,
  ChevronUpRegular,
  ArrowFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  graphApi,
  mediaApi,
  personsApi,
  relationshipsApi,
  settingsApi,
} from "../../api/client";
import type {
  AncestorGraph,
  DescendantGraph,
  KinshipDescriptor,
  MediaItem,
  Person,
  PersonDetail,
} from "../../api/types";
import { resolveLocale } from "../../i18n";
import { formatKinship } from "../../i18n/kinship";
import { ErrorBanner } from "../../components/feedback";
import { IconButton } from "../../components/ui/icon-button";
import { useToast } from "../../components/ui/toast";
import { useAsyncAction } from "../../lib/useAsyncAction";
import {
  centeredOffset,
  fitScale,
  zoomAtPoint,
} from "../../lib/viewport";
import PersonCard from "../persons/PersonCard";
import PersonForm from "../persons/PersonForm";
import PersonSearch from "../persons/PersonSearch";
import type { PersonNavigationAction } from "../persons/actions";
import { displayName } from "../persons/helpers";
import {
  initialsFromName,
  photosByPerson,
} from "../media/helpers";
import { showsNodeLabels } from "./detail";
import {
  layoutAncestors,
  layoutDescendants,
  spousePairKey,
  type LayoutNode,
} from "./layout";
import { buildBloodTree, buildFullTree } from "./forest";
import { combineLayouts } from "./combined";
import {
  parentEdgesFromRelationships,
  type ParentEdges,
} from "./parents";
import { selectRootPerson } from "./root";

const GRAPH_SCALE_BOUNDS = { min: 0.4, max: 1.8 } as const;
const FIT_PADDING = 16;
const ZOOM_STEP = 1.15;
/** Pointer travel (px) that turns a press into a pan instead of a click. */
const PAN_THRESHOLD = 4;
/** Elements that keep their own click handling instead of dragging the canvas. */
const NO_PAN_SELECTOR =
  "button, a, input, textarea, select, label, [role='button'], [data-graph-no-pan]";
const PERSON_LIMIT = 1000;
/** Initial direct-line depth requested for a newly selected root. */
const DEFAULT_GENERATIONS = 3;
/** The root card alone: the down arrow can collapse every generation. */
const MIN_GENERATIONS = 0;
/** Backend cap for explicit generation requests (`MAX_GENERATIONS`). */
const MAX_GENERATIONS = 8;

/** Which people the tree shows around the selected root. */
type GraphMode = "both" | "ancestors" | "descendants" | "relatives" | "tree";
type DirectMode = "ancestors" | "descendants";

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

/** Deepest generation that actually has a real card; placeholders do not count. */
function visibleDepth(graph: AncestorGraph | DescendantGraph): number {
  return graph.nodes.reduce((max, node) => {
    if ("placeholder" in node && node.placeholder) return max;
    return Math.max(max, node.generation);
  }, 0);
}

/**
 * The graph paints through `.graph-*` rules that still live in `styles.css`
 * and read the `--legacy-*` palette. Rebinding those variables on the screen
 * root moves the canvas, edges and node chrome onto Fluent tokens without
 * touching `styles.css` or the layout maths; the bridge disappears with the
 * legacy stylesheet in the cleanup phase.
 */
const useStyles = makeStyles({
  screen: {
    "--legacy-panel-border": tokens.colorNeutralStroke2,
    "--legacy-control-border": tokens.colorNeutralStroke1,
    "--legacy-control-bg": tokens.colorNeutralBackground1,
    "--legacy-fg": tokens.colorNeutralForeground1,
    "--legacy-heading": tokens.colorNeutralForeground1,
    "--legacy-muted": tokens.colorNeutralForeground2,
    "--legacy-muted-strong": tokens.colorNeutralForeground2,
    "--legacy-surface": tokens.colorNeutralBackground1,
    "--legacy-surface-alt": tokens.colorNeutralBackground2,
    // Accent text and the selected-node ring: brandForeground1 is only
    // 2.99:1 on white with this teal ramp, the inverted pair is 4.66:1.
    "--legacy-accent": tokens.colorBrandStroke1,
    "--legacy-link": tokens.colorBrandForegroundInverted,
    "--legacy-edge": tokens.colorNeutralStrokeAccessible,
    "--legacy-node-hover-border": tokens.colorNeutralStrokeAccessible,
    "--legacy-grid": tokens.colorNeutralStroke2,
  },
  controlHint: {
    display: "block",
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground2,
  },
});

type Props = {
  projectId: string;
  homePersonId: string | null;
  /** Root requested from another tab (relation page); takes precedence. */
  initialRootPersonId?: string | null;
  /** Clears the one-shot root request once the screen has applied it. */
  onRootHandled?: () => void;
  onHomeChanged: (personId: string | null) => void;
  onNavigate?: (action: PersonNavigationAction, personId: string) => void;
};

type Editing = { person: Person; version: string };

export default function GraphPage({
  projectId,
  homePersonId,
  initialRootPersonId = null,
  onRootHandled,
  onHomeChanged,
  onNavigate,
}: Props) {
  const { t, i18n } = useTranslation(["graph", "person", "common", "enums"]);
  const toast = useToast();
  const styles = useStyles();

  const [persons, setPersons] = useState<Person[]>([]);
  const [personsLoaded, setPersonsLoaded] = useState(false);
  const [photos, setPhotos] = useState<Map<string, MediaItem>>(new Map());
  const [spousePairs, setSpousePairs] = useState<Set<string>>(new Set());
  const [parentEdges, setParentEdges] = useState<ParentEdges>(new Map());
  const [mode, setMode] = useState<GraphMode>("both");
  /** The mode of the last request; read by callbacks that must not re-subscribe. */
  const modeRef = useRef<GraphMode>("both");
  const [ancestorGraph, setAncestorGraph] = useState<AncestorGraph | null>(
    null,
  );
  const [descendantGraph, setDescendantGraph] =
    useState<DescendantGraph | null>(null);
  /**
   * Independent depths for the two halves of the tree. One arrow click changes
   * exactly one direction, so expanding descendants never hides ancestors.
   */
  const [ancestorGenerations, setAncestorGenerations] = useState(
    DEFAULT_GENERATIONS,
  );
  const ancestorGenerationsRef = useRef(DEFAULT_GENERATIONS);
  const [descendantGenerations, setDescendantGenerations] = useState(
    DEFAULT_GENERATIONS,
  );
  const descendantGenerationsRef = useRef(DEFAULT_GENERATIONS);
  /** Experimental rootless mode, off unless enabled in Settings. */
  const [wholeTreeEnabled, setWholeTreeEnabled] = useState(false);
  const [explicitRoot, setExplicitRoot] = useState<string | null>(
    initialRootPersonId,
  );
  const [home, setHome] = useState<string | null>(homePersonId);
  const [selected, setSelected] = useState<PersonDetail | null>(null);
  const [kinshipById, setKinshipById] = useState<
    Map<string, KinshipDescriptor>
  >(new Map());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const { busy, error, run } = useAsyncAction();
  const [view, setView] = useState({
    scale: 1,
    offset: { x: 0, y: 0 },
  });
  const [panning, setPanning] = useState(false);
  /** "Fit width" is the 100% baseline, not the raw fitted ratio. */
  const [baselineScale, setBaselineScale] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<PanState | null>(null);

  useEffect(() => {
    setHome(homePersonId);
  }, [homePersonId]);

  useEffect(() => {
    // A null request must not overwrite a root the user picked or persisted on
    // this screen; only a new one-shot request moves the root.
    if (initialRootPersonId === null) return;
    setExplicitRoot(initialRootPersonId);
    onRootHandled?.();
  }, [initialRootPersonId, onRootHandled]);

  useEffect(() => {
    let active = true;
    void settingsApi
      .get()
      .then((snapshot) => {
        if (active) {
          setWholeTreeEnabled(
            snapshot.config.app.graph_whole_tree === true,
          );
        }
      })
      .catch(() => {
        // A hidden experimental mode is the correct fallback.
      });
    return () => {
      active = false;
    };
  }, []);

  const loadContext = useCallback(async () => {
    if (projectId === "") return;
    const [page, relationships, media] = await Promise.all([
      personsApi.list({ limit: PERSON_LIMIT, sort: "name" }),
      relationshipsApi.list(),
      // Photos are decoration: a media failure must not hide the tree.
      mediaApi.list().catch(() => [] as MediaItem[]),
    ]);
    setPersons(page.items.map((item) => item.entity));
    setPhotos(photosByPerson(media));
    setSpousePairs(
      new Set(
        relationships
          .filter(
            (row) =>
              row.entity.type === "SPOUSE" ||
              row.entity.type === "PARTNER",
          )
          .map((row) =>
            spousePairKey(row.entity.personId, row.entity.relatedPersonId),
          ),
      ),
    );
    setParentEdges(parentEdgesFromRelationships(relationships));
    setPersonsLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void run(loadContext);
  }, [run, loadContext]);

  const personsById = useMemo(
    () => new Map(persons.map((person) => [person.id, person])),
    [persons],
  );

  const fallbackRoot = useMemo(
    () => selectRootPerson(persons, home),
    [persons, home],
  );

  const rootId = explicitRoot ?? fallbackRoot?.id ?? null;

  /** Whole-project forest for the feature-flagged rootless mode. */
  const fullTree = useMemo(
    () => buildFullTree(persons, parentEdges),
    [persons, parentEdges],
  );
  /** Everyone connected to the root by blood (no spouses, no adoption). */
  const bloodTree = useMemo(
    () =>
      rootId === null
        ? null
        : buildBloodTree(persons, parentEdges, rootId),
    [persons, parentEdges, rootId],
  );

  // Disclosure stays available at every depth: the backend clamps the request,
  // and a graph that reports no further generation must not lock the arrows.
  const canCollapseAncestors = ancestorGenerations > MIN_GENERATIONS;
  const canExpandAncestors = ancestorGenerations < MAX_GENERATIONS;
  const canCollapseDescendants = descendantGenerations > MIN_GENERATIONS;
  const canExpandDescendants = descendantGenerations < MAX_GENERATIONS;

  const rootHasParents = useMemo(
    () => rootId !== null && (parentEdges.get(rootId)?.length ?? 0) > 0,
    [parentEdges, rootId],
  );
  const rootHasChildren = useMemo(
    () =>
      rootId !== null &&
      persons.some((person) =>
        (parentEdges.get(person.id) ?? []).some(
          (edge) => edge.parentId === rootId,
        ),
      ),
    [persons, parentEdges, rootId],
  );

  const loadAncestors = useCallback(
    async (requestedGenerations: number, rootOverride?: string) => {
      const targetRoot = rootOverride ?? rootId;
      if (targetRoot === null) {
        setAncestorGraph(null);
        return;
      }
      const next = await graphApi.ancestors({
        rootPersonId: targetRoot,
        generations: Math.min(
          MAX_GENERATIONS,
          Math.max(MIN_GENERATIONS, requestedGenerations),
        ),
      });
      setAncestorGraph(next);
      // Mirror the depth that is actually on screen, so the next arrow click
      // always adds or removes one visible generation.
      const depth = visibleDepth(next);
      ancestorGenerationsRef.current = depth;
      setAncestorGenerations(depth);
    },
    [rootId],
  );

  const loadDescendants = useCallback(
    async (requestedGenerations: number, rootOverride?: string) => {
      const targetRoot = rootOverride ?? rootId;
      if (targetRoot === null) {
        setDescendantGraph(null);
        return;
      }
      const next = await graphApi.descendants({
        rootPersonId: targetRoot,
        generations: Math.min(
          MAX_GENERATIONS,
          Math.max(MIN_GENERATIONS, requestedGenerations),
        ),
      });
      setDescendantGraph(next);
      const depth = visibleDepth(next);
      descendantGenerationsRef.current = depth;
      setDescendantGenerations(depth);
    },
    [rootId],
  );

  const loadBoth = useCallback(
    async (
      ancestorDepth: number,
      descendantDepth: number,
      rootOverride?: string,
    ) => {
      await Promise.all([
        loadAncestors(ancestorDepth, rootOverride),
        loadDescendants(descendantDepth, rootOverride),
      ]);
    },
    [loadAncestors, loadDescendants],
  );

  useEffect(() => {
    // A root change reloads both halves; relatives and the rootless full tree
    // are derived from the loaded context and need no request.
    void run(() =>
      loadBoth(
        ancestorGenerationsRef.current,
        descendantGenerationsRef.current,
      ),
    );
  }, [run, loadBoth]);

  const displayGraph = useMemo(() => {
    if (mode === "tree") return fullTree.graph;
    if (mode === "relatives") return bloodTree?.graph ?? null;
    if (mode === "ancestors") return ancestorGraph;
    if (mode === "descendants") return descendantGraph;
    return null;
  }, [ancestorGraph, descendantGraph, mode, fullTree, bloodTree]);

  /** No rootless tree and no root means no kinship to label. */
  const rootGraphId = mode === "tree" ? "" : (rootId ?? "");

  const graphPersonIds = useMemo(() => {
    if (mode === "both") {
      const ids = new Set<string>();
      for (const node of ancestorGraph?.nodes ?? []) {
        if (node.personId) ids.add(node.personId);
      }
      for (const node of descendantGraph?.nodes ?? []) {
        ids.add(node.personId);
      }
      return [...ids];
    }
    return (
      displayGraph?.nodes
        .map((node) => node.personId)
        .filter((id): id is string => id !== null) ?? []
    );
  }, [ancestorGraph, descendantGraph, displayGraph, mode]);

  useEffect(() => {
    if (rootGraphId === "" || graphPersonIds.length === 0) {
      setKinshipById(new Map());
      return undefined;
    }
    let active = true;
    void graphApi
      .kinship(rootGraphId, graphPersonIds)
      .then((rows) => {
        if (active) setKinshipById(new Map(Object.entries(rows)));
      })
      .catch(() => {
        // Kinship labels are decorative here: structural roles still render.
        if (active) setKinshipById(new Map());
      });
    return () => {
      active = false;
    };
  }, [graphPersonIds, rootGraphId]);

  const locale = resolveLocale(i18n.language, navigator.language);

  const layout = useMemo(() => {
    if (mode === "tree") {
      return layoutDescendants(fullTree.graph, {
        extraEdges: fullTree.extraEdges,
      });
    }
    if (mode === "relatives") {
      return bloodTree
        ? layoutDescendants(bloodTree.graph, {
            extraEdges: bloodTree.extraEdges,
          })
        : null;
    }
    // Placeholder "unknown parent" nodes are not part of the desktop tree: the
    // backend still returns them for the web client.
    const ancestorLayout =
      (mode === "ancestors" || mode === "both") && ancestorGraph
        ? layoutAncestors(ancestorGraph, spousePairs, {
            includePlaceholders: false,
          })
        : null;
    const descendantLayout =
      (mode === "descendants" || mode === "both") && descendantGraph
        ? layoutDescendants(descendantGraph)
        : null;
    if (mode === "ancestors") return ancestorLayout;
    if (mode === "descendants") return descendantLayout;
    if (ancestorLayout && descendantLayout) {
      return combineLayouts(ancestorLayout, descendantLayout);
    }
    return ancestorLayout ?? descendantLayout;
  }, [
    ancestorGraph,
    descendantGraph,
    fullTree,
    bloodTree,
    mode,
    spousePairs,
  ]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout || layout.width === 0) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width <= 0 || height <= 0) return;
    const scale = fitScale(
      layout.width,
      layout.height,
      width,
      height,
      FIT_PADDING,
    );
    setView({
      scale,
      offset: centeredOffset(layout.width, layout.height, width, height, scale),
    });
    setBaselineScale(scale);
  }, [layout]);

  useEffect(() => {
    panRef.current = null;
    setPanning(false);
    fit();
  }, [fit]);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const point = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };
    setView((current) =>
      zoomAtPoint(
        current.scale,
        current.offset,
        point,
        factor,
        GRAPH_SCALE_BOUNDS,
      ),
    );
  }, []);

  // Native listener: React's onWheel is passive, so the page would scroll.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left - viewport.clientLeft,
        y: event.clientY - rect.top - viewport.clientTop,
      };
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView((current) =>
        zoomAtPoint(
          current.scale,
          current.offset,
          point,
          factor,
          GRAPH_SCALE_BOUNDS,
        ),
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

  const openPerson = (id: string) => {
    void run(async () => {
      setSelected(await personsApi.get(id));
    });
  };

  const startEdit = (person: Person, version: string) => {
    setEditing({ person, version });
    setFormOpen(true);
  };

  const handleNodeClick = (node: LayoutNode) => {
    if (node.personId) openPerson(node.personId);
  };

  const reload = async () => {
    await loadContext();
    await loadBoth(
      ancestorGenerationsRef.current,
      descendantGenerationsRef.current,
    );
  };

  const saved = (person: Person) => {
    void run(async () => {
      setFormOpen(false);
      setEditing(null);
      await reload();
      setSelected(await personsApi.get(person.id));
    });
  };

  const remove = (detail: PersonDetail) => {
    if (!window.confirm(t("person:deleteConfirm"))) return;
    void run(async () => {
      const removedId = detail.person.entity.id;
      const deletingRoot = rootId === removedId;
      await personsApi.delete(removedId, detail.person.version);
      setSelected(null);
      if (explicitRoot === removedId) setExplicitRoot(null);
      if (home === removedId) {
        setHome(null);
        onHomeChanged(null);
      }
      await loadContext();
      // A deleted root makes the root-id effect pick the next person; any other
      // deletion only changes the relationships, so reload both halves.
      if (!deletingRoot) {
        await loadBoth(
          ancestorGenerationsRef.current,
          descendantGenerationsRef.current,
        );
      }
    });
  };

  /**
   * Persists `personId` as the project's starting person through the existing
   * `persons_set_home` command. The screen calls it "root" everywhere: the
   * manifest field keeps its backend name, the UI never says "home person".
   * The root-id effect rebuilds the tree when the visible root changes.
   */
  const markAsRoot = (personId: string) => {
    void run(async () => {
      await personsApi.setHome(personId);
      setHome(personId);
      onHomeChanged(personId);
      const person = personsById.get(personId);
      toast.success(
        t("graph:rootSaved", {
          name: person
            ? displayName(person, t("person:unknownName"))
            : personId,
        }),
      );
      setExplicitRoot(null);
      // Close the card that supplied the target so the re-rooted tree is
      // visible immediately; the action is about the tree, not the card.
      if (selected !== null) setSelected(null);
      // The rootless view has no root card to rebuild: open the rooted view.
      // Loading both halves also covers the case where the visible root was
      // already this person and no root-id effect would fire.
      if (modeRef.current === "tree") {
        modeRef.current = "both";
        setMode("both");
      }
      await loadBoth(
        ancestorGenerationsRef.current,
        descendantGenerationsRef.current,
        personId,
      );
    });
  };

  /**
   * Switches the view without changing either depth. Both halves are already
   * loaded; relatives and the feature-flagged whole tree are derived from the
   * loaded context.
   */
  const switchMode = (nextMode: GraphMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
  };

  /**
   * Root picker: choosing a person while the rootless full tree is on screen
   * returns to the rooted view. The root-id effect loads the direct-line modes;
   * the blood tree is derived from the new root automatically.
   */
  const chooseRoot = (personId: string) => {
    const next = personId === "" ? null : personId;
    setExplicitRoot(next);
    if (next !== null && modeRef.current === "tree") {
      modeRef.current = "both";
      setMode("both");
      // When the root id changes, the root-id effect loads both halves. Only an
      // unchanged id needs a manual request.
      if (next === rootId) {
        void run(() =>
          loadBoth(
            ancestorGenerationsRef.current,
            descendantGenerationsRef.current,
            next,
          ),
        );
      }
    }
  };

  /**
   * One arrow click changes exactly one direction. The other half stays on
   * screen: switching away from a focused view opens the combined tree instead
   * of replacing ancestors with descendants (or the reverse).
   */
  const changeGeneration = (direction: DirectMode, delta: 1 | -1) => {
    const depth =
      direction === "ancestors"
        ? ancestorGenerationsRef.current
        : descendantGenerationsRef.current;
    const next = depth + delta;
    if (next < MIN_GENERATIONS || next > MAX_GENERATIONS) return;
    if (modeRef.current !== direction) {
      modeRef.current = "both";
      setMode("both");
    }
    const load = direction === "ancestors" ? loadAncestors : loadDescendants;
    void run(() => load(next));
  };

  const rootPerson =
    rootGraphId !== "" ? personsById.get(rootGraphId) : undefined;
  /**
   * The person the root button acts on: an open person card wins over the
   * current root, so selecting someone on the canvas and pressing "Make root"
   * roots the tree at that person instead of re-saving the old root.
   */
  const rootTarget = selected?.person.entity.id ?? rootId;
  const canMarkRoot =
    rootTarget !== null && (selected !== null || mode !== "tree");
  // The hints describe the data, not the current cut: parents and children can
  // exist while the arrows keep them hidden.
  const hasKnownAncestors = rootHasParents;
  const hasKnownDescendants = rootHasChildren;
  const hasBloodRelatives = (bloodTree?.graph.nodes.length ?? 0) > 1;
  const canvasLabelKey =
    mode === "both"
      ? "graph:canvasLabelBoth"
      : mode === "ancestors"
        ? "graph:canvasLabel"
        : mode === "descendants"
          ? "graph:canvasLabelDescendants"
          : mode === "relatives"
            ? "graph:canvasLabelRelatives"
            : "graph:canvasLabelWholeTree";

  return (
    <>
      <div className="card-head">
        <h1 className="page-title">{t("graph:title")}</h1>
        {rootPerson ? (
          <span className="badge">
            {t("graph:rootValue", { name: displayName(rootPerson, t("person:unknownName")) })}
          </span>
        ) : null}
      </div>

      <section className={`panel ${styles.screen}`}>
        <ErrorBanner error={error} />

        {!personsLoaded ? <p className="meta">{t("common:loading")}</p> : null}

        {personsLoaded && persons.length === 0 ? (
          <p className="meta">{t("graph:emptyProject")}</p>
        ) : null}

        {personsLoaded && persons.length > 0 ? (
          <>
            <div className="graph-toolbar graph-root-picker">
              <PersonSearch
                id="graph-root-person"
                label={t("graph:rootPickerLabel")}
                persons={persons}
                photos={photos}
                value={mode === "tree" ? "" : (rootId ?? "")}
                placeholder={t("graph:rootPickerPlaceholder")}
                disabled={busy}
                onChange={chooseRoot}
              />
              <Button
                appearance="secondary"
                disabled={busy || !canMarkRoot}
                title={t("graph:setAsRootHint")}
                onClick={() => {
                  if (rootTarget !== null) markAsRoot(rootTarget);
                }}
              >
                {t("graph:setAsRoot")}
              </Button>
              {explicitRoot && mode !== "tree" ? (
                <Button
                  appearance="secondary"
                  disabled={busy}
                  title={t("graph:rootHint")}
                  onClick={() => setExplicitRoot(null)}
                >
                  {t("graph:resetRoot")}
                </Button>
              ) : null}
            </div>
            {mode !== "tree" ? (
              <Text as="p" size={200} className={styles.controlHint}>
                {t("graph:rootHint")}
              </Text>
            ) : null}
          </>
        ) : null}

        {layout ? (
          <>
            <div className="graph-toolbar">
              <IconButton
                label={t("graph:zoomOut")}
                disabled={busy || view.scale <= GRAPH_SCALE_BOUNDS.min}
                onClick={() => zoomBy(1 / ZOOM_STEP)}
              >
                <ZoomOutRegular />
              </IconButton>
              <span className="graph-zoom-value" aria-live="polite">
                {`${Math.round(
                  (view.scale / (baselineScale ?? 1)) * 100,
                )}%`}
              </span>
              <IconButton
                label={t("graph:zoomIn")}
                disabled={busy || view.scale >= GRAPH_SCALE_BOUNDS.max}
                onClick={() => zoomBy(ZOOM_STEP)}
              >
                <ZoomInRegular />
              </IconButton>
              <IconButton
                label={t("graph:fit")}
                disabled={busy}
                onClick={fit}
              >
                <ArrowFitRegular />
              </IconButton>
              <Button
                appearance={mode === "both" ? "primary" : "secondary"}
                disabled={busy}
                title={t("graph:showBothHint")}
                onClick={() => switchMode("both")}
              >
                {t("graph:showBoth")}
              </Button>
              <Button
                appearance={mode === "ancestors" ? "primary" : "secondary"}
                disabled={busy}
                title={t("graph:showAncestorsHint")}
                onClick={() => switchMode("ancestors")}
              >
                {t("graph:showAncestors")}
              </Button>
              <Button
                appearance={mode === "descendants" ? "primary" : "secondary"}
                disabled={busy}
                title={t("graph:showDescendantsHint")}
                onClick={() => switchMode("descendants")}
              >
                {t("graph:showDescendants")}
              </Button>
              <Button
                appearance={mode === "relatives" ? "primary" : "secondary"}
                disabled={busy}
                title={t("graph:showBloodRelativesHint")}
                onClick={() => switchMode("relatives")}
              >
                {t("graph:showBloodRelatives")}
              </Button>
              {wholeTreeEnabled ? (
                <Button
                  appearance={mode === "tree" ? "primary" : "secondary"}
                  disabled={busy}
                  title={t("graph:showWholeTreeHint")}
                  onClick={() => switchMode("tree")}
                >
                  {t("graph:showWholeTree")}
                </Button>
              ) : null}
            </div>

            {mode === "ancestors" && !hasKnownAncestors ? (
              <p className="hint">{t("graph:emptyRelationships")}</p>
            ) : null}
            {mode === "descendants" && !hasKnownDescendants ? (
              <p className="hint">{t("graph:emptyDescendants")}</p>
            ) : null}
            {mode === "relatives" && !hasBloodRelatives ? (
              <p className="hint">{t("graph:emptyBloodRelatives")}</p>
            ) : null}
            {mode === "tree" ? (
              <p className="hint">{t("graph:wholeTreeWarning")}</p>
            ) : null}
            {(mode === "ancestors" || mode === "both") &&
            ancestorGraph?.truncated ? (
              <p className="hint">{t("graph:truncated")}</p>
            ) : null}
            {(mode === "descendants" || mode === "both") &&
            descendantGraph?.truncated ? (
              <p className="hint">{t("graph:truncatedDescendants")}</p>
            ) : null}
            {(mode === "ancestors" || mode === "both") &&
            ancestorGraph?.pedigreeCollapse ? (
              <p className="hint">{t("graph:collapse")}</p>
            ) : null}
            {(mode === "descendants" || mode === "both") &&
            descendantGraph?.pedigreeCollapse ? (
              <p className="hint">{t("graph:collapseDescendants")}</p>
            ) : null}

            <div
              className={
                panning
                  ? "graph-viewport graph-pan graph-panning"
                  : "graph-viewport graph-pan"
              }
              ref={viewportRef}
              role="group"
              aria-label={t(canvasLabelKey)}
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onLostPointerCapture={endPan}
            >
              {/* Panning is a translate on the outer layer; zooming is a
                  `scale` with its origin at the layout origin on the inner
                  one. Unlike CSS `zoom`, the transform leaves layout at 100%
                  and lets Chromium rasterise node text at the final scale. */}
              <div
                className="graph-canvas"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `translate(${view.offset.x}px, ${view.offset.y}px)`,
                }}
              >
                <div
                  className={
                    showsNodeLabels(view.scale)
                      ? "graph-canvas-zoom"
                      : "graph-canvas-zoom graph-canvas-compact"
                  }
                  style={{
                    width: layout.width,
                    height: layout.height,
                    transform: `scale(${view.scale})`,
                  }}
                >
                  <svg
                    className="graph-edges"
                    width={layout.width}
                    height={layout.height}
                    aria-hidden="true"
                  >
                    {layout.edges.map((edge) => (
                      <path
                        key={`${edge.kind}-${edge.fromKey}-${edge.toKey}`}
                        d={edge.path}
                        className={`graph-edge ${edge.kind}`}
                      />
                    ))}
                  </svg>

                  {layout.nodes.map((node) => {
                    const person = node.personId
                      ? personsById.get(node.personId)
                      : undefined;
                    const name = person
                      ? displayName(person, t("person:unknownName"))
                      : t("person:unknownName");
                    const ancestorNode =
                      node.role === "FATHER" || node.role === "MOTHER";
                    const role =
                      mode === "relatives"
                        ? ""
                        : t(
                            `enums:${
                              mode === "ancestors" ||
                              (mode === "both" && ancestorNode)
                                ? "ancestorRole"
                                : "descendantRole"
                            }.${node.role}`,
                          );
                    const descriptor = node.personId
                      ? kinshipById.get(node.personId)
                      : undefined;
                    const kinshipLabel =
                      descriptor &&
                      descriptor.kind !== "UNKNOWN" &&
                      node.personId !== rootGraphId
                        ? formatKinship(descriptor, locale, (id) => {
                            const related = personsById.get(id);
                            return related
                              ? displayName(
                                  related,
                                  t("person:unknownName"),
                                )
                              : undefined;
                          })
                        : null;
                    const meta = kinshipLabel ?? role;
                    const cardTitle = kinshipLabel
                      ? role
                        ? `${kinshipLabel} · ${role}`
                        : kinshipLabel
                      : undefined;
                    const photo = node.personId
                      ? photos.get(node.personId)
                      : undefined;
                    const initials = initialsFromName(name);
                    const classes = ["graph-node"];
                    const isRoot =
                      rootGraphId !== "" && node.personId === rootGraphId;
                    if (isRoot) classes.push("root");
                    if (selected?.person.entity.id === node.personId)
                      classes.push("selected");
                    const position = {
                      left: node.x,
                      top: node.y,
                      width: node.width,
                      height: node.height,
                    };
                    const card = (
                      <>
                        <span
                          className="graph-node-avatar"
                          aria-hidden="true"
                        >
                          <span className="graph-node-avatar-initials">
                            {initials}
                          </span>
                          {photo ? (
                            <img
                              src={convertFileSrc(photo.path)}
                              alt={t("graph:avatarAlt", { name })}
                              loading="lazy"
                              draggable={false}
                              onError={(event) => {
                                event.currentTarget.style.visibility =
                                  "hidden";
                              }}
                            />
                          ) : null}
                        </span>
                        <span className="graph-node-body">
                          <span className="graph-node-name">{name}</span>
                          <span className="graph-node-meta">{meta}</span>
                          {node.adoptive ? (
                            <span className="graph-node-flag">
                              {t(
                                mode === "ancestors" ||
                                  (mode === "both" && ancestorNode)
                                  ? "graph:adoptive"
                                  : "graph:adoptiveChild",
                              )}
                            </span>
                          ) : null}
                        </span>
                      </>
                    );

                    if (isRoot) {
                      // The root card owns both direct-line controls: ancestors
                      // on the left, descendants on the right. Both pairs stay
                      // visible, and using one from another view also opens that
                      // direction. The arrow points toward the generation it
                      // adds.
                      return (
                        <div
                          key={node.occurrenceKey}
                          className={classes.join(" ")}
                          style={position}
                          role="group"
                          aria-label={name}
                        >
                          <span className="graph-node-levels">
                            <button
                              type="button"
                              className="graph-node-level"
                              disabled={busy || !canExpandAncestors}
                              title={t("graph:expandAncestors")}
                              aria-label={t("graph:expandAncestors")}
                              onClick={() =>
                                changeGeneration("ancestors", 1)
                              }
                            >
                              <ChevronUpRegular fontSize={12} />
                            </button>
                            <button
                              type="button"
                              className="graph-node-level"
                              disabled={busy || !canCollapseAncestors}
                              title={t("graph:collapseAncestors")}
                              aria-label={t("graph:collapseAncestors")}
                              onClick={() =>
                                changeGeneration("ancestors", -1)
                              }
                            >
                              <ChevronDownRegular fontSize={12} />
                            </button>
                          </span>
                          <button
                            type="button"
                            className="graph-node-main"
                            disabled={busy}
                            title={cardTitle}
                            aria-label={meta ? `${name}, ${meta}` : name}
                            onClick={() => handleNodeClick(node)}
                          >
                            {card}
                          </button>
                          <span className="graph-node-levels">
                            <button
                              type="button"
                              className="graph-node-level"
                              disabled={busy || !canCollapseDescendants}
                              title={t("graph:collapseDescendants")}
                              aria-label={t("graph:collapseDescendants")}
                              onClick={() =>
                                changeGeneration("descendants", -1)
                              }
                            >
                              <ChevronUpRegular fontSize={12} />
                            </button>
                            <button
                              type="button"
                              className="graph-node-level"
                              disabled={busy || !canExpandDescendants}
                              title={t("graph:expandDescendants")}
                              aria-label={t("graph:expandDescendants")}
                              onClick={() =>
                                changeGeneration("descendants", 1)
                              }
                            >
                              <ChevronDownRegular fontSize={12} />
                            </button>
                          </span>
                        </div>
                      );
                    }

                    return (
                      <button
                        key={node.occurrenceKey}
                        type="button"
                        className={classes.join(" ")}
                        style={position}
                        disabled={busy}
                        title={cardTitle}
                        aria-label={meta ? `${name}, ${meta}` : name}
                        onClick={() => handleNodeClick(node)}
                      >
                        {card}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
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

      {selected ? (
        <PersonCard
          detail={selected}
          onBack={() => setSelected(null)}
          onEdit={() => startEdit(selected.person.entity, selected.person.version)}
          onDelete={() => remove(selected)}
          onChanged={() => {
            void run(async () => {
              setSelected(await personsApi.get(selected.person.entity.id));
              await reload();
            });
          }}
          onNavigate={onNavigate}
        />
      ) : null}
    </>
  );
}
