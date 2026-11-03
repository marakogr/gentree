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
  TimelineScope,
} from "../../api/types";
import { MultiSelectDropdown } from "../../components/filters/MultiSelectDropdown";
import { SelectDropdown } from "../../components/filters/SelectDropdown";
import { cn } from "../../lib/utils";
import { eventTypeOptions } from "../events/typeOptions";
import PersonSearch from "../persons/PersonSearch";
import { useTimelineTranslate } from "./i18n";
import {
  LINE_SCOPES,
  MAX_GENERATIONS,
  scopeLabel,
  scopeRequiresPerson,
} from "./scope";
import "./timeline-filters.css";

// Fluent tokens for the compact filter strip; layout stays on Tailwind.
const useStyles = makeStyles({
  scopeOption: {
    color: tokens.colorNeutralForeground2,
    backgroundColor: "transparent",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  scopeOptionActive: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1Selected,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
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
  scope: TimelineScope;
  personId: string | null;
  persons: Person[];
  /** Primary photo per person id; initials are the fallback. */
  photos?: ReadonlyMap<string, MediaItem>;
  generations: number;
  /** Event types shown on the timeline; empty means every type. */
  types: readonly EventType[];
  onScopeChange: (scope: TimelineScope) => void;
  onPersonChange: (personId: string | null) => void;
  onGenerationsChange: (generations: number) => void;
  onTypesChange: (types: string[]) => void;
}

/**
 * Compact one-row filter strip for the line screen: the focus scope, the
 * shared person picker (only when the scope needs a root person) and the walk
 * depth. The active state lives in the scope buttons, so there are no chips and
 * no reset action; event types are switched on the canvas legend only.
 */
export function TimelineFilters({
  scope,
  personId,
  persons,
  photos,
  generations,
  types,
  onScopeChange,
  onPersonChange,
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
    () => LINE_SCOPES.map((value) => ({ id: value, label: scopeLabel(value, t) })),
    [t],
  );

  return (
    <div
      data-testid="line-filters"
      className="timeline-filter-row flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <div className="timeline-filter-scope">
        <SelectDropdown
          options={scopeOptions}
          value={scope}
          onChange={(value) => {
            if ((LINE_SCOPES as readonly string[]).includes(value)) {
              onScopeChange(value as (typeof LINE_SCOPES)[number]);
            }
          }}
          label={t("filters.focusAria")}
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

      {scopeRequiresPerson(scope) && (
        <div className="timeline-filter-person">
          <PersonSearch
            id="timeline-focus-person"
            label={scopeLabel(scope, t)}
            hideLabel
            persons={persons}
            photos={photos}
            value={personId ?? ""}
            placeholder={String(tShared("person:searchPlaceholder"))}
            onChange={(next) => onPersonChange(next === "" ? null : next)}
          />
        </div>
      )}

      {(scope === "ancestors" ||
        scope === "descendants" ||
        scope === "both") && (
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
