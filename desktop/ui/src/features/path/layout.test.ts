import { describe, expect, it } from "vitest";
import type { PathStep } from "../../api/types";
import {
  FIT_PADDING,
  H_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  PADDING,
  SCALE_BOUNDS,
  V_GAP,
  centeredOffset,
  clampScale,
  fitScale,
  layoutPath,
  zoomAtPoint,
} from "./layout";

/** A → father (UP) → grandfather (UP) → uncle (DOWN) → B. */
function ancestorPath(): PathStep[] {
  return [
    { personId: "a", edgeToNext: "UP" },
    { personId: "f", edgeToNext: "UP" },
    { personId: "gf", edgeToNext: "DOWN" },
    { personId: "u", edgeToNext: "DOWN" },
    { personId: "b", edgeToNext: null },
  ];
}

function spouseChain(): PathStep[] {
  return [
    { personId: "a", edgeToNext: "SPOUSE" },
    { personId: "s1", edgeToNext: "SPOUSE" },
    { personId: "s2", edgeToNext: null },
  ];
}

describe("layoutPath", () => {
  it("is deterministic for equal input", () => {
    expect(layoutPath(ancestorPath(), "gf")).toEqual(
      layoutPath(ancestorPath(), "gf"),
    );
    expect(layoutPath([], null)).toEqual(layoutPath([], null));
  });

  it("puts A left, B right and the common ancestor above", () => {
    const layout = layoutPath(ancestorPath(), "gf");
    expect(layout.nodes.map((node) => node.personId)).toEqual([
      "a",
      "f",
      "gf",
      "u",
      "b",
    ]);
    expect(layout.nodes[0].x).toBe(PADDING);
    expect(layout.nodes[0].y).toBe(
      PADDING + 2 * (NODE_HEIGHT + V_GAP),
    );
    expect(layout.nodes[2].y).toBe(PADDING);
    expect(layout.nodes[4].y).toBe(layout.nodes[0].y);
    expect(layout.nodes[0].x).toBeLessThan(layout.nodes[4].x);
    expect(layout.commonAncestorIndex).toBe(2);
    expect(layout.edges).toHaveLength(4);
    expect(layout.width).toBe(PADDING * 2 + 5 * NODE_WIDTH + 4 * H_GAP);
  });

  it("keeps a spouse chain on one row when there is no common ancestor", () => {
    const layout = layoutPath(spouseChain());
    const ys = new Set(layout.nodes.map((node) => node.y));
    expect(ys).toEqual(new Set([PADDING]));
    expect(layout.commonAncestorIndex).toBeNull();
    expect(layout.nodes.map((node) => node.x)).toEqual([
      PADDING,
      PADDING + NODE_WIDTH + H_GAP,
      PADDING + 2 * (NODE_WIDTH + H_GAP),
    ]);
    expect(layout.edges.every((edge) => edge.direction === "SPOUSE")).toBe(true);
  });

  it("moves down for a descendant path and reports no ancestor", () => {
    const layout = layoutPath([
      { personId: "a", edgeToNext: "DOWN" },
      { personId: "c", edgeToNext: null },
    ]);
    expect(layout.nodes[1].y).toBe(PADDING + NODE_HEIGHT + V_GAP);
    expect(layout.commonAncestorIndex).toBeNull();
  });

  it("returns an empty layout for an empty path", () => {
    expect(layoutPath([])).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      commonAncestorIndex: null,
    });
  });
});

describe("clampScale", () => {
  it("keeps values inside the 0.4–2.5 range", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.1)).toBe(SCALE_BOUNDS.min);
    expect(clampScale(10)).toBe(SCALE_BOUNDS.max);
    expect(SCALE_BOUNDS).toEqual({ min: 0.4, max: 2.5 });
  });

  it("uses custom bounds when given", () => {
    const bounds = { min: 0.5, max: 4 };
    expect(clampScale(0.2, bounds)).toBe(0.5);
    expect(clampScale(9, bounds)).toBe(4);
  });

  it("falls back to the minimum for NaN", () => {
    expect(clampScale(Number.NaN)).toBe(SCALE_BOUNDS.min);
  });
});

describe("zoomAtPoint", () => {
  it("keeps the layout point under the cursor fixed", () => {
    const offset = { x: -40, y: 12 };
    const point = { x: 200, y: 120 };
    const scale = 0.8;
    const factor = 1.15;
    const view = zoomAtPoint(scale, offset, point, factor);

    expect(view.scale).toBeCloseTo(scale * factor, 10);
    const before = {
      x: (point.x - offset.x) / scale,
      y: (point.y - offset.y) / scale,
    };
    const after = {
      x: (point.x - view.offset.x) / view.scale,
      y: (point.y - view.offset.y) / view.scale,
    };
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it("anchors the origin when the offset is zero", () => {
    const view = zoomAtPoint(1, { x: 0, y: 0 }, { x: 100, y: 50 }, 2);
    expect(view.scale).toBe(2);
    expect(view.offset).toEqual({ x: -100, y: -50 });
  });

  it("clamps at the maximum but still keeps the anchor", () => {
    const view = zoomAtPoint(2.4, { x: 0, y: 0 }, { x: 120, y: 80 }, 10);
    expect(view.scale).toBe(SCALE_BOUNDS.max);
    // The content point under the cursor stays at 120/2.4 = 50 px.
    expect((120 - view.offset.x) / view.scale).toBeCloseTo(50, 8);
    expect((80 - view.offset.y) / view.scale).toBeCloseTo(80 / 2.4, 8);
  });

  it("clamps at the minimum", () => {
    const view = zoomAtPoint(0.45, { x: 4, y: -4 }, { x: 10, y: 10 }, 0.1);
    expect(view.scale).toBe(SCALE_BOUNDS.min);
    expect((10 - view.offset.x) / view.scale).toBeCloseTo(
      (10 - 4) / 0.45,
      8,
    );
  });

  it("is a no-op for a factor of one", () => {
    const offset = { x: 7, y: 9 };
    const view = zoomAtPoint(1.3, offset, { x: 40, y: 40 }, 1);
    expect(view.scale).toBe(1.3);
    expect(view.offset).toBe(offset);
  });

  it("ignores a broken factor instead of producing NaN", () => {
    const view = zoomAtPoint(1, { x: 0, y: 0 }, { x: 10, y: 10 }, Number.NaN);
    expect(view.scale).toBe(1);
    expect(view.offset).toEqual({ x: 0, y: 0 });
  });
});

describe("fitScale", () => {
  it("is limited by width", () => {
    expect(fitScale(2000, 300, 800, 600, 16)).toBeCloseTo(768 / 2000, 10);
  });

  it("is limited by height", () => {
    expect(fitScale(400, 2000, 800, 600, 16)).toBeCloseTo(568 / 2000, 10);
  });

  it("never grows beyond 100%", () => {
    expect(fitScale(100, 100, 1200, 800, 16)).toBe(1);
    expect(fitScale(400, 300, 5000, 5000, 16)).toBe(1);
  });

  it("accounts for padding on both sides", () => {
    const padded = fitScale(800, 400, 800, 600, 16);
    expect(padded).toBeLessThan(1);
    expect(fitScale(800, 400, 800, 600, 0)).toBeCloseTo(1, 10);
    expect(FIT_PADDING).toBeGreaterThan(0);
  });

  it("falls back to 100% for degenerate sizes", () => {
    expect(fitScale(0, 0, 800, 600, 16)).toBe(1);
    expect(fitScale(800, 400, 0, 0, 16)).toBe(1);
    expect(fitScale(800, 400, 20, 20, 16)).toBe(SCALE_BOUNDS.min);
  });
});

describe("centeredOffset", () => {
  it("centres a smaller diagram", () => {
    expect(centeredOffset(400, 200, 800, 600, 1)).toEqual({ x: 200, y: 200 });
  });

  it("never goes negative for oversized content", () => {
    expect(centeredOffset(2000, 1200, 800, 600, 1)).toEqual({ x: 0, y: 0 });
  });
});
