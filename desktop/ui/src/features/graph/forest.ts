// Project-wide and blood-relative forests. The rooted ancestor and descendant
// graphs always start at one person; these modules turn a set of people into a
// down-growing forest where every included person is placed once. Pure module:
// no React, no IPC (ADR-0011 §layout is deterministic for equal input).

import type {
  DescendantEdge,
  DescendantGraph,
  DescendantNode,
  DescendantRole,
} from "../../api/types";
import type { ParentEdge, ParentEdges } from "./parents";

export type FullTree = {
  graph: DescendantGraph;
  /**
   * Parent links that do not own the child's placement band (a second parent).
   * They are drawn by `layoutDescendants` without moving any card.
   */
  extraEdges: DescendantEdge[];
};

type PersonLike = {
  id: string;
  gender: "MALE" | "FEMALE" | "UNKNOWN";
};

function genderRole(
  person: PersonLike,
  depth: number,
  rootPersonId: string,
): DescendantRole {
  if (person.id === rootPersonId || depth === 0) return "ROOT";
  if (person.gender === "MALE") return "SON";
  if (person.gender === "FEMALE") return "DAUGHTER";
  return "CHILD";
}

/**
 * Places `persons` in a forest rooted at the people without parents.
 * A child belongs to one primary parent for placement: the smallest parent id,
 * so equal input stays equal. The other parent links become `extraEdges`.
 * People caught in a data cycle still get a card, so nobody silently disappears.
 */
function buildForest(
  persons: readonly PersonLike[],
  parents: ParentEdges,
  rootPersonId: string,
): FullTree {
  const byId = new Map(persons.map((person) => [person.id, person]));
  const childrenOf = new Map<string, string[]>();
  const placementEdges: DescendantEdge[] = [];
  const extraEdges: DescendantEdge[] = [];
  const primaryEdge = new Map<string, DescendantEdge>();

  for (const person of persons) {
    const own = (parents.get(person.id) ?? []).filter((edge) =>
      byId.has(edge.parentId),
    );
    const primary = own.map((edge) => edge.parentId).sort()[0] ?? null;
    for (const edge of own) {
      const link: DescendantEdge = {
        parentKey: edge.parentId,
        childKey: person.id,
        adoptive: edge.adoptive,
      };
      if (edge.parentId === primary) {
        placementEdges.push(link);
        primaryEdge.set(person.id, link);
      } else {
        extraEdges.push(link);
      }
    }
    if (primary !== null) {
      const list = childrenOf.get(primary) ?? [];
      list.push(person.id);
      childrenOf.set(primary, list);
    }
  }

  const hasParent = new Set(placementEdges.map((edge) => edge.childKey));
  const roots = persons
    .filter((person) => !hasParent.has(person.id))
    .map((person) => person.id);

  const generation = new Map<string, number>();
  const visit = (id: string, depth: number) => {
    const known = generation.get(id);
    if (known !== undefined && known <= depth) return;
    generation.set(id, depth);
    for (const child of childrenOf.get(id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Unreachable nodes (a corrupt cycle) become extra roots at the end.
  for (const person of persons) {
    if (generation.has(person.id)) continue;
    roots.push(person.id);
    visit(person.id, 0);
  }

  const nodes: DescendantNode[] = persons.map((person) => {
    const depth = generation.get(person.id) ?? 0;
    return {
      personId: person.id,
      occurrenceKey: person.id,
      generation: depth,
      role: genderRole(person, depth, rootPersonId),
      // A parent link that is the child's primary edge is reflected here.
      adoptive: primaryEdge.get(person.id)?.adoptive ?? false,
    };
  });

  return {
    graph: {
      rootPersonId,
      generations: Math.max(0, ...generation.values()),
      nodes,
      edges: placementEdges,
      truncated: false,
      pedigreeCollapse: false,
    },
    extraEdges,
  };
}

/** Every person in the project, rooted at the people without parents. */
export function buildFullTree(
  persons: readonly PersonLike[],
  parents: ParentEdges,
): FullTree {
  return buildForest(persons, parents, "");
}

/**
 * Everyone related to `rootPersonId` by blood: its ancestors, every descendant
 * of those ancestors (siblings, aunts, uncles, cousins, nieces and further),
 * and its own descendants. Adoptive links and relatives by marriage are
 * excluded. The result is laid out like a descendant forest, so the selected
 * person can sit in the middle of the tree while kinship labels stay relative
 * to them.
 */
export function buildBloodTree(
  persons: readonly PersonLike[],
  parents: ParentEdges,
  rootPersonId: string,
): FullTree {
  const known = new Set(persons.map((person) => person.id));
  if (!known.has(rootPersonId)) {
    return buildForest([], new Map(), rootPersonId);
  }

  const blood = new Map<string, ParentEdge[]>();
  const bloodChildren = new Map<string, string[]>();
  for (const [child, edges] of parents) {
    if (!known.has(child)) continue;
    const own = edges.filter(
      (edge) => !edge.adoptive && known.has(edge.parentId),
    );
    if (own.length === 0) continue;
    blood.set(child, [...own]);
    for (const edge of own) {
      const list = bloodChildren.get(edge.parentId) ?? [];
      if (!list.includes(child)) list.push(child);
      bloodChildren.set(edge.parentId, list);
    }
  }

  // A blood relative shares an ancestor with the root; a relative by marriage
  // does not. Walking parent-child links undirectedly would pull in a spouse
  // through a shared child, so the set is built in one direction only:
  // ancestors of the root, then every descendant of every such ancestor.
  const component = new Set<string>([rootPersonId]);
  const ancestors = [rootPersonId];
  while (ancestors.length > 0) {
    const current = ancestors.shift();
    if (current === undefined) break;
    for (const edge of blood.get(current) ?? []) {
      if (component.has(edge.parentId)) continue;
      component.add(edge.parentId);
      ancestors.push(edge.parentId);
    }
  }
  const descendants = [...component];
  while (descendants.length > 0) {
    const current = descendants.shift();
    if (current === undefined) break;
    for (const child of bloodChildren.get(current) ?? []) {
      if (component.has(child)) continue;
      component.add(child);
      descendants.push(child);
    }
  }

  const memberPersons = persons.filter((person) => component.has(person.id));
  const memberParents = new Map<string, ParentEdge[]>();
  for (const [child, edges] of blood) {
    if (!component.has(child)) continue;
    // A parent outside the set is a relative by marriage, not a blood link.
    const own = edges.filter((edge) => component.has(edge.parentId));
    if (own.length > 0) memberParents.set(child, own);
  }
  return buildForest(memberPersons, memberParents, rootPersonId);
}
