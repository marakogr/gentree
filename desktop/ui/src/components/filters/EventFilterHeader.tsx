// Shared event filter header: search, person with photo, type multi-select and
// the year range. The same component and the same stored values serve every
// view of the event data (events now, map and timeline next), so switching a
// view keeps the filters.

import { useTranslation } from "react-i18next";
import type { EventType, MediaItem, Person } from "../../api/types";
import { Button } from "../ui/button";
import { FilterBar } from "./FilterBar";
import { MultiSelectDropdown, type MultiSelectOption } from "./MultiSelectDropdown";
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
  persons: Person[];
  photos?: ReadonlyMap<string, MediaItem>;
  types: readonly EventType[];
  onTypesChange: (types: string[]) => void;
  typeOptions: MultiSelectOption[];
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
  persons,
  photos,
  types,
  onTypesChange,
  typeOptions,
  fromYear,
  toYear,
  onFromYearChange,
  onToYearChange,
  yearBounds,
  resultLabel,
  activeCount,
}: EventFilterHeaderProps) {
  const { t } = useTranslation(["event", "common"]);

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
            id="events-person-filter"
            label={t("event:person")}
            hideLabel
            persons={persons}
            photos={photos}
            value={personId}
            onChange={onPersonChange}
            placeholder={t("event:personFilterPlaceholder")}
            allOptionLabel={t("event:allPersons")}
            clearLabel={t("event:clearPerson")}
            emptyLabel={t("event:noPersonMatches")}
          />
        </div>

        <div className="event-filter-type">
          <MultiSelectDropdown
            options={typeOptions}
            values={[...types]}
            onChange={onTypesChange}
            label={t("event:type")}
            allLabel={t("event:allTypes")}
            searchPlaceholder={t("event:typeFilterSearch")}
            emptyLabel={t("event:noPersonMatches")}
            multipleLabel={(count) => t("event:typesSelected", { count })}
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
