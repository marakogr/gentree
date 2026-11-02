// Pure row builder for the events timeline on the person card. No React, no
// i18n: the localized date and type labels, the child-name label and the
// detail entries are passed in, so the caller owns the dictionaries and the
// tests need no provider.

import type {
  DateValue,
  EventEntity,
  Person,
  RelationshipEntity,
  Versioned,
} from "../../api/types";
import { civilDateKey } from "../../lib/dates";
import type { EventDetailEntry } from "../events/fields";

/** One metadata fragment of a row: place or a type-specific detail. */
export type EventTimelineMeta = {
  key: string;
  text: string;
};

type TimelineRowBase = {
  id: string;
  /** The stored date the row is sorted and labelled by. */
  date: DateValue;
  /** Localized date with the precision of the stored `DateValue`. */
  dateLabel: string;
  /** Localized event type, or the label of the derived child-birth row. */
  typeLabel: string;
  /** Trimmed place, `null` when the row has none. */
  place: string | null;
  /** Trimmed description, `null` when the row has none. */
  description: string | null;
  /**
   * Place followed by type-specific details, in registry order; blank values
   * are already gone. Empty when the row has no metadata at all.
   */
  meta: EventTimelineMeta[];
  /** The last row draws no continuation of the vertical thread. */
  isLast: boolean;
};

/** A stored event; the row opens the event form. */
export type EventTimelineEventRow = TimelineRowBase & {
  kind: "event";
  /** Entity version, kept so the edit form can send a conditional write. */
  version: string;
  event: EventEntity;
};

/**
 * A birth derived from a child's own `Person.birth`. It has no event, so the
 * card offers the child's name instead of the edit action.
 */
export type EventTimelineChildBirthRow = TimelineRowBase & {
  kind: "childBirth";
  /** The child whose birth the row shows. */
  personId: string;
  /** Resolved child name, passed in by the caller. */
  childName: string;
};

/** One row of the timeline, ready to render. */
export type EventTimelineRow =
  | EventTimelineEventRow
  | EventTimelineChildBirthRow;

export type EventTimelineOptions = {
  formatDate: (value: DateValue) => string;
  typeLabel: (event: EventEntity) => string;
  detailEntries: (event: EventEntity) => EventDetailEntry[];
  /**
   * Children of the card's person. Each one whose birth is not already an
   * event gets a derived row; omitted or empty means events only.
   */
  children?: readonly Person[];
  /** Localized label of a derived row, e.g. "Birth of a child". */
  childBirthLabel?: string;
  /** Resolves a child's display name; defaults to an empty string. */
  personName?: (person: Person) => string;
};

/** Relationship types where `person_id` is the parent and `related_person_id` the child. */
const PARENT_CHILD_TYPES: ReadonlySet<RelationshipEntity["type"]> = new Set([
  "PARENT_CHILD",
  "ADOPTIVE_PARENT_CHILD",
]);

function textOrNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text === "" ? null : text;
}

type BuiltRow =
  | Omit<EventTimelineEventRow, "isLast">
  | Omit<EventTimelineChildBirthRow, "isLast">;

function buildMeta(
  place: string | null,
  details: EventDetailEntry[],
): EventTimelineMeta[] {
  const meta: EventTimelineMeta[] = [];
  if (place !== null) meta.push({ key: "place", text: place });
  for (const entry of details) {
    meta.push({
      key: `detail-${entry.key}`,
      text: `${entry.label}: ${entry.value}`,
    });
  }
  return meta;
}

/**
 * Children of `parentId`, in relationship order and without duplicates.
 * Only the parent endpoint counts: for `PARENT_CHILD` and
 * `ADOPTIVE_PARENT_CHILD` the parent is `personId` and the child
 * `relatedPersonId`. A child missing from `persons` is skipped rather than
 * invented.
 */
export function childrenOf(
  parentId: string,
  relationships: readonly Versioned<RelationshipEntity>[],
  persons: readonly Person[],
): Person[] {
  const byId = new Map(persons.map((person) => [person.id, person]));
  const seen = new Set<string>();
  const children: Person[] = [];
  for (const { entity } of relationships) {
    if (!PARENT_CHILD_TYPES.has(entity.type)) continue;
    if (entity.personId !== parentId) continue;
    const childId = entity.relatedPersonId;
    if (childId === parentId || seen.has(childId)) continue;
    const child = byId.get(childId);
    if (!child) continue;
    seen.add(childId);
    children.push(child);
  }
  return children;
}

/**
 * A child's own birth event already shows the birth, whether the child owns
 * it or is a participant of it. The derived row must not repeat it.
 */
export function hasBirthEvent(
  events: readonly Versioned<EventEntity>[],
  personId: string,
): boolean {
  return events.some(
    ({ entity }) =>
      entity.type === "BIRTH" &&
      (entity.personId === personId ||
        (entity.participantIds ?? []).includes(personId)),
  );
}

/** Sortable day key for any row; no bounds means an unknown date. */
function rowDateKey(date: DateValue): number | null {
  const value = date.start ?? date.end;
  return value === null ? null : civilDateKey(value);
}

/**
 * Builds the timeline oldest first; undated rows stay last and equal dates
 * keep their insertion order (events first, then derived rows) because
 * `Array.prototype.sort` is stable. Nothing is invented: a missing place or
 * description becomes `null` so the card can omit the line instead of
 * rendering a dash.
 */
export function buildEventTimeline(
  events: readonly Versioned<EventEntity>[],
  options: EventTimelineOptions,
): EventTimelineRow[] {
  const rows: BuiltRow[] = events.map((row) => {
    const place = textOrNull(row.entity.place);
    return {
      kind: "event",
      id: row.entity.id,
      version: row.version,
      event: row.entity,
      date: row.entity.date,
      dateLabel: options.formatDate(row.entity.date),
      typeLabel: options.typeLabel(row.entity),
      place,
      description: textOrNull(row.entity.description),
      meta: buildMeta(place, options.detailEntries(row.entity)),
    };
  });

  const children = options.children ?? [];
  for (const child of children) {
    if (hasBirthEvent(events, child.id)) continue;
    rows.push({
      kind: "childBirth",
      id: `child-birth:${child.id}`,
      personId: child.id,
      childName: options.personName?.(child) ?? "",
      date: child.birth,
      dateLabel: options.formatDate(child.birth),
      typeLabel: options.childBirthLabel ?? "",
      place: null,
      description: null,
      meta: [],
    });
  }

  rows.sort((left, right) => {
    const a = rowDateKey(left.date);
    const b = rowDateKey(right.date);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  return rows.map((row, index) => ({
    ...row,
    isLast: index === rows.length - 1,
  }));
}
