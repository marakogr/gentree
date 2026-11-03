// Shared event filters used by every view of the same data (events now, map and
// timeline next). The query and the person/type/year values live in the common
// "filters" view section, so switching views keeps them; each screen keeps its
// own sort, page and selection next to it.

import { useCallback, useMemo } from "react";
import { useViewState } from "../../lib/useViewState";
import type { ViewFilters } from "../../lib/viewState";
import {
  clearEventFilterValues,
  readEventFilters,
  withFilterValue,
  type EventListFilters,
} from "./helpers";

export type EventFilterState = {
  query: string;
  filters: EventListFilters;
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

  return { query: state.query, filters, setQuery, setFilter, patchFilters, reset };
}
