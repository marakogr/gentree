// Shared option builders for the event filters.
//
// Events, Map and Timeline must offer the same person scopes and event types;
// building them here keeps the labels and ordering in one place.

import type { TFunction } from "i18next";
import { eventTypeOptions } from "./typeOptions";
import type { MultiSelectOption } from "../../components/filters/MultiSelectDropdown";
import { EVENT_PERSON_SCOPES, type EventPersonScope } from "./helpers";

export function eventTypeFilterOptions(t: TFunction): MultiSelectOption[] {
  return eventTypeOptions((type) => String(t(`enums:eventType.${type}`)));
}

export function eventPersonScopeFilterOptions(
  t: TFunction,
): { id: EventPersonScope; label: string }[] {
  return EVENT_PERSON_SCOPES.map((scope) => ({
    id: scope,
    label: String(t(`event:personScope.${scope}`)),
  }));
}
