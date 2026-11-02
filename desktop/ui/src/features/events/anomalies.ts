// Data-quality checks for the events screen ("Check the data" badge).
// Pure: no React, no IPC. Dates are compared at the coarsest precision of the
// two values involved, so a year-only date never produces a false positive
// against a day-precise one, and UNKNOWN/empty dates are never compared.

import type {
  CivilDate,
  DateValue,
  EventEntity,
  EventType,
  Person,
  Versioned,
} from "../../api/types";
import { parseCivilDate } from "../../lib/dates";

export type AnomalyCode =
  | "DUPLICATE_DEATH"
  | "DUPLICATE_BIRTH"
  | "BIRTH_AFTER_DEATH"
  | "EVENT_AFTER_DEATH"
  | "EVENT_BEFORE_BIRTH"
  | "FUTURE_DATE";

/** Stable order used for per-row badges and for `anomalySummary` keys. */
export const ANOMALY_CODES: readonly AnomalyCode[] = [
  "DUPLICATE_DEATH",
  "DUPLICATE_BIRTH",
  "BIRTH_AFTER_DEATH",
  "EVENT_AFTER_DEATH",
  "EVENT_BEFORE_BIRTH",
  "FUTURE_DATE",
];

/** Events that are allowed to happen on or after the death date. */
const AFTER_DEATH_ALLOWED: ReadonlySet<EventType> = new Set<EventType>([
  "DEATH",
  "BURIAL",
]);

/** Events that are allowed to happen on or before the birth date. */
const BEFORE_BIRTH_ALLOWED: ReadonlySet<EventType> = new Set<EventType>([
  "BIRTH",
]);

/** Day, month or year of a date, depending on its precision. */
type DateUnit = { rank: 1 | 2 | 3; key: string };

function unitOf(value: DateValue | null | undefined): DateUnit | null {
  if (!value || value.precision === "UNKNOWN" || !value.start) return null;
  const canonical = parseCivilDate(value.start);
  if (canonical === null) return null;
  if (value.precision === "YEAR") {
    return { rank: 1, key: canonical.slice(0, 4) };
  }
  if (value.precision === "MONTH") {
    return { rank: 2, key: canonical.slice(0, 7) };
  }
  return { rank: 3, key: canonical };
}

function truncate(unit: DateUnit, rank: 1 | 2 | 3): string {
  if (rank === 1) return unit.key.slice(0, 4);
  if (rank === 2) return unit.key.slice(0, 7);
  return unit.key;
}

/**
 * Compares two dates at the coarser of their precisions. Returns `null` when
 * either side is undated or UNKNOWN, i.e. "cannot tell", never "equal".
 */
function compareDates(
  left: DateValue | null | undefined,
  right: DateValue | null | undefined,
): -1 | 0 | 1 | null {
  const a = unitOf(left);
  const b = unitOf(right);
  if (a === null || b === null) return null;
  const rank = Math.min(a.rank, b.rank) as 1 | 2 | 3;
  const ka = truncate(a, rank);
  const kb = truncate(b, rank);
  if (ka === kb) return 0;
  return ka < kb ? -1 : 1;
}

/** Parses a `YYYY-MM-DD` value into the same shape as a DAY-precise date. */
function dayValue(iso: CivilDate): DateValue {
  const canonical = parseCivilDate(iso);
  return {
    start: canonical,
    end: null,
    precision: canonical === null ? "UNKNOWN" : "DAY",
    qualifier: canonical === null ? "UNKNOWN" : "EXACT",
    original: null,
  };
}

/** Today in UTC as `YYYY-MM-DD`; day-precise by construction. */
export function todayCivilDate(now: Date = new Date()): CivilDate {
  return now.toISOString().slice(0, 10);
}

function hasStart(value: DateValue | null | undefined): value is DateValue {
  return Boolean(value && value.start && value.precision !== "UNKNOWN");
}

/** Earliest dated event of one type, or `null` when there is none. */
function firstEventDate(
  events: readonly Versioned<EventEntity>[],
  type: EventType,
): DateValue | null {
  let best: DateValue | null = null;
  for (const { entity } of events) {
    if (entity.type !== type || !hasStart(entity.date)) continue;
    const order = compareDates(entity.date, best);
    if (best === null || order === -1) best = entity.date;
  }
  return best;
}

/** Combines the person's own dates with the earliest matching event date. */
function boundaryDate(
  own: DateValue,
  eventsOfPerson: readonly Versioned<EventEntity>[],
  type: "BIRTH" | "DEATH",
): DateValue | null {
  if (hasStart(own)) return own;
  return firstEventDate(eventsOfPerson, type);
}

/**
 * Flags suspicious events of one tree.
 *
 * The map is keyed by event id; codes are ordered as in `ANOMALY_CODES`.
 * Structural duplicates (two DEATH/BIRTH events for one person) are reported
 * on every event of that kind, because the UI cannot tell which one is wrong.
 * Date checks use `person.birth`/`person.death` when dated, otherwise the
 * earliest BIRTH/DEATH event of that person.
 *
 * @param today reference day for FUTURE_DATE (`YYYY-MM-DD`); injectable so
 *   tests never depend on the wall clock.
 */
export function detectAnomalies(
  events: readonly Versioned<EventEntity>[],
  persons: readonly Versioned<Person>[],
  today: CivilDate = todayCivilDate(),
): Map<string, AnomalyCode[]> {
  const todayValue = dayValue(today);
  const eventsByPerson = new Map<string, Versioned<EventEntity>[]>();
  for (const event of events) {
    const list = eventsByPerson.get(event.entity.personId);
    if (list) list.push(event);
    else eventsByPerson.set(event.entity.personId, [event]);
  }

  const birthCount = new Map<string, number>();
  const deathCount = new Map<string, number>();
  for (const { entity } of events) {
    if (entity.type === "BIRTH") {
      birthCount.set(entity.personId, (birthCount.get(entity.personId) ?? 0) + 1);
    } else if (entity.type === "DEATH") {
      deathCount.set(entity.personId, (deathCount.get(entity.personId) ?? 0) + 1);
    }
  }

  const boundaryByPerson = new Map<
    string,
    { birth: DateValue | null; death: DateValue | null }
  >();
  for (const { entity } of persons) {
    const own = eventsByPerson.get(entity.id) ?? [];
    boundaryByPerson.set(entity.id, {
      birth: boundaryDate(entity.birth, own, "BIRTH"),
      death: boundaryDate(entity.death, own, "DEATH"),
    });
  }

  const found = new Map<string, Set<AnomalyCode>>();
  const flag = (eventId: string, code: AnomalyCode): void => {
    const codes = found.get(eventId);
    if (codes) codes.add(code);
    else found.set(eventId, new Set<AnomalyCode>([code]));
  };

  for (const { entity } of events) {
    if ((deathCount.get(entity.personId) ?? 0) > 1 && entity.type === "DEATH") {
      flag(entity.id, "DUPLICATE_DEATH");
    }
    if ((birthCount.get(entity.personId) ?? 0) > 1 && entity.type === "BIRTH") {
      flag(entity.id, "DUPLICATE_BIRTH");
    }

    const boundary = boundaryByPerson.get(entity.personId);

    // A future date at the event's own precision: a year-only "2026" is not
    // future while today is still in 2026.
    if (compareDates(entity.date, todayValue) === 1) {
      flag(entity.id, "FUTURE_DATE");
    }

    if (boundary) {
      const beforeDeath = compareDates(boundary.birth, boundary.death) === 1;
      if (beforeDeath) {
        if (entity.type === "BIRTH" || entity.type === "DEATH") {
          flag(entity.id, "BIRTH_AFTER_DEATH");
        }
      }

      const death = boundary.death;
      if (
        death !== null &&
        !AFTER_DEATH_ALLOWED.has(entity.type) &&
        compareDates(entity.date, death) === 1
      ) {
        flag(entity.id, "EVENT_AFTER_DEATH");
      }

      const birth = boundary.birth;
      if (
        birth !== null &&
        !BEFORE_BIRTH_ALLOWED.has(entity.type) &&
        compareDates(entity.date, birth) === -1
      ) {
        flag(entity.id, "EVENT_BEFORE_BIRTH");
      }
    }
  }

  const result = new Map<string, AnomalyCode[]>();
  for (const [eventId, codes] of found) {
    result.set(
      eventId,
      ANOMALY_CODES.filter((code) => codes.has(code)),
    );
  }
  return result;
}

/** Per-code counters for the badge; every code is present, zeros included. */
export function anomalySummary(
  anomalies: ReadonlyMap<string, readonly AnomalyCode[]>,
): Record<AnomalyCode, number> {
  const summary = {} as Record<AnomalyCode, number>;
  for (const code of ANOMALY_CODES) summary[code] = 0;
  for (const codes of anomalies.values()) {
    for (const code of codes) summary[code] += 1;
  }
  return summary;
}
