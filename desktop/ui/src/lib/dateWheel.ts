// Geometry of the date wheel columns. One fixed row height plus symmetric
// column padding lets every option - including the first and the last - sit on
// the same centre line, so the chosen day, month and year always line up.
// The component only translates these values into CSS.

/** Height of one wheel row, shared by the CSS and the scroll math. */
export const WHEEL_ITEM_HEIGHT = 36;

/** Visible rows. An odd count leaves one row in the middle of the column. */
export const WHEEL_VISIBLE_ROWS = 5;

/** Viewport height of a column: exactly the visible rows. */
export const WHEEL_COLUMN_HEIGHT = WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ROWS;

/**
 * Vertical padding that lets the first and last option reach the centre line.
 * Half of the space left by the middle row.
 */
export const WHEEL_COLUMN_PADDING =
  (WHEEL_COLUMN_HEIGHT - WHEEL_ITEM_HEIGHT) / 2;

/**
 * Scroll offset that centres the option at `index`. Every column uses the same
 * row height and the same padding, so equal indices produce equal offsets and
 * the chosen rows stay on one horizontal line.
 */
export function wheelScrollTop(index: number): number {
  const safe = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return safe * WHEEL_ITEM_HEIGHT;
}
