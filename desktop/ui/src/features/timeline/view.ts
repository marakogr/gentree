// Pure helpers for the timeline screen: persisted view state <-> local view
// and state -> `timeline_list` parameters. No React, no DOM.

import type {
  TimelineListParams,
  TimelineScope,
} from "../../api/types";
import type {
  SectionViewState,
  SortDirection,
  ViewFilters,
} from "../../lib/viewState";
import type { LineIconKind } from "./line";
import {
  DEFAULT_GENERATIONS,
  LINE_SCOPES,
  buildTimelineEventsOptions,
  clampGenerations,
} from "./scope";

/** Sort keys persisted by older builds; only the stored state shape remains. */
const LEGACY_SORT_KEYS = ["date", "type", "person"] as const;

/** Icon families shown by the canvas legend. */
const LINE_ICON_KINDS: readonly LineIconKind[] = [
  "birth",
  "marriage",
  "death",
  "other",
];

export type TimelineView = {
  scope: TimelineScope;
  personId: string | null;
  generations: number;
  hiddenTypes: LineIconKind[];
  /** Persisted sort of the removed list; kept for state compatibility. */
  sort: string;
  sortDirection: SortDirection;
};

export const DEFAULT_TIMELINE_VIEW: TimelineView = {
  scope: "all",
  personId: null,
  generations: DEFAULT_GENERATIONS,
  hiddenTypes: [],
  sort: "date",
  sortDirection: "asc",
};

function isScope(value: unknown): value is TimelineScope {
  return (
    typeof value === "string" &&
    (LINE_SCOPES as readonly string[]).includes(value)
  );
}

function isSortKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (LEGACY_SORT_KEYS as readonly string[]).includes(value)
  );
}

function stringFilter(filters: ViewFilters, key: string): string {
  const value = filters[key];
  return typeof value === "string" ? value : "";
}

function hiddenTypeList(
  value: ViewFilters[string] | undefined,
): LineIconKind[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return LINE_ICON_KINDS.filter((kind) => list.includes(kind));
}

/**
 * Validates persisted state and falls back to the defaults field by field. An
 * old state may still carry the removed `place` scope or the removed search
 * and place fields; those are dropped, so the scope falls back to `all`.
 */
export function timelineViewFromState(state: SectionViewState): TimelineView {
  const filters = state.filters;
  const scope = isScope(filters.scope) ? filters.scope : "all";
  const rawGenerations = stringFilter(filters, "generations");
  const generations =
    rawGenerations === "" ? Number.NaN : Number(rawGenerations);
  const sortKey = state.sort?.key;
  const personId = stringFilter(filters, "personId");

  return {
    scope,
    personId: personId === "" ? null : personId,
    generations: Number.isFinite(generations)
      ? clampGenerations(generations)
      : DEFAULT_GENERATIONS,
    hiddenTypes: hiddenTypeList(filters.hiddenTypes),
    sort: isSortKey(sortKey) ? sortKey : "date",
    sortDirection: state.sort?.direction === "desc" ? "desc" : "asc",
  };
}

/** Serialisable filters for the persisted view state. */
export function timelineFilters(view: TimelineView): ViewFilters {
  const filters: ViewFilters = {};
  if (view.scope !== "all") filters.scope = view.scope;
  if (view.personId !== null && view.personId !== "") {
    filters.personId = view.personId;
  }
  filters.generations = String(view.generations);
  if (view.hiddenTypes.length > 0) {
    filters.hiddenTypes = [...view.hiddenTypes];
  }
  return filters;
}

/** Partial persistable state written by the screen on every view change. */
export function timelineViewPatch(
  view: TimelineView,
): Partial<SectionViewState> {
  return {
    filters: timelineFilters(view),
    sort: { key: view.sort, direction: view.sortDirection },
  };
}

/**
 * Clears every filter and focus field (scope, person, hidden types,
 * generations) while keeping the legacy persisted sort, which no longer has a
 * UI.
 */
export function resetTimelineView(view: TimelineView): TimelineView {
  return {
    ...DEFAULT_TIMELINE_VIEW,
    sort: view.sort,
    sortDirection: view.sortDirection,
  };
}

/**
 * Stored state plus the one-shot deep link from another screen. A non-empty
 * `initialPersonId` always wins over the stored scope/person; without it the
 * stored view is restored unchanged.
 */
export function resolveInitialTimelineView({
  stored,
  initialScope,
  initialPersonId,
}: {
  stored: SectionViewState;
  initialScope: TimelineScope;
  initialPersonId: string | null;
}): TimelineView {
  const base = timelineViewFromState(stored);
  if (initialPersonId === null || initialPersonId === "") {
    return base;
  }
  return {
    ...base,
    scope: isScope(initialScope) ? initialScope : base.scope,
    personId: initialPersonId,
  };
}

/** Scope-specific parameters; the line screen has no year filter. */
export function buildTimelineListParams(view: TimelineView): TimelineListParams {
  return buildTimelineEventsOptions({
    scope: view.scope,
    personId: view.personId,
    generations: view.generations,
  });
}
