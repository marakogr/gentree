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
 * Generations are assigned per co-parent unit instead of per placement edge, so
 * the two parents of a child always share one level even when they have
 * different ancestries. People caught in a data cycle still get a card, so
 * nobody silently disappears.
 */
function buildForest(
  persons: readonly PersonLike[],
  parents: ParentEdges,
  rootPersonId: string,
): FullTree {
  const byId = new Map(persons.map((person) => [person.id, person]));
  const placementEdges: DescendantEdge[] = [];
  const extraEdges: DescendantEdge[] = [];
  const primaryEdge = new Map<string, DescendantEdge>();
  const ownParents = new Map<string, ParentEdge[]>();

  for (const person of persons) {
    const own = (parents.get(person.id) ?? []).filter((edge) =>
      byId.has(edge.parentId),
    );
    ownParents.set(person.id, own);
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
  }

  // Co-parents form one unit, so a child's father and mother cannot land on
  // different generations. Union-find keeps a person in exactly one unit even
  // when they have children with more than one partner.
  const indexOf = new Map(persons.map((person, index) => [person.id, index]));
  const unitRoot = persons.map((_, index) => index);
  const findUnit = (index: number): number => {
    let root = index;
    while (unitRoot[root] !== root) root = unitRoot[root];
    let current = index;
    while (unitRoot[current] !== root) {
      const next = unitRoot[current];
      unitRoot[current] = root;
      current = next;
    }
    return root;
  };
  const unionUnits = (left: number, right: number) => {
    const leftRoot = findUnit(left);
    const rightRoot = findUnit(right);
    if (leftRoot === rightRoot) return;
    // The smaller index stays the root, so unit ids follow person order.
    if (leftRoot < rightRoot) unitRoot[rightRoot] = leftRoot;
    else unitRoot[leftRoot] = rightRoot;
  };
  for (const person of persons) {
    const own = ownParents.get(person.id) ?? [];
    const first = own[0];
    if (!first) continue;
    const firstIndex = indexOf.get(first.parentId);
    if (firstIndex === undefined) continue;
    for (const edge of own.slice(1)) {
      const otherIndex = indexOf.get(edge.parentId);
      if (otherIndex !== undefined) unionUnits(firstIndex, otherIndex);
    }
  }
  const unitOfPerson = (id: string): number => {
    const index = indexOf.get(id);
    return index === undefined ? -1 : findUnit(index);
  };

  // Units form a DAG along the placement edges. A unit sits one level below
  // its deepest parent unit, so partners share a row and their child is below.
  const unitChildren = new Map<number, number[]>();
  const unitParentsByUnit = new Map<number, number[]>();
  const seenUnitEdges = new Set<string>();
  for (const edge of placementEdges) {
    const parentUnit = unitOfPerson(edge.parentKey);
    const childUnit = unitOfPerson(edge.childKey);
    if (parentUnit < 0 || childUnit < 0 || parentUnit === childUnit) continue;
    const key = `${parentUnit}>${childUnit}`;
    if (seenUnitEdges.has(key)) continue;
    seenUnitEdges.add(key);
    const children = unitChildren.get(parentUnit) ?? [];
    children.push(childUnit);
    unitChildren.set(parentUnit, children);
    const unitParents = unitParentsByUnit.get(childUnit) ?? [];
    unitParents.push(parentUnit);
    unitParentsByUnit.set(childUnit, unitParents);
  }

  const unitIds = [
    ...new Set(persons.map((_, index) => findUnit(index))),
  ].sort((left, right) => left - right);
  const unitLevel = new Map<number, number>();
  const pendingParents = new Map<number, number>();
  for (const unit of unitIds) {
    pendingParents.set(unit, (unitParentsByUnit.get(unit) ?? []).length);
  }
  const ready = unitIds.filter((unit) => pendingParents.get(unit) === 0);
  const settled = new Set<number>();
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const unit = ready[cursor];
    if (settled.has(unit)) continue;
    settled.add(unit);
    const level = unitLevel.get(unit) ?? 0;
    unitLevel.set(unit, level);
    for (const childUnit of unitChildren.get(unit) ?? []) {
      unitLevel.set(
        childUnit,
        Math.max(unitLevel.get(childUnit) ?? 0, level + 1),
      );
      const remaining = (pendingParents.get(childUnit) ?? 1) - 1;
      pendingParents.set(childUnit, remaining);
      if (remaining === 0) ready.push(childUnit);
    }
  }
  // A corrupt cycle never becomes ready. Its units still get a level, in unit
  // order, below whichever of their parents already has one.
  for (const unit of unitIds) {
    if (settled.has(unit)) continue;
    let level = 0;
    for (const parentUnit of unitParentsByUnit.get(unit) ?? []) {
      level = Math.max(level, (unitLevel.get(parentUnit) ?? 0) + 1);
    }
    unitLevel.set(unit, level);
  }

  const generation = new Map<string, number>();
  for (const person of persons) {
    const unit = unitOfPerson(person.id);
    generation.set(person.id, unit < 0 ? 0 : (unitLevel.get(unit) ?? 0));
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
