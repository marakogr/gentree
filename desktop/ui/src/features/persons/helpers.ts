// Pure helpers for the persons screen: display names, filtering/sorting and
// form <-> Person conversion. No DOM, no IPC.

import type {
  DatePrecision,
  DateQualifier,
  DateValue,
  Gender,
  ParentRef,
  Person,
  PersonInput,
  PersonName,
} from "../../api/types";
import {
  civilDateKey,
  dateValueToInput,
  emptyDateValue,
  parseDateInput,
  type ParsedDateInput,
} from "../../lib/dates";
import { EMPTY_VALUE } from "../../lib/formatValue";

export type PersonSort = "name" | "birth" | "death" | "age";
export type PersonSortDirection = "asc" | "desc";

export function displayName(person: Person, unknown = ""): string {
  const primary =
    person.names.find((name) => name.isPrimary) ?? person.names[0];
  if (!primary) return unknown;
  const parts = [primary.surname, primary.given, primary.patronymic].filter(
    (part): part is string => Boolean(part && part.trim() !== ""),
  );
  return parts.length > 0 ? parts.join(" ") : unknown;
}

export function matchesPersonQuery(person: Person, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    displayName(person).toLowerCase().includes(needle) ||
    person.names.some((name) =>
      [name.surname, name.given, name.patronymic].some((part) =>
        (part ?? "").toLowerCase().includes(needle),
      ),
    )
  );
}

export function filterPersons(persons: Person[], query: string): Person[] {
  return persons.filter((person) => matchesPersonQuery(person, query));
}

export function sortPersons(
  persons: Person[],
  sort: PersonSort,
  direction: PersonSortDirection = "asc",
): Person[] {
  const result = [...persons];
  if (sort === "name") {
    result.sort((left, right) =>
      applyDirection(byName(left, right), direction),
    );
    return result;
  }
  if (sort === "age") {
    // Living people age up to today, deceased up to the death date, and an
    // unusable birth date leaves no key, so those rows stay last.
    const today = new Date();
    result.sort((left, right) => {
      const ages = compareDates(
        ageInCompletedYears(left, today),
        ageInCompletedYears(right, today),
        direction,
      );
      return ages !== 0 ? ages : byName(left, right);
    });
    return result;
  }
  const key = sort === "birth" ? birthKey : deathKey;
  result.sort((left, right) => {
    const dates = compareDates(key(left), key(right), direction);
    return dates !== 0 ? dates : byName(left, right);
  });
  return result;
}

/** Dated rows first; undated last for both directions (mirrors Rust). */
function compareDates(
  left: number | null,
  right: number | null,
  direction: PersonSortDirection,
): number {
  if (left !== null && right !== null) {
    return applyDirection(left - right, direction);
  }
  if (left !== null) return -1;
  if (right !== null) return 1;
  return 0;
}

function applyDirection(value: number, direction: PersonSortDirection): number {
  if (value === 0) return 0;
  return direction === "desc" ? -value : value;
}

function birthKey(person: Person): number | null {
  return person.birth.start ? civilDateKey(person.birth.start) : null;
}

function deathKey(person: Person): number | null {
  return person.death.start ? civilDateKey(person.death.start) : null;
}

function byName(left: Person, right: Person): number {
  return displayName(left)
    .toLowerCase()
    .localeCompare(displayName(right).toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* List columns                                                                */
/* -------------------------------------------------------------------------- */

/** Four-digit year of a date value; `null` when the date is unknown. */
export function yearOfValue(value: DateValue): number | null {
  const start = value.start;
  if (!start) return null;
  const year = Number(start.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

/**
 * `1935 – 1998`, `1935 – …` while the death date is unknown, `—` when both
 * sides are unknown. Never invents a year.
 */
export function lifeYears(
  person: Pick<Person, "birth" | "death">,
): string {
  const birth = yearOfValue(person.birth);
  const death = yearOfValue(person.death);
  if (birth === null && death === null) return EMPTY_VALUE;
  if (death === null) return `${birth} \u2013 \u2026`;
  if (birth === null) return `${EMPTY_VALUE} \u2013 ${death}`;
  return `${birth} \u2013 ${death}`;
}

/** Calendar parts of a canonical `YYYY-MM-DD` value. */
type CalendarParts = { year: number; month: number; day: number };

function calendarParts(value: string): CalendarParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** `UNKNOWN` = 0 so a missing precision never becomes the coarsest bound. */
const PRECISION_RANK: Record<DatePrecision, number> = {
  UNKNOWN: 0,
  YEAR: 1,
  MONTH: 2,
  DAY: 3,
};

/**
 * Completed years at the coarser of the two precisions: a year-only date has no
 * birthday to compare, so only the year difference counts.
 */
function completedYears(
  birth: CalendarParts,
  end: CalendarParts,
  rank: number,
): number {
  let years = end.year - birth.year;
  const beforeAnniversary =
    rank >= 3
      ? end.month < birth.month ||
        (end.month === birth.month && end.day < birth.day)
      : rank >= 2
        ? end.month < birth.month
        : false;
  if (beforeAnniversary) years -= 1;
  return years;
}

/**
 * Age in completed years, from the system date for a living person and at the
 * death date for a person known to be dead.
 *
 * Never invents a value: an unknown or unparsable birth date gives `null`, and
 * so does a known death whose date cannot be used (e.g. only free text). A
 * year-only date yields the year difference; a day-precise pair compares the
 * birthday exactly.
 */
export function ageInCompletedYears(
  person: Pick<Person, "birth" | "death">,
  today: Date,
): number | null {
  const { birth, death } = person;
  if (birth.precision === "UNKNOWN" || birth.start === null) return null;
  const birthParts = calendarParts(birth.start);
  if (birthParts === null) return null;

  const deathKnown =
    death.precision !== "UNKNOWN" ||
    death.start !== null ||
    death.end !== null ||
    Boolean(death.original?.trim());

  let end: CalendarParts;
  let rank: number;
  if (deathKnown) {
    const iso = death.start ?? death.end;
    const endParts = iso === null ? null : calendarParts(iso);
    if (endParts === null || death.precision === "UNKNOWN") return null;
    end = endParts;
    rank = Math.min(PRECISION_RANK[birth.precision], PRECISION_RANK[death.precision]);
  } else {
    end = {
      year: today.getUTCFullYear(),
      month: today.getUTCMonth() + 1,
      day: today.getUTCDate(),
    };
    rank = PRECISION_RANK[birth.precision];
  }

  if (rank <= 0) return null;
  const age = completedYears(birthParts, end, rank);
  return age >= 0 ? age : null;
}

function ageInYears(birth: string, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let age = today.getUTCFullYear() - year;
  const todayMonth = today.getUTCMonth() + 1;
  const todayDay = today.getUTCDate();
  if (todayMonth < month || (todayMonth === month && todayDay < day)) {
    age -= 1;
  }
  return age;
}

/**
 * True when the record says the person died, even if the exact date is free
 * text: an empty `death` date means "unknown", not "alive".
 */
export function hasKnownDeath(
  person: Pick<Person, "death">,
): boolean {
  const { death } = person;
  return (
    death.precision !== "UNKNOWN" ||
    death.start !== null ||
    death.end !== null ||
    Boolean(death.original?.trim())
  );
}

export type AgeTone = "living" | "dead" | "unknown";

/**
 * Colour of the age value: green while the person is probably alive, red when
 * they are dead. A known death date always means dead; without one the same
 * heuristic as the old "living" badge decides, and an age above its limit is
 * read as a presumed death while the hypothetical age stays visible.
 */
export function ageTone(
  person: Pick<Person, "birth" | "death">,
  today: Date,
  maxAge = 110,
): AgeTone {
  if (hasKnownDeath(person)) return "dead";
  if (isProbablyLiving(person, today, maxAge)) return "living";
  if (person.birth.start !== null) return "dead";
  return "unknown";
}

/**
 * Heuristic "probably alive" flag: no death date, a known birth date and an age
 * of at most `maxAge` years. Used for the age colour, never for decisions.
 */
export function isProbablyLiving(
  person: Pick<Person, "birth" | "death">,
  today: Date,
  maxAge = 110,
): boolean {
  if (person.death.start !== null) return false;
  const birth = person.birth.start;
  if (!birth) return false;
  const age = ageInYears(birth, today);
  if (age === null) return false;
  return age >= 0 && age <= maxAge;
}

/** Strictly numeric year input: blank means "no bound". */
export function parseYearInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const year = Number(trimmed);
  return year > 0 ? year : null;
}

/** `false` only when both bounds are valid years and `from > to`. */
export function isValidYearRange(from: string, to: string): boolean {
  const start = parseYearInput(from);
  const end = parseYearInput(to);
  if (start === null || end === null) return true;
  return start <= end;
}

/**
 * Client-side year filter: a person matches when a known birth year or a known
 * death year falls inside the inclusive range. An inverted range is ignored
 * (the form shows the error and the list is not silently emptied).
 */
export function filterPersonsByYears(
  persons: Person[],
  from: string,
  to: string,
): Person[] {
  const start = parseYearInput(from);
  const end = parseYearInput(to);
  if (start === null && end === null) return persons;
  if (start !== null && end !== null && start > end) return persons;
  return persons.filter((person) => {
    const years = [yearOfValue(person.birth), yearOfValue(person.death)].filter(
      (year): year is number => year !== null,
    );
    return years.some(
      (year) =>
        (start === null || year >= start) && (end === null || year <= end),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Parents column                                                              */
/* -------------------------------------------------------------------------- */

/** Parent row plus the adoption flag once the backend can supply it. */
export type ParentEntry = {
  id: string;
  name: string;
  gender: Gender;
  adoptive: boolean;
};

/** Normalises the batch `person_parents` map for one person. */
export function parentEntries(refs: ParentRef[] | undefined): ParentEntry[] {
  return (refs ?? []).map((ref) => ({
    id: ref.id,
    name: ref.name.trim(),
    gender: ref.gender,
    // `ParentRef` carries no adoption flag today; read it defensively so an
    // extra field starts rendering without a UI change.
    adoptive:
      (ref as ParentRef & { adoptive?: boolean }).adoptive === true,
  }));
}

/** At most `max` parents are shown, the rest collapse into a "+N" counter. */
export function parentSummary(
  entries: ParentEntry[],
  max = 2,
): { visible: ParentEntry[]; extra: number } {
  const limit = Math.max(0, max);
  return {
    visible: entries.slice(0, limit),
    extra: Math.max(0, entries.length - limit),
  };
}

export type PersonDraft = {
  given: string;
  surname: string;
  patronymic: string;
  /** Surname at birth; stored as a non-primary BIRTH name. */
  birthSurname: string;
  gender: Gender;
  birthDate: string;
  birthPrecision: DatePrecision;
  birthQualifier: DateQualifier;
  deathDate: string;
  deathPrecision: DatePrecision;
  deathQualifier: DateQualifier;
  notes: string;
};

export function emptyPersonDraft(): PersonDraft {
  return {
    given: "",
    surname: "",
    patronymic: "",
    birthSurname: "",
    gender: "UNKNOWN",
    birthDate: "",
    // A new person starts on day precision so the wheel opens on a full date.
    // A blank field still saves as an unknown date (see `parseDraftDate`).
    birthPrecision: "DAY",
    birthQualifier: "EXACT",
    deathDate: "",
    deathPrecision: "DAY",
    deathQualifier: "EXACT",
    notes: "",
  };
}

/**
 * Explicit helper for the "split name" action in the person form. GEDCOM has
 * no patronymic field, so a merged value is ambiguous ("Anna Maria" may be a
 * double given name). The last word is offered as the patronymic only when the
 * user asks for it; nothing is split silently on import or when opening a form.
 */
export function splitGivenPatronymic(
  given: string,
  patronymic: string,
): { given: string; patronymic: string } {
  if (patronymic.trim() !== "") {
    return { given, patronymic };
  }
  const parts = given.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { given, patronymic };
  }
  return {
    given: parts.slice(0, -1).join(" "),
    patronymic: parts[parts.length - 1],
  };
}

/**
 * Normalises a name typed into the person form: trims the ends and upper-cases
 * the first letter of every word, including hyphenated parts (`ivan ivanov` ->
 * `Ivan Ivanov`, `petrov-vodkin` -> `Petrov-Vodkin`). The rest of the user's
 * case is preserved, so mixed-case input is not lower-cased.
 */
export function capitalizeName(value: string): string {
  return value
    .trim()
    .replace(
      /(^|[\s-])(\p{L})/gu,
      (_match: string, lead: string, letter: string) =>
        lead + letter.toLocaleUpperCase(),
    );
}

/** Name fields are normalised on save too, so a skipped blur cannot leak case. */
function normalizedNameDraft(draft: PersonDraft): PersonDraft {
  return {
    ...draft,
    given: capitalizeName(draft.given),
    surname: capitalizeName(draft.surname),
    patronymic: capitalizeName(draft.patronymic),
    birthSurname: capitalizeName(draft.birthSurname),
  };
}

function birthNameOf(
  person: Person,
  primary: PersonName | undefined,
): PersonName | undefined {
  return (
    person.names.find(
      (name) => name !== primary && name.nameType === "BIRTH",
    ) ??
    person.names.find(
      (name) =>
        name !== primary &&
        name.nameType === "MARRIED" &&
        (name.surname ?? "").trim() !== "",
    )
  );
}

/** Round-trips every qualifier; the form shows unknown ones as extra options. */
function qualifierForForm(value: DateQualifier): DateQualifier {
  return value;
}

export function draftFromPerson(person: Person): PersonDraft {
  const primary =
    person.names.find((name) => name.isPrimary) ?? person.names[0];
  return {
    given: primary?.given ?? "",
    surname: primary?.surname ?? "",
    patronymic: primary?.patronymic ?? "",
    birthSurname: birthNameOf(person, primary)?.surname ?? "",
    gender: person.gender,
    birthDate: dateValueToInput(person.birth),
    birthPrecision: person.birth.precision,
    birthQualifier: qualifierForForm(person.birth.qualifier),
    deathDate: dateValueToInput(person.death),
    deathPrecision: person.death.precision,
    deathQualifier: qualifierForForm(person.death.qualifier),
    notes: person.notes ?? "",
  };
}

export type PersonDraftError = "NAME_REQUIRED" | "DATE_INVALID";

export type PersonDraftErrors = Partial<
  Record<"name" | "birth" | "death", PersonDraftError>
>;

/**
 * Pure form validation. Unknown precision keeps whatever the user typed as
 * `date_original`; a chosen precision must parse (year-only and approximate
 * values included). At least one of given name / surname is required.
 */
export function validatePersonDraft(draft: PersonDraft): PersonDraftErrors {
  const errors: PersonDraftErrors = {};
  if (draft.given.trim() === "" && draft.surname.trim() === "") {
    errors.name = "NAME_REQUIRED";
  }
  if (!dateInputValid(draft.birthDate, draft.birthPrecision)) {
    errors.birth = "DATE_INVALID";
  }
  if (!dateInputValid(draft.deathDate, draft.deathPrecision)) {
    errors.death = "DATE_INVALID";
  }
  return errors;
}

function dateInputValid(raw: string, precision: DatePrecision): boolean {
  // A blank field means "no date" for every precision; nothing is invented.
  if (raw.trim() === "") return true;
  if (precision === "UNKNOWN") return true;
  return parseDateInput(raw, precision).ok;
}

export type PersonBuildResult =
  | { ok: true; person: PersonInput }
  | { ok: false; fields: { birth?: true; death?: true } };

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function replacePrimaryName(
  base: Person | undefined,
  draft: PersonDraft,
): PersonName[] {
  const names: PersonName[] = base
    ? base.names.map((name) => ({ ...name }))
    : [];
  if (names.length === 0) {
    names.push({
      given: null,
      patronymic: null,
      surname: null,
      prefix: null,
      suffix: null,
      nameType: "BIRTH",
      isPrimary: true,
    });
  }
  const primaryIndex = names.findIndex((name) => name.isPrimary);
  const index = primaryIndex >= 0 ? primaryIndex : 0;
  names[index] = {
    ...names[index],
    given: blankToNull(draft.given),
    surname: blankToNull(draft.surname),
    patronymic: blankToNull(draft.patronymic),
    isPrimary: true,
  };
  return applyBirthSurname(names, index, draft);
}

/**
 * Keeps the surname at birth as a non-primary BIRTH name. When the entered
 * birth surname differs from the primary surname, the primary name becomes
 * the married/current name so the two values are unambiguous.
 */
function applyBirthSurname(
  names: PersonName[],
  primaryIndex: number,
  draft: PersonDraft,
): PersonName[] {
  const primary = names[primaryIndex];
  const birthSurname = draft.birthSurname.trim();
  const existingIndex = names.findIndex(
    (name, index) => index !== primaryIndex && name.nameType === "BIRTH",
  );
  const alternateIndex =
    existingIndex >= 0
      ? existingIndex
      : names.findIndex(
          (name, index) =>
            index !== primaryIndex &&
            name.nameType === "MARRIED" &&
            (name.surname ?? "").trim() !== "",
        );

  if (birthSurname === "") {
    return alternateIndex >= 0
      ? names.filter((_, index) => index !== alternateIndex)
      : names;
  }

  if (birthSurname === (primary.surname ?? "").trim()) {
    return alternateIndex >= 0
      ? names.filter((_, index) => index !== alternateIndex)
      : names;
  }

  if (primary.nameType === "BIRTH") {
    names[primaryIndex] = { ...primary, nameType: "MARRIED" };
  }
  const birthName: PersonName = {
    given: blankToNull(draft.given),
    patronymic: blankToNull(draft.patronymic),
    surname: birthSurname,
    prefix: null,
    suffix: null,
    nameType: "BIRTH",
    isPrimary: false,
  };
  if (alternateIndex >= 0) {
    names[alternateIndex] = birthName;
  } else {
    names.push(birthName);
  }
  return names;
}

/**
 * Draft date -> `DateValue`. A blank field means "no date": it becomes an
 * unknown date instead of inventing bounds for the chosen precision. Text typed
 * under UNKNOWN precision stays in `original` exactly as before.
 */
function parseDraftDate(
  raw: string,
  precision: DatePrecision,
  qualifier: DateQualifier,
): ParsedDateInput {
  if (raw.trim() === "") return { ok: true, value: emptyDateValue() };
  return parseDateInput(raw, precision, qualifier);
}

/** Builds the command payload; secondary names and external ids survive edit. */
export function buildPersonInput(
  draft: PersonDraft,
  base?: Person,
): PersonBuildResult {
  const birth = parseDraftDate(
    draft.birthDate,
    draft.birthPrecision,
    draft.birthQualifier,
  );
  const death = parseDraftDate(
    draft.deathDate,
    draft.deathPrecision,
    draft.deathQualifier,
  );
  const fields: { birth?: true; death?: true } = {};
  if (!birth.ok) fields.birth = true;
  if (!death.ok) fields.death = true;
  if (!birth.ok || !death.ok) return { ok: false, fields };

  return {
    ok: true,
    person: {
      ...(base ? { id: base.id } : {}),
      gender: draft.gender,
      names: replacePrimaryName(base, normalizedNameDraft(draft)),
      birth: birth.value,
      death: death.value,
      notes: blankToNull(draft.notes),
      externalIds: base?.externalIds ?? [],
    },
  };
}
