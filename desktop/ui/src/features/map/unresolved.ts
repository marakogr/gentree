// Unresolved places on the map: events whose place was typed by hand and has
// no confirmed point. The list is local; no request is made until the user asks
// for suggestions (ADR-0020).

import type { TimelineEntry } from "../../api/types";

export type UnresolvedPlace = {
  key: string;
  label: string;
  entries: TimelineEntry[];
};

/** Case- and whitespace-insensitive identity; display text stays as typed. */
export function normalizePlaceText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * Groups unresolved events by normalized text. A place with a point is never
 * listed, and events without a place are ignored.
 */
export function groupUnresolved(
  entries: readonly TimelineEntry[],
): UnresolvedPlace[] {
  const groups = new Map<string, UnresolvedPlace>();
  for (const entry of entries) {
    const raw = entry.event.place?.trim() ?? "";
    if (raw === "" || entry.event.placeGeo) continue;
    const key = normalizePlaceText(raw);
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    groups.set(key, {
      key,
      label: raw.replace(/\s+/g, " "),
      entries: [entry],
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.entries.length - left.entries.length ||
      left.label.localeCompare(right.label),
  );
}
