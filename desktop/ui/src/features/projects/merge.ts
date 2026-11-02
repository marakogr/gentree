// Pure helpers for the project-merge dialog (ADR-0017). No DOM, no IPC:
// defaults and the final decision payload are unit-tested in merge.test.ts.

import type {
  EventDecision,
  MergeAction,
  MergeDecisions,
  MergeEventMatch,
  MergeFieldPolicy,
  MergePerson,
  MergePersonMatch,
  MergePreview,
  MergeSide,
  PersonDecision,
} from "../../api/types";
import { displayName } from "../persons/helpers";

/** What the dialog keeps for one suggested person pair. */
export type MergePersonChoice = {
  action: MergeAction;
  base: MergeSide;
  /** Only fields listed in `fieldDiffs` are meaningful. */
  fields: Record<string, MergeFieldPolicy>;
};

/** What the dialog keeps for one suggested event pair. */
export type MergeEventChoice = {
  action: MergeAction;
  base: MergeSide;
  fields: Record<string, MergeFieldPolicy>;
};

/** Per-pair draft state, keyed by the preview suggestion ids. */
export type MergeDraft = {
  persons: Record<string, MergePersonChoice>;
  events: Record<string, MergeEventChoice>;
};

/** Text fields may keep both sides; scalars only take one side. */
const BOTH_POLICIES: MergeFieldPolicy[] = ["Left", "Right", "Both"];
const SIDE_POLICIES: MergeFieldPolicy[] = ["Left", "Right"];

/** Notes are the only person field where `Both` makes sense. */
export function fieldPolicies(
  field: string,
  scope: "person" | "event",
): MergeFieldPolicy[] {
  if (field === "notes" || field === "description" || field === "place") {
    return BOTH_POLICIES;
  }
  if (scope === "event" && field.startsWith("details.")) {
    return BOTH_POLICIES;
  }
  return SIDE_POLICIES;
}

/** `details.<key>` -> `<key>`; every other field is returned unchanged. */
export function detailKey(field: string): string | null {
  return field.startsWith("details.") ? field.slice("details.".length) : null;
}

function hasText(value: string | null | undefined): boolean {
  return (value ?? "").trim() !== "";
}

/**
 * Safe default: only a `High` suggestion is pre-selected for merging; every
 * other pair starts as "keep both" and needs an explicit click.
 */
export function defaultPersonChoice(
  match: MergePersonMatch,
): MergePersonChoice {
  const fields: Record<string, MergeFieldPolicy> = {};
  for (const field of match.fieldDiffs) {
    // Notes default to "both" when both sides have text; an empty side would
    // only add whitespace to the merged note.
    fields[field] =
      field === "notes" && hasText(match.left.notes) && hasText(match.right.notes)
        ? "Both"
        : "Left";
  }
  return {
    action: match.confidence === "High" ? "Merge" : "KeepBoth",
    base: "Left",
    fields,
  };
}

export function defaultEventChoice(match: MergeEventMatch): MergeEventChoice {
  const fields: Record<string, MergeFieldPolicy> = {};
  for (const field of match.fieldDiffs) {
    fields[field] = "Left";
  }
  return {
    action: match.confidence === "High" ? "Merge" : "KeepBoth",
    base: "Left",
    fields,
  };
}

/** Defaults for every suggestion in a preview, in preview order. */
export function defaultMergeDraft(preview: MergePreview): MergeDraft {
  const persons: Record<string, MergePersonChoice> = {};
  const events: Record<string, MergeEventChoice> = {};

  for (const match of preview.matches) {
    persons[match.id] = defaultPersonChoice(match);
    for (const eventMatch of match.eventMatches) {
      events[eventMatch.id] = defaultEventChoice(eventMatch);
    }
  }

  return { persons, events };
}

/**
 * Final `MergeDecisions` for `merge_apply`.
 *
 * Every person suggestion gets an explicit decision. Event decisions exist
 * only under a person whose action is `Merge`: folding the right events into a
 * left person that stays separate would silently move them.
 */
export function buildMergeDecisions(
  preview: MergePreview,
  draft: MergeDraft,
): MergeDecisions {
  const persons: PersonDecision[] = [];
  const events: EventDecision[] = [];

  for (const match of preview.matches) {
    const choice = draft.persons[match.id] ?? defaultPersonChoice(match);
    persons.push({
      leftId: match.left.id,
      rightId: match.right.id,
      action: choice.action,
      base: choice.base,
      fields: { ...choice.fields },
    });

    if (choice.action !== "Merge") continue;

    for (const eventMatch of match.eventMatches) {
      const eventChoice =
        draft.events[eventMatch.id] ?? defaultEventChoice(eventMatch);
      events.push({
        leftEventId: eventMatch.left.id,
        rightEventId: eventMatch.right.id,
        action: eventChoice.action,
        base: eventChoice.base,
        fields: { ...eventChoice.fields },
      });
    }
  }

  return { persons, events };
}

/** Display name for a preview person; the structural shape matches `Person`. */
export function mergePersonLabel(person: MergePerson, unknown = ""): string {
  return displayName(person, unknown);
}
