// Parent index shared by the tree screens. Siblings are never stored as edges:
// they are derived from shared parents (AGENTS.md). Pure module: no React, no
// IPC.

import type {
  RelationshipEntity,
  Versioned,
} from "../../api/types";

/** One parent edge of a child, with the relationship type preserved. */
export type ParentEdge = {
  parentId: string;
  adoptive: boolean;
};

/** child id -> its known parents, in relationship order. */
export type ParentEdges = ReadonlyMap<string, readonly ParentEdge[]>;

/**
 * Builds the child -> parents index from the project's parent-child edges.
 * Duplicate edges for the same pair are collapsed; an adoptive edge wins only
 * when it is the first one seen for that pair.
 */
export function parentEdgesFromRelationships(
  rows: readonly Versioned<RelationshipEntity>[],
): Map<string, ParentEdge[]> {
  const edges = new Map<string, ParentEdge[]>();
  for (const row of rows) {
    const relationship = row.entity;
    if (
      relationship.type !== "PARENT_CHILD" &&
      relationship.type !== "ADOPTIVE_PARENT_CHILD"
    ) {
      continue;
    }
    const child = relationship.relatedPersonId;
    const list = edges.get(child) ?? [];
    if (list.some((edge) => edge.parentId === relationship.personId)) continue;
    list.push({
      parentId: relationship.personId,
      adoptive: relationship.type === "ADOPTIVE_PARENT_CHILD",
    });
    edges.set(child, list);
  }
  return edges;
}
