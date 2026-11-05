// Spouse view shared by the tree screen. Pure module: no React, no IPC.
//
// `SPOUSE` and `PARTNER` rows are already loaded with every other relationship,
// so the tree only needs an ordered index, a session toggle and a decoration
// pass that adds spouse-only cards to a base graph. Blood generations are never
// recomputed here: a spouse card copies its anchor's generation.

import type {
  AncestorGraph,
  AncestorNode,
  DescendantGraph,
  DescendantNode,
  Person,
  RelationshipEntity,
  Versioned,
} from "../../api/types";
import { spousePairKey } from "./layout";

/** Minimal person surface the decoration needs. */
export type SpousePerson = Pick<Person, "id" | "gender">;

/** A person's partners in relationship order, then id. */
export type SpouseIndex = {
  partnersOf: ReadonlyMap<string, readonly string[]>;
  pairs: ReadonlySet<string>;
};

export const EMPTY_SPOUSE_INDEX: SpouseIndex = {
  partnersOf: new Map(),
  pairs: new Set(),
};

function isSpouseType(type: RelationshipEntity["type"]): boolean {
  return type === "SPOUSE" || type === "PARTNER";
}

/**
 * Builds a bidirectional partner index from relationship rows. Rows are ranked
 * by their stored order, so several marriages keep a stable order; duplicate
 * rows and self-links are collapsed and a partner id breaks any remaining tie.
 */
export function buildSpouseIndex(
  rows: readonly Versioned<RelationshipEntity>[],
): SpouseIndex {
  const ranked = new Map<string, Map<string, number>>();
  const pairs = new Set<string>();
  let rank = 0;

  const add = (personId: string, partnerId: string) => {
    if (personId === partnerId) return;
    const known = ranked.get(personId) ?? new Map<string, number>();
    if (!known.has(partnerId)) known.set(partnerId, rank);
    ranked.set(personId, known);
  };

  for (const row of rows) {
    const relationship = row.entity;
    if (!isSpouseType(relationship.type)) continue;
    const { personId, relatedPersonId } = relationship;
    if (personId === relatedPersonId) continue;
    pairs.add(spousePairKey(personId, relatedPersonId));
    add(personId, relatedPersonId);
    add(relatedPersonId, personId);
    rank += 1;
  }

  const partnersOf = new Map<string, readonly string[]>();
  for (const [personId, partners] of ranked) {
    partnersOf.set(
      personId,
      [...partners.entries()]
        .sort(
          ([leftId, leftRank], [rightId, rightRank]) =>
            leftRank - rightRank || (leftId < rightId ? -1 : 1),
        )
        .map(([partnerId]) => partnerId),
    );
  }
  return { partnersOf, pairs };
}

/** Minimal storage surface: tests pass a plain object, the app sessionStorage. */
export type SessionStorageLike = Pick<Storage, "getItem" | "setItem">;

export const SPOUSE_SESSION_KEY = "gentree.tree.spouses.v1";

function browserSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    // Access to sessionStorage can throw in hardened webviews.
    return null;
  }
}

/** Off unless this session explicitly enabled it. Never throws. */
export function readSpouseToggle(
  storage: SessionStorageLike | null = browserSessionStorage(),
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(SPOUSE_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

/** A lost preference must not break the screen. Never throws. */
export function writeSpouseToggle(
  value: boolean,
  storage: SessionStorageLike | null = browserSessionStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(SPOUSE_SESSION_KEY, value ? "1" : "0");
  } catch {
    // Quota or a disabled storage: keep the in-memory state only.
  }
}

type PlanNode = {
  personId: string | null;
  occurrenceKey: string;
  generation: number;
  placeholder?: boolean;
};

type SpouseAddition = {
  anchorKey: string;
  generation: number;
  personId: string;
};

type SpousePlan = {
  additions: SpouseAddition[];
  pairs: [string, string][];
};

/**
 * Plans spouse-only cards for one graph. A partner already drawn as a blood
 * node (or already added for another anchor) is never added twice; it only
 * contributes a connector pair.
 */
function planSpouses(
  nodes: readonly PlanNode[],
  persons: ReadonlyMap<string, SpousePerson>,
  index: SpouseIndex,
): SpousePlan {
  const bloodKey = new Map<string, string>();
  for (const node of nodes) {
    if (node.personId === null || node.placeholder) continue;
    if (!bloodKey.has(node.personId)) {
      bloodKey.set(node.personId, node.occurrenceKey);
    }
  }

  const addedKey = new Map<string, string>();
  const additions: SpouseAddition[] = [];
  const pairs = new Map<string, [string, string]>();
  const addPair = (left: string, right: string) => {
    if (left === right) return;
    const key = spousePairKey(left, right);
    if (!pairs.has(key)) pairs.set(key, [left, right]);
  };

  for (const node of nodes) {
    if (node.personId === null || node.placeholder) continue;
    for (const partnerId of index.partnersOf.get(node.personId) ?? []) {
      if (!persons.has(partnerId)) continue;
      const blood = bloodKey.get(partnerId);
      if (blood !== undefined) {
        addPair(node.occurrenceKey, blood);
        continue;
      }
      const added = addedKey.get(partnerId);
      if (added !== undefined) {
        addPair(node.occurrenceKey, added);
        continue;
      }
      const key = `spouse:${node.occurrenceKey}:${partnerId}`;
      additions.push({
        anchorKey: node.occurrenceKey,
        generation: node.generation,
        personId: partnerId,
      });
      addedKey.set(partnerId, key);
      addPair(node.occurrenceKey, key);
    }
  }

  return { additions, pairs: [...pairs.values()] };
}

function descendantRole(person: SpousePerson): DescendantNode["role"] {
  if (person.gender === "MALE") return "SON";
  if (person.gender === "FEMALE") return "DAUGHTER";
  return "CHILD";
}

function ancestorRole(person: SpousePerson): AncestorNode["role"] {
  return person.gender === "MALE" ? "FATHER" : "MOTHER";
}

export type DescendantSpouseView = {
  graph: DescendantGraph;
  spouseOf: ReadonlyMap<string, string>;
  spousePairs: readonly [string, string][];
};

export type AncestorSpouseView = {
  graph: AncestorGraph;
  spouseOf: ReadonlyMap<string, string>;
  spousePairs: readonly [string, string][];
};

function spouseKey(anchorKey: string, personId: string): string {
  return `spouse:${anchorKey}:${personId}`;
}

/** Adds spouse-only cards to a descendant graph without touching its edges. */
export function decorateDescendantGraph(
  graph: DescendantGraph,
  persons: ReadonlyMap<string, SpousePerson>,
  index: SpouseIndex,
): DescendantSpouseView {
  const plan = planSpouses(graph.nodes, persons, index);
  const spouseOf = new Map<string, string>();
  const nodes: DescendantNode[] = [...graph.nodes];
  for (const addition of plan.additions) {
    const person = persons.get(addition.personId);
    if (person === undefined) continue;
    const key = spouseKey(addition.anchorKey, addition.personId);
    spouseOf.set(key, addition.anchorKey);
    nodes.push({
      personId: addition.personId,
      occurrenceKey: key,
      generation: addition.generation,
      role: descendantRole(person),
      adoptive: false,
    });
  }
  return {
    graph: { ...graph, nodes },
    spouseOf,
    spousePairs: plan.pairs,
  };
}

/** Adds spouse-only cards to an ancestor graph without touching its edges. */
export function decorateAncestorGraph(
  graph: AncestorGraph,
  persons: ReadonlyMap<string, SpousePerson>,
  index: SpouseIndex,
): AncestorSpouseView {
  const plan = planSpouses(graph.nodes, persons, index);
  const spouseOf = new Map<string, string>();
  const nodes: AncestorNode[] = [...graph.nodes];
  for (const addition of plan.additions) {
    const person = persons.get(addition.personId);
    if (person === undefined) continue;
    const key = spouseKey(addition.anchorKey, addition.personId);
    spouseOf.set(key, addition.anchorKey);
    nodes.push({
      personId: addition.personId,
      occurrenceKey: key,
      generation: addition.generation,
      role: ancestorRole(person),
      adoptive: false,
      placeholder: false,
    });
  }
  return {
    graph: { ...graph, nodes },
    spouseOf,
    spousePairs: plan.pairs,
  };
}
