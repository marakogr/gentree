import { describe, expect, it } from "vitest";
import type { AncestorGraph, DescendantGraph } from "../../api/types";
import { combineLayouts } from "./combined";
import { layoutAncestors, layoutDescendants } from "./layout";

const ANCESTORS: AncestorGraph = {
  rootPersonId: "root",
  generations: 1,
  nodes: [
    {
      personId: "root",
      occurrenceKey: "0",
      generation: 0,
      role: "ROOT",
      adoptive: false,
      placeholder: false,
    },
    {
      personId: "father",
      occurrenceKey: "0.f",
      generation: 1,
      role: "FATHER",
      adoptive: false,
      placeholder: false,
    },
    {
      personId: "mother",
      occurrenceKey: "0.m",
      generation: 1,
      role: "MOTHER",
      adoptive: false,
      placeholder: false,
    },
  ],
  edges: [
    { parentKey: "0.f", childKey: "0", adoptive: false },
    { parentKey: "0.m", childKey: "0", adoptive: false },
  ],
  truncated: false,
  pedigreeCollapse: false,
};

const DESCENDANTS: DescendantGraph = {
  rootPersonId: "root",
  generations: 1,
  nodes: [
    {
      personId: "root",
      occurrenceKey: "0",
      generation: 0,
      role: "ROOT",
      adoptive: false,
    },
    {
      personId: "child",
      occurrenceKey: "0.c0",
      generation: 1,
      role: "SON",
      adoptive: false,
    },
  ],
  edges: [{ parentKey: "0", childKey: "0.c0", adoptive: false }],
  truncated: false,
  pedigreeCollapse: false,
};

function combined() {
  return combineLayouts(
    layoutAncestors(ANCESTORS, new Set(), { includePlaceholders: false }),
    layoutDescendants(DESCENDANTS),
  );
}

describe("combineLayouts", () => {
  it("keeps one root card with ancestors above and descendants below", () => {
    const layout = combined();
    const roots = layout.nodes.filter((node) => node.occurrenceKey === "0");
    expect(roots).toHaveLength(1);
    const root = roots[0];
    const father = layout.nodes.find((node) => node.occurrenceKey === "0.f");
    const child = layout.nodes.find((node) => node.occurrenceKey === "0.c0");
    expect(root).toBeDefined();
    expect(father?.y).toBeLessThan(root!.y);
    expect(child?.y).toBeGreaterThan(root!.y);
    expect(child!.x + child!.width / 2).toBeCloseTo(
      root!.x + root!.width / 2,
      5,
    );
  });

  it("draws parent edges from both halves", () => {
    const layout = combined();
    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.every((edge) => edge.path.startsWith("M "))).toBe(true);
    expect(
      layout.edges.some(
        (edge) => edge.fromKey === "0" && edge.toKey === "0.c0",
      ),
    ).toBe(true);
    expect(
      layout.edges.some(
        (edge) => edge.fromKey === "0.f" && edge.toKey === "0",
      ),
    ).toBe(true);
  });

  it("normalizes the merged bounds to the usual padding", () => {
    const layout = combined();
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(24);
      expect(node.y).toBeGreaterThanOrEqual(24);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe("combined spouse cards", () => {
  it("keeps one card when both halves decorate the same spouse", () => {
    const ancestor: AncestorGraph = {
      rootPersonId: "root",
      generations: 0,
      nodes: [
        {
          personId: "root",
          occurrenceKey: "0",
          generation: 0,
          role: "ROOT",
          adoptive: false,
          placeholder: false,
        },
        {
          personId: "wife",
          occurrenceKey: "spouse:0:wife",
          generation: 0,
          role: "MOTHER",
          adoptive: false,
          placeholder: false,
        },
      ],
      edges: [],
      truncated: false,
      pedigreeCollapse: false,
    };
    const descendant: DescendantGraph = {
      rootPersonId: "root",
      generations: 1,
      nodes: [
        {
          personId: "root",
          occurrenceKey: "0",
          generation: 0,
          role: "ROOT",
          adoptive: false,
        },
        {
          personId: "wife",
          occurrenceKey: "spouse:0:wife",
          generation: 0,
          role: "DAUGHTER",
          adoptive: false,
        },
        {
          personId: "child",
          occurrenceKey: "0.c0",
          generation: 1,
          role: "CHILD",
          adoptive: false,
        },
      ],
      edges: [{ parentKey: "0", childKey: "0.c0", adoptive: false }],
      truncated: false,
      pedigreeCollapse: false,
    };
    const ancestorLayout = layoutAncestors(ancestor, new Set(), {
      includePlaceholders: false,
      spouseOf: new Map([["spouse:0:wife", "0"]]),
      spousePairs: [["0", "spouse:0:wife"]],
    });
    const descendantLayout = layoutDescendants(descendant, {
      spouseOf: new Map([["spouse:0:wife", "0"]]),
      spousePairs: [["0", "spouse:0:wife"]],
    });
    const combined = combineLayouts(ancestorLayout, descendantLayout);
    expect(
      combined.nodes.filter((node) => node.personId === "wife"),
    ).toHaveLength(1);
    expect(
      combined.edges.filter((edge) => edge.kind === "spouse"),
    ).toHaveLength(1);
    expect(
      combined.nodes.filter((node) => node.personId === "child"),
    ).toHaveLength(1);
  });
});
