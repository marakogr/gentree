// Pure "before → after" diff for a confirmed `update_person`. No DOM, no IPC.
//
// The backend already computed `changedFields` by comparing the two `Person`
// values; this module renders the same comparison into labelled rows so the
// card and the write can never diverge. `externalIds` are never shown.

import type {
  DateValue,
  Gender,
  NameType,
  Person,
  PersonName,
} from "../../api/types";
import { dash } from "../../lib/formatValue";

export type PersonDiffRow = {
  field: "names" | "gender" | "birth" | "death" | "notes";
  nameType?: NameType;
  before: string;
  after: string;
};

const NAME_TYPES: readonly NameType[] = [
  "BIRTH",
  "MARRIED",
  "RELIGIOUS",
  "OTHER",
];

/** `surname given patronymic`, in the same order as the backend display name. */
export function formatPersonName(name: PersonName): string {
  return [name.surname, name.given, name.patronymic]
    .filter((part): part is string => Boolean(part && part.trim() !== ""))
    .join(" ");
}

/** Structural equality for dates: `before`/`after` are distinct JSON objects. */
function sameDate(left: DateValue, right: DateValue): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.precision === right.precision &&
    left.qualifier === right.qualifier &&
    left.original === right.original
  );
}

/**
 * Computes the visible diff rows between two `Person` values.
 *
 * Names are grouped by `nameType` and matched by position inside each group, so
 * a lost name (the model replaced the whole array) shows up as an empty
 * `before`/`after` string that the caller renders as "(none)" / "(removed)".
 * Only changed rows are returned.
 */
export function diffPerson(
  before: Person,
  after: Person,
  format: {
    name: (person: Person) => string;
    date: (value: DateValue) => string;
    gender: (value: Gender) => string;
  },
): PersonDiffRow[] {
  const rows: PersonDiffRow[] = [];

  for (const nameType of NAME_TYPES) {
    const left = before.names.filter((name) => name.nameType === nameType);
    const right = after.names.filter((name) => name.nameType === nameType);
    const count = Math.max(left.length, right.length);
    for (let index = 0; index < count; index += 1) {
      const beforeValue = left[index] ? formatPersonName(left[index]) : "";
      const afterValue = right[index] ? formatPersonName(right[index]) : "";
      if (beforeValue !== afterValue) {
        rows.push({ field: "names", nameType, before: beforeValue, after: afterValue });
      }
    }
  }

  if (before.gender !== after.gender) {
    rows.push({
      field: "gender",
      before: format.gender(before.gender),
      after: format.gender(after.gender),
    });
  }

  if (!sameDate(before.birth, after.birth)) {
    rows.push({
      field: "birth",
      before: format.date(before.birth),
      after: format.date(after.birth),
    });
  }

  if (!sameDate(before.death, after.death)) {
    rows.push({
      field: "death",
      before: format.date(before.death),
      after: format.date(after.death),
    });
  }

  if (before.notes !== after.notes) {
    rows.push({
      field: "notes",
      before: dash(before.notes),
      after: dash(after.notes),
    });
  }

  return rows;
}
