// Shared event filter header: search, person with photo, type multi-select and
// the year range. The same component and the same stored values serve every
// view of the event data (events now, map and timeline next), so switching a
// view keeps the filters.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EventType, MediaItem, Person } from "../../api/types";
import {
  EVENT_PERSON_SCOPES,
  isEventPersonScope,
  type EventPersonScope,
} from "../../features/events/helpers";
import { eventTypeOptions } from "../../features/events/typeOptions";
import { Button } from "../ui/button";
import { FilterBar } from "./FilterBar";
import { MultiSelectDropdown } from "./MultiSelectDropdown";
import { SelectDropdown } from "./SelectDropdown";
import { YearRange } from "./YearRange";
import PersonSearch from "../../features/persons/PersonSearch";
import "./filters.css";

export type EventFilterHeaderProps = {
  query: string;
  onQueryChange: (value: string) => void;
  onReset: () => void;
  loading?: boolean;
  personId: string;
  onPersonChange: (id: string) => void;
  /** Relatives included with the chosen person. */
  personScope: EventPersonScope;
  onPersonScopeChange: (scope: EventPersonScope) => void;
  /** Input id for the person picker; each screen keeps its own. */
  personFilterId?: string;
  persons: Person[];
  photos?: ReadonlyMap<string, MediaItem>;
  types: readonly EventType[];
  onTypesChange: (types: string[]) => void;
  fromYear: string;
  toYear: string;
  onFromYearChange: (value: string) => void;
  onToYearChange: (value: string) => void;
  yearBounds: { minYear: number; maxYear: number; hasDated: boolean };
  resultLabel: string;
  activeCount: number;
};

export function EventFilterHeader({
  query,
  onQueryChange,
  onReset,
  loading = false,
  personId,
  onPersonChange,
  personScope,
  onPersonScopeChange,
  personFilterId = "events-person-filter",
  persons,
  photos,
  types,
  onTypesChange,
  fromYear,
  toYear,
  onFromYearChange,
  onToYearChange,
  yearBounds,
  resultLabel,
  activeCount,
}: EventFilterHeaderProps) {
  const { t } = useTranslation(["event", "common", "enums"]);
  const typeOptions = useMemo(
    () => eventTypeOptions((type) => t(`enums:eventType.${type}`)),
    [t],
  );
  const scopeOptions = useMemo(
    () =>
      EVENT_PERSON_SCOPES.map((scope) => ({
        id: scope,
        label: t(`event:personScope.${scope}`),
      })),
    [t],
  );

  return (
    <div className="event-filter-header">
      <div className="event-filter-top">
        <FilterBar
          query={query}
          onQueryChange={onQueryChange}
          queryPlaceholder={t("event:searchPlaceholder")}
          queryLabel={t("event:searchLabel")}
          clearLabel={t("event:clearSearch")}
          filtersLabel={t("event:filtersTitle")}
          activeCount={activeCount}
          chips={[]}
          onReset={onReset}
          resetLabel={t("event:resetFilters")}
          showReset={false}
          resultLabel={resultLabel}
          loading={loading}
        />
      </div>

      <div className="event-filter-row">
        <div className="event-filter-person">
          <PersonSearch
            id={personFilterId}
            label={t("event:person")}
            hideLabel
            persons={persons}
            photos={photos}
            value={personId}
            onChange={(id) => {
              onPersonChange(id);
              // With nobody chosen the relation no longer applies.
              if (id === "") onPersonScopeChange("person");
            }}
            placeholder={t("event:personFilterPlaceholder")}
            allOptionLabel={t("event:allPersons")}
            clearLabel={t("event:clearPerson")}
            emptyLabel={t("event:noPersonMatches")}
          />
        </div>

        <div className="event-filter-scope">
          <SelectDropdown
            options={scopeOptions}
            value={personScope}
            onChange={(id) => {
              if (isEventPersonScope(id)) onPersonScopeChange(id);
            }}
            label={t("event:personScope.label")}
            placeholder={t("event:personScope.label")}
            disabled={personId === ""}
            id={`${personFilterId}-scope`}
          />
        </div>

        <div className="event-filter-type">
          <MultiSelectDropdown
            options={typeOptions}
            values={[...types]}
            onChange={onTypesChange}
            label={t("event:type")}
            allLabel={t("event:allTypes")}
            multipleLabel={(count) => t("event:typesSelected", { count })}
            id="event-type-filter"
          />
        </div>

        <YearRange
          from={fromYear}
          to={toYear}
          minYear={yearBounds.minYear}
          maxYear={yearBounds.maxYear}
          disabled={
            !yearBounds.hasDated || yearBounds.minYear >= yearBounds.maxYear
          }
          onFromChange={onFromYearChange}
          onToChange={onToYearChange}
          fromLabel={t("event:yearFrom")}
          toLabel={t("event:yearTo")}
          groupLabel={t("event:yearRange")}
        />

        {activeCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="event-filter-reset"
            onClick={onReset}
          >
            {t("event:resetFilters")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
