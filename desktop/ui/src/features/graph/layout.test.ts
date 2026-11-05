import { describe, expect, it } from "vitest";
import type {
  AncestorEdge,
  AncestorGraph,
  AncestorNode,
  DescendantEdge,
  DescendantGraph,
  DescendantNode,
} from "../../api/types";
import {
  H_GAP,
  MAX_LEVEL_NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  PADDING,
  SPOUSE_GAP,
  V_GAP,
  layoutAncestors,
  layoutDescendants,
  placeholderChildPersonId,
  spousePairKey,
  type LayoutNode,
} from "./layout";

function node(
  key: string,
  generation: number,
  personId: string | null,
  role: AncestorNode["role"],
  placeholder = false,
): AncestorNode {
  return {
    personId,
    occurrenceKey: key,
    generation,
    role,
    adoptive: false,
    placeholder,
  };
}

function edge(parentKey: string, childKey: string): AncestorEdge {
  return { parentKey, childKey, adoptive: false };
}

/** Root `me`, father `f`, mother `m`, grandparents on both sides. */
function familyGraph(): AncestorGraph {
  return {
    rootPersonId: "me",
    generations: 3,
    nodes: [
      node("0", 0, "me", "ROOT"),
      node("0.f", 1, "f", "FATHER"),
      node("0.m", 1, "m", "MOTHER"),
      node("0.f.f", 2, "gf1", "FATHER"),
      node("0.f.m", 2, "gm1", "MOTHER"),
      node("0.m.f", 2, null, "FATHER", true),
      node("0.m.m", 2, null, "MOTHER", true),
      node("0.f.f.f", 3, "ggf", "FATHER"),
      node("0.f.f.m", 3, null, "MOTHER", true),
      node("0.f.m.f", 3, null, "FATHER", true),
      node("0.f.m.m", 3, null, "MOTHER", true),
    ],
    edges: [
      edge("0.f", "0"),
      edge("0.m", "0"),
      edge("0.f.f", "0.f"),
      edge("0.f.m", "0.f"),
      edge("0.m.f", "0.m"),
      edge("0.m.m", "0.m"),
      edge("0.f.f.f", "0.f.f"),
      edge("0.f.f.m", "0.f.f"),
      edge("0.f.m.f", "0.f.m"),
      edge("0.f.m.m", "0.f.m"),
    ],
    truncated: false,
    pedigreeCollapse: false,
  };
}

/** Four ancestor levels where two branches are uneven (collision-prone). */
function unevenFourGenerationGraph(): AncestorGraph {
  return {
    rootPersonId: "me",
    generations: 4,
    nodes: [
      node("0", 0, "me", "ROOT"),
      node("0.f", 1, "f", "FATHER"),
      node("0.m", 1, "m", "MOTHER"),
      node("0.f.f", 2, "ff", "FATHER"),
      node("0.f.m", 2, "fm", "MOTHER"),
      node("0.m.f", 2, "mf", "FATHER"),
      node("0.m.m", 2, "mm", "MOTHER"),
      node("0.f.f.f", 3, "fff", "FATHER"),
      node("0.f.f.m", 3, "ffm", "MOTHER"),
      node("0.m.m.f", 3, "mmf", "FATHER"),
      node("0.m.m.m", 3, "mmm", "MOTHER"),
    ],
    edges: [
      edge("0.f", "0"),
      edge("0.m", "0"),
      edge("0.f.f", "0.f"),
      edge("0.f.m", "0.f"),
      edge("0.m.f", "0.m"),
      edge("0.m.m", "0.m"),
      edge("0.f.f.f", "0.f.f"),
      edge("0.f.f.m", "0.f.f"),
      edge("0.m.m.f", "0.m.m"),
      edge("0.m.m.m", "0.m.m"),
    ],
    truncated: true,
    pedigreeCollapse: false,
  };
}

/**
 * The screenshot case: two couples in one generation where the left couple has
 * no known parents. Both partners are unknown-parent cards, so centring used to
 * pull a card of the right couple between them.
 */
function splitCoupleGraph(): AncestorGraph {
  return {
    rootPersonId: "me",
    generations: 3,
    nodes: [
      node("0", 0, "me", "ROOT"),
      node("0.f", 1, "f", "FATHER"),
      node("0.m", 1, "m", "MOTHER"),
      node("0.f.f", 2, "ff", "FATHER"),
      node("0.f.m", 2, "fm", "MOTHER"),
      node("0.m.f", 2, "mf", "FATHER"),
      node("0.m.m", 2, "mm", "MOTHER"),
      node("0.m.f.f", 3, "mff", "FATHER"),
      node("0.m.f.m", 3, "mfm", "MOTHER"),
      node("0.m.m.f", 3, "mmf", "FATHER"),
      node("0.m.m.m", 3, "mmm", "MOTHER"),
    ],
    edges: [
      edge("0.f", "0"),
      edge("0.m", "0"),
      edge("0.f.f", "0.f"),
      edge("0.f.m", "0.f"),
      edge("0.m.f", "0.m"),
      edge("0.m.m", "0.m"),
      edge("0.m.f.f", "0.m.f"),
      edge("0.m.f.m", "0.m.f"),
      edge("0.m.m.f", "0.m.m"),
      edge("0.m.m.m", "0.m.m"),
    ],
    truncated: false,
    pedigreeCollapse: false,
  };
}

function splitCoupleSpouses(): Set<string> {
  return new Set([
    spousePairKey("f", "m"),
    spousePairKey("ff", "fm"),
    spousePairKey("mf", "mm"),
    spousePairKey("mff", "mfm"),
    spousePairKey("mmf", "mmm"),
  ]);
}

describe("layoutAncestors", () => {
  it("is deterministic for equal input", () => {
    const graph = familyGraph();
    const first = layoutAncestors(graph, new Set([spousePairKey("f", "m")]));
    const second = layoutAncestors(graph, new Set([spousePairKey("f", "m")]));
    expect(first).toEqual(second);
  });

  it("puts generations in order with the root at the bottom", () => {
    const layout = layoutAncestors(familyGraph());
    for (const shallow of layout.nodes) {
      for (const deep of layout.nodes) {
        if (shallow.generation < deep.generation) {
          expect(shallow.y).toBeGreaterThan(deep.y);
        }
      }
    }
    // The root is the lowest node of the layout.
    const root = layout.nodes.find((item) => item.occurrenceKey === "0");
    expect(root?.y).toBe(Math.max(...layout.nodes.map((item) => item.y)));
  });

  it("places every node, including placeholders", () => {
    const graph = familyGraph();
    const layout = layoutAncestors(graph);
    expect(layout.nodes).toHaveLength(graph.nodes.length);
    const keys = new Set(layout.nodes.map((item) => item.occurrenceKey));
    for (const item of graph.nodes) {
      expect(keys.has(item.occurrenceKey)).toBe(true);
    }

    const placeholders = layout.nodes.filter((item) => item.placeholder);
    expect(placeholders).toHaveLength(5);
    for (const item of placeholders) {
      expect(item.personId).toBeNull();
      expect(Number.isFinite(item.x)).toBe(true);
      expect(Number.isFinite(item.y)).toBe(true);
    }
  });

  it("drops placeholder nodes and their edges when asked", () => {
    const graph = familyGraph();
    const layout = layoutAncestors(graph, new Set([spousePairKey("f", "m")]), {
      includePlaceholders: false,
    });
    const placeholderKeys = new Set(
      graph.nodes
        .filter((item) => item.placeholder)
        .map((item) => item.occurrenceKey),
    );
    const keys = new Set(layout.nodes.map((item) => item.occurrenceKey));

    expect(layout.nodes).toHaveLength(graph.nodes.length - placeholderKeys.size);
    for (const key of placeholderKeys) {
      expect(keys.has(key)).toBe(false);
    }
    for (const key of ["0", "0.f", "0.m", "0.f.f", "0.f.m", "0.f.f.f"]) {
      expect(keys.has(key)).toBe(true);
    }

    expect(layout.edges.length).toBeGreaterThan(0);
    for (const item of layout.edges) {
      expect(keys.has(item.fromKey)).toBe(true);
      expect(keys.has(item.toKey)).toBe(true);
      expect(placeholderKeys.has(item.fromKey)).toBe(false);
      expect(placeholderKeys.has(item.toKey)).toBe(false);
    }

    for (const item of layout.nodes) {
      expect(item.placeholder).toBe(false);
      expect(Number.isFinite(item.x)).toBe(true);
      expect(item.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(item.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it("keeps placeholders when includePlaceholders is true", () => {
    const graph = familyGraph();
    const layout = layoutAncestors(graph, new Set(), {
      includePlaceholders: true,
    });
    expect(layout.nodes).toHaveLength(graph.nodes.length);
    expect(layout.nodes.filter((item) => item.placeholder)).toHaveLength(5);
    expect(layoutAncestors(graph)).toEqual(layout);
  });

  it("collapses a root with only unknown parents to a single node", () => {
    const graph: AncestorGraph = {
      rootPersonId: "me",
      generations: 1,
      nodes: [
        node("0", 0, "me", "ROOT"),
        node("0.f", 1, null, "FATHER", true),
        node("0.m", 1, null, "MOTHER", true),
      ],
      edges: [edge("0.f", "0"), edge("0.m", "0")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutAncestors(graph, new Set(), {
      includePlaceholders: false,
    });
    expect(layout.nodes.map((item) => item.occurrenceKey)).toEqual(["0"]);
    expect(layout.edges).toEqual([]);
    expect(layout.height).toBe(PADDING * 2 + NODE_HEIGHT);
    expect(layout.width).toBe(PADDING * 2 + NODE_WIDTH);
  });

  it("keeps the layout width bounded by the widest generation", () => {
    const layout = layoutAncestors(familyGraph());
    const bound = MAX_LEVEL_NODES * (NODE_WIDTH + H_GAP) + 2 * PADDING;
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.width).toBeLessThanOrEqual(bound);
    for (const item of layout.nodes) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(item.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it("keeps the two parents of a child as neighbours in their generation", () => {
    const layout = layoutAncestors(familyGraph());
    const father = layout.nodes.find((item) => item.occurrenceKey === "0.f");
    const mother = layout.nodes.find((item) => item.occurrenceKey === "0.m");
    expect(father && mother).toBeTruthy();
    if (!father || !mother) return;
    expect(father.y).toBe(mother.y);
    // No other node of the same generation sits between the couple.
    const between = layout.nodes.filter(
      (item) =>
        item.generation === father.generation &&
        item.occurrenceKey !== father.occurrenceKey &&
        item.occurrenceKey !== mother.occurrenceKey &&
        item.x > Math.min(father.x, mother.x) &&
        item.x < Math.max(father.x, mother.x),
    );
    expect(between).toHaveLength(0);
  });

  it("keeps a couple adjacent when one partner has no known parents", () => {
    // Couples in one generation: the left one has no known parents, the right
    // one does. Centring the childless couple by the next free slot used to let
    // a card of the other couple land between the partners, so the spouse line
    // ran across that card and the row read as one chain of three people.
    const layout = layoutAncestors(splitCoupleGraph(), splitCoupleSpouses());
    const ff = layout.nodes.find((item) => item.occurrenceKey === "0.f.f");
    const fm = layout.nodes.find((item) => item.occurrenceKey === "0.f.m");
    const mf = layout.nodes.find((item) => item.occurrenceKey === "0.m.f");
    expect(ff && fm && mf).toBeTruthy();
    if (!ff || !fm || !mf) return;

    // The father stays left, the mother right, and nobody sits between them.
    expect(ff.x).toBeLessThan(fm.x);
    const between = layout.nodes.filter(
      (item) =>
        item.generation === ff.generation &&
        item.occurrenceKey !== ff.occurrenceKey &&
        item.occurrenceKey !== fm.occurrenceKey &&
        item.x > ff.x &&
        item.x < fm.x + NODE_WIDTH,
    );
    expect(between).toHaveLength(0);

    // Partners are tighter than the gap between two couples, so pairs read as
    // pairs instead of one chain.
    expect(fm.x - (ff.x + NODE_WIDTH)).toBe(SPOUSE_GAP);
    expect(mf.x - (fm.x + NODE_WIDTH)).toBe(H_GAP);
  });

  it("routes every spouse line through empty space", () => {
    const layout = layoutAncestors(splitCoupleGraph(), splitCoupleSpouses());
    const spouse = layout.edges.filter((item) => item.kind === "spouse");
    expect(spouse.length).toBeGreaterThan(0);

    for (const edge of spouse) {
      const left = layout.nodes.find(
        (item) => item.occurrenceKey === edge.fromKey,
      );
      const right = layout.nodes.find(
        (item) => item.occurrenceKey === edge.toKey,
      );
      expect(left && right).toBeTruthy();
      if (!left || !right) continue;
      expect(left.y).toBe(right.y);
      expect(edge.path).toBe(
        `M ${left.x + NODE_WIDTH} ${left.y + NODE_HEIGHT / 2} H ${right.x}`,
      );

      // No third card may cover the line between the partners.
      const covered = layout.nodes.filter(
        (item) =>
          item.generation === left.generation &&
          item.occurrenceKey !== edge.fromKey &&
          item.occurrenceKey !== edge.toKey &&
          item.x < right.x &&
          item.x + NODE_WIDTH > left.x + NODE_WIDTH,
      );
      expect(covered).toHaveLength(0);
    }
  });

  it("never overlaps two nodes of one generation with four generations", () => {
    const layout = layoutAncestors(unevenFourGenerationGraph());
    const byGeneration = new Map<number, LayoutNode[]>();
    for (const item of layout.nodes) {
      const row = byGeneration.get(item.generation) ?? [];
      row.push(item);
      byGeneration.set(item.generation, row);
    }
    // Four ancestor levels above the root are all rendered.
    expect([...byGeneration.keys()].sort()).toEqual([0, 1, 2, 3]);

    for (const row of byGeneration.values()) {
      const ordered = [...row].sort((left, right) => left.x - right.x);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        expect(current.x).toBeGreaterThanOrEqual(
          previous.x + NODE_WIDTH + H_GAP,
        );
      }
    }

    // These two used to land on exactly the same x before the pass.
    const motherFather = layout.nodes.find(
      (item) => item.occurrenceKey === "0.m.f",
    );
    const motherMother = layout.nodes.find(
      (item) => item.occurrenceKey === "0.m.m",
    );
    expect(motherFather && motherMother).toBeTruthy();
    if (!motherFather || !motherMother) return;
    expect(motherMother.x - motherFather.x).toBeGreaterThanOrEqual(
      NODE_WIDTH + H_GAP,
    );

    // The widened row is still covered by the reported canvas size.
    expect(layout.width).toBeGreaterThan(0);
    for (const item of layout.nodes) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(item.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it("draws a spouse connector only for actual couples", () => {
    const graph = familyGraph();
    const couple = layoutAncestors(graph, new Set([spousePairKey("f", "m")]));
    const spouse = couple.edges.filter((item) => item.kind === "spouse");
    expect(spouse).toHaveLength(1);
    expect(new Set([spouse[0].fromKey, spouse[0].toKey])).toEqual(
      new Set(["0.f", "0.m"]),
    );

    const strangers = layoutAncestors(
      graph,
      new Set([spousePairKey("f", "gf1")]),
    );
    expect(
      strangers.edges.filter((item) => item.kind === "spouse"),
    ).toHaveLength(0);
  });

  it("keeps a person that appears twice as two occurrences", () => {
    const graph: AncestorGraph = {
      rootPersonId: "me",
      generations: 2,
      nodes: [
        node("0", 0, "me", "ROOT"),
        node("0.f", 1, "a", "FATHER"),
        node("0.m", 1, "b", "MOTHER"),
        node("0.f.f", 2, "shared", "FATHER"),
        node("0.f.m", 2, null, "MOTHER", true),
        node("0.m.f", 2, "shared", "FATHER"),
        node("0.m.m", 2, null, "MOTHER", true),
      ],
      edges: [
        edge("0.f", "0"),
        edge("0.m", "0"),
        edge("0.f.f", "0.f"),
        edge("0.f.m", "0.f"),
        edge("0.m.f", "0.m"),
        edge("0.m.m", "0.m"),
      ],
      truncated: false,
      pedigreeCollapse: true,
    };
    const layout = layoutAncestors(graph);
    const shared = layout.nodes.filter((item) => item.personId === "shared");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((item) => item.occurrenceKey)).size).toBe(2);
  });

  it("finds the child of a placeholder", () => {
    const graph = familyGraph();
    expect(placeholderChildPersonId(graph, "0.m.f")).toBe("m");
    expect(placeholderChildPersonId(graph, "missing")).toBeNull();
  });
});

function descendantNode(
  key: string,
  generation: number,
  personId: string,
  role: DescendantNode["role"],
): DescendantNode {
  return {
    personId,
    occurrenceKey: key,
    generation,
    role,
    adoptive: false,
  };
}

function descendantEdge(
  parentKey: string,
  childKey: string,
  adoptive = false,
): DescendantEdge {
  return { parentKey, childKey, adoptive };
}

/** Root `me`, a son, a daughter and the son's child. */
function descendantGraph(): DescendantGraph {
  return {
    rootPersonId: "me",
    generations: 2,
    nodes: [
      descendantNode("0", 0, "me", "ROOT"),
      descendantNode("0.c0", 1, "son", "SON"),
      descendantNode("0.c1", 1, "daughter", "DAUGHTER"),
      descendantNode("0.c0.c0", 2, "grandchild", "CHILD"),
    ],
    edges: [
      descendantEdge("0", "0.c0"),
      descendantEdge("0", "0.c1"),
      descendantEdge("0.c0", "0.c0.c0", true),
    ],
    truncated: false,
    pedigreeCollapse: false,
  };
}

describe("layoutDescendants", () => {
  it("leaves room inside the node for a three-line caption", () => {
    // Mirrors the caption box in styles.css: three 13px/1.25 name lines, the
    // 11px/1.25 meta line, the 2px grid gap, 8px padding above and below, and
    // the 1px border on each side. Otherwise a wrapped name would overlap the
    // next generation.
    const caption =
      3 * 13 * 1.25 + 11 * 1.25 + 2 + 2 * 8 + 2 * 1;
    expect(NODE_HEIGHT).toBeGreaterThanOrEqual(caption);
  });

  it("puts the root on top and grows downward by generation", () => {
    const layout = layoutDescendants(descendantGraph());
    const root = layout.nodes.find((item) => item.occurrenceKey === "0");
    expect(root?.y).toBe(PADDING);
    for (const item of layout.nodes) {
      for (const other of layout.nodes) {
        if (item.generation < other.generation) {
          expect(item.y).toBeLessThan(other.y);
        }
      }
    }
    expect(
      Math.max(...layout.nodes.map((item) => item.y)),
    ).toBe(PADDING + 2 * (NODE_HEIGHT + V_GAP));
  });

  it("places the parent above its children and spreads siblings apart", () => {
    const layout = layoutDescendants(descendantGraph());
    const root = layout.nodes.find((item) => item.occurrenceKey === "0");
    const son = layout.nodes.find((item) => item.occurrenceKey === "0.c0");
    const daughter = layout.nodes.find((item) => item.occurrenceKey === "0.c1");
    const grandchild = layout.nodes.find(
      (item) => item.occurrenceKey === "0.c0.c0",
    );
    expect(root && son && daughter && grandchild).toBeTruthy();
    if (!root || !son || !daughter || !grandchild) return;

    expect(root.y + NODE_HEIGHT).toBeLessThan(son.y);
    expect(son.y + NODE_HEIGHT).toBeLessThan(grandchild.y);
    expect(Math.abs(son.y - daughter.y)).toBe(0);
    expect(
      Math.abs(son.x - daughter.x),
    ).toBeGreaterThanOrEqual(NODE_WIDTH + H_GAP);
    // The root is centred over the span of its children.
    expect(root.x).toBeCloseTo((son.x + daughter.x) / 2, 1);
  });

  it("draws one edge per parent-child link and keeps adoption", () => {
    const graph = descendantGraph();
    const layout = layoutDescendants(graph);
    expect(layout.edges).toHaveLength(graph.edges.length);
    const kinds = layout.edges.map((item) => item.kind).sort();
    expect(kinds).toEqual(["adoptive", "parent", "parent"]);
    for (const item of layout.edges) {
      expect(item.path.startsWith("M ")).toBe(true);
      expect(item.fromKey).not.toBe(item.toKey);
    }
    expect(
      layout.edges.some(
        (item) =>
          item.fromKey === "0.c0" &&
          item.toKey === "0.c0.c0" &&
          item.kind === "adoptive",
      ),
    ).toBe(true);
  });

  it("covers every node with the reported canvas size", () => {
    const layout = layoutDescendants(descendantGraph());
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    for (const item of layout.nodes) {
      expect(item.x).toBeGreaterThanOrEqual(PADDING);
      expect(item.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(item.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
      expect(item.placeholder).toBe(false);
    }
  });

  it("keeps each sibling's children under that sibling", () => {
    // A childless son used to push his sister's card away and leave her child
    // under him, so two families looked like one shared set of children.
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 2,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantNode("0.c0", 1, "son", "SON"),
        descendantNode("0.c1", 1, "daughter", "DAUGHTER"),
        descendantNode("0.c1.c0", 2, "grandchild", "CHILD"),
      ],
      edges: [
        descendantEdge("0", "0.c0"),
        descendantEdge("0", "0.c1"),
        descendantEdge("0.c1", "0.c1.c0"),
      ],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph);
    const son = layout.nodes.find((item) => item.occurrenceKey === "0.c0");
    const daughter = layout.nodes.find(
      (item) => item.occurrenceKey === "0.c1",
    );
    const grandchild = layout.nodes.find(
      (item) => item.occurrenceKey === "0.c1.c0",
    );
    expect(son && daughter && grandchild).toBeTruthy();
    if (!son || !daughter || !grandchild) return;

    // The child sits directly below its own parent, not below the sibling.
    expect(grandchild.x).toBe(daughter.x);
    expect(grandchild.x).not.toBe(son.x);
    // The two subtrees stay in separate bands.
    expect(daughter.x).toBeGreaterThanOrEqual(son.x + NODE_WIDTH + H_GAP);
  });

  it("draws extra parent links without moving the placed card", () => {
    const graph = descendantGraph();
    const layout = layoutDescendants(graph, {
      extraEdges: [descendantEdge("0.c1", "0.c0.c0")],
    });
    expect(layout.edges).toHaveLength(graph.edges.length + 1);
    expect(
      layout.edges.some(
        (item) => item.fromKey === "0.c1" && item.toKey === "0.c0.c0",
      ),
    ).toBe(true);
  });

  it("is deterministic for equal input", () => {
    expect(layoutDescendants(descendantGraph())).toEqual(
      layoutDescendants(descendantGraph()),
    );
  });

  it("handles an empty graph", () => {
    const layout = layoutDescendants({
      rootPersonId: "me",
      generations: 0,
      nodes: [],
      edges: [],
      truncated: false,
      pedigreeCollapse: false,
    });
    expect(layout).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("collapses a root without children to a single card", () => {
    const layout = layoutDescendants({
      rootPersonId: "me",
      generations: 3,
      nodes: [descendantNode("0", 0, "me", "ROOT")],
      edges: [],
      truncated: false,
      pedigreeCollapse: false,
    });
    expect(layout.nodes.map((item) => item.occurrenceKey)).toEqual(["0"]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(PADDING * 2 + NODE_WIDTH);
    expect(layout.height).toBe(PADDING * 2 + NODE_HEIGHT);
    expect(layout.nodes[0].y).toBe(PADDING);
  });
});
