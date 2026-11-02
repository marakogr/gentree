// Selection rules for the shared multi-select dropdown. An empty selection is
// the "all" state, so the dedicated all-row clears every chosen id; any other
// id is toggled in place. Pure and DOM-free so the contract stays testable.

/**
 * Toggle one option in a multi-select value list. `""` is the all-row id and
 * clears the selection. The input array is never mutated.
 */
export function toggleMultiSelect(
  values: readonly string[],
  id: string,
): string[] {
  if (id === "") return [];
  return values.includes(id)
    ? values.filter((value) => value !== id)
    : [...values, id];
}
