// Compact one-row filter strip for the line screen. The person and the relation
// scope are the same shared filter values as the events and map screens, so a
// person chosen there opens the timeline with the same focus; types are shared
// too. Generations and the sort stay local to the timeline.

import { useMemo } from "react";
import {
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import type {
  EventType,
  MediaItem,
  Person,
} from "../../api/types";
import {
  EVENT_PERSON_SCOPES,
  isEventPersonScope,
  type EventPersonScope,
} from "../events/helpers";
import { MultiSelectDropdown } from "../../components/filters/MultiSelectDropdown";
import { SelectDropdown } from "../../components/filters/SelectDropdown";
import { cn } from "../../lib/utils";
import { eventTypeOptions } from "../events/typeOptions";
import PersonSearch from "../persons/PersonSearch";
import { useTimelineTranslate } from "./i18n";
import { MAX_GENERATIONS } from "./scope";
import "./timeline-filters.css";

// Fluent tokens for the compact filter strip; layout stays on Tailwind.
const useStyles = makeStyles({
  field: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    ":hover": {
      ...shorthands.borderColor(tokens.colorNeutralStroke1Hover),
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
});

export interface TimelineFiltersProps {
  /** Shared person filter; empty means every person. */
  personId: string;
  /** Relatives included with the chosen person. */
  personScope: EventPersonScope;
  persons: Person[];
  /** Primary photo per person id; initials are the fallback. */
  photos?: ReadonlyMap<string, MediaItem>;
  generations: number;
  /** Event types shown on the timeline; empty means every type. */
  types: readonly EventType[];
  onPersonChange: (personId: string) => void;
  onPersonScopeChange: (scope: EventPersonScope) => void;
  onGenerationsChange: (generations: number) => void;
  onTypesChange: (types: string[]) => void;
}

export function TimelineFilters({
  personId,
  personScope,
  persons,
  photos,
  generations,
  types,
  onPersonChange,
  onPersonScopeChange,
  onGenerationsChange,
  onTypesChange,
}: TimelineFiltersProps) {
  const t = useTimelineTranslate();
  const { t: tShared } = useTranslation(["event", "person", "enums"]);
  const styles = useStyles();

  const typeOptions = useMemo(
    () =>
      eventTypeOptions((type) => String(tShared(`enums:eventType.${type}`))),
    [tShared],
  );
  const scopeOptions = useMemo(
    () =>
      EVENT_PERSON_SCOPES.map((scope) => ({
        id: scope,
        label: String(tShared(`event:personScope.${scope}`)),
      })),
    [tShared],
  );

  return (
    <div
      data-testid="line-filters"
      className="timeline-filter-row flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <div className="timeline-filter-person">
        <PersonSearch
          id="timeline-focus-person"
          label={String(tShared("event:person"))}
          hideLabel
          persons={persons}
          photos={photos}
          value={personId}
          placeholder={String(tShared("person:searchPlaceholder"))}
          allOptionLabel={String(tShared("event:allPersons"))}
          clearLabel={String(tShared("event:clearPerson"))}
          onChange={onPersonChange}
        />
      </div>

      <div className="timeline-filter-scope">
        <SelectDropdown
          options={scopeOptions}
          value={personScope}
          onChange={(id) => {
            if (isEventPersonScope(id)) onPersonScopeChange(id);
          }}
          label={String(tShared("event:personScope.label"))}
          placeholder={String(tShared("event:personScope.label"))}
          disabled={personId === ""}
          id="timeline-scope-filter"
        />
      </div>

      <div className="timeline-filter-types">
        <MultiSelectDropdown
          options={typeOptions}
          values={[...types]}
          onChange={onTypesChange}
          label={String(tShared("event:type"))}
          allLabel={String(tShared("event:allTypes"))}
          multipleLabel={(count) =>
            String(tShared("event:typesSelected", { count }))
          }
          id="timeline-type-filter"
        />
      </div>

      {personScope !== "person" && (
        <label className="timeline-filter-label">
          <span className="shrink-0">{t("filters.generations")}</span>
          <input
            type="number"
            min={1}
            max={MAX_GENERATIONS}
            value={generations}
            data-testid="line-generations"
            onChange={(event) =>
              onGenerationsChange(Number(event.target.value))
            }
            className={cn(
              styles.field,
              "h-7 w-16 rounded-md px-2 py-0 text-[11px] outline-none",
            )}
          />
        </label>
      )}
    </div>
  );
}
