/**
 * Pure value and geometry rules for the events year range. Everything here is
 * DOM-free so the slider behaviour can be unit-tested in the `node` vitest
 * environment (see yearRangeRules.test.ts).
 *
 * The two handles always satisfy `lower <= upper`: every move is clamped
 * against the opposite handle, so dragging, keyboard input and a normalized
 * external pair can never cross.
 */

/** Which end of the range a handle edits. */
export type YearRangeHandle = "from" | "to";

/**
 * One drawable range: the full scale (`lowest`..`highest`) plus the normalized
 * picked pair (`lower`..`upper`, always ordered).
 */
export type YearRangeBounds = {
  lowest: number;
  highest: number;
  lower: number;
  upper: number;
};

/** Arrow-key step, in years. */
export const YEAR_STEP = 1;

/** PageUp/PageDown step, in years. */
export const YEAR_PAGE_STEP = 10;

/** Stored bound as a number, or `null` for empty/foreign text. */
export function parseYear(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Clamp `value` to the inclusive `min`..`max` interval. */
export function clampYear(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Turn the stored `from`/`to` strings into one drawable range.
 *
 * Empty or unparseable bounds mean "the end of the scale"; out-of-scale values
 * are clamped; an inverted pair is swapped. A view state may hold an inverted
 * pair from an older build, so the drawable range is normalized here and the
 * caller writes the valid value back on the next move.
 */
export function normalizeYearRange(
  from: string,
  to: string,
  minYear: number,
  maxYear: number,
): YearRangeBounds {
  const lowest = Math.min(minYear, maxYear);
  const highest = Math.max(minYear, maxYear);
  const start = clampYear(parseYear(from) ?? lowest, lowest, highest);
  const end = clampYear(parseYear(to) ?? highest, lowest, highest);

  return {
    lowest,
    highest,
    lower: Math.min(start, end),
    upper: Math.max(start, end),
  };
}

/**
 * Move one handle to `year` without letting it cross the other handle.
 *
 * `from` may reach `upper` and `to` may reach `lower` (a zero-width range is
 * allowed); beyond that the value is clamped. Non-finite input leaves the
 * handle where it is.
 */
export function moveHandle(
  handle: YearRangeHandle,
  year: number,
  bounds: YearRangeBounds,
): number {
  const lower = Math.min(bounds.lower, bounds.upper);
  const upper = Math.max(bounds.lower, bounds.upper);

  if (handle === "from") {
    if (!Number.isFinite(year)) return lower;
    return clampYear(Math.round(year), bounds.lowest, upper);
  }

  if (!Number.isFinite(year)) return upper;
  return clampYear(Math.round(year), lower, bounds.highest);
}

/**
 * Year produced by a key press, or `null` for keys the slider ignores.
 * Arrows move by one year, PageUp/PageDown by ten, Home/End jump to a bound.
 */
export function yearForKey(
  key: string,
  current: number,
  min: number,
  max: number,
): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clampYear(current + YEAR_STEP, min, max);
    case "ArrowLeft":
    case "ArrowDown":
      return clampYear(current - YEAR_STEP, min, max);
    case "PageUp":
      return clampYear(current + YEAR_PAGE_STEP, min, max);
    case "PageDown":
      return clampYear(current - YEAR_PAGE_STEP, min, max);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/**
 * Position of a year on the scale as a percentage of the handle travel, where
 * 0 and 100 sit exactly on the two handle centres.
 */
export function percentForYear(
  year: number,
  lowest: number,
  highest: number,
): number {
  if (highest === lowest) return 0;
  const ratio = (year - lowest) / (highest - lowest);
  return clampYear(ratio, 0, 1) * 100;
}

/**
 * Year under a pointer, measured over the handle-travel rectangle (the inset
 * layer whose edges are the handle centres) and mirrored for RTL layouts.
 */
export function yearAtPointer(
  clientX: number,
  rect: { left: number; width: number },
  lowest: number,
  highest: number,
  rtl = false,
): number {
  if (!Number.isFinite(clientX) || rect.width <= 0) return lowest;

  const raw = (clientX - rect.left) / rect.width;
  const ratio = clampYear(rtl ? 1 - raw : raw, 0, 1);
  return clampYear(
    Math.round(lowest + ratio * (highest - lowest)),
    lowest,
    highest,
  );
}

/**
 * Blue fill as percentages from the handle centres: `start` is the lower
 * handle, `end` the upper one. Callers paint between them and leave the outer
 * segments as the plain track background.
 */
export function rangeFill(
  lower: number,
  upper: number,
  lowest: number,
  highest: number,
): { start: number; end: number } {
  const a = percentForYear(lower, lowest, highest);
  const b = percentForYear(upper, lowest, highest);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
