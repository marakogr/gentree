// Pure helpers for the events screen: form <-> Event conversion, client-side
// search/filtering/sorting/paging and the column visibility rule. No React, no
// DOM, no IPC, so everything here is covered by the node vitest suite.

import type {
  CivilDate,
  DatePrecision,
  DateQualifier,
  DateValue,
  EventEntity,
  EventInput,
  EventType,
  PlaceGeo,
} from "../../api/types";
import {
  civilDateKey,
  dateOverlapsYearRange,
  dateValueToInput,
  emptyDateValue,
  parseCivilDate,
  parseDateInput,
  type ParsedDateInput,
} from "../../lib/dates";
import { EMPTY_VALUE } from "../../lib/formatValue";
import type { SortDirection, ViewFilters } from "../../lib/viewState";
import { parsePeriodInput, periodFromDate, supportsDateRange } from "./datePeriod";
import { isPairedEventType } from "./eventRoles";

/** Every event type in the order used by the form select and the type chips. */
export const EVENT_TYPES: readonly EventType[] = [
  "BIRTH",
  "DEATH",
  "MARRIAGE",
  "DIVORCE",
  "BURIAL",
  "RESIDENCE",
  "OCCUPATION",
  "EDUCATION",
  "OTHER",
];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Select values for custom names are prefixed so a user-defined name can never
 * collide with a built-in enum value such as `BIRTH`.
 */
export const CUSTOM_EVENT_TYPE_PREFIX = "custom:";

/**
 * Case-insensitive lookup of a custom type name in the configured list.
 * Returns the stored spelling, or `null` when the list does not contain it.
 */
export function findCustomEventType(
  name: string,
  customTypes: readonly string[],
): string | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return null;
  return (
    customTypes.find((item) => item.trim().toLowerCase() === wanted) ?? null
  );
}

/**
 * Value of the type select for a draft. A custom type (stored as `OTHER` plus
 * `originalType`) selects its own option; everything else uses the enum.
 */
export function eventTypeSelectionValue(
  type: EventType,
  originalType: string | null | undefined,
  customTypes: readonly string[],
): string {
  const custom =
    type === "OTHER"
      ? findCustomEventType(originalType ?? "", customTypes)
      : null;
  return custom === null ? type : `${CUSTOM_EVENT_TYPE_PREFIX}${custom}`;
}

/**
 * Type select value -> draft fields. Built-in types clear `originalType`; a
 * custom option becomes `OTHER` plus its name.
 */
export function readEventTypeSelection(
  value: string,
  customTypes: readonly string[],
): { eventType: EventType; originalType: string | null } {
  if (value.startsWith(CUSTOM_EVENT_TYPE_PREFIX)) {
    const name = value.slice(CUSTOM_EVENT_TYPE_PREFIX.length);
    const custom = findCustomEventType(name, customTypes);
    return { eventType: "OTHER", originalType: custom };
  }
  return {
    eventType: isEventType(value) ? value : "OTHER",
    originalType: null,
  };
}

/**
 * Human label for an event type. A custom type keeps its configured name; a
 * built-in type uses the localized enum label. `t` must resolve the `enums`
 * namespace, e.g. `(key) => t(key)`.
 */
export function eventTypeLabel(
  type: EventType,
  originalType: string | null | undefined,
  t: (key: string) => string,
): string {
  const custom = (originalType ?? "").trim();
  if (type === "OTHER" && custom !== "") return custom;
  return t(`enums:eventType.${type}`);
}

/** Rows per page in the events table (client-side, the whole list is fetched). */
export const EVENT_PAGE_SIZE = 50;

/** The place column is hidden once at least this share of rows has no place. */
export const PLACE_HIDE_SHARE = 0.8;

/* ------------------------------------------------------------------------- */
/* Form draft                                                                */
/* ------------------------------------------------------------------------- */

export type EventDraft = {
  personId: string;
  /** Second participant of a marriage/divorce; empty when unknown. */
  spouseId: string;
  /** Selected parents of a birth, at most two; other types keep [] . */
  parentIds: string[];
  eventType: EventType;
  /**
   * Name of a user-defined type from the config (stored as `OTHER` plus this
   * value), or the imported source type. `null` for a plain built-in type.
   */
  originalType: string | null;
  /** Start (or the only date) rendered by the date field. */
  date: string;
  /** End of an explicit period; ignored unless `dateMode` is `"range"`. */
  dateEnd: string;
  /**
   * An open-ended residence period. When true, `dateEnd` is ignored and the
   * stored `RANGE` has no end. Only offered for `RESIDENCE`.
   */
  dateOngoing: boolean;
  /**
   * `"range"` stores one RANGE `DateValue`; `"single"` keeps the historical
   * one-bound date. Only range-capable types offer the switch.
   */
  dateMode: "single" | "range";
  precision: DatePrecision;
  /** Only EXACT/APPROXIMATE are offered; other stored values survive editing. */
  qualifier: DateQualifier;
  place: string;
  /** Confirmed map point for `place` (ADR-0020); null when not chosen. */
  placeGeo: PlaceGeo | null;
  description: string;
  /** Type-specific values keyed by the stable detail id (ADR-0015). */
  details: Record<string, string>;
};

export function emptyEventDraft(
  personId = "",
  eventType: EventType = "BIRTH",
): EventDraft {
  return {
    personId,
    spouseId: "",
    parentIds: [],
    eventType,
    originalType: null,
    date: "",
    dateEnd: "",
    dateOngoing: false,
    // A new event starts on day precision; a blank date still saves as an
    // unknown date (see `parseDraftDateValue`).
    dateMode: "single",
    precision: "DAY",
    qualifier: "EXACT",
    place: "",
    placeGeo: null,
    description: "",
    details: {},
  };
}

export function draftFromEvent(event: EventEntity): EventDraft {
  const period = supportsDateRange(event.type)
    ? periodFromDate(event.date)
    : null;
  return {
    personId: event.personId,
    spouseId: event.participantIds?.[0] ?? "",
    parentIds: event.type === "BIRTH" ? [...(event.participantIds ?? [])] : [],
    eventType: event.type,
    originalType: event.originalType ?? null,
    date: dateValueToInput(event.date),
    dateEnd: period?.to ?? "",
    dateOngoing: period !== null && period.to === "",
    dateMode: period === null ? "single" : "range",
    precision: event.date.precision,
    qualifier: event.date.qualifier,
    place: event.place ?? "",
    placeGeo: event.placeGeo ?? null,
    description: event.description ?? "",
    details: { ...(event.details ?? {}) },
  };
}

function sameDetails(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * True when the form holds edits the stored event does not have. Used to keep
 * "add a related event" from silently discarding unsaved input.
 */
export function isEventDraftDirty(
  draft: EventDraft,
  base: EventEntity,
): boolean {
  const stored = draftFromEvent(base);
  return (
    draft.personId !== stored.personId ||
    draft.spouseId !== stored.spouseId ||
    draft.parentIds.join("|") !== stored.parentIds.join("|") ||
    draft.eventType !== stored.eventType ||
    draft.originalType !== stored.originalType ||
    draft.date !== stored.date ||
    draft.dateEnd !== stored.dateEnd ||
    draft.dateOngoing !== stored.dateOngoing ||
    draft.dateMode !== stored.dateMode ||
    draft.precision !== stored.precision ||
    draft.qualifier !== stored.qualifier ||
    draft.place !== stored.place ||
    draft.description !== stored.description ||
    !sameDetails(draft.details, stored.details)
  );
}

/**
 * Drops blank keys and values so an emptied field is removed from the stored
 * map. Keys are stable ids: never lowercased or renamed here, because a rename
 * would orphan the stored value.
 */
export function sanitizeEventDetails(
  details: Readonly<Record<string, string>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === "" || value === "") continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export type EventBuildResult =
  | { ok: true; event: EventInput }
  | {
      ok: false;
      fields: { date?: true; personId?: true; participantIds?: true };
    };

export type DraftDateResult =
  | { ok: true; value: DateValue }
  | { ok: false; reason: "format" | "incomplete" | "order" };

/**
 * Draft date -> `DateValue`. A blank field means "no date": it becomes an
 * unknown date instead of inventing bounds for the chosen precision. Text typed
 * under UNKNOWN precision stays in `original` exactly as before. A period needs
 * both bounds and keeps the half-open `end` produced by `parseDateInput`.
 */
export function parseDraftDateValue(draft: EventDraft): DraftDateResult {
  if (draft.dateMode === "range" && draft.precision !== "UNKNOWN") {
    const allowOpenEnd = draft.eventType === "RESIDENCE" && draft.dateOngoing;
    return parsePeriodInput(
      draft.date,
      allowOpenEnd ? "" : draft.dateEnd,
      draft.precision,
      allowOpenEnd,
    );
  }
  if (draft.date.trim() === "") return { ok: true, value: emptyDateValue() };
  const parsed: ParsedDateInput = parseDateInput(
    draft.date,
    draft.precision,
    draft.qualifier,
  );
  return parsed.ok ? parsed : { ok: false, reason: "format" };
}

export function buildEventInput(
  draft: EventDraft,
  base?: EventEntity,
): EventBuildResult {
  const fields: { date?: true; personId?: true; participantIds?: true } = {};
  if (draft.personId === "") fields.personId = true;

  // A second participant is required for a new paired event. An existing
  // legacy marriage/divorce that already has only one participant stays
  // saveable: the form never forces historical data into a new shape.
  const paired = isPairedEventType(draft.eventType);
  const sameAsPrimary = draft.spouseId === draft.personId;
  const spouseId = sameAsPrimary ? "" : draft.spouseId;
  const requiresSecond =
    paired && (!base || (base.participantIds ?? []).length > 0);
  if (requiresSecond && spouseId === "") fields.participantIds = true;

  const parsed = parseDraftDateValue(draft);
  if (!parsed.ok) {
    fields.date = true;
    return { ok: false, fields };
  }
  if (fields.personId || fields.participantIds) {
    return { ok: false, fields };
  }

  const place = draft.place.trim();
  const description = draft.description.trim();
  const participantIds = paired
    ? spouseId === ""
      ? []
      : [spouseId]
    : draft.eventType === "BIRTH"
      ? Array.from(
          new Set(
            draft.parentIds.filter(
              (id) => id !== "" && id !== draft.personId,
            ),
          ),
        )
      : (base?.participantIds ?? []);
  const details = sanitizeEventDetails(draft.details);
  return {
    ok: true,
    event: {
      ...(base ? { id: base.id } : {}),
      personId: draft.personId,
      type: draft.eventType,
      date: parsed.value,
      place: place === "" ? null : place,
      // Preserve a point the user already confirmed; an empty draft sends none,
      // which clears it on update (ADR-0020).
      ...(draft.placeGeo ? { placeGeo: draft.placeGeo } : {}),
      description: description === "" ? null : description,
      sourceIds: base?.sourceIds ?? [],
      originalType: draft.originalType,
      participantIds,
      // Omit an empty map: the JSON contract skips it, and an update without
      // `details` clears the stored map because the backend defaults to empty.
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Server-side date range filter (kept for the half-open API contract)        */
/* ------------------------------------------------------------------------- */

export type EventFilterValues = {
  personId: string;
  eventType: EventType | "";
  from: string;
  to: string;
};

/** Half-open `[start, end)` overlap, mirroring the Rust `event.list` filter. */
export function dateOverlaps(
  value: DateValue,
  from: CivilDate | null,
  to: CivilDate | null,
): boolean {
  const afterFrom = (() => {
    if (!from) return true;
    const bound = civilDateKey(from);
    if (value.end) return civilDateKey(value.end) > bound;
    if (value.start) return civilDateKey(value.start) >= bound;
    return false;
  })();
  const beforeTo = (() => {
    if (!to) return true;
    const bound = civilDateKey(to);
    if (value.start) return civilDateKey(value.start) < bound;
    if (value.end) return civilDateKey(value.end) <= bound;
    return false;
  })();
  return afterFrom && beforeTo;
}

export function eventMatchesFilters(
  event: EventEntity,
  filters: EventFilterValues,
): boolean {
  if (
    filters.personId !== "" &&
    event.personId !== filters.personId &&
    !(event.participantIds ?? []).includes(filters.personId)
  ) {
    return false;
  }
  if (filters.eventType !== "" && event.type !== filters.eventType) {
    return false;
  }
  const from = filters.from === "" ? null : parseCivilDate(filters.from);
  const to = filters.to === "" ? null : parseCivilDate(filters.to);
  return dateOverlaps(event.date, from, to);
}

export function filterEvents(
  events: EventEntity[],
  filters: EventFilterValues,
): EventEntity[] {
  return events.filter((event) => eventMatchesFilters(event, filters));
}

/* ------------------------------------------------------------------------- */
/* Date keys and the legacy one-key date sort                                 */
/* ------------------------------------------------------------------------- */

/** Sortable day key; an open start bound falls back to the end bound. */
export function eventDateKey(event: EventEntity): number | null {
  const value = event.date.start ?? event.date.end;
  return value ? civilDateKey(value) : null;
}

/**
 * Table cell text for a date. Wraps the shared formatter, but a date with no
 * bounds and no original text renders the em dash instead of a sentence.
 */
export function eventDateLabel(
  date: DateValue,
  format: (value: DateValue) => string,
): string {
  const hasBound = date.start !== null || date.end !== null;
  const hasOriginal = (date.original ?? "").trim() !== "";
  if (date.precision === "UNKNOWN" && !hasBound && !hasOriginal) {
    return EMPTY_VALUE;
  }
  return format(date);
}

export type EventDateSort = "oldest" | "newest";

/** Undated events stay last for both directions; equal dates keep their order. */
export function compareEventsByDate(
  left: EventEntity,
  right: EventEntity,
  sort: EventDateSort,
): number {
  const a = eventDateKey(left);
  const b = eventDateKey(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return sort === "newest" ? b - a : a - b;
}

export function sortEventsByDate<T extends { entity: EventEntity }>(
  rows: readonly T[],
  sort: EventDateSort,
): T[] {
  return [...rows].sort((left, right) =>
    compareEventsByDate(left.entity, right.entity, sort),
  );
}

/** Unique participants in display order: the primary person first. */
export function eventPersonIds(event: EventEntity): string[] {
  const ids = [event.personId, ...(event.participantIds ?? [])].filter(
    (id) => id !== "",
  );
  return [...new Set(ids)];
}

/**
 * Owner shown in the «person» table column. Participants are deliberately left
 * out: they stay in the event card. A blank owner yields `null` so the cell
 * falls back to the neutral empty value.
 */
export function eventOwnerId(event: EventEntity): string | null {
  return event.personId.trim() === "" ? null : event.personId;
}

/* ------------------------------------------------------------------------- */
/* Client-side list: search, filters, sorting, paging, columns                */
/* ------------------------------------------------------------------------- */

/** Locale-free row text used by the search and the type/person sorts. */
export type EventRowContext = {
  personName: string;
  typeLabel: string;
};

/** Which relatives of the chosen person take part in the event filter. */
export type EventPersonScope =
  | "person"
  | "ancestors"
  | "descendants"
  | "both";

export const EVENT_PERSON_SCOPES: readonly EventPersonScope[] = [
  "person",
  "ancestors",
  "descendants",
  "both",
];

export function isEventPersonScope(value: unknown): value is EventPersonScope {
  return (
    typeof value === "string" &&
    (EVENT_PERSON_SCOPES as readonly string[]).includes(value)
  );
}

export type EventListFilters = {
  personId: string;
  /** Relatives included with `personId`; ignored when no person is chosen. */
  personScope: EventPersonScope;
  /** Empty list means "every type". */
  types: readonly EventType[];
  /** `YYYY` strings; empty means "no bound". */
  fromYear: string;
  toYear: string;
};

export type EventColumn = "date" | "type" | "person" | "place";

/** Canonical column order, also the order used by the columns menu. */
export const EVENT_COLUMNS: readonly EventColumn[] = [
  "date",
  "type",
  "person",
  "place",
];

export type EventSortKey = "date" | "type" | "person";

export type EventSortState = {
  key: EventSortKey;
  direction: SortDirection;
};

const SORT_KEYS: readonly string[] = ["date", "type", "person"];

export function isEventSortKey(value: string): value is EventSortKey {
  return SORT_KEYS.includes(value);
}

/** Lowercase and fold the Cyrillic yo letter, mirroring the UI kit search. */
export function normalizeEventText(value: string): string {
  return value.toLowerCase().replace(/\u0451/g, "\u0435");
}

/**
 * Live search over place, description, person name, type label and the stored
 * detail values. The raw event type is included too, so "birth" finds a BIRTH
 * row in any locale.
 */
export function matchesEventQuery(
  event: EventEntity,
  context: EventRowContext,
  query: string,
): boolean {
  const needle = normalizeEventText(query.trim());
  if (needle === "") return true;
  const details = Object.values(event.details ?? {}).filter(
    (value) => value.trim() !== "",
  );
  return [
    event.place ?? "",
    event.description ?? "",
    event.originalType ?? "",
    event.type,
    context.personName,
    context.typeLabel,
    ...details,
  ].some((value) => normalizeEventText(value).includes(needle));
}

/** Calendar year of an event, whichever bound is present (`null` if undated). */
export function eventYear(event: EventEntity): number | null {
  const key = eventDateKey(event);
  if (key === null || key === 0) return null;
  return Math.floor(key / 10000);
}

export type EventYearBounds = {
  /** Earliest year among the dated rows; never after `maxYear`. */
  minYear: number;
  /** End of the scale: the current year. */
  maxYear: number;
  /** False when no row has a date, so there is nothing to slide over. */
  hasDated: boolean;
};

/**
 * Scale of the year slider: the earliest dated row up to the current year.
 * Without dated rows both ends collapse to the current year.
 */
export function eventYearBounds(
  rows: readonly { entity: EventEntity }[],
  currentYear: number,
): EventYearBounds {
  const maxYear = Math.trunc(currentYear);
  let earliest: number | null = null;
  for (const row of rows) {
    const year = eventYear(row.entity);
    if (year === null) continue;
    if (earliest === null || year < earliest) earliest = year;
  }
  if (earliest === null) return { minYear: maxYear, maxYear, hasDated: false };
  return { minYear: Math.min(earliest, maxYear), maxYear, hasDated: true };
}

function parseYearBound(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Year filter overlap: the event matches `fromYear..toYear` when its
 * `[start, end)` interval intersects `[from-01-01, (to+1)-01-01)`. An open end
 * runs to today; an undated event never matches a bounded range.
 */
export function eventYearOverlaps(
  event: EventEntity,
  fromYear: string,
  toYear: string,
  today: Date = new Date(),
): boolean {
  return dateOverlapsYearRange(
    event.date,
    parseYearBound(fromYear),
    parseYearBound(toYear),
    today,
  );
}

/** True when both bounds are present and the lower one is later. */
export function isYearRangeInvalid(
  fromYear: string,
  toYear: string,
): boolean {
  const from = parseYearBound(fromYear);
  const to = parseYearBound(toYear);
  return from !== null && to !== null && from > to;
}

export function matchesEventListFilters(
  event: EventEntity,
  filters: EventListFilters,
  personIds?: ReadonlySet<string> | null,
): boolean {
  if (personIds && personIds.size > 0) {
    const involved =
      personIds.has(event.personId) ||
      (event.participantIds ?? []).some((personId) => personIds.has(personId));
    if (!involved) return false;
  } else if (
    filters.personId !== "" &&
    event.personId !== filters.personId &&
    !(event.participantIds ?? []).includes(filters.personId)
  ) {
    return false;
  }
  if (filters.types.length > 0 && !filters.types.includes(event.type)) {
    return false;
  }
  return eventYearOverlaps(event, filters.fromYear, filters.toYear);
}

/** Search + person/type/year filters over already fetched rows. */
export function filterEventRows<T extends { entity: EventEntity }>(
  rows: readonly T[],
  query: string,
  filters: EventListFilters,
  context: (event: EventEntity) => EventRowContext,
  personIds?: ReadonlySet<string> | null,
): T[] {
  return rows.filter(
    (row) =>
      matchesEventListFilters(row.entity, filters, personIds) &&
      matchesEventQuery(row.entity, context(row.entity), query),
  );
}

function applyDirection(value: number, direction: SortDirection): number {
  if (value === 0) return 0;
  return direction === "desc" ? -value : value;
}

function compareRowText(
  left: string,
  right: string,
  direction: SortDirection,
): number {
  const result = normalizeEventText(left).localeCompare(
    normalizeEventText(right),
  );
  return applyDirection(result, direction);
}

function compareRowDates(
  left: EventEntity,
  right: EventEntity,
  direction: SortDirection,
): number {
  const a = eventDateKey(left);
  const b = eventDateKey(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return applyDirection(a - b, direction);
}

/**
 * Sorts rows by date, type or person. Undated rows stay last in both
 * directions for the date key; equal keys keep the incoming order.
 */
export function sortEventRows<T extends { entity: EventEntity }>(
  rows: readonly T[],
  sort: EventSortState | null,
  context: (event: EventEntity) => EventRowContext,
): T[] {
  const active: EventSortState = sort ?? { key: "date", direction: "asc" };
  return [...rows].sort((left, right) => {
    if (active.key === "date") {
      return compareRowDates(left.entity, right.entity, active.direction);
    }
    const pick = (event: EventEntity): string =>
      active.key === "person"
        ? context(event).personName
        : context(event).typeLabel;
    return compareRowText(pick(left.entity), pick(right.entity), active.direction);
  });
}

export type EventPageSlice<T> = {
  rows: T[];
  /** Clamped, 0-based page actually shown. */
  page: number;
  totalPages: number;
  total: number;
  offset: number;
};

/** Client-side paging with a clamp so a shrinking list cannot strand a user. */
export function paginateEventRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = EVENT_PAGE_SIZE,
): EventPageSlice<T> {
  const size = Number.isFinite(pageSize) && pageSize > 0
    ? Math.floor(pageSize)
    : EVENT_PAGE_SIZE;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(page) ? Math.floor(page) : 0;
  const safePage = Math.min(Math.max(0, requested), totalPages - 1);
  const offset = safePage * size;
  return {
    rows: rows.slice(offset, offset + size),
    page: safePage,
    totalPages,
    total,
    offset,
  };
}

export function isBlankPlace(value: string | null | undefined): boolean {
  return (value ?? "").trim() === "";
}

/** The place column is useful while at least 20% of rows have a place. */
export function shouldShowPlaceColumn(
  rows: readonly { entity: EventEntity }[],
  hideShare: number = PLACE_HIDE_SHARE,
): boolean {
  if (rows.length === 0) return false;
  const empty = rows.filter((row) => isBlankPlace(row.entity.place)).length;
  return empty / rows.length < hideShare;
}

function defaultEventColumns(
  rows: readonly { entity: EventEntity }[],
): EventColumn[] {
  const base: EventColumn[] = ["date", "type", "person"];
  return shouldShowPlaceColumn(rows) ? [...base, "place"] : base;
}

/**
 * Columns to render: the stored user choice when it has known columns,
 * otherwise the default (place hidden for mostly-empty data).
 */
export function resolveEventColumns(
  stored: readonly string[] | undefined,
  rows: readonly { entity: EventEntity }[],
): EventColumn[] {
  if (!stored || stored.length === 0) return defaultEventColumns(rows);
  const known = EVENT_COLUMNS.filter((column) => stored.includes(column));
  return known.length > 0 ? known : defaultEventColumns(rows);
}

/* ------------------------------------------------------------------------- */
/* View-state filters                                                         */
/* ------------------------------------------------------------------------- */

/** Parses the serialisable section filters into typed event filters. */
export function readEventFilters(filters: ViewFilters): EventListFilters {
  const personId =
    typeof filters.personId === "string" ? filters.personId : "";
  const rawTypes = filters.types;
  const types = Array.isArray(rawTypes)
    ? rawTypes.filter(isEventType)
    : [];
  return {
    personId,
    personScope: isEventPersonScope(filters.personScope)
      ? filters.personScope
      : "person",
    types,
    fromYear: typeof filters.fromYear === "string" ? filters.fromYear : "",
    toYear: typeof filters.toYear === "string" ? filters.toYear : "",
  };
}

/** Stored column choice, or `undefined` when the user never chose. */
export function readEventColumns(
  filters: ViewFilters,
): EventColumn[] | undefined {
  const raw = filters.columns;
  if (!Array.isArray(raw)) return undefined;
  const known = EVENT_COLUMNS.filter((column) => raw.includes(column));
  return known.length > 0 ? known : undefined;
}

/**
 * Copies the filter map without the event filter values, keeping unrelated
 * entries such as the column choice.
 */
export function clearEventFilterValues(filters: ViewFilters): ViewFilters {
  let next: ViewFilters = { ...filters };
  for (const key of ["personId", "personScope", "types", "fromYear", "toYear"]) {
    next = withFilterValue(next, key, "");
  }
  return next;
}

/**
 * Copies the filter map with one key set, or removed when the value is empty.
 * Keeps the persisted view state free of empty strings/arrays.
 */
export function withFilterValue(
  filters: ViewFilters,
  key: string,
  value: string | string[] | undefined,
): ViewFilters {
  const next: ViewFilters = { ...filters };
  const isEmpty =
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  if (isEmpty) delete next[key];
  else next[key] = value;
  return next;
}
