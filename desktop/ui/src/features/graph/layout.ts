// Pure graph layouts: no React, no IPC, no DOM. Ancestor generations are
// stacked vertically with the root at the bottom; descendant generations grow
// downward with the root at the top. Equal input always yields equal positions
// (ADR-0011 §layout). An ancestor couple is laid out as one block, so the two
// partners are always neighbours and their spouse line never spans a card.

import type {
  AncestorGraph,
  AncestorNode,
  DescendantGraph,
  DescendantNode,
} from "../../api/types";

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 64;
export const H_GAP = 28;
/** Partners sit closer together than unrelated cards, so a couple reads as one. */
export const SPOUSE_GAP = 16;
export const V_GAP = 72;
export const PADDING = 24;
/** Widest generation in a 3-generation ancestor graph is 8 nodes. */
export const MAX_LEVEL_NODES = 8;

export type LayoutNode = {
  occurrenceKey: string;
  personId: string | null;
  generation: number;
  role: AncestorNode["role"] | DescendantNode["role"];
  adoptive: boolean;
  placeholder: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutEdgeKind = "parent" | "adoptive" | "spouse";

export type LayoutEdge = {
  kind: LayoutEdgeKind;
  fromKey: string;
  toKey: string;
  /** SVG path in layout coordinates. */
  path: string;
};

export type GraphLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
};

export type LayoutOptions = {
  /**
   * Keep dashed "unknown parent" nodes (default). When `false` placeholders are
   * dropped before coordinates are computed and edges with a filtered endpoint
   * disappear with them.
   */
  includePlaceholders?: boolean;
};

/** Order-independent key for a spouse/partner couple. */
export function spousePairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function layoutAncestors(
  graph: AncestorGraph,
  spousePairs: ReadonlySet<string> = new Set(),
  options: LayoutOptions = {},
): GraphLayout {
  const includePlaceholders = options.includePlaceholders ?? true;
  const sourceNodes = includePlaceholders
    ? graph.nodes
    : graph.nodes.filter((node) => !node.placeholder);
  const sourceKeys = new Set(sourceNodes.map((node) => node.occurrenceKey));
  const sourceEdges = includePlaceholders
    ? graph.edges
    : graph.edges.filter(
        (edge) =>
          sourceKeys.has(edge.parentKey) && sourceKeys.has(edge.childKey),
      );

  const nodesByKey = new Map(
    sourceNodes.map((node) => [node.occurrenceKey, node]),
  );
  const parentsOf = new Map<string, string[]>();
  for (const edge of sourceEdges) {
    const keys = parentsOf.get(edge.childKey) ?? [];
    keys.push(edge.parentKey);
    parentsOf.set(edge.childKey, keys);
  }

  const root = sourceNodes.find((node) => node.occurrenceKey === "0");
  if (!root) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  // Tree order, level by level: the parents of a child are pushed together.
  const levels: AncestorNode[][] = [];
  const seen = new Set<string>([root.occurrenceKey]);
  let frontier: AncestorNode[] = [root];
  while (frontier.length > 0) {
    levels.push(frontier);
    const next: AncestorNode[] = [];
    for (const node of frontier) {
      for (const key of parentsOf.get(node.occurrenceKey) ?? []) {
        const parent = nodesByKey.get(key);
        if (parent && !seen.has(key)) {
          seen.add(key);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  // Nodes unreachable from the root (defensive) still get a slot.
  for (const node of sourceNodes) {
    if (seen.has(node.occurrenceKey)) continue;
    while (levels.length <= node.generation) levels.push([]);
    levels[node.generation].push(node);
  }

  // A couple is one block, so the partners are always neighbours: a spouse line
  // can never run behind a third card and two couples can never chain into one
  // row of "who is married to whom". Only co-parents that are also a
  // SPOUSE/PARTNER pair form a block; every other card stands alone.
  const partnerOf = new Map<string, string>();
  for (const parentKeys of parentsOf.values()) {
    if (parentKeys.length < 2) continue;
    const [firstKey, secondKey] = parentKeys;
    const first = nodesByKey.get(firstKey);
    const second = nodesByKey.get(secondKey);
    if (!first?.personId || !second?.personId) continue;
    if (!spousePairs.has(spousePairKey(first.personId, second.personId))) {
      continue;
    }
    if (partnerOf.has(firstKey) || partnerOf.has(secondKey)) continue;
    partnerOf.set(firstKey, secondKey);
    partnerOf.set(secondKey, firstKey);
  }

  type Block = { keys: string[]; width: number; x: number };
  const blockWidth = (keys: string[]): number =>
    keys.length < 2 ? NODE_WIDTH : NODE_WIDTH * 2 + SPOUSE_GAP;

  // Blocks keep the tree order of the level: parents of one child stay
  // together, and the father slot stays left of the mother slot.
  const blocksByLevel: Block[][] = levels.map((level) => {
    const positionOf = new Map(
      level.map((node, index) => [node.occurrenceKey, index]),
    );
    const used = new Set<string>();
    const blocks: Block[] = [];
    for (const node of level) {
      const key = node.occurrenceKey;
      if (used.has(key)) continue;
      const partner = partnerOf.get(key);
      const keys =
        partner !== undefined && positionOf.has(partner) && !used.has(partner)
          ? [key, partner].sort(
              (left, right) =>
                (positionOf.get(left) ?? 0) - (positionOf.get(right) ?? 0),
            )
          : [key];
      for (const member of keys) used.add(member);
      blocks.push({ keys, width: blockWidth(keys), x: 0 });
    }
    return blocks;
  });
  const blockOfKey = new Map<string, Block>();
  for (const blocks of blocksByLevel) {
    for (const block of blocks) {
      for (const key of block.keys) blockOfKey.set(key, block);
    }
  }

  // Deepest generation first, left to right; then each block is centred over
  // the blocks of its parents and pushed clear of its left neighbour. Order is
  // tree order, never the provisional x, so a partner is never swapped past a
  // stranger by centring.
  const deepest = levels.length - 1;
  let cursor = 0;
  for (const block of blocksByLevel[deepest] ?? []) {
    block.x = cursor;
    cursor += block.width + H_GAP;
  }
  for (let level = deepest - 1; level >= 0; level -= 1) {
    let previousRight: number | null = null;
    for (const block of blocksByLevel[level] ?? []) {
      const parentCentres: number[] = [];
      for (const key of block.keys) {
        for (const parentKey of parentsOf.get(key) ?? []) {
          const parent = blockOfKey.get(parentKey);
          if (parent) parentCentres.push(parent.x + parent.width / 2);
        }
      }
      const desired =
        parentCentres.length > 0
          ? (Math.min(...parentCentres) + Math.max(...parentCentres)) / 2 -
            block.width / 2
          : (previousRight ?? 0);
      block.x =
        previousRight === null
          ? desired
          : Math.max(desired, previousRight + H_GAP);
      previousRight = block.x + block.width;
    }
  }

  const blockXs = blocksByLevel.flat().map((block) => block.x);
  const shift = PADDING - Math.min(...blockXs);
  const nodes: LayoutNode[] = sourceNodes.map((node) => {
    const block = blockOfKey.get(node.occurrenceKey);
    const slot = block ? block.keys.indexOf(node.occurrenceKey) : 0;
    return {
      occurrenceKey: node.occurrenceKey,
      personId: node.personId,
      generation: node.generation,
      role: node.role,
      adoptive: node.adoptive,
      placeholder: node.placeholder,
      x: round(
        (block?.x ?? 0) + shift + slot * (NODE_WIDTH + SPOUSE_GAP),
      ),
      y: round(PADDING + (deepest - node.generation) * (NODE_HEIGHT + V_GAP)),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const right = Math.max(
    ...nodes.map((node) => node.x + NODE_WIDTH),
    PADDING,
  );
  const width = round(right + PADDING);
  const height = round(
    PADDING * 2 + (deepest + 1) * NODE_HEIGHT + deepest * V_GAP,
  );

  const positioned = new Map(nodes.map((node) => [node.occurrenceKey, node]));

  const edges: LayoutEdge[] = [];
  for (const edge of sourceEdges) {
    const parent = positioned.get(edge.parentKey);
    const child = positioned.get(edge.childKey);
    if (!parent || !child) continue;
    const startX = parent.x + NODE_WIDTH / 2;
    const startY = parent.y + NODE_HEIGHT;
    const endX = child.x + NODE_WIDTH / 2;
    const endY = child.y;
    const middleY = (startY + endY) / 2;
    edges.push({
      kind: edge.adoptive ? "adoptive" : "parent",
      fromKey: edge.parentKey,
      toKey: edge.childKey,
      path: [
        `M ${round(startX)} ${round(startY)}`,
        `V ${round(middleY)}`,
        `H ${round(endX)}`,
        `V ${round(endY)}`,
      ].join(" "),
    });
  }

  // Each couple block gets one horizontal connector between the two cards, so a
  // line never spans a stranger.
  for (const block of blocksByLevel.flat()) {
    if (block.keys.length < 2) continue;
    const first = positioned.get(block.keys[0]);
    const second = positioned.get(block.keys[1]);
    if (!first || !second) continue;
    const [left, rightNode] =
      first.x <= second.x ? [first, second] : [second, first];
    const connectorY = left.y + NODE_HEIGHT / 2;
    edges.push({
      kind: "spouse",
      fromKey: left.occurrenceKey,
      toKey: rightNode.occurrenceKey,
      path: `M ${round(left.x + NODE_WIDTH)} ${round(connectorY)} H ${round(
        rightNode.x,
      )}`,
    });
  }

  return { nodes, edges, width, height };
}

/**
 * Root (or several roots, for a full-project forest) at the top, descendants
 * below. A parent's subtree gets its own horizontal band, and the parent is
 * centred inside that band. Siblings therefore cannot slide their children
 * under a childless neighbour: brother's and sister's families never share a
 * connector, which used to read as one set of common children.
 *
 * `extraEdges` are drawn after placement without affecting it. The full-tree
 * screen uses them for a second parent of a child, which cannot own a second
 * band in a top-down tree.
 */
export function layoutDescendants(
  graph: DescendantGraph,
  options: LayoutOptions & { extraEdges?: DescendantGraph["edges"] } = {},
): GraphLayout {
  if (graph.nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const nodesByKey = new Map(
    graph.nodes.map((node) => [node.occurrenceKey, node]),
  );

  // Placement edges define the tree: one band per child. A child listed twice
  // (defensive) is placed under its first parent only.
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodesByKey.has(edge.parentKey) || !nodesByKey.has(edge.childKey)) {
      continue;
    }
    if (hasParent.has(edge.childKey)) continue;
    hasParent.add(edge.childKey);
    const keys = childrenOf.get(edge.parentKey) ?? [];
    keys.push(edge.childKey);
    childrenOf.set(edge.parentKey, keys);
  }

  const widths = new Map<string, number>();
  const visiting = new Set<string>();
  const subtreeWidth = (key: string): number => {
    const cached = widths.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return NODE_WIDTH;
    visiting.add(key);
    const children = childrenOf.get(key) ?? [];
    let width = NODE_WIDTH;
    if (children.length > 0) {
      const total =
        children.reduce((sum, child) => sum + subtreeWidth(child), 0) +
        H_GAP * (children.length - 1);
      width = Math.max(NODE_WIDTH, total);
    }
    visiting.delete(key);
    widths.set(key, width);
    return width;
  };

  const x = new Map<string, number>();
  const placed = new Set<string>();
  const place = (key: string, left: number) => {
    if (placed.has(key)) return;
    placed.add(key);
    const width = subtreeWidth(key);
    const children = childrenOf.get(key) ?? [];
    if (children.length === 0) {
      x.set(key, left + (width - NODE_WIDTH) / 2);
      return;
    }
    const total =
      children.reduce((sum, child) => sum + subtreeWidth(child), 0) +
      H_GAP * (children.length - 1);
    let cursor = left + (width - total) / 2;
    for (const child of children) {
      place(child, cursor);
      cursor += subtreeWidth(child) + H_GAP;
    }
    const first = x.get(children[0]) ?? left;
    const last = x.get(children[children.length - 1]) ?? left;
    const desired = (first + last) / 2;
    x.set(
      key,
      Math.min(Math.max(desired, left), left + width - NODE_WIDTH),
    );
  };

  // Roots in node order, so equal input stays equal. A node caught in a data
  // cycle has a parent but is never reached; it becomes its own root below.
  const roots = graph.nodes.filter((node) => !hasParent.has(node.occurrenceKey));
  let cursor = 0;
  for (const root of roots) {
    place(root.occurrenceKey, cursor);
    cursor += subtreeWidth(root.occurrenceKey) + H_GAP;
  }
  for (const node of graph.nodes) {
    if (placed.has(node.occurrenceKey)) continue;
    place(node.occurrenceKey, cursor);
    cursor += subtreeWidth(node.occurrenceKey) + H_GAP;
  }

  const knownXs = [...x.values()];
  const shift = PADDING - Math.min(...knownXs);
  const deepest = Math.max(...graph.nodes.map((node) => node.generation));
  const nodes: LayoutNode[] = graph.nodes.map((node) => ({
    occurrenceKey: node.occurrenceKey,
    personId: node.personId,
    generation: node.generation,
    role: node.role,
    adoptive: node.adoptive,
    placeholder: false,
    x: round((x.get(node.occurrenceKey) ?? 0) + shift),
    y: round(PADDING + node.generation * (NODE_HEIGHT + V_GAP)),
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));

  const right = Math.max(
    ...nodes.map((node) => node.x + NODE_WIDTH),
    PADDING,
  );
  const width = round(right + PADDING);
  const height = round(
    PADDING * 2 + (deepest + 1) * NODE_HEIGHT + deepest * V_GAP,
  );

  const positioned = new Map(nodes.map((node) => [node.occurrenceKey, node]));

  const edges: LayoutEdge[] = [];
  const drawEdge = (edge: DescendantGraph["edges"][number]) => {
    const parent = positioned.get(edge.parentKey);
    const child = positioned.get(edge.childKey);
    if (!parent || !child) return;
    const startX = parent.x + NODE_WIDTH / 2;
    const startY = parent.y + NODE_HEIGHT;
    const endX = child.x + NODE_WIDTH / 2;
    const endY = child.y;
    const middleY = (startY + endY) / 2;
    edges.push({
      kind: edge.adoptive ? "adoptive" : "parent",
      fromKey: edge.parentKey,
      toKey: edge.childKey,
      path: [
        `M ${round(startX)} ${round(startY)}`,
        `V ${round(middleY)}`,
        `H ${round(endX)}`,
        `V ${round(endY)}`,
      ].join(" "),
    });
  };
  for (const edge of graph.edges) drawEdge(edge);
  if (options.extraEdges) {
    const drawn = new Set(
      graph.edges.map((edge) => `${edge.parentKey}>${edge.childKey}`),
    );
    for (const edge of options.extraEdges) {
      if (drawn.has(`${edge.parentKey}>${edge.childKey}`)) continue;
      drawEdge(edge);
    }
  }

  return { nodes, edges, width, height };
}

/**
 * Child a placeholder belongs to, so "add parent" can create
 * `PARENT_CHILD(parent, child)`. `null` when the occurrence has no edge.
 */
export function placeholderChildPersonId(
  graph: AncestorGraph,
  occurrenceKey: string,
): string | null {
  const edge = graph.edges.find((item) => item.parentKey === occurrenceKey);
  if (!edge) return null;
  return (
    graph.nodes.find((node) => node.occurrenceKey === edge.childKey)?.personId ??
    null
  );
}
