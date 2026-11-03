// One list of event-type dropdown options for every screen that filters events
// (events, map and the timeline). Labels come from the caller's dictionary.

import type { EventType } from "../../api/types";
import type { MultiSelectOption } from "../../components/filters/MultiSelectDropdown";
import { EVENT_TYPES } from "./helpers";
import { EVENT_TYPE_ICONS } from "./typeIcons";

export function eventTypeOptions(
  label: (type: EventType) => string,
): MultiSelectOption[] {
  return EVENT_TYPES.map((type) => {
    const Icon = EVENT_TYPE_ICONS[type];
    return {
      id: type,
      label: label(type),
      icon: <Icon fontSize={16} aria-hidden="true" />,
    };
  });
}
