// Pure table interaction rules shared by every list screen.

import type { SortDirection } from "./sort-icon";

/** Direction of the next click on a sortable header. */
export function nextSortDirection(
  key: string,
  currentKey: string,
  currentDirection: SortDirection,
  directionForKey: (key: string) => SortDirection = () => "asc",
): SortDirection {
  if (currentKey === key) {
    return currentDirection === "asc" ? "desc" : "asc";
  }
  return directionForKey(key);
}

/** `ascending`/`descending` for Fluent's header cell, or `undefined`. */
export function fluentSortDirection(
  active: boolean,
  direction: SortDirection,
): "ascending" | "descending" | undefined {
  if (!active) return undefined;
  return direction === "asc" ? "ascending" : "descending";
}
