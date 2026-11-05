// Pure horizontal path layout: no React, no IPC, no DOM.
// A sits at the left, B at the right, and the direction of every edge shifts
// the row, so a path through a common ancestor peaks above the A–B line while
// a spouse chain stays on one row (ADR-0011 §path layout). Equal input always
// yields equal coordinates.

import type { EdgeDirection, PathStep } from "../../api/types";

export const NODE_WIDTH = 168;
/** Same three-line caption box as the tree node (see `graph/layout.ts`). */
export const NODE_HEIGHT = 84;
export const H_GAP = 56;
export const V_GAP = 48;
export const PADDING = 24;

export type PathLayoutNode = {
  index: number;
  personId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PathLayoutEdge = {
  fromIndex: number;
  toIndex: number;
  direction: EdgeDirection;
  /** SVG path in layout coordinates. */
  path: string;
};

export type PathLayout = {
  nodes: PathLayoutNode[];
  edges: PathLayoutEdge[];
  width: number;
  height: number;
  /** Index of `commonAncestorId` on the path, or `null` when there is none. */
  commonAncestorIndex: number | null;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ---- Diagram viewport: pan and zoom -------------------------------------
   Shared with the ancestor tree: the pure maths lives in `lib/viewport`, the
   relation diagram only adds its own scale limits and re-exports the helpers
   so existing imports and tests keep working. */

import {
  centeredOffset as sharedCenteredOffset,
  clampScale as sharedClampScale,
  fitScale as sharedFitScale,
  zoomAtPoint as sharedZoomAtPoint,
} from "../../lib/viewport";
import type {
  Point as PathPoint,
  ScaleBounds,
  View as PathView,
} from "../../lib/viewport";

/** Zoom limits for the relation diagram (0.4–2.5). */
export const SCALE_BOUNDS = { min: 0.4, max: 2.5 } as const;
/** One step of the +/- buttons and of a wheel notch. */
export const ZOOM_STEP = 1.15;
/** Gap between the fitted diagram and the viewport edges, in pixels. */
export const FIT_PADDING = 16;

export function clampScale(
  value: number,
  bounds: ScaleBounds = SCALE_BOUNDS,
): number {
  return sharedClampScale(value, bounds);
}

export function zoomAtPoint(
  scale: number,
  offset: PathPoint,
  point: PathPoint,
  factor: number,
  bounds: ScaleBounds = SCALE_BOUNDS,
): PathView {
  return sharedZoomAtPoint(scale, offset, point, factor, bounds);
}

export function fitScale(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  padding: number = FIT_PADDING,
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
  // Preserve the relation diagram's old contract: a viewport that leaves no
  // room after padding sits at the minimum rather than at 100%.
  if (
    Math.max(0, viewportWidth - gap * 2) === 0 ||
    Math.max(0, viewportHeight - gap * 2) === 0
  ) {
    return SCALE_BOUNDS.min;
  }
  return sharedFitScale(width, height, viewportWidth, viewportHeight, gap);
}

export function centeredOffset(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): PathPoint {
  return sharedCenteredOffset(
    width,
    height,
    viewportWidth,
    viewportHeight,
    scale,
  );
}

export type { PathPoint, ScaleBounds, PathView };

function depthDelta(direction: EdgeDirection): number {
  if (direction === "UP") return -1;
  if (direction === "DOWN") return 1;
  return 0;
}

export function layoutPath(
  path: readonly PathStep[],
  commonAncestorId: string | null = null,
): PathLayout {
  if (path.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      commonAncestorIndex: null,
    };
  }

  // Depth relative to A: parents are above, children below, spouses stay level.
  const depths: number[] = [0];
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const direction = previous.edgeToNext ?? "SPOUSE";
    depths.push(depths[index - 1] + depthDelta(direction));
  }
  const top = Math.min(...depths);

  const nodes: PathLayoutNode[] = path.map((step, index) => ({
    index,
    personId: step.personId,
    x: round(PADDING + index * (NODE_WIDTH + H_GAP)),
    y: round(PADDING + (depths[index] - top) * (NODE_HEIGHT + V_GAP)),
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));

  const edges: PathLayoutEdge[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    const direction = path[index].edgeToNext ?? "SPOUSE";
    const startX = from.x + NODE_WIDTH;
    const startY = from.y + NODE_HEIGHT / 2;
    const endX = to.x;
    const endY = to.y + NODE_HEIGHT / 2;
    const middleX = (startX + endX) / 2;
    edges.push({
      fromIndex: index,
      toIndex: index + 1,
      direction,
      path: [
        `M ${round(startX)} ${round(startY)}`,
        `H ${round(middleX)}`,
        `V ${round(endY)}`,
        `H ${round(endX)}`,
      ].join(" "),
    });
  }

  const right = Math.max(...nodes.map((node) => node.x + NODE_WIDTH));
  const bottom = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT));
  const commonAncestorIndex =
    commonAncestorId === null
      ? null
      : (() => {
          const found = path.findIndex((step) => step.personId === commonAncestorId);
          return found >= 0 ? found : null;
        })();

  return {
    nodes,
    edges,
    width: round(right + PADDING),
    height: round(bottom + PADDING),
    commonAncestorIndex,
  };
}
