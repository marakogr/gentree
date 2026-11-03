import { makeStyles, shorthands, tokens } from "@fluentui/react-components";
import {
  AddRegular,
  DocumentRegular,
  FireRegular,
  FullScreenMaximizeRegular,
  HeartRegular,
  PersonRegular,
  SubtractRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Translate } from "../../lib/dates";
import { cn } from "../../lib/utils";
import type { TimelineWindow } from "./dates";
import { eventTypeLabel, participantName } from "./format";
import {
  genderLabelKey,
  genderMarker,
  type GenderMarkerIcon,
  type GenderMarkerTone,
} from "./gender";
import { useTimelineTranslate } from "./i18n";
import {
  brushWindow,
  buildAxisTicks,
  buildDensityBins,
  clusterLineMarkers,
  layoutLineLabels,
  panWindow,
  positionOnLine,
  zoomWindow,
  type LineCluster,
  type LineIconKind,
  type LineMarker,
} from "./line";

interface LineTypeMeta {
  label: string;
  Icon: FluentIcon;
  swatch: string;
  interval: string;
  text: string;
}

type LineStyles = ReturnType<typeof useStyles>;

/**
 * Marker palette on Fluent semantic tokens. Filled swatches invert inside the
 * theme (dark teal on light surfaces, mint on dark ones) so the glyph keeps
 * AAA contrast with the marker; the interval bands are the same hue at low
 * opacity.
 */
const useStyles = makeStyles({
  canvas: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  trackSurface: {
    backgroundColor: tokens.colorNeutralBackground2,
  },
  axis: {
    color: tokens.colorNeutralStroke2,
  },
  tickLabel: {
    fill: tokens.colorNeutralForeground2,
  },
  leader: {
    color: tokens.colorNeutralStroke3,
  },
  muted: {
    color: tokens.colorNeutralForeground2,
  },
  focusRing: {
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  hoverSurface: {
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  surface: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  stripBorder: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  zoomButton: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    ":hover": {
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  popover: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
  tooltip: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  markerBorder: {
    ...shorthands.borderColor(tokens.colorNeutralBackground1),
  },
  markerSelected: {
    boxShadow: `0 0 0 1px ${tokens.colorNeutralBackground1}, 0 0 0 3px ${tokens.colorStrokeFocus2}`,
  },
  clusterSelected: {
    boxShadow: `0 0 0 2px ${tokens.colorStrokeFocus2}`,
  },
  labelChip: {
    backgroundColor: tokens.colorNeutralBackground1,
  },
  minimapFrame: {
    ...shorthands.borderColor(tokens.colorNeutralStroke2),
  },
  density: {
    color: tokens.colorBrandBackground,
  },
  densityWindow: {
    color: tokens.colorBrandStroke1,
  },
  densityBrush: {
    color: tokens.colorBrandBackground,
  },
  // Event types: birth -> brand, marriage -> red (the heart), death -> neutral
  // grey, other -> warning. The brand swatch uses the accessible brand shade
  // (the plain brandBackground is under 4.5:1 with either glyph colour); warning
  // and neutral pair with the surface colour because their tints are too light
  // for white text. Palette tokens flip with the theme, so the red heart and the
  // grey death marker keep their contrast in light and dark.
  swatchBirth: {
    backgroundColor: tokens.colorBrandForegroundInverted,
    color: tokens.colorNeutralBackground1,
  },
  swatchMarriage: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  swatchDeath: {
    backgroundColor: tokens.colorNeutralStrokeAccessible,
    color: tokens.colorNeutralBackground1,
  },
  swatchOther: {
    backgroundColor: tokens.colorStatusWarningForeground2,
    color: tokens.colorNeutralBackground1,
  },
  intervalBirth: {
    backgroundColor: tokens.colorBrandBackground,
    opacity: 0.3,
  },
  intervalMarriage: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    opacity: 0.3,
  },
  intervalDeath: {
    backgroundColor: tokens.colorNeutralStrokeAccessible,
    opacity: 0.3,
  },
  intervalOther: {
    backgroundColor: tokens.colorStatusWarningBackground3,
    opacity: 0.3,
  },
  textBirth: { color: tokens.colorBrandForegroundInverted },
  textMarriage: { color: tokens.colorPaletteRedForeground2 },
  textDeath: { color: tokens.colorNeutralForeground3 },
  textOther: { color: tokens.colorStatusWarningForeground3 },
  // Birth markers carry the gender axis instead of the event type. Fluent has
  // no semantic male/female tokens, so the three tones use palette hues that
  // flip with the theme; the glyph always takes the surface colour.
  swatchMale: {
    backgroundColor: tokens.colorPaletteBlueBorderActive,
    color: tokens.colorNeutralBackground1,
  },
  swatchFemale: {
    backgroundColor: tokens.colorPaletteMagentaBorderActive,
    color: tokens.colorNeutralBackground1,
  },
  swatchNeutral: {
    backgroundColor: tokens.colorNeutralForeground2,
    color: tokens.colorNeutralBackground1,
  },
  intervalMale: {
    backgroundColor: tokens.colorPaletteBlueBorderActive,
    opacity: 0.3,
  },
  intervalFemale: {
    backgroundColor: tokens.colorPaletteMagentaBorderActive,
    opacity: 0.3,
  },
  intervalNeutral: {
    backgroundColor: tokens.colorNeutralStrokeAccessible,
    opacity: 0.3,
  },
  textMale: { color: tokens.colorPaletteBlueForeground2 },
  textFemale: { color: tokens.colorPaletteMagentaForeground2 },
  textNeutral: { color: tokens.colorNeutralForeground2 },
});

/** Visual metadata for one marker family; labels come from the dictionary. */
export function lineTypeMeta(
  t: Translate,
  styles: LineStyles,
): Record<LineIconKind, LineTypeMeta> {
  return {
    birth: {
      label: t("type.birth"),
      Icon: PersonRegular,
      swatch: styles.swatchBirth,
      interval: styles.intervalBirth,
      text: styles.textBirth,
    },
    marriage: {
      label: t("type.marriage"),
      Icon: HeartRegular,
      swatch: styles.swatchMarriage,
      interval: styles.intervalMarriage,
      text: styles.textMarriage,
    },
    death: {
      label: t("type.death"),
      Icon: FireRegular,
      swatch: styles.swatchDeath,
      interval: styles.intervalDeath,
      text: styles.textDeath,
    },
    other: {
      label: t("type.other"),
      Icon: DocumentRegular,
      swatch: styles.swatchOther,
      interval: styles.intervalOther,
      text: styles.textOther,
    },
  };
}

// Fluent has no Mars/Venus glyphs; the gender stays readable through the
// marker colour and the accessible name built in `formatMarkerAria`.
const GENDER_ICONS: Record<GenderMarkerIcon, FluentIcon> = {
  mars: PersonRegular,
  venus: PersonRegular,
  neutral: PersonRegular,
};

type GenderToneMeta = Pick<LineTypeMeta, "swatch" | "interval" | "text">;

/** Per-gender marker colours on Fluent palette tokens. */
function genderToneMeta(
  styles: LineStyles,
): Record<GenderMarkerTone, GenderToneMeta> {
  return {
    male: {
      swatch: styles.swatchMale,
      interval: styles.intervalMale,
      text: styles.textMale,
    },
    female: {
      swatch: styles.swatchFemale,
      interval: styles.intervalFemale,
      text: styles.textFemale,
    },
    unknown: {
      swatch: styles.swatchNeutral,
      interval: styles.intervalNeutral,
      text: styles.textNeutral,
    },
  };
}

/**
 * Birth markers use the subject's gender glyph and colour; every other marker
 * keeps its event-type appearance. Clusters and the legend stay type-based.
 */
function markerAppearance(
  marker: LineMarker,
  typeMeta: Record<LineIconKind, LineTypeMeta>,
  genderTones: Record<GenderMarkerTone, GenderToneMeta>,
): LineTypeMeta {
  const base = typeMeta[marker.icon];
  if (marker.icon !== "birth") return base;
  const gender = genderMarker(marker.gender);
  const tone = genderTones[gender.tone];
  return {
    ...base,
    Icon: GENDER_ICONS[gender.icon],
    swatch: tone.swatch,
    interval: tone.interval,
    text: tone.text,
  };
}

const MIN_FALLBACK_WIDTH = 720;

function formatMarkerAria(marker: LineMarker, t: Translate): string {
  const name =
    marker.mainParticipant === null
      ? ""
      : participantName(marker.mainParticipant, t);
  const gender = marker.icon === "birth" ? t(genderLabelKey(marker.gender)) : "";
  return [eventTypeLabel(marker.event.type, t), gender, name, marker.label]
    .filter((part) => part.length > 0)
    .join(", ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clusterRangeLabel(cluster: LineCluster): string {
  const first = cluster.markers[0]?.label ?? "";
  const last = cluster.markers[cluster.markers.length - 1]?.label ?? "";
  return first === last ? first : `${first}–${last}`;
}

function densityPath(
  weights: readonly number[],
  width: number,
  height: number,
): string {
  if (weights.length === 0) {
    return "";
  }
  const step = width / weights.length;
  const points = weights.map((weight, index) => ({
    x: step * (index + 0.5),
    y: height - Math.max(1, weight * (height - 3)),
  }));
  let path = `M 0 ${height} L 0 ${points[0]?.y ?? height}`;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined) {
      continue;
    }
    if (next === undefined) {
      path += ` L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
      break;
    }
    const midX = (point.x + next.x) / 2;
    const midY = (point.y + next.y) / 2;
    path += ` Q ${point.x.toFixed(2)} ${point.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  if (last !== undefined) {
    path += ` L ${width} ${last.y.toFixed(2)} L ${width} ${height} Z`;
  }
  return path;
}

interface HoverState {
  kind: "marker" | "cluster";
  id: string;
  x: number;
}

interface DragState {
  mode: "pan" | "brush";
  pointerId: number;
  startX: number;
  startWindow: TimelineWindow;
  moved: boolean;
  brushFrom?: number;
  brushTo?: number;
}

interface PinchState {
  startDistance: number;
  startWindow: TimelineWindow;
  anchor: number;
}

export interface LineCanvasProps {
  markers: LineMarker[];
  window: TimelineWindow;
  /** Tight data window; the minimap always shows this range. */
  fullWindow: TimelineWindow | null;
  selectedEventId: string | null;
  rootPersonId: string | null;
  focusPersonId: string | null;
  highlightIds: ReadonlySet<string>;
  loadingMore?: boolean;
  onSelectEvent: (eventId: string) => void;
  onWindowChange: (window: TimelineWindow) => void;
  onFit: () => void;
}

/**
 * Readable event timeline: adaptive year/month axis, labelled markers with
 * leader lines on both sides, pixel clusters, a density minimap with a brush
 * and zoom/pan controls. All positions come from `date.start`; the width of a
 * month/year interval is visual only.
 */
export function LineCanvas({
  markers,
  window,
  fullWindow,
  selectedEventId,
  rootPersonId,
  focusPersonId,
  highlightIds,
  loadingMore = false,
  onSelectEvent,
  onWindowChange,
  onFit,
}: LineCanvasProps) {
  const t = useTimelineTranslate();
  const styles = useStyles();
  const typeMeta = useMemo(() => lineTypeMeta(t, styles), [t, styles]);
  const genderTones = useMemo(() => genderToneMeta(styles), [styles]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  // The fallback matches the CSS `min-h` of the canvas so the first paint is
  // already close to the measured box and the axis does not jump.
  const [size, setSize] = useState({ width: MIN_FALLBACK_WIDTH, height: 520 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [hoverCardHeight, setHoverCardHeight] = useState(0);
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  const [openClusterId, setOpenClusterId] = useState<string | null>(null);
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);
  const [hintVisible, setHintVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState | null>(null);
  const windowRef = useRef(window);
  windowRef.current = window;
  const hintTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null,
  );
  const hintShownRef = useRef(false);

  useEffect(() => {
    const element = trackRef.current;
    if (element === null) {
      return;
    }
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = {
        width: rect.width > 0 ? rect.width : MIN_FALLBACK_WIDTH,
        height: rect.height > 0 ? rect.height : 520,
      };
      setSize((current) =>
        Math.abs(current.width - next.width) < 0.5 &&
        Math.abs(current.height - next.height) < 0.5
          ? current
          : next,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") {
      return;
    }
    const query = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
  }, []);

  useEffect(
    () => () => {
      if (hintTimerRef.current !== null) {
        globalThis.clearTimeout(hintTimerRef.current);
      }
    },
    [],
  );

  const rememberHint = useCallback(() => {
    if (hintShownRef.current) {
      return;
    }
    hintShownRef.current = true;
    setHintVisible(true);
    hintTimerRef.current = globalThis.setTimeout(
      () => setHintVisible(false),
      3600,
    );
  }, []);

  const clusters = useMemo(
    () =>
      clusterLineMarkers(markers, window, size.width, {
        thresholdPx: 17,
        isolateId: selectedEventId,
      }),
    [selectedEventId, size.width, markers, window],
  );

  const axisY = size.height / 2;
  const labels = useMemo(
    () =>
      layoutLineLabels(clusters, size.width, {
        axisY,
        height: size.height,
        topInset: size.width < 480 ? 78 : 52,
        bottomInset: 10,
        // The year/month ticks are drawn up to 25px under the axis; bottom
        // labels start below that band so a card never covers the date.
        axisLabelHeight: 26,
        maxRows: size.height < 420 ? 2 : 3,
        maxWidth: size.width < 480 ? 132 : 188,
        selectedEventId,
        rootPersonId,
        focusPersonId,
        t,
      }),
    [axisY, clusters, focusPersonId, rootPersonId, selectedEventId, size, t],
  );
  const ticks = useMemo(
    () =>
      buildAxisTicks(window, size.width, t, size.width < 420 ? 46 : 58),
    [size.width, t, window],
  );

  const minimapWindow = fullWindow ?? window;
  const fullBins = useMemo(
    () => buildDensityBins(markers, minimapWindow, 72),
    [markers, minimapWindow],
  );
  const fullMax = useMemo(
    () => Math.max(1, ...fullBins.map((bin) => bin.count)),
    [fullBins],
  );

  const closeCluster = useCallback(() => setOpenClusterId(null), []);

  useEffect(() => {
    const element = trackRef.current;
    if (element === null) {
      return;
    }
    const listener = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : 1;
      const fraction = clamp((event.clientX - rect.left) / width, 0, 1);
      const factor = Math.exp(event.deltaY * 0.0015);
      onWindowChange(zoomWindow(windowRef.current, factor, fraction));
      rememberHint();
    };
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [onWindowChange, rememberHint]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("[data-line-interactive='true']") !== null) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      pointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      if (pointersRef.current.size === 2) {
        const [a, b] = Array.from(pointersRef.current.values());
        if (a !== undefined && b !== undefined) {
          const centerX = (a.x + b.x) / 2 - rect.left;
          pinchRef.current = {
            startDistance: Math.max(1, Math.abs(a.x - b.x)),
            startWindow: windowRef.current,
            anchor: clamp(centerX / Math.max(1, rect.width), 0, 1),
          };
        }
        dragRef.current = null;
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        mode: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startWindow: windowRef.current,
        moved: false,
      };
      closeCluster();
    },
    [closeCluster],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }
      const pinch = pinchRef.current;
      if (pinch !== null && pointersRef.current.size === 2) {
        const [a, b] = Array.from(pointersRef.current.values());
        if (a !== undefined && b !== undefined) {
          const distance = Math.max(1, Math.abs(a.x - b.x));
          const factor = pinch.startDistance / distance;
          onWindowChange(zoomWindow(pinch.startWindow, factor, pinch.anchor));
          rememberHint();
        }
        return;
      }
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      const dx = event.clientX - drag.startX;
      if (Math.abs(dx) > 2) {
        drag.moved = true;
      }
      const width = Math.max(1, size.width);
      onWindowChange(panWindow(drag.startWindow, -dx / width));
      rememberHint();
    },
    [onWindowChange, rememberHint, size.width],
  );

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
    }
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-line-interactive='true']") !== null) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = clamp(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        0,
        1,
      );
      onWindowChange(zoomWindow(windowRef.current, 0.45, fraction));
      rememberHint();
    },
    [onWindowChange, rememberHint],
  );

  const handleMinimapPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = clamp(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        0,
        1,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        mode: "brush",
        pointerId: event.pointerId,
        startX: event.clientX,
        startWindow: minimapWindow,
        moved: false,
        brushFrom: fraction,
        brushTo: fraction,
      };
      setBrush({ from: fraction, to: fraction });
    },
    [minimapWindow],
  );

  const handleMinimapPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.mode !== "brush" || drag.pointerId !== event.pointerId) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = clamp(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        0,
        1,
      );
      drag.moved = true;
      drag.brushTo = fraction;
      setBrush({ from: drag.brushFrom ?? fraction, to: fraction });
    },
    [],
  );

  const handleMinimapPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.mode !== "brush" || drag.pointerId !== event.pointerId) {
        return;
      }
      const from = drag.brushFrom ?? 0;
      const to = drag.brushTo ?? from;
      dragRef.current = null;
      setBrush(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onWindowChange(brushWindow(minimapWindow, from, to));
      rememberHint();
    },
    [minimapWindow, onWindowChange, rememberHint],
  );

  const handleTrackKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.getAttribute("data-line-nav") !== "true") {
        return;
      }
      const track = trackRef.current;
      if (track === null) {
        return;
      }
      const items = Array.from(
        track.querySelectorAll<HTMLElement>("[data-line-nav='true']"),
      ).filter((item) => item.tabIndex !== -1);
      const index = items.indexOf(target);
      if (index === -1) {
        return;
      }
      event.preventDefault();
      const nextIndex = clamp(
        index + (event.key === "ArrowRight" ? 1 : -1),
        0,
        items.length - 1,
      );
      items[nextIndex]?.focus();
    },
    [],
  );

  const openCluster = useMemo(
    () =>
      openClusterId === null
        ? null
        : (clusters.find((cluster) => cluster.id === openClusterId) ?? null),
    [clusters, openClusterId],
  );

  const hoveredCluster =
    hover?.kind === "cluster"
      ? (clusters.find((cluster) => cluster.id === hover.id) ?? null)
      : null;
  const hoveredMarker =
    hover?.kind === "marker"
      ? (markers.find((marker) => marker.event.id === hover.id) ?? null)
      : null;

  const tooltip =
    hoveredCluster !== null
      ? {
          body: (
            <>
              <p className="text-[12px] font-semibold">
                {t("canvas.clusterCount", { count: hoveredCluster.count })}
              </p>
              <p className={cn(styles.muted, "text-[11px]")}>
                {clusterRangeLabel(hoveredCluster)}
              </p>
              <p className={cn(styles.muted, "mt-1 text-[11px]")}>
                {t("canvas.expandHint")}
              </p>
            </>
          ),
        }
      : hoveredMarker !== null
        ? {
            body: (
              <>
                <p className={cn("text-[11px] font-semibold", markerAppearance(hoveredMarker, typeMeta, genderTones).text)}>
                  {eventTypeLabel(hoveredMarker.event.type, t)}
                </p>
                <p className="text-[13px] font-medium">{hoveredMarker.label}</p>
                {hoveredMarker.event.place !== null &&
                  hoveredMarker.event.place.trim().length > 0 && (
                    <p className={cn(styles.muted, "max-w-72 break-words text-[11.5px]")}>
                      {hoveredMarker.event.place}
                    </p>
                  )}
                {hoveredMarker.event.participants.length > 0 && (
                  <p className={cn(styles.muted, "max-w-72 break-words text-[11.5px]")}>
                    {hoveredMarker.event.participants
                      .slice(0, 3)
                      .map((participant) => participantName(participant, t))
                      .join(", ")}
                  </p>
                )}
              </>
            ),
          }
        : null;

  // The hover card grows with its content (long addresses, several
  // participants). Measure it so a tall card is placed above the marker by its
  // real height instead of the old fixed offset: otherwise it drops over the
  // marker it describes.
  useLayoutEffect(() => {
    const node = hoverCardRef.current;
    setHoverCardHeight(
      node === null ? 0 : Math.ceil(node.getBoundingClientRect().height),
    );
  }, [hover?.id, size.width]);

  const hoverCardGap = 20;
  const hoverCardLeft = clamp(
    (hover?.x ?? 0) - 128,
    8,
    Math.max(8, size.width - 264),
  );
  const hoverCardAbove = axisY - hoverCardGap - hoverCardHeight;
  const hoverCardBelow = hoverCardHeight > 0 && hoverCardAbove < 8;
  const hoverCardStyle: CSSProperties = {
    left: `${hoverCardLeft}px`,
    ...(hoverCardBelow
      ? {
          top: `${clamp(
            axisY + hoverCardGap,
            8,
            Math.max(8, size.height - hoverCardHeight - 8),
          )}px`,
        }
      : { bottom: `${Math.max(8, size.height - axisY + hoverCardGap)}px` }),
  };

  const windowFractions = useMemo(() => {
    const fullSpan =
      minimapWindow.end.getTime() - minimapWindow.start.getTime();
    if (!Number.isFinite(fullSpan) || fullSpan <= 0) {
      return { left: 0, width: 1 };
    }
    const left = clamp(
      (window.start.getTime() - minimapWindow.start.getTime()) / fullSpan,
      0,
      1,
    );
    const right = clamp(
      (window.end.getTime() - minimapWindow.start.getTime()) / fullSpan,
      0,
      1,
    );
    return { left, width: Math.max(0.005, right - left) };
  }, [minimapWindow, window]);

  return (
    <section
      className={cn(
        styles.canvas,
        "relative flex h-full min-h-[480px] flex-col overflow-hidden rounded-lg",
      )}
      aria-label={t("canvas.aria")}
      data-testid="line-canvas"
    >
      <div
        ref={trackRef}
        data-testid="timeline-line-track"
        role="list"
        aria-label={t("canvas.listAria")}
        tabIndex={-1}
        className="relative flex-1 touch-none select-none overflow-hidden"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleTrackKeyDown}
      >
        <svg
          className={cn(
            styles.axis,
            "pointer-events-none absolute inset-0 size-full",
          )}
          width={size.width}
          height={size.height}
          aria-hidden="true"
        >
          <line
            x1={0}
            y1={axisY}
            x2={size.width}
            y2={axisY}
            stroke="currentColor"
            strokeWidth={1}
          />
          {ticks.map((tick) => {
            const fraction = positionOnLine(tick.time, window);
            if (fraction === null) {
              return null;
            }
            const x = fraction * size.width;
            return (
              <g key={`${tick.time.getTime()}-${tick.unit}`}>
                <line
                  x1={x}
                  y1={axisY - (tick.major ? 6 : 4)}
                  x2={x}
                  y2={axisY + (tick.major ? 6 : 4)}
                  stroke="currentColor"
                  strokeWidth={tick.major ? 1.5 : 1}
                />
                <text
                  x={clamp(x, 18, size.width - 18)}
                  y={axisY + 22}
                  textAnchor="middle"
                  data-testid="line-axis-tick"
                  data-tick-unit={tick.unit}
                  className={cn(styles.tickLabel, "text-[12px]")}
                  style={{ fontSize: tick.unit === "year" ? 13 : 12 }}
                >
                  {tick.label}
                </text>
              </g>
            );
          })}
          {labels.map((label) => (
            <polyline
              key={`leader-${label.clusterId}`}
              points={`${label.leader.x},${label.leader.y} ${label.leader.midX},${label.leader.midY} ${label.leader.endX},${label.leader.endY}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              className={styles.leader}
            />
          ))}
        </svg>

        {markers.length === 0 && (
          <div
            className={cn(
              styles.muted,
              "absolute inset-0 flex items-center justify-center p-6 text-center text-xs",
            )}
          >
            {t("noDated")}
          </div>
        )}

        {markers.map((marker) => {
          const startFraction = positionOnLine(marker.time, window);
          if (startFraction === null) {
            return null;
          }
          const endFraction =
            marker.end === null
              ? startFraction
              : (positionOnLine(marker.end, window) ?? 1);
          const intervalWidth = Math.max(
            0,
            (endFraction - startFraction) * size.width,
          );
          const showInterval =
            marker.precision !== "day" || marker.dateKind === "range";
          return showInterval && intervalWidth > 1 ? (
            <span
              key={`interval-${marker.event.id}`}
              data-testid="line-interval"
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute h-2 -translate-y-1/2 rounded-full",
                markerAppearance(marker, typeMeta, genderTones).interval,
              )}
              style={{
                left: `${startFraction * 100}%`,
                width: `${intervalWidth}px`,
                top: axisY,
              }}
            />
          ) : null;
        })}

        {clusters.map((cluster) => {
          const x = cluster.fraction * size.width;
          const left = clamp(x, 12, Math.max(12, size.width - 12));
          if (cluster.count > 1) {
            return (
              <div
                key={cluster.id}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left, top: axisY }}
              >
                <button
                  type="button"
                  data-testid="line-cluster"
                  data-cluster-count={cluster.count}
                  data-line-nav="true"
                  aria-expanded={openClusterId === cluster.id}
                  aria-label={t("canvas.clusterAria", {
                    count: cluster.count,
                    range: clusterRangeLabel(cluster),
                  })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseEnter={() => setHover({ kind: "cluster", id: cluster.id, x })}
                  onMouseLeave={() =>
                    setHover((current) =>
                      current?.id === cluster.id ? null : current,
                    )
                  }
                  onFocus={() => setHover({ kind: "cluster", id: cluster.id, x })}
                  onBlur={() =>
                    setHover((current) =>
                      current?.id === cluster.id ? null : current,
                    )
                  }
                  onClick={() => {
                    setOpenClusterId((current) =>
                      current === cluster.id ? null : cluster.id,
                    );
                    setHover(null);
                  }}
                  className={cn(
                    styles.focusRing,
                    styles.markerBorder,
                    "flex h-6 min-w-6 items-center justify-center rounded-full border-2 px-1.5 py-0 text-[11px] font-semibold shadow-sm transition-[left,top] duration-150 motion-reduce:transition-none",
                    typeMeta[cluster.icon].swatch,
                    selectedEventId !== null &&
                      cluster.markers.some(
                        (marker) => marker.event.id === selectedEventId,
                      ) &&
                      styles.clusterSelected,
                  )}
                >
                  +{cluster.count}
                </button>
              </div>
            );
          }
          const marker = cluster.markers[0];
          if (marker === undefined) {
            return null;
          }
          const selected = marker.event.id === selectedEventId;
          const highlighted =
            highlightIds.size === 0 || highlightIds.has(marker.event.id);
          const appearance = markerAppearance(marker, typeMeta, genderTones);
          const Icon = appearance.Icon;
          return (
            <div
              key={cluster.id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top: axisY }}
            >
              <button
                type="button"
                data-testid="line-marker"
                data-line-nav="true"
                data-event-id={marker.event.id}
                data-event-type={marker.icon}
                data-date-kind={marker.dateKind}
                data-precision={marker.precision}
                data-highlighted={highlighted ? "true" : "false"}
                data-selected={selected ? "true" : "false"}
                aria-label={formatMarkerAria(marker, t)}
                aria-pressed={selected}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseEnter={() =>
                  setHover({ kind: "marker", id: marker.event.id, x })
                }
                onMouseLeave={() =>
                  setHover((current) =>
                    current?.id === marker.event.id ? null : current,
                  )
                }
                onFocus={() =>
                  setHover({ kind: "marker", id: marker.event.id, x })
                }
                onBlur={() =>
                  setHover((current) =>
                    current?.id === marker.event.id ? null : current,
                  )
                }
                onClick={() => {
                  setOpenClusterId(null);
                  onSelectEvent(marker.event.id);
                }}
                className={cn(
                  styles.focusRing,
                  styles.markerBorder,
                  "flex size-6 items-center justify-center border-2 p-0 shadow-sm transition-[left,top] duration-150 motion-reduce:transition-none",
                  marker.dateKind === "exact"
                    ? "rounded-full"
                    : marker.dateKind === "range"
                      ? "rotate-45 rounded-[4px]"
                      : "rounded-full border-dashed",
                  appearance.swatch,
                  selected && styles.markerSelected,
                  !highlighted && "opacity-35 saturate-50",
                )}
              >
                <Icon
                  fontSize={14}
                  className={marker.dateKind === "range" ? "-rotate-45" : undefined}
                  aria-hidden="true"
                />
              </button>
            </div>
          );
        })}

        {labels.map((label) => {
          // The hover card repeats the marker's name; keep the info once.
          if (hover?.kind === "marker" && hover.id === label.eventId) {
            return null;
          }
          return (
            <div
              key={`label-${label.clusterId}`}
              data-testid="line-label"
              className={cn(
                styles.labelChip,
                "pointer-events-none absolute z-10 rounded-sm px-1 py-0.5 text-left",
              )}
              style={{
                left: `${label.x}px`,
                top: `${label.y}px`,
                width: `${label.width}px`,
                height: `${label.height}px`,
              }}
            >
              <p className="break-words text-[11px] font-semibold leading-[1.15]">
                {label.title}
              </p>
              <p
                className={cn(
                  styles.muted,
                  "truncate text-[11px] leading-[1.15]",
                )}
              >
                {label.date}
              </p>
            </div>
          );
        })}

        {openCluster !== null && (
          <div
            role="dialog"
            aria-label={t("canvas.nearbyAria", {
              range: clusterRangeLabel(openCluster),
            })}
            data-testid="line-cluster-popover"
            data-line-interactive="true"
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
              styles.popover,
              "absolute z-30 w-72 max-w-[calc(100%-1rem)] rounded-md p-2",
            )}
            style={{
              left: `${clamp(openCluster.fraction * size.width - 144, 8, Math.max(8, size.width - 296))}px`,
              top: `${clamp(axisY + 26, 8, Math.max(8, size.height - 240))}px`,
            }}
          >
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <p className="text-[12px] font-semibold">
                {t("canvas.clusterCount", { count: openCluster.count })}
              </p>
              <button
                type="button"
                onClick={closeCluster}
                aria-label={t("canvas.closeCluster")}
                className={cn(
                  styles.focusRing,
                  styles.muted,
                  "rounded px-1 py-0 text-sm",
                )}
              >
                ×
              </button>
            </div>
            <div className="max-h-52 space-y-0.5 overflow-y-auto">
              {openCluster.markers.map((marker) => {
                const meta = markerAppearance(marker, typeMeta, genderTones);
                const Icon = meta.Icon;
                return (
                  <button
                    key={marker.event.id}
                    type="button"
                    onClick={() => {
                      closeCluster();
                      onSelectEvent(marker.event.id);
                    }}
                    className={cn(
                      styles.focusRing,
                      styles.hoverSurface,
                      "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px]",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full",
                        meta.swatch,
                      )}
                    >
                      <Icon fontSize={10} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">
                        {eventTypeLabel(marker.event.type, t)}
                        {marker.mainParticipant === null
                          ? ""
                          : ` — ${participantName(marker.mainParticipant, t)}`}
                      </span>
                      <span
                        className={cn(
                          styles.muted,
                          "block text-[10.5px]",
                        )}
                      >
                        {marker.label}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {tooltip !== null && hover !== null && (
          <div
            ref={hoverCardRef}
            role="tooltip"
            data-testid="line-hover-card"
            className={cn(
              styles.tooltip,
              "pointer-events-none absolute z-30 w-64 max-w-[calc(100%-1rem)] rounded-md px-3 py-2.5 text-left",
            )}
            style={hoverCardStyle}
          >
            {tooltip.body}
          </div>
        )}

        {hintVisible && (
          <div
            data-testid="line-controls-hint"
            role="status"
            className={cn(
              styles.tooltip,
              styles.muted,
              "pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full px-3 py-1.5 text-[12px]",
              !reducedMotion && "motion-safe:animate-in motion-safe:fade-in",
            )}
          >
            {t("canvas.hint")}
          </div>
        )}

        {loadingMore && (
          <p
            role="status"
            className={cn(
              styles.surface,
              styles.muted,
              "absolute right-3 top-12 z-20 rounded-full px-2 py-1 text-[11px]",
            )}
          >
            {t("canvas.loadingMore")}
          </p>
        )}
      </div>

      <div
        className={cn(
          styles.trackSurface,
          styles.stripBorder,
          "shrink-0 px-3 py-1.5",
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <p
            className={cn(
              styles.muted,
              "text-[11px] font-medium uppercase tracking-wide",
            )}
          >
            {t("canvas.density")}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="line-zoom-out"
              onClick={() => onWindowChange(zoomWindow(window, 1.6, 0.5))}
              aria-label={t("zoomOut")}
              title={t("zoomOut")}
              className={cn(
                styles.zoomButton,
                "flex size-6 items-center justify-center rounded p-0",
              )}
            >
              <SubtractRegular fontSize={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="line-zoom-in"
              onClick={() => onWindowChange(zoomWindow(window, 0.6, 0.5))}
              aria-label={t("zoomIn")}
              title={t("zoomIn")}
              className={cn(
                styles.zoomButton,
                "flex size-6 items-center justify-center rounded p-0",
              )}
            >
              <AddRegular fontSize={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="line-zoom-fit"
              onClick={onFit}
              aria-label={t("fit")}
              title={t("fit")}
              className={cn(
                styles.zoomButton,
                "flex size-6 items-center justify-center rounded p-0",
              )}
            >
              <FullScreenMaximizeRegular fontSize={12} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          ref={minimapRef}
          data-testid="line-minimap"
          role="group"
          aria-label={t("canvas.minimapAria")}
          className={cn(
            styles.minimapFrame,
            "relative h-10 w-full cursor-crosshair touch-none overflow-hidden rounded border",
          )}
          onPointerDown={handleMinimapPointerDown}
          onPointerMove={handleMinimapPointerMove}
          onPointerUp={handleMinimapPointerUp}
          onPointerCancel={() => {
            dragRef.current = null;
            setBrush(null);
          }}
        >
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            <path
              d={densityPath(
                fullBins.map((bin) => bin.count / fullMax),
                size.width,
                40,
              )}
              fill="currentColor"
              fillOpacity={0.18}
              className={styles.density}
            />
            <rect
              x={windowFractions.left * size.width}
              y={0}
              width={Math.max(2, windowFractions.width * size.width)}
              height={40}
              fill="currentColor"
              fillOpacity={0.06}
              stroke="currentColor"
              className={styles.densityWindow}
              strokeWidth={1}
            />
            {brush !== null && (
              <rect
                x={Math.min(brush.from, brush.to) * size.width}
                y={0}
                width={Math.abs(brush.to - brush.from) * size.width}
                height={40}
                fill="currentColor"
                fillOpacity={0.15}
                className={styles.densityBrush}
              />
            )}
          </svg>
        </div>
      </div>
    </section>
  );
}
