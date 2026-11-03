import type { TimelineListParams, TimelineScope } from "../../api/types";
import type { Translate } from "../../lib/dates";

/** Focus choices shown by the line screen, in the order of the panel. */
export const LINE_SCOPES = [
  "all",
  "person",
  "ancestors",
  "descendants",
  "both",
] as const satisfies readonly TimelineScope[];

/** Depth of the ancestors/descendants walk; mirrors the backend default. */
export const DEFAULT_GENERATIONS = 10;

/** Hard cap of the ancestors/descendants walk; mirrors the backend. */
export const MAX_GENERATIONS = 50;

/** Clamps the walk depth to `1..MAX_GENERATIONS`, defaults on garbage. */
export function clampGenerations(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GENERATIONS;
  }
  return Math.min(MAX_GENERATIONS, Math.max(1, Math.trunc(value)));
}

/** Localized label for a focus choice. */
export function scopeLabel(scope: TimelineScope, t: Translate): string {
  return t(`scope.${scope}`);
}

/** `person`/`ancestors`/`descendants`/`both` need a focus person. */
export function scopeRequiresPerson(scope: TimelineScope): boolean {
  return (
    scope === "person" ||
    scope === "ancestors" ||
    scope === "descendants" ||
    scope === "both"
  );
}

/** The committed focus that drives one `timeline_list` request. */
export interface LineScopeState {
  scope: TimelineScope;
  personId: string | null;
  /** Depth of the ancestors/descendants walk. */
  generations?: number;
}

/**
 * Scope-specific command parameters. Only the fields the scope actually needs
 * are filled, so an invalid combination is never sent.
 */
export function buildTimelineEventsOptions(
  state: LineScopeState,
): TimelineListParams {
  const options: TimelineListParams = { scope: state.scope };
  if (scopeRequiresPerson(state.scope) && state.personId !== null) {
    options.personId = state.personId;
  }
  if (
    (state.scope === "ancestors" ||
      state.scope === "descendants" ||
      state.scope === "both") &&
    state.generations !== undefined
  ) {
    options.generations = state.generations;
  }
  return options;
}

/** Whether a request can be issued for the given focus. */
export function canRequestScope(state: LineScopeState): boolean {
  if (state.scope === "all") {
    return true;
  }
  return scopeRequiresPerson(state.scope) && state.personId !== null;
}

/**
 * Monotonic guard for `timeline_list` responses. Two quick activations issue
 * two IPC calls that may resolve out of order; only the response of the newest
 * request may write the line, so a slower stale answer cannot blank it.
 */
export interface LineRequestGuard {
  /** Registers a new request and returns its id. */
  begin(): number;
  /** True when the response belongs to the newest registered request. */
  accepts(id: number): boolean;
}

/** Creates a fresh request guard; one instance lives per screen mount. */
export function createLineRequestGuard(): LineRequestGuard {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    accepts(id) {
      return id === latest;
    },
  };
}
