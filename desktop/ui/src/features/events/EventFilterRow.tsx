import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EventType, MediaItem, Person } from "../../api/types";
import { Button } from "../../components/ui/button";
import type { EventPersonScope } from "./helpers";
import { isEventPersonScope } from "./helpers";
import { MultiSelectDropdown } from "../../components/filters/MultiSelectDropdown";
import { SelectDropdown } from "../../components/filters/SelectDropdown";
import { YearRange } from "../../components/filters/YearRange";
import { cn } from "../../lib/utils";
import {
  eventPersonScopeFilterOptions,
  eventTypeFilterOptions,
} from "./filterOptions";
import PersonSearch from "../persons/PersonSearch";
import "../../components/filters/filters.css";

export type EventFilterRowProps = {
  personId: string;
  onPersonChange: (id: string) => void;
  personScope: EventPersonScope;
  onPersonScopeChange: (scope: EventPersonScope) => void;
  /** Input id for the person picker; each screen keeps its own. */
  personFilterId?: string;
  persons: Person[];
  photos?: ReadonlyMap<string, MediaItem>;
  types: readonly EventType[];
  onTypesChange: (types: string[]) => void;
  /** Year range controls; omitted by the timeline strip. */
  yearRange?: {
    from: string;
    to: string;
    minYear: number;
    maxYear: number;
    hasDated: boolean;
    onFromChange: (value: string) => void;
    onToChange: (value: string) => void;
  };
  /** Screen-local controls (e.g. timeline generations) appended to the row. */
  extra?: ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  activeCount?: number;
  className?: string;
  /** Optional `data-testid` for the row. */
  testId?: string;
};

/**
 * Person, relation scope, type and optional year controls. Shared by the
 * Events screen, the Map toolbar and the Timeline strip.
 */
export function EventFilterRow({
  personId,
  onPersonChange,
  personScope,
  onPersonScopeChange,
  personFilterId = "events-person-filter",
  persons,
  photos,
  types,
  onTypesChange,
  yearRange,
  extra,
  onReset,
  resetLabel,
  activeCount = 0,
  className,
  testId,
}: EventFilterRowProps) {
  const { t } = useTranslation(["event", "person", "enums"]);
  const typeOptions = useMemo(() => eventTypeFilterOptions(t), [t]);
  const scopeOptions = useMemo(() => eventPersonScopeFilterOptions(t), [t]);

  return (
    <div className={cn("event-filter-row", className)} data-testid={testId}>
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

      {yearRange ? (
        <YearRange
          from={yearRange.from}
          to={yearRange.to}
          minYear={yearRange.minYear}
          maxYear={yearRange.maxYear}
          disabled={!yearRange.hasDated || yearRange.minYear >= yearRange.maxYear}
          onFromChange={yearRange.onFromChange}
          onToChange={yearRange.onToChange}
          fromLabel={t("event:yearFrom")}
          toLabel={t("event:yearTo")}
          groupLabel={t("event:yearRange")}
        />
      ) : null}

      {extra}

      {onReset && activeCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="event-filter-reset"
          onClick={onReset}
        >
          {resetLabel}
        </Button>
      ) : null}
    </div>
  );
}
