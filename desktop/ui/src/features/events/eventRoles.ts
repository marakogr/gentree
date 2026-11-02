// Semantic participant roles of the event form. The stored model stays
// `personId` plus `participantIds`; this module only decides which localized
// label/placeholder a slot gets, so no relation or project format changes.

import type { EventType } from "../../api/types";
import { supportsDateRange } from "./datePeriod";

export type EventPersonSlot = "primary" | "secondary";

/** Marriage and divorce have two equal participants. */
export function isPairedEventType(type: EventType): boolean {
  return type === "MARRIAGE" || type === "DIVORCE";
}

/** i18n key of the primary or secondary participant label. */
export function personRoleKey(
  type: EventType,
  slot: EventPersonSlot = "primary",
): string {
  if (slot === "secondary") return "roleSpouseSecond";
  switch (type) {
    case "BIRTH":
      return "roleChild";
    case "DEATH":
      return "roleDeceased";
    case "BURIAL":
      return "roleDeceasedBurial";
    case "MARRIAGE":
    case "DIVORCE":
      return "roleSpouseFirst";
    default:
      return "rolePerson";
  }
}

/** i18n key of the person search placeholder for a slot. */
export function personPlaceholderKey(
  type: EventType,
  slot: EventPersonSlot = "primary",
): string {
  if (slot === "secondary") return "personPlaceholderSpouse";
  if (type === "BIRTH") return "personPlaceholderChild";
  return "personPlaceholder";
}

/**
 * i18n key of the top place field placeholder, or `null` for the generic
 * "Place" text. Burial's place is the settlement, not the cemetery; residence's
 * place is the settlement, not the street address.
 */
export function placePlaceholderKey(type: EventType): string | null {
  if (type === "BURIAL") return "placePlaceholderCityRegion";
  if (type === "RESIDENCE") return "placePlaceholderCity";
  return null;
}

export type DateModeKeys = { single: string; range: string };

/** Labels of the exact-date / period switch for a range-capable type. */
export function dateModeKeys(type: EventType): DateModeKeys | null {
  if (!supportsDateRange(type)) return null;
  switch (type) {
    case "EDUCATION":
      return { single: "dateModeGraduation", range: "dateModeStudyPeriod" };
    case "RESIDENCE":
      return { single: "dateModeSingle", range: "dateModeResidencePeriod" };
    default:
      return { single: "dateModeSingle", range: "dateModePeriod" };
  }
}
