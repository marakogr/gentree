// Pure helpers for type-specific event detail fields (ADR-0015): the curated
// built-in key registry, the config-driven custom fields and the mapping from
// a stored `details` map to display rows. No React, no DOM, no IPC.

import type { EventEntity, EventType } from "../../api/types";

/** One user-defined field from `event_fields.custom` in the global config. */
export type CustomEventField = {
  key: string;
  label: string;
  multiline?: boolean;
};

/** Config group: a built-in type code or a custom type label, plus fields. */
export type CustomEventFieldGroup = {
  type: string;
  fields: CustomEventField[];
};

/** A field ready for the form or the card, with a display label. */
export type ResolvedEventField = {
  key: string;
  label: string;
  multiline: boolean;
  custom: boolean;
};

/**
 * Curated detail keys of every built-in event type.
 * Keep in sync with `gentree_core::event_fields`.
 */
export const BUILTIN_EVENT_FIELDS: Record<
  EventType,
  readonly { key: string; multiline?: boolean }[]
> = {
  BIRTH: [{ key: "birth_certificate" }, { key: "hospital" }],
  DEATH: [{ key: "cause" }, { key: "death_certificate" }],
  MARRIAGE: [
    { key: "marriage_certificate" },
    { key: "marriage_rite" },
    { key: "officiant" },
  ],
  DIVORCE: [
    { key: "reason" },
    { key: "court" },
    { key: "divorce_certificate" },
  ],
  BURIAL: [
    { key: "cemetery" },
    { key: "grave" },
    { key: "burial_rite" },
    { key: "burial_officiant" },
  ],
  RESIDENCE: [{ key: "address" }],
  OCCUPATION: [{ key: "position" }, { key: "employer" }],
  EDUCATION: [
    { key: "institution" },
    { key: "faculty" },
    { key: "specialty" },
    { key: "qualification" },
  ],
  OTHER: [],
};

/** Case-insensitive lookup of one config group; the last declaration wins. */
function findGroup(
  groups: readonly CustomEventFieldGroup[],
  type: string | null | undefined,
): CustomEventFieldGroup | null {
  const wanted = (type ?? "").trim().toLowerCase();
  if (wanted === "") return null;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.type.trim().toLowerCase() === wanted) return group;
  }
  return null;
}

/**
 * Fields of an event in form order.
 *
 * A built-in type shows its curated keys and then the config group for that
 * code. `OTHER` shows the group of its custom type label, falling back to the
 * `OTHER` group. Custom fields come after built-ins and duplicate keys are
 * skipped, so a config key can never shadow a built-in label twice.
 */
export function resolveEventFields(
  eventType: EventType,
  originalType: string | null | undefined,
  groups: readonly CustomEventFieldGroup[],
  label: (key: string) => string,
): ResolvedEventField[] {
  const fields: ResolvedEventField[] = [];
  const seen = new Set<string>();
  const push = (field: ResolvedEventField) => {
    if (seen.has(field.key)) return;
    seen.add(field.key);
    fields.push(field);
  };

  if (eventType === "OTHER") {
    const customType = (originalType ?? "").trim();
    const group =
      (customType === "" ? null : findGroup(groups, customType)) ??
      findGroup(groups, "OTHER");
    for (const field of group?.fields ?? []) {
      push({
        key: field.key,
        label: field.label,
        multiline: field.multiline ?? false,
        custom: true,
      });
    }
    return fields;
  }

  for (const spec of BUILTIN_EVENT_FIELDS[eventType]) {
    push({
      key: spec.key,
      label: label(spec.key),
      multiline: spec.multiline ?? false,
      custom: false,
    });
  }
  for (const field of findGroup(groups, eventType)?.fields ?? []) {
    push({
      key: field.key,
      label: field.label,
      multiline: field.multiline ?? false,
      custom: true,
    });
  }
  return fields;
}

/**
 * Details to keep after a type change: values shared with the next type, plus
 * unknown/legacy keys. Only fields unique to the previous type are dropped, so
 * a value from another config is never deleted silently.
 */
export function retainDetailsForTypeChange(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  details: Readonly<Record<string, string>>,
): Record<string, string> {
  const previous = new Set(previousKeys);
  const next = new Set(nextKeys);
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    if (next.has(key) || !previous.has(key)) kept[key] = value;
  }
  return kept;
}

export type EventDetailEntry = { key: string; label: string; value: string };

/**
 * Display rows of an event's stored details: known fields in registry order,
 * then unknown stored keys with the raw key as the label. Blank values are
 * skipped; a value is never dropped because config forgot its key.
 */
export function eventDetailEntries(
  event: Pick<EventEntity, "type" | "originalType" | "details">,
  groups: readonly CustomEventFieldGroup[],
  label: (key: string) => string,
): EventDetailEntry[] {
  const details = event.details ?? {};
  const specs = resolveEventFields(event.type, event.originalType, groups, label);
  const entries: EventDetailEntry[] = [];
  const known = new Set<string>();
  for (const spec of specs) {
    known.add(spec.key);
    const value = (details[spec.key] ?? "").trim();
    if (value === "") continue;
    entries.push({ key: spec.key, label: spec.label, value });
  }
  for (const [key, rawValue] of Object.entries(details)) {
    if (known.has(key)) continue;
    const value = rawValue.trim();
    if (value === "") continue;
    entries.push({ key, label: key, value });
  }
  return entries;
}
