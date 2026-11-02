import type { ShellTab } from "../../lib/navigation";

/** Ordered steps of the first-run tour. */
export type TourStepId =
  | "welcome"
  | "projects"
  | "create"
  | "persons"
  | "personsAdd"
  | "events"
  | "eventsAdd"
  | "map"
  | "graph"
  | "timeline"
  | "path"
  | "search"
  | "chat"
  | "help"
  | "finish";

export type TourStep = {
  id: TourStepId;
  /** `data-tour` value of the element to highlight; absent means centered. */
  target?: string;
  /** Shell screen opened when the step starts. */
  screen?: ShellTab;
  /**
   * Where the bubble prefers to sit. `top-right` keeps the page body (search
   * results, lists) visible instead of covering it next to a sidebar item.
   */
  placement?: "auto" | "top-right";
  /** Listed only while no project is open. */
  noProjectOnly?: boolean;
  /** Listed only while a project is open. */
  projectOnly?: boolean;
};

/**
 * The whole tour. Copy lives in the `onboarding` dictionary, keyed by step id,
 * so adding a step means adding two keys per locale.
 */
const STEPS: readonly TourStep[] = [
  { id: "welcome" },
  { id: "projects", target: "nav-projects", screen: "projects" },
  {
    id: "create",
    target: "projects-create",
    screen: "projects",
    noProjectOnly: true,
  },
  { id: "persons", target: "nav-persons", screen: "persons", projectOnly: true },
  {
    id: "personsAdd",
    target: "persons-add",
    screen: "persons",
    projectOnly: true,
  },
  { id: "events", target: "nav-events", screen: "events", projectOnly: true },
  {
    id: "eventsAdd",
    target: "events-add",
    screen: "events",
    projectOnly: true,
  },
  { id: "map", target: "nav-map", screen: "map", projectOnly: true },
  { id: "graph", target: "nav-graph", screen: "graph", projectOnly: true },
  {
    id: "timeline",
    target: "nav-timeline",
    screen: "timeline",
    projectOnly: true,
  },
  { id: "path", target: "nav-path", screen: "path", projectOnly: true },
  {
    id: "search",
    target: "search-input",
    screen: "search",
    placement: "top-right",
    projectOnly: true,
  },
  { id: "chat", target: "nav-chat", screen: "chat", projectOnly: true },
  { id: "help", target: "nav-help", screen: "help", projectOnly: true },
  { id: "finish" },
];

/** Steps that make sense in the current shell state. */
export function tourSteps(projectOpen: boolean): readonly TourStep[] {
  return STEPS.filter((step) =>
    projectOpen ? !step.noProjectOnly : !step.projectOnly,
  );
}

export function stepIndex(
  steps: readonly TourStep[],
  id: TourStepId,
): number {
  return steps.findIndex((step) => step.id === id);
}

/** Neighbouring step, or `null` at either end of the list. */
export function adjacentStep(
  steps: readonly TourStep[],
  id: TourStepId,
  direction: 1 | -1,
): TourStep | null {
  const index = stepIndex(steps, id);
  if (index < 0) return null;
  return steps[index + direction] ?? null;
}

export function isLastStep(
  steps: readonly TourStep[],
  id: TourStepId,
): boolean {
  const index = stepIndex(steps, id);
  return index >= 0 && index === steps.length - 1;
}
