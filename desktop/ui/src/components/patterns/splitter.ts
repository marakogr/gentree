// Pure geometry and keyboard rules for the master-detail splitter.
//
// Widths are percentages of the layout width, as stored in the project's view
// state. The component only translates these rules into pointer events.

export type SplitterBounds = {
  /** Default position in percent, also used by a double click. */
  defaultWidth: number;
  /** Lower bound in percent. */
  min: number;
  /** Upper bound in percent. */
  max: number;
};

/** Arrow-key step in percent. */
export const SPLITTER_STEP = 2;
/** Shift + arrow step in percent. */
export const SPLITTER_LARGE_STEP = 5;

/** Clamp a width to the bounds; NaN falls back to the default. */
export function clampSplitterWidth(value: number, bounds: SplitterBounds): number {
  if (Number.isNaN(value)) return bounds.defaultWidth;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** Rounded width that is safe to persist. */
export function roundSplitterWidth(value: number, bounds: SplitterBounds): number {
  return Math.round(clampSplitterWidth(value, bounds));
}

/** Stored width from the filters map, or the default when absent/invalid. */
export function readSplitterWidth(
  raw: unknown,
  bounds: SplitterBounds,
): number {
  if (typeof raw !== "string" || raw === "") return bounds.defaultWidth;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed)
    ? clampSplitterWidth(parsed, bounds)
    : bounds.defaultWidth;
}

/** Width from a pointer position inside the layout, or `null` when unmeasurable. */
export function splitterPointerWidth(
  clientX: number,
  left: number,
  width: number,
  bounds: SplitterBounds,
): number | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  return clampSplitterWidth(((clientX - left) / width) * 100, bounds);
}

/** Target width for a key press, or `null` when the key is not handled. */
export function splitterKeyTarget(
  key: string,
  current: number,
  bounds: SplitterBounds,
  shiftKey = false,
): number | null {
  const step = shiftKey ? SPLITTER_LARGE_STEP : SPLITTER_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampSplitterWidth(current - step, bounds);
    case "ArrowRight":
      return clampSplitterWidth(current + step, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
}
