// Pure slot filtering for the birth parent pickers. No React and no I/O so the
// rules stay testable without a rendering dependency.

import type { Person } from "../../api/types";

export type BirthParentSlot = 0 | 1;

const NIL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * People offered in one birth parent slot.
 *
 * Slot 0 is the father picker (MALE), slot 1 the mother picker (FEMALE).
 * The child, the other selected parent, nil ids and duplicate rows are always
 * excluded. A current selection is kept even when its gender does not match or
 * is UNKNOWN, so opening an existing event never hides or drops stored data.
 */
export function birthParentCandidates(
  persons: readonly Person[],
  slot: BirthParentSlot,
  selectedIds: readonly string[],
  childId: string,
): Person[] {
  const wanted = slot === 0 ? "MALE" : "FEMALE";
  const otherId = selectedIds[slot === 0 ? 1 : 0] ?? "";
  const currentId = selectedIds[slot] ?? "";
  const seen = new Set<string>();
  const out: Person[] = [];

  for (const person of persons) {
    if (person.id === "" || person.id === NIL_ID) continue;
    if (person.id === childId || person.id === otherId) continue;
    if (person.gender !== wanted) continue;
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    out.push(person);
  }

  if (
    currentId !== "" &&
    currentId !== childId &&
    currentId !== otherId &&
    !seen.has(currentId)
  ) {
    const current = persons.find((person) => person.id === currentId);
    if (current && current.id !== NIL_ID) out.push(current);
  }

  return out;
}
