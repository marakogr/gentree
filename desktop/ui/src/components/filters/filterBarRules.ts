// Pure visibility rules for the shared filter bar.

/** Reset is disabled while the search, chips and filter count are all empty. */
export function isFilterResetDisabled(
  activeCount: number,
  query: string,
  chipCount: number,
): boolean {
  return activeCount === 0 && query === "" && chipCount === 0;
}

/** The chips row appears when there is a chip or an explicit reset action. */
export function showsFilterChips(chipCount: number, showReset: boolean): boolean {
  return chipCount > 0 || showReset;
}

/** The filters toggle appears only with a panel and outside inline mode. */
export function showsFilterPanelToggle(
  hasChildren: boolean,
  inline: boolean,
): boolean {
  return hasChildren && !inline;
}
