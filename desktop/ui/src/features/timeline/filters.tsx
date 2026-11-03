import { useMemo } from "react";
import {
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDownRegular,
  ArrowUpRegular,
  DocumentRegular,
  FireRegular,
  GlobeRegular,
  HeartRegular,
  PersonRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import type { MediaItem, Person, TimelineScope } from "../../api/types";
import { MultiSelectDropdown } from "../../components/filters/MultiSelectDropdown";
import { cn } from "../../lib/utils";
import PersonSearch from "../persons/PersonSearch";
import { useTimelineTranslate } from "./i18n";
import {
  LINE_SCOPES,
  MAX_GENERATIONS,
  scopeLabel,
  scopeRequiresPerson,
} from "./scope";
import { LINE_TYPES } from "./LineCanvas";
import type { LineIconKind } from "./line";
import "./timeline-filters.css";

const SCOPE_ICONS: Record<(typeof LINE_SCOPES)[number], FluentIcon> = {
  all: GlobeRegular,
  person: PersonRegular,
  ancestors: ArrowUpRegular,
  descendants: ArrowDownRegular,
};

/** Icons of the timeline marker families, the same set the legend draws. */
const TYPE_ICONS: Record<LineIconKind, FluentIcon> = {
  birth: PersonRegular,
  marriage: HeartRegular,
  death: FireRegular,
  other: DocumentRegular,
};

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
  /** Marker families the user switched off in the legend or the dropdown. */
  hiddenTypes: LineIconKind[];
  onScopeChange: (scope: TimelineScope) => void;
  onPersonChange: (personId: string | null) => void;
  onGenerationsChange: (generations: number) => void;
  onHiddenTypesChange: (hiddenTypes: LineIconKind[]) => void;
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
  hiddenTypes,
  onScopeChange,
  onPersonChange,
  onGenerationsChange,
  onHiddenTypesChange,
}: TimelineFiltersProps) {
  const t = useTimelineTranslate();
  const { t: tShared } = useTranslation(["event", "person"]);
  const styles = useStyles();

  const typeOptions = useMemo(
    () =>
      LINE_TYPES.map((kind) => {
        const Icon = TYPE_ICONS[kind];
        return {
          id: kind,
          label: t(`type.${kind}`),
          icon: <Icon fontSize={16} aria-hidden="true" />,
        };
      }),
    [t],
  );
  const visibleTypes =
    hiddenTypes.length === 0
      ? []
      : LINE_TYPES.filter((kind) => !hiddenTypes.includes(kind));

  return (
    <div
      data-testid="line-filters"
      className="timeline-filter-row flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <div
        role="group"
        aria-label={t("filters.focusAria")}
        className="timeline-filter-group"
      >
        {LINE_SCOPES.map((value) => {
          const active = value === scope;
          const Icon = SCOPE_ICONS[value];
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) {
                  onScopeChange(value);
                }
              }}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full px-2.5 py-0 text-[11px] transition-colors",
                active ? styles.scopeOptionActive : styles.scopeOption,
              )}
            >
              <Icon fontSize={14} aria-hidden="true" />
              {scopeLabel(value, t)}
            </button>
          );
        })}
      </div>

      <div className="timeline-filter-types">
        <MultiSelectDropdown
          options={typeOptions}
          values={visibleTypes}
          onChange={(values) =>
            onHiddenTypesChange(
              values.length === 0
                ? []
                : LINE_TYPES.filter((kind) => !values.includes(kind)),
            )
          }
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

      {(scope === "ancestors" || scope === "descendants") && (
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
