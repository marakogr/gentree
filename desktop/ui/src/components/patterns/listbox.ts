// Pure keyboard model shared by the single- and multi-select dropdowns.

import { moveActiveIndex } from "../ui/helpers";

export type ListboxAction =
  | { type: "move"; index: number }
  | { type: "activate"; index: number }
  | { type: "close"; restoreFocus: boolean }
  | { type: "ignore" };

/** First active index for a list; `-1` when empty. */
export function firstActiveIndex(length: number): number {
  return length > 0 ? 0 : -1;
}

/** Last active index for a list; `-1` when empty. */
export function lastActiveIndex(length: number): number {
  return length > 0 ? length - 1 : -1;
}

/**
 * Map a key to an action for the listbox. `active` is the highlighted row;
 * `length` is the number of rows (including the multi-select "all" row).
 */
export function listboxKeyAction(
  key: string,
  active: number,
  length: number,
): ListboxAction {
  switch (key) {
    case "ArrowDown":
      return { type: "move", index: moveActiveIndex(active, 1, length) };
    case "ArrowUp":
      return { type: "move", index: moveActiveIndex(active, -1, length) };
    case "Home":
      return { type: "move", index: firstActiveIndex(length) };
    case "End":
      return { type: "move", index: lastActiveIndex(length) };
    case "Enter":
      return active >= 0 && active < length
        ? { type: "activate", index: active }
        : { type: "ignore" };
    case "Escape":
      return { type: "close", restoreFocus: true };
    case "Tab":
      return { type: "close", restoreFocus: false };
    default:
      return { type: "ignore" };
  }
}

/** DOM id of an option row, so the component can scroll it into view. */
export function optionElementId(baseId: string, optionId: string): string {
  return `${baseId}-option-${optionId === "" ? "all" : optionId}`;
}
