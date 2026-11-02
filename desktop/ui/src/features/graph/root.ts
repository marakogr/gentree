// Root-person selection shared by the graph screen. Mirrors the backend
// fallback (`graph_ancestors` without `rootPersonId`): the manifest home
// person, else the earliest known birth, else the smallest id (ADR-0011).

import type { Person } from "../../api/types";

function comparePersons(left: Person, right: Person): number {
  const a = left.birth.start;
  const b = right.birth.start;
  if (a !== null && b !== null) {
    if (a !== b) return a < b ? -1 : 1;
  } else if (a !== null) {
    return -1;
  } else if (b !== null) {
    return 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** `null` only for an empty project, so the screen can show its empty state. */
export function selectRootPerson(
  persons: Person[],
  homePersonId: string | null | undefined,
): Person | null {
  if (persons.length === 0) return null;
  if (homePersonId) {
    const home = persons.find((person) => person.id === homePersonId);
    if (home) return home;
  }
  return [...persons].sort(comparePersons)[0] ?? null;
}
