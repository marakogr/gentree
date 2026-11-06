// Shared event filters used by every view of the same data (events, map and
// timeline). The query and the person/type/year values live in the common
// "filters" view section, so switching views keeps them; each screen keeps its
// own sort, page and selection next to it.
//
// The values are stored per project (`gentree.views.v1.<projectId>`) and each
// project keeps its own filter: opening another project loads that project's
// section, it never inherits or clears the previous one (issue #107).

import { useCallback, useEffect, useMemo } from "react";
import { useViewState } from "../../lib/useViewState";
import type { ViewFilters } from "../../lib/viewState";
import {
  clearEventFilterValues,
  countActiveEventFilters,
  isEventPersonFilterStale,
  readEventFilters,
  withFilterValue,
  type EventListFilters,
} from "./helpers";

export type EventFilterState = {
  query: string;
  filters: EventListFilters;
  /** Person, type and year filters currently narrowing the list. */
  activeCount: number;
  setQuery: (query: string) => void;
  setFilter: (key: string, value: string | string[]) => void;
  patchFilters: (next: (current: ViewFilters) => ViewFilters) => void;
  reset: () => void;
};

export function useEventFilterState(projectId: string): EventFilterState {
  // `useViewState` reloads the section of the open project, so the values here
  // always belong to `projectId`; a project switch needs no reset.
  const { state, patch } = useViewState(projectId, "filters");
  const filters = useMemo(
    () => readEventFilters(state.filters),
    [state.filters],
  );

  const setQuery = useCallback(
    (query: string) => patch({ query }),
    [patch],
  );

  const patchFilters = useCallback(
    (next: (current: ViewFilters) => ViewFilters) =>
      patch((previous) => ({
        ...previous,
        filters: next(previous.filters),
      })),
    [patch],
  );

  const setFilter = useCallback(
    (key: string, value: string | string[]) =>
      patch((previous) => ({
        ...previous,
        filters: withFilterValue(previous.filters, key, value),
      })),
    [patch],
  );

  const reset = useCallback(
    () =>
      patch((previous) => ({
        ...previous,
        query: "",
        filters: clearEventFilterValues(previous.filters),
      })),
    [patch],
  );

  return {
    query: state.query,
    filters,
    activeCount: countActiveEventFilters(filters),
    setQuery,
    setFilter,
    patchFilters,
    reset,
  };
}

/**
 * Drops a person filter that no longer resolves in the open project: the person
 * was deleted, or the id came from another tree. Such a filter hides every
 * event while looking like an ordinary selection. Runs only once the person
 * list is known, so a slow load never clears a valid filter.
 */
export function usePruneEventPersonFilter(
  filters: EventListFilters,
  knownPersonIds: ReadonlySet<string> | null | undefined,
  onChange: (key: string, value: string | string[]) => void,
): void {
  const stale = isEventPersonFilterStale(filters, knownPersonIds);
  useEffect(() => {
    if (!stale) return;
    onChange("personId", "");
    onChange("personScope", "");
  }, [stale, onChange]);
}
