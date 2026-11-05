// One tree around the root: ancestors above, descendants below. The two
// backend layouts already know how to place their half; this module only aligns
// the shared root card and re-routes the edges in the merged coordinate space.
// Pure: no React, no IPC, no DOM.

import {
  PADDING,
  SPOUSE_GAP,
  V_GAP,
  type GraphLayout,
  type LayoutEdge,
} from "./layout";

const ROOT_KEY = "0";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function edgePath(edge: LayoutEdge, layout: GraphLayout): string | null {
  const byKey = new Map(layout.nodes.map((node) => [node.occurrenceKey, node]));
  const from = byKey.get(edge.fromKey);
  const to = byKey.get(edge.toKey);
  if (!from || !to) return null;
  if (edge.kind === "spouse") {
    const [left, right] = from.x <= to.x ? [from, to] : [to, from];
    const gap = right.x - (left.x + left.width);
    if (Math.abs(left.y - right.y) < 0.01 && gap <= SPOUSE_GAP + 0.01) {
      const y = round(left.y + left.height / 2);
      return `M ${round(left.x + left.width)} ${y} H ${round(right.x)}`;
    }
    const midY = round(
      Math.max(PADDING / 2, Math.min(left.y, right.y) - V_GAP / 2),
    );
    return [
      `M ${round(left.x + left.width / 2)} ${round(left.y)}`,
      `V ${midY}`,
      `H ${round(right.x + right.width / 2)}`,
      `V ${round(right.y)}`,
    ].join(" ");
  }
  const startX = round(from.x + from.width / 2);
  const startY = round(from.y + from.height);
  const endX = round(to.x + to.width / 2);
  const endY = round(to.y);
  const middleY = round((startY + endY) / 2);
  return [
    `M ${startX} ${startY}`,
    `V ${middleY}`,
    `H ${endX}`,
    `V ${endY}`,
  ].join(" ");
}

/**
 * Merge the ancestor and descendant layouts of one root. The root card is kept
 * from the ancestor half; its descendant copy is dropped and the descendant
 * half is shifted so both roots coincide. Edges are re-routed after the final
 * padding shift, so no path keeps a stale coordinate.
 */
export function combineLayouts(
  ancestor: GraphLayout,
  descendant: GraphLayout,
): GraphLayout {
  if (ancestor.nodes.length === 0) return descendant;
  if (descendant.nodes.length === 0) return ancestor;

  const ancestorRoot = ancestor.nodes.find(
    (node) => node.occurrenceKey === ROOT_KEY,
  );
  const descendantRoot = descendant.nodes.find(
    (node) => node.occurrenceKey === ROOT_KEY,
  );
  if (!ancestorRoot || !descendantRoot) return ancestor;

  const dx = ancestorRoot.x - descendantRoot.x;
  const dy = ancestorRoot.y - descendantRoot.y;
  const ancestorSpousePersons = new Set(
    ancestor.nodes
      .filter((node) => node.spouseOfKey !== null && node.personId !== null)
      .map((node) => node.personId as string),
  );
  const merged = [
    ...ancestor.nodes,
    ...descendant.nodes
      .filter(
        (node) =>
          node.occurrenceKey !== ROOT_KEY &&
          !(
            node.spouseOfKey !== null &&
            node.personId !== null &&
            ancestorSpousePersons.has(node.personId)
          ),
      )
      .map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
  ];

  const minX = Math.min(...merged.map((node) => node.x));
  const minY = Math.min(...merged.map((node) => node.y));
  const shiftX = PADDING - minX;
  const shiftY = PADDING - minY;
  const nodes = merged.map((node) => ({
    ...node,
    x: round(node.x + shiftX),
    y: round(node.y + shiftY),
  }));

  // Descendant edges keep the root key, so they attach to the single root card
  // that the ancestor half contributed.
  const positioned: GraphLayout = {
    nodes,
    edges: [],
    width: 0,
    height: 0,
  };
  const seen = new Set<string>();
  const edges: LayoutEdge[] = [];
  for (const edge of [...ancestor.edges, ...descendant.edges]) {
    const key = `${edge.kind}|${edge.fromKey}|${edge.toKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = edgePath(edge, positioned);
    if (path !== null) edges.push({ ...edge, path });
  }

  const width = round(
    Math.max(...nodes.map((node) => node.x + node.width), PADDING) + PADDING,
  );
  const height = round(
    Math.max(...nodes.map((node) => node.y + node.height), PADDING) + PADDING,
  );

  return { nodes, edges, width, height };
}
