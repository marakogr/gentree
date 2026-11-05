// Year range of the map: a placed event is shown only when its date position
// falls inside the chosen years. Undated events stay off the map and are
// counted separately (ADR-0010: never invent a date).

import type { TimelineEntry } from "../../api/types";
import { dateOverlapsYearRange } from "../../lib/dates";

export type YearBounds = { min: number; max: number };

/**
 * Year of the event's position: `start`, or `end` for a `BEFORE` date that has
 * no start. This mirrors the timeline's `timeline_position`.
 */
export function entryYear(entry: TimelineEntry): number | null {
  const value = entry.event.date.start ?? entry.event.date.end;
  if (value === null) return null;
  const match = /^([+-]?\d{1,6})-/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

/** Min/max over placed dated events; null when nothing can be shown. */
export function yearBounds(
  entries: readonly TimelineEntry[],
): YearBounds | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const entry of entries) {
    const year = entryYear(entry);
    if (year === null) continue;
    min = min === null ? year : Math.min(min, year);
    max = max === null ? year : Math.max(max, year);
  }
  return min === null || max === null ? null : { min, max };
}

/**
 * Inclusive `[from, to]` years over the event's `[start, end)` period; an
 * undated event never matches.
 */
export function filterByYears(
  entries: readonly TimelineEntry[],
  from: number,
  to: number,
): TimelineEntry[] {
  return entries.filter((entry) =>
    dateOverlapsYearRange(entry.event.date, from, to),
  );
}
