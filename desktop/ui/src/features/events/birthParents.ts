// Pure slot filtering for the birth parent pickers. No React and no I/O so the
// rules stay testable without a rendering dependency.

import type { Person } from "../../api/types";

export type BirthParentSlot = 0 | 1;

/** Father slot, then mother slot. Both are empty strings when unset. */
export type BirthParentSlots = [string, string];

const NIL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Map stored participant ids onto the father/mother pickers by gender.
 *
 * `participantIds` is compact and positional only by convention, so deleting a
 * father leaves a lone mother at index 0. Reading that index as "father" would
 * relabel and later overwrite her, so the role comes from the person's gender
 * instead: a man takes the father slot, a woman the mother slot, and an
 * unknown-gender (or unknown) person the first free slot. The stored array is
 * never reordered or otherwise changed here.
 */
export function birthParentSlots(
  participantIds: readonly string[],
  persons: readonly Person[],
): BirthParentSlots {
  const slots: BirthParentSlots = ["", ""];
  const pending: string[] = [];
  const seen = new Set<string>();

  for (const id of participantIds) {
    if (id === "" || id === NIL_ID || seen.has(id)) continue;
    seen.add(id);
    const gender = persons.find((person) => person.id === id)?.gender;
    const slot: BirthParentSlot | null =
      gender === "MALE" ? 0 : gender === "FEMALE" ? 1 : null;
    if (slot !== null && slots[slot] === "") {
      slots[slot] = id;
    } else {
      pending.push(id);
    }
  }

  for (const id of pending) {
    if (slots[0] === "") slots[0] = id;
    else if (slots[1] === "") slots[1] = id;
  }

  return slots;
}

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
