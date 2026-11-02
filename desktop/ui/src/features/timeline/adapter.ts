// Converts desktop event rows into the event shape the ported line view expects.
//
// Desktop dates are civil `YYYY-MM-DD` values with explicit `[start, end)`
// bounds; the web model uses timestamps and treats `end` as the last visible
// boundary. Exact/approximate ends are therefore dropped (precision already
// communicates the width), while a RANGE end is converted back to its inclusive
// boundary. No missing bound is ever invented.

import type {
  DatePrecision,
  DateValue,
  Gender,
  TimelineEntry,
} from "../../api/types";
import { inclusiveEnd } from "../../lib/dates";
import type { ApiDate, TimelineEvent } from "./types";

/** Civil date -> UTC timestamp accepted by `toTimelineDate`. */
export function civilToTimestamp(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Exclusive end -> last visible unit. Used only for RANGE dates, where the
 * second bound is shown to the user.
 */
export function inclusiveCivilBoundary(
  value: string,
  precision: DatePrecision,
): string {
  return inclusiveEnd(value, precision);
}

/**
 * Desktop `DateValue` -> web `ApiDate`. `EXACT`/`APPROXIMATE` keep the stored
 * half-open end out of the visible model; `BEFORE` uses its only bound; `RANGE`
 * keeps an inclusive second boundary.
 */
export function toApiDate(value: DateValue): ApiDate {
  const start = civilToTimestamp(value.start);
  let end: string | null = null;
  if (value.qualifier === "RANGE" && value.end !== null) {
    end = civilToTimestamp(inclusiveCivilBoundary(value.end, value.precision));
  } else if (value.qualifier === "BEFORE") {
    end = civilToTimestamp(value.end);
  }
  return {
    start,
    end,
    precision: value.precision,
    qualifier: value.qualifier,
    original: value.original,
  };
}

/**
 * One timeline row -> one line event; the backend-resolved name is kept.
 * Gender precedence: backend `personGender`, then the page's persons list,
 * then `UNKNOWN`. The participant only carries the key when gender is known so
 * old payload shapes stay intact.
 */
export function toTimelineEvent(
  entry: TimelineEntry,
  gender?: Gender | null,
  nameById?: ReadonlyMap<string, string>,
): TimelineEvent {
  const name = entry.personName.trim();
  const backendGender =
    entry.personGender === "MALE" || entry.personGender === "FEMALE"
      ? entry.personGender
      : null;
  const listGender =
    gender === "MALE" || gender === "FEMALE" ? gender : null;
  const resolved = backendGender ?? listGender ?? "UNKNOWN";
  const role = entry.event.type === "MARRIAGE" ? "SPOUSE" : "PARTICIPANT";
  return {
    id: entry.event.id,
    type: entry.event.originalType?.trim() || entry.event.type,
    title: null,
    description: entry.event.description,
    place: entry.event.place,
    date: toApiDate(entry.event.date),
    participants: [
      {
        personId: entry.event.personId,
        firstName: name.length > 0 ? name : null,
        lastName: null,
        role: "SUBJECT",
        ...(resolved === "UNKNOWN" ? {} : { gender: resolved }),
      },
      ...(entry.event.participantIds ?? []).map((personId) => ({
        personId,
        firstName: nameById?.get(personId) ?? null,
        lastName: null,
        role,
      })),
    ],
    mediaIds: [],
    sourceIds: entry.event.sourceIds,
  };
}

export function toTimelineEvents(
  entries: readonly TimelineEntry[],
  genderById?: ReadonlyMap<string, Gender>,
  nameById?: ReadonlyMap<string, string>,
): TimelineEvent[] {
  return entries.map((entry) =>
    toTimelineEvent(
      entry,
      genderById?.get(entry.event.personId),
      nameById,
    ),
  );
}
