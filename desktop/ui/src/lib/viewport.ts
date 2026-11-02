// Pure pan/zoom maths shared by the relation and ancestor diagrams. The
// canvas is drawn in layout coordinates and moved by a CSS
// `translate(offset) scale(scale)` with `transform-origin: top left`.
// `offset` and `point` are viewport pixels; nothing here touches the DOM.

export type Point = { x: number; y: number };
export type ScaleBounds = { min: number; max: number };
export type View = { scale: number; offset: Point };

export function clampScale(value: number, bounds: ScaleBounds): number {
  if (Number.isNaN(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * Zooms by `factor` while keeping the layout point under `point` (viewport
 * pixels) fixed. The scale is clamped to `bounds`, and the offset follows the
 * clamped scale so the anchor stays put at the limits.
 */
export function zoomAtPoint(
  scale: number,
  offset: Point,
  point: Point,
  factor: number,
  bounds: ScaleBounds,
): View {
  const current = Number.isFinite(scale) && scale > 0 ? scale : bounds.min;
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const next = clampScale(current * safeFactor, bounds);
  if (next === current) {
    return { scale: current, offset };
  }
  // Content coordinate under the cursor before and after zooming.
  const contentX = (point.x - offset.x) / current;
  const contentY = (point.y - offset.y) / current;
  return {
    scale: next,
    offset: {
      x: point.x - contentX * next,
      y: point.y - contentY * next,
    },
  };
}

/**
 * Scale that shows the whole diagram inside the viewport with `padding` on
 * every side. Both dimensions are taken into account and the result never
 * exceeds 1, so a small diagram is not blown up. Degenerate sizes fall back
 * to 1.
 */
export function fitScale(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  padding: number,
): number {
  if (
    !(width > 0) ||
    !(height > 0) ||
    !(viewportWidth > 0) ||
    !(viewportHeight > 0)
  ) {
    return 1;
  }
  const gap = Number.isFinite(padding) && padding > 0 ? padding : 0;
  const availableWidth = Math.max(0, viewportWidth - gap * 2);
  const availableHeight = Math.max(0, viewportHeight - gap * 2);
  if (availableWidth === 0 || availableHeight === 0) {
    return 1;
  }
  const ratio = Math.min(availableWidth / width, availableHeight / height);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(1, ratio);
}

/**
 * Offset that centres a `scale`d diagram in the viewport. Never negative:
 * content wider than the viewport sticks to the top-left corner.
 */
export function centeredOffset(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): Point {
  return {
    x: Math.max(0, (viewportWidth - width * scale) / 2),
    y: Math.max(0, (viewportHeight - height * scale) / 2),
  };
}
