// Grid layout of an event's detail fields. The registry owns which keys exist;
// this module only decides their order and whether a cell takes one column or
// the full width. Pure: no React, no DOM.

import type { EventType } from "../../api/types";
import type { ResolvedEventField } from "./fields";

export type EventFieldCell = ResolvedEventField & {
  /** 1 = half of the two-column grid, 2 = full width. */
  span: 1 | 2;
};

/** Form reading order per built-in type (not the card's display order). */
const FORM_ORDER: Partial<Record<EventType, readonly string[]>> = {
  BIRTH: ["birth_certificate", "hospital"],
  DEATH: ["cause", "death_certificate"],
  MARRIAGE: ["marriage_certificate", "marriage_rite", "officiant"],
  DIVORCE: ["divorce_certificate", "court", "reason"],
  BURIAL: ["cemetery", "grave", "burial_rite", "burial_officiant"],
  RESIDENCE: ["address"],
  OCCUPATION: ["position", "employer"],
  EDUCATION: ["institution", "faculty", "specialty", "qualification"],
};

/**
 * Keys a user may add through `event_fields.custom` for the registration
 * number. They are recognized but not built in, so no default field appears
 * unless the archive actually configured one.
 */
const ACT_RECORD_KEYS: readonly string[] = [
  "act_record",
  "act_number",
  "record_number",
];

function fullWidthKey(type: EventType, key: string): boolean {
  if (type === "DIVORCE" && key === "reason") return true;
  if (type === "RESIDENCE" && key === "address") return true;
  return false;
}

/**
 * Fields in form order with their grid span.
 *
 * - Two related facts share a row (certificate | place, cemetery | plot).
 * - Long free text (`reason`, `address`) and multiline custom fields take the
 *   whole row.
 * - The marriage officiant is full width unless an act-record field exists to
 *   pair with it.
 * - Configured and unknown keys keep their resolved order after the built-ins,
 *   so a custom map is never dropped from the form.
 */
export function layoutEventFields(
  type: EventType,
  fields: readonly ResolvedEventField[],
): EventFieldCell[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const cells: EventFieldCell[] = [];
  const placed = new Set<string>();
  const push = (field: ResolvedEventField, span: 1 | 2) => {
    if (placed.has(field.key)) return;
    placed.add(field.key);
    cells.push({ ...field, span });
  };

  const hasActRecord =
    type === "MARRIAGE" &&
    fields.some((field) => ACT_RECORD_KEYS.includes(field.key));

  for (const key of FORM_ORDER[type] ?? []) {
    const field = byKey.get(key);
    if (!field) continue;
    const officiantFullWidth =
      type === "MARRIAGE" && key === "officiant" && !hasActRecord;
    push(field, officiantFullWidth || fullWidthKey(type, key) ? 2 : 1);
  }

  for (const field of fields) {
    if (placed.has(field.key)) continue;
    push(field, field.multiline ? 2 : 1);
  }
  return cells;
}
