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
  LEVEL_COLUMN_WIDTH,
  MAX_LEVEL_NODES,
  NODE_CONTENT_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  PADDING,
  ROOT_NODE_WIDTH,
  SPOUSE_GAP,
  V_GAP,
  layoutAncestors,
  layoutDescendants,
  placeholderChildPersonId,
  spousePairKey,
  type GraphLayout,
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
      expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
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
    expect(layout.width).toBe(PADDING * 2 + ROOT_NODE_WIDTH);
  });

  it("keeps the layout width bounded by the widest generation", () => {
    const layout = layoutAncestors(familyGraph());
    const bound = MAX_LEVEL_NODES * (NODE_WIDTH + H_GAP) + 2 * PADDING;
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.width).toBeLessThanOrEqual(bound);
    for (const item of layout.nodes) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
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
      expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
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
    expect(root.x + root.width / 2).toBeCloseTo(
      (son.x + son.width / 2 + daughter.x + daughter.width / 2) / 2,
      1,
    );
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
      expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
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
    expect(layout.width).toBe(PADDING * 2 + ROOT_NODE_WIDTH);
    expect(layout.height).toBe(PADDING * 2 + NODE_HEIGHT);
    expect(layout.nodes[0].y).toBe(PADDING);
  });
});

describe("spouse slots", () => {
  function descendantSpouse(key: string, generation: number, personId: string) {
    return descendantNode(key, generation, personId, "CHILD");
  }

  function ancestorSpouse(key: string, generation: number, personId: string) {
    return {
      personId,
      occurrenceKey: key,
      generation,
      role: "MOTHER" as const,
      adoptive: false,
      placeholder: false,
    };
  }

  it("keeps a spouse on the anchor generation and next to it", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 0,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantSpouse("s:0:wife", 0, "wife"),
      ],
      edges: [],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph, {
      spouseOf: new Map([["s:0:wife", "0"]]),
      spousePairs: [["0", "s:0:wife"]],
    });
    const root = layout.nodes.find((node) => node.occurrenceKey === "0");
    const wife = layout.nodes.find((node) => node.occurrenceKey === "s:0:wife");
    expect(wife?.generation).toBe(root?.generation);
    expect(wife?.y).toBe(root?.y);
    expect(wife?.spouseOfKey).toBe("0");
    expect((wife?.x ?? 0) - (root?.x ?? 0)).toBe(
      (root?.width ?? 0) + SPOUSE_GAP,
    );
    const connector = layout.edges.find((edge) => edge.kind === "spouse");
    expect(connector).toBeDefined();
    expect(connector?.path).not.toContain("V");
  });

  it("does not change blood positions when a spouse is shown", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 1,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantNode("0.c0", 1, "son", "SON"),
        descendantNode("0.c1", 1, "daughter", "DAUGHTER"),
      ],
      edges: [descendantEdge("0", "0.c0"), descendantEdge("0", "0.c1")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const before = layoutDescendants(graph);
    const after = layoutDescendants(
      {
        ...graph,
        nodes: [...graph.nodes, descendantSpouse("s:1:wife", 1, "wife")],
      },
      {
        spouseOf: new Map([["s:1:wife", "0.c0"]]),
        spousePairs: [["0.c0", "s:1:wife"]],
      },
    );
    for (const node of before.nodes) {
      const moved = after.nodes.find(
        (item) => item.occurrenceKey === node.occurrenceKey,
      );
      expect(moved?.generation).toBe(node.generation);
      expect(moved?.y).toBe(node.y);
    }
  });

  it("keeps every spouse in a deterministic order without overlap", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 0,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantSpouse("s:0:first", 0, "first"),
        descendantSpouse("s:0:second", 0, "second"),
      ],
      edges: [],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph, {
      spouseOf: new Map([
        ["s:0:first", "0"],
        ["s:0:second", "0"],
      ]),
      spousePairs: [
        ["0", "s:0:first"],
        ["0", "s:0:second"],
      ],
    });
    const row = layout.nodes
      .filter((node) => node.generation === 0)
      .sort((left, right) => left.x - right.x);
    expect(row.map((node) => node.occurrenceKey)).toEqual([
      "0",
      "s:0:first",
      "s:0:second",
    ]);
    for (let index = 1; index < row.length; index += 1) {
      expect(row[index].x).toBeGreaterThanOrEqual(
        row[index - 1].x + NODE_WIDTH,
      );
    }
    expect(layoutDescendants(graph, {
      spouseOf: new Map([
        ["s:0:first", "0"],
        ["s:0:second", "0"],
      ]),
      spousePairs: [
        ["0", "s:0:first"],
        ["0", "s:0:second"],
      ],
    })).toEqual(layout);
  });

  it("keeps one child occurrence under a couple", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 1,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantSpouse("s:0:wife", 0, "wife"),
        descendantNode("0.c0", 1, "child", "CHILD"),
      ],
      edges: [descendantEdge("0", "0.c0")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph, {
      spouseOf: new Map([["s:0:wife", "0"]]),
      spousePairs: [["0", "s:0:wife"]],
    });
    expect(layout.nodes.filter((node) => node.personId === "child")).toHaveLength(1);
  });

  it("routes a married-cousin connector above the row, clear of cards", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 1,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantNode("0.c0", 1, "cousinA", "CHILD"),
        descendantNode("0.c1", 1, "cousinB", "CHILD"),
      ],
      edges: [descendantEdge("0", "0.c0"), descendantEdge("0", "0.c1")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph, {
      spousePairs: [["0.c0", "0.c1"]],
    });
    const connector = layout.edges.find((edge) => edge.kind === "spouse");
    expect(connector).toBeDefined();
    expect((connector?.path.match(/V/g) ?? []).length).toBe(2);
    const first = layout.nodes.find((node) => node.occurrenceKey === "0.c0");
    const second = layout.nodes.find((node) => node.occurrenceKey === "0.c1");
    const rowTop = Math.min(first?.y ?? 0, second?.y ?? 0);
    expect(connector?.path).toContain(`V ${rowTop - V_GAP / 2}`);
    expect(connector?.path).not.toContain(`H ${first?.x}`);
  });

  it("puts a root spouse in the ancestor root block", () => {
    const graph: AncestorGraph = {
      rootPersonId: "me",
      generations: 1,
      nodes: [
        {
          personId: "me",
          occurrenceKey: "0",
          generation: 0,
          role: "ROOT",
          adoptive: false,
          placeholder: false,
        },
        ancestorSpouse("s:0:wife", 0, "wife"),
        {
          personId: "father",
          occurrenceKey: "0.f",
          generation: 1,
          role: "FATHER",
          adoptive: false,
          placeholder: false,
        },
      ],
      edges: [edge("0.f", "0")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutAncestors(graph, new Set(), {
      includePlaceholders: false,
      spouseOf: new Map([["s:0:wife", "0"]]),
      spousePairs: [["0", "s:0:wife"]],
    });
    const root = layout.nodes.find((node) => node.occurrenceKey === "0");
    const wife = layout.nodes.find((node) => node.occurrenceKey === "s:0:wife");
    expect(wife?.y).toBe(root?.y);
    expect(wife?.spouseOfKey).toBe("0");
    expect((wife?.x ?? 0) - (root?.x ?? 0)).toBe(
      (root?.width ?? 0) + SPOUSE_GAP,
    );
    expect(layout.edges.some((item) => item.kind === "spouse")).toBe(true);
  });

  it("puts a grandparent's second spouse on the grandparent row", () => {
    const graph: AncestorGraph = {
      rootPersonId: "me",
      generations: 2,
      nodes: [
        {
          personId: "me",
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
          personId: "grandpa",
          occurrenceKey: "0.f.f",
          generation: 2,
          role: "FATHER",
          adoptive: false,
          placeholder: false,
        },
        ancestorSpouse("s:0.f.f:second", 2, "secondWife"),
      ],
      edges: [edge("0.f", "0"), edge("0.f.f", "0.f")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutAncestors(graph, new Set(), {
      includePlaceholders: false,
      spouseOf: new Map([["s:0.f.f:second", "0.f.f"]]),
      spousePairs: [["0.f.f", "s:0.f.f:second"]],
    });
    const grandpa = layout.nodes.find((node) => node.occurrenceKey === "0.f.f");
    const spouse = layout.nodes.find(
      (node) => node.occurrenceKey === "s:0.f.f:second",
    );
    expect(spouse?.y).toBe(grandpa?.y);
    expect(spouse?.x).toBe(
      (grandpa?.x ?? 0) + (grandpa?.width ?? NODE_WIDTH) + SPOUSE_GAP,
    );
  });
});

/**
 * #103: the root card also renders a depth-control column on each side of its
 * caption. Those columns used to take half of the caption box, so a long full
 * name was clipped while every other card wrapped onto three lines. The root
 * card is now wider by exactly that footprint, so the name box is identical
 * everywhere and the root keeps its own controls.
 */
describe("root card caption width", () => {
  /** The box a clamped name gets: the card minus its depth-control columns. */
  function captionWidth(node: LayoutNode, rootPersonId: string): number {
    const columns =
      rootPersonId !== "" && node.personId === rootPersonId
        ? 2 * (LEVEL_COLUMN_WIDTH + NODE_CONTENT_GAP)
        : 0;
    return node.width - columns;
  }

  function byKey(layout: GraphLayout, key: string): LayoutNode {
    const found = layout.nodes.find((node) => node.occurrenceKey === key);
    if (!found) throw new Error(`missing node ${key}`);
    return found;
  }

  it("gives the ancestor root the same name box as every other card", () => {
    const layout = layoutAncestors(familyGraph());
    const root = byKey(layout, "0");
    const father = byKey(layout, "0.f");
    expect(root.width).toBe(ROOT_NODE_WIDTH);
    expect(father.width).toBe(NODE_WIDTH);
    // The wider card pays for its two control columns, nothing else.
    expect(captionWidth(root, "me")).toBe(NODE_WIDTH);
    expect(captionWidth(root, "me")).toBe(captionWidth(father, "me"));
  });

  it("gives the descendant root the same name box as its children", () => {
    const layout = layoutDescendants(descendantGraph());
    const root = byKey(layout, "0");
    expect(root.width).toBe(ROOT_NODE_WIDTH);
    for (const key of ["0.c0", "0.c1", "0.c0.c0"]) {
      const card = byKey(layout, key);
      expect(card.width).toBe(NODE_WIDTH);
      expect(captionWidth(card, "me")).toBe(captionWidth(root, "me"));
    }
  });

  it("keeps the wider root clear of neighbours and the canvas edge", () => {
    const ancestors = layoutAncestors(
      familyGraph(),
      new Set([spousePairKey("f", "m")]),
    );
    const root = byKey(ancestors, "0");
    expect(root.x + root.width).toBeLessThanOrEqual(ancestors.width);

    const descendants = layoutDescendants(descendantGraph());
    const descendantRoot = byKey(descendants, "0");
    const son = byKey(descendants, "0.c0");
    // The next generation still starts one V_GAP below the card.
    expect(son.y - (descendantRoot.y + descendantRoot.height)).toBe(V_GAP);

    for (const layout of [ancestors, descendants]) {
      const rows = new Map<number, LayoutNode[]>();
      for (const card of layout.nodes) {
        const row = rows.get(card.generation) ?? [];
        row.push(card);
        rows.set(card.generation, row);
      }
      for (const row of rows.values()) {
        const ordered = [...row].sort((left, right) => left.x - right.x);
        for (let index = 1; index < ordered.length; index += 1) {
          const previous = ordered[index - 1];
          expect(ordered[index].x).toBeGreaterThanOrEqual(
            previous.x + previous.width,
          );
        }
      }
      for (const card of layout.nodes) {
        expect(card.x + card.width).toBeLessThanOrEqual(layout.width);
      }
    }
  });

  it("places a root spouse after the wider card", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 0,
      nodes: [
        descendantNode("0", 0, "me", "ROOT"),
        descendantNode("s:0:wife", 0, "wife", "CHILD"),
      ],
      edges: [],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph, {
      spouseOf: new Map([["s:0:wife", "0"]]),
      spousePairs: [["0", "s:0:wife"]],
    });
    const root = byKey(layout, "0");
    const wife = byKey(layout, "s:0:wife");
    expect(root.width).toBe(ROOT_NODE_WIDTH);
    expect(wife.width).toBe(NODE_WIDTH);
    expect(wife.x - (root.x + root.width)).toBe(SPOUSE_GAP);
    expect(wife.x + wife.width).toBeLessThanOrEqual(layout.width);
  });

  it("finds the root in a person-id keyed tree (relatives mode)", () => {
    const graph: DescendantGraph = {
      rootPersonId: "me",
      generations: 1,
      nodes: [
        descendantNode("me", 0, "me", "ROOT"),
        descendantNode("son", 1, "son", "SON"),
        descendantNode("cousin", 1, "cousin", "CHILD"),
      ],
      edges: [descendantEdge("me", "son"), descendantEdge("me", "cousin")],
      truncated: false,
      pedigreeCollapse: false,
    };
    const layout = layoutDescendants(graph);
    const root = byKey(layout, "me");
    const son = byKey(layout, "son");
    const cousin = byKey(layout, "cousin");
    expect(root.width).toBe(ROOT_NODE_WIDTH);
    expect(son.width).toBe(NODE_WIDTH);
    expect(captionWidth(root, "me")).toBe(captionWidth(son, "me"));
    expect(cousin.x - (son.x + son.width)).toBe(H_GAP);
  });

  it("keeps a rootless forest at the base width", () => {
    const graph: DescendantGraph = {
      rootPersonId: "",
      generations: 1,
      nodes: [
        descendantNode("a", 0, "a", "ROOT"),
        descendantNode("b", 1, "b", "CHILD"),
      ],
      edges: [descendantEdge("a", "b")],
      truncated: false,
      pedigreeCollapse: false,
    };
    for (const card of layoutDescendants(graph).nodes) {
      expect(card.width).toBe(NODE_WIDTH);
    }
    // An explicit empty root also keeps a graph that names a root uniform.
    for (const card of layoutDescendants(descendantGraph(), { rootPersonId: "" })
      .nodes) {
      expect(card.width).toBe(NODE_WIDTH);
    }
    for (const card of layoutAncestors(familyGraph(), new Set(), {
      rootPersonId: "",
    }).nodes) {
      expect(card.width).toBe(NODE_WIDTH);
    }
  });
});
