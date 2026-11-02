// Placement of the tour bubble next to a highlighted element, kept pure so the
// edge cases (no room on the right, short windows) are unit-tested.

export type Size = { width: number; height: number };
export type Point = { left: number; top: number; centered: boolean };
export type Box = { left: number; top: number; width: number; height: number };

export const BUBBLE_MARGIN = 16;
export const BUBBLE_GAP = 14;

/** Preferred bubble position; `auto` follows the target, `top-right` is fixed. */
export type Placement = "auto" | "top-right";

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Prefer the right of the target, then the left, then below, then above.
 * A missing target centers the bubble in the viewport.
 */
export function placeBubble(
  target: Box | null,
  bubble: Size,
  viewport: Size,
  placement: Placement = "auto",
): Point {
  const leftEdge = BUBBLE_MARGIN;
  const topEdge = BUBBLE_MARGIN;
  const rightEdge = viewport.width - bubble.width - BUBBLE_MARGIN;
  const bottomEdge = viewport.height - bubble.height - BUBBLE_MARGIN;

  if (placement === "top-right") {
    // A fixed corner keeps long page content (search results, lists) clear
    // while the step still spotlights its control elsewhere.
    return {
      left: Math.max(leftEdge, rightEdge),
      top: topEdge,
      centered: false,
    };
  }

  if (!target) {
    return {
      left: clamp((viewport.width - bubble.width) / 2, leftEdge, rightEdge),
      top: clamp((viewport.height - bubble.height) / 2, topEdge, bottomEdge),
      centered: true,
    };
  }

  const targetRight = target.left + target.width;
  const targetBottom = target.top + target.height;

  if (targetRight + BUBBLE_GAP + bubble.width <= viewport.width - BUBBLE_MARGIN) {
    return {
      left: targetRight + BUBBLE_GAP,
      top: clamp(target.top, topEdge, bottomEdge),
      centered: false,
    };
  }

  if (target.left - BUBBLE_GAP - bubble.width >= BUBBLE_MARGIN) {
    return {
      left: target.left - BUBBLE_GAP - bubble.width,
      top: clamp(target.top, topEdge, bottomEdge),
      centered: false,
    };
  }

  const centeredLeft = clamp(
    target.left + target.width / 2 - bubble.width / 2,
    leftEdge,
    rightEdge,
  );

  if (targetBottom + BUBBLE_GAP + bubble.height <= viewport.height - BUBBLE_MARGIN) {
    return { left: centeredLeft, top: targetBottom + BUBBLE_GAP, centered: false };
  }

  return {
    left: centeredLeft,
    top: clamp(target.top - BUBBLE_GAP - bubble.height, topEdge, bottomEdge),
    centered: false,
  };
}
