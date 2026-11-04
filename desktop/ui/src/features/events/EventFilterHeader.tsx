// Shared event filter header: search, person with photo, type multi-select and
// the year range. The same component and the same stored values serve every
// view of the event data (events now, map and timeline next), so switching a
// view keeps the filters.

import { useTranslation } from "react-i18next";
import type { EventType, MediaItem, Person } from "../../api/types";
import { FilterBar } from "../../components/filters/FilterBar";
import type { EventPersonScope } from "./helpers";
import { EventFilterRow } from "./EventFilterRow";
import "../../components/filters/filters.css";

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

      <EventFilterRow
        personId={personId}
        onPersonChange={onPersonChange}
        personScope={personScope}
        onPersonScopeChange={onPersonScopeChange}
        personFilterId={personFilterId}
        persons={persons}
        photos={photos}
        types={types}
        onTypesChange={onTypesChange}
        yearRange={{
          from: fromYear,
          to: toYear,
          minYear: yearBounds.minYear,
          maxYear: yearBounds.maxYear,
          hasDated: yearBounds.hasDated,
          onFromChange: onFromYearChange,
          onToChange: onToYearChange,
        }}
        onReset={onReset}
        resetLabel={t("event:resetFilters")}
        activeCount={activeCount}
      />
    </div>
  );
}
