// Shared event filters used by every view of the same data (events, map and
// timeline). The query and the person/type/year values live in the common
// "filters" view section, so switching views keeps them; each screen keeps its
// own sort, page and selection next to it.
//
// A filter describes the events of one project: opening another project drops
// the person/type/year values instead of hiding that project's events behind a
// filter the user set somewhere else (issue #107).

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useViewState } from "../../lib/useViewState";
import type { ViewFilters } from "../../lib/viewState";
import {
  clearEventFilterValues,
  countActiveEventFilters,
  isEventPersonFilterStale,
  readEventFilters,
  resetEventFilterSection,
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
  const { state, patch } = useViewState(projectId, "filters");
  const filters = useMemo(
    () => readEventFilters(state.filters),
    [state.filters],
  );

  // The stored values belong to the project they were set in. `useViewState`
  // already reloads the section per project; this also clears a filter that the
  // new project may keep from an earlier session.
  const previousProjectId = useRef(projectId);
  useEffect(() => {
    if (previousProjectId.current === projectId) return;
    previousProjectId.current = projectId;
    patch(resetEventFilterSection);
  }, [projectId, patch]);

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
