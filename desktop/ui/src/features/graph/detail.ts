// Far-zoom detail policy for the graph canvas: which parts of a card are worth
// painting at a given scale. Pure values and functions only, no React, no DOM.

/**
 * Absolute scale below which node captions stop being legible. There the canvas
 * paints avatars only, so a distant tree reads as a deliberately schematic,
 * crisp diagram instead of a field of smeared text. Measured in whole percents.
 */
export const GRAPH_LABEL_MIN_SCALE = 0.7;

/**
 * Scale in whole percents, the unit the zoom badge reports. Non-finite input
 * falls back to 100 so callers keep the normal, detailed view.
 */
export function scalePercent(scale: number): number {
  return Number.isFinite(scale) ? Math.round(scale * 100) : 100;
}

/**
 * True while captions are worth painting at `scale`. The comparison runs in
 * whole percents, so float noise just under the threshold (0.6999999) still
 * counts as 70% and the canvas never flickers between the two views.
 */
export function showsNodeLabels(scale: number): boolean {
  return scalePercent(scale) >= scalePercent(GRAPH_LABEL_MIN_SCALE);
}
