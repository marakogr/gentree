// Navigation actions available on a person row and on the person card.
// Pure mapping: the shell turns a target into tab state, the components only
// choose the action.

export type PersonNavigationAction = "tree" | "timeline";

export type PersonNavigationTarget = {
  tab: "graph" | "timeline";
  personId: string;
};

export const PERSON_NAVIGATION_ACTIONS: readonly PersonNavigationAction[] = [
  "tree",
  "timeline",
];

/** Label key for the action button (namespaces are resolved by i18next). */
export function personNavigationLabelKey(
  action: PersonNavigationAction,
): string {
  return action === "tree"
    ? "common:actions.openTree"
    : "common:actions.openTimeline";
}

/** Tab and focus that one navigation action requests. */
export function personNavigationTarget(
  action: PersonNavigationAction,
  personId: string,
): PersonNavigationTarget {
  return action === "tree"
    ? { tab: "graph", personId }
    : { tab: "timeline", personId };
}
