// Occupation fact on the person card. The stored model keeps every job as an
// `OCCUPATION` event; the card shows only the distinct positions, in the same
// order as the events timeline (oldest first). No React, no i18n, no IPC.

import type { EventTimelineRow } from "./eventTimeline";

function normalize(position: string): string {
  return position.toLowerCase();
}

/**
 * Unique positions of the occupation rows, preserving the input order.
 * Blank positions and other event types are skipped; the same role written in
 * a different case counts once and keeps the first spelling.
 */
export function occupationPositions(
  rows: readonly EventTimelineRow[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "event" || row.event.type !== "OCCUPATION") continue;
    const position = (row.event.details?.position ?? "").trim();
    if (position === "") continue;
    const key = normalize(position);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(position);
  }
  return result;
}
