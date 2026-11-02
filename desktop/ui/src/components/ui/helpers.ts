/**
 * Pure helpers shared by the UI kit. Everything here is DOM-free so it can be
 * unit-tested in the `node` vitest environment (see helpers.test.ts).
 */

export type ComboItem = {
  id: string;
  label: string;
  hint?: string;
};

/** Lowercase and fold the Cyrillic yo letter (U+0451) to ye (U+0435). */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\u0451/g, "\u0435");
}

/**
 * Case-insensitive substring filter over `label` and `hint`.
 * An empty/whitespace query returns every item in its original order.
 */
export function filterComboItems(
  items: ComboItem[],
  query: string,
): ComboItem[] {
  const needle = normalizeSearchText(query.trim());
  if (needle === "") return items;
  return items.filter((item) => {
    const label = normalizeSearchText(item.label);
    if (label.includes(needle)) return true;
    return item.hint ? normalizeSearchText(item.hint).includes(needle) : false;
  });
}

/**
 * Clamp an active (highlighted) option index. Negative input means
 * "nothing is highlighted" and stays `-1`; the upper bound is inclusive.
 */
export function clampActiveIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (!Number.isFinite(index) || index < 0) return -1;
  return Math.min(Math.trunc(index), length - 1);
}

/**
 * Move the active option by `delta`, wrapping around the list edges.
 * Starting from "no selection" (`-1`) moves to the first (delta >= 0) or the
 * last (delta < 0) option.
 */
export function moveActiveIndex(
  index: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  if (!Number.isFinite(index) || index < 0) {
    return step < 0 ? length - 1 : 0;
  }
  const start = clampActiveIndex(index, length);
  return ((start + step) % length + length) % length;
}

/** Keys that activate the focused menu item / option. */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

/** Person pickers keep this many rows visible; the rest scroll inside. */
export const COMBOBOX_VISIBLE_OPTIONS = 5;

/**
 * One rich option row: 20px name line + 16px hint line + 6px padding above and
 * below. Compact rows get the same exact height so five rows always fit.
 */
export const COMBOBOX_OPTION_HEIGHT_PX = 48;

/**
 * Fluent's listbox has a small inner padding. Without it the fifth row is
 * clipped by a few pixels, which looks like the popup ends too early.
 */
export const COMBOBOX_LISTBOX_PADDING_PX = 16;

/**
 * Max height of the listbox popup in pixels: five full rows plus the listbox
 * padding. The popup never grows to the app/window height; longer lists scroll.
 */
export function comboListboxMaxHeightPx(): number {
  return (
    COMBOBOX_VISIBLE_OPTIONS * COMBOBOX_OPTION_HEIGHT_PX +
    COMBOBOX_LISTBOX_PADDING_PX
  );
}

/**
 * Fluent sizes the open popup with `autoSize: true`: its positioning layer
 * writes `max-height` (and `height`) straight onto the listbox element, so it
 * fills the rest of the window and overrides the five-row cap above. Sizing
 * only the width leaves the height to `comboListboxMaxHeightPx()`.
 */
export const COMBOBOX_POSITIONING = { autoSize: "width" } as const;
