import { describe, expect, it } from "vitest";
import type { DateValue } from "../../api/types";
import { parseCivilDate } from "../../lib/dates";
import { DEFAULT_VIEW_STATE, mergeViewState } from "../../lib/viewState";
import { dateOverlaps } from "../events/helpers";
import { canRequestScope, createLineRequestGuard } from "./scope";
import {
  buildTimelineListParams,
  DEFAULT_TIMELINE_VIEW,
  resetTimelineView,
  resolveInitialTimelineView,
  timelineFilters,
  timelineViewFromState,
  timelineViewPatch,
  type TimelineView,
} from "./view";

function stored(
  overrides: Parameters<typeof mergeViewState>[0],
): ReturnType<typeof mergeViewState> {
  return mergeViewState(overrides);
}

function view(overrides: Partial<TimelineView> = {}): TimelineView {
  return { ...DEFAULT_TIMELINE_VIEW, ...overrides };
}

describe("timelineViewFromState", () => {
  it("restores a valid view from persisted state", () => {
    const restored = timelineViewFromState(
      stored({
        filters: {
          scope: "ancestors",
          personId: "p1",
          generations: "4",
        },
        sort: { key: "person", direction: "desc" },
        scrollTop: 120,
        selectedId: "e1",
      }),
    );

    expect(restored).toEqual({
      scope: "ancestors",
      personId: "p1",
      generations: 4,
      sort: "person",
      sortDirection: "desc",
    });
  });

  it("drops unknown scopes, types and sort keys", () => {
    const restored = timelineViewFromState(
      stored({
        filters: {
          scope: "galaxy",
          generations: "999",
        },
        sort: { key: "colour", direction: "desc" },
      }),
    );

    expect(restored.scope).toBe("all");
    expect(restored.generations).toBe(50);
    expect(restored.sort).toBe("date");
    expect(restored.sortDirection).toBe("desc");
  });

  it("falls back to `all` for the removed place scope and ignores removed fields", () => {
    const restored = timelineViewFromState(
      stored({
        query: "Kazan",
        filters: { scope: "place", place: "Kazan", personId: "p1" },
      }),
    );

    expect(restored.scope).toBe("all");
    expect(restored).not.toHaveProperty("query");
    expect(restored).not.toHaveProperty("place");
  });

  it("returns the defaults for an empty state", () => {
    expect(timelineViewFromState(DEFAULT_VIEW_STATE)).toEqual(
      DEFAULT_TIMELINE_VIEW,
    );
  });
});

describe("resolveInitialTimelineView", () => {
  it("lets the one-shot person deep link win over the stored focus", () => {
    const resolved = resolveInitialTimelineView({
      stored: stored({
        filters: { scope: "ancestors", personId: "old", generations: "3" },
      }),
      initialScope: "person",
      initialPersonId: "new-person",
    });

    expect(resolved.scope).toBe("person");
    expect(resolved.personId).toBe("new-person");
    // Other stored filters stay intact.
    expect(resolved.generations).toBe(3);
  });

  it("restores the stored focus when there is no deep link", () => {
    const resolved = resolveInitialTimelineView({
      stored: stored({
        filters: { scope: "descendants", personId: "p1" },
      }),
      initialScope: "all",
      initialPersonId: null,
    });

    expect(resolved.scope).toBe("descendants");
    expect(resolved.personId).toBe("p1");
  });

  it("keeps an empty initial person id as no deep link", () => {
    const resolved = resolveInitialTimelineView({
      stored: stored({ filters: { scope: "ancestors", personId: "p1" } }),
      initialScope: "person",
      initialPersonId: "",
    });

    expect(resolved.scope).toBe("ancestors");
    expect(resolved.personId).toBe("p1");
  });

  it("migrates a stored place scope to `all` when the section is reopened", () => {
    const resolved = resolveInitialTimelineView({
      stored: stored({
        filters: { scope: "place", place: "Kazan" },
        scrollTop: 240,
      }),
      initialScope: "all",
      initialPersonId: null,
    });

    expect(resolved.scope).toBe("all");
    expect(resolved).not.toHaveProperty("place");
  });
});

describe("resetTimelineView", () => {
  it("clears focus, person, types and generations", () => {
    const dirty = view({
      scope: "ancestors",
      personId: "p1",
      generations: 3,
    });

    expect(resetTimelineView(dirty)).toEqual(DEFAULT_TIMELINE_VIEW);
  });

  it("keeps the legacy persisted sort of the removed list", () => {
    const reset = resetTimelineView(
      view({ scope: "person", personId: "p1", sort: "person", sortDirection: "desc" }),
    );

    expect(reset.sort).toBe("person");
    expect(reset.sortDirection).toBe("desc");
    expect(reset.scope).toBe("all");
    expect(reset.personId).toBeNull();
  });
});

describe("timelineFilters and timelineViewPatch", () => {
  it("serialises only active values", () => {
    expect(timelineFilters(view())).toEqual({
      generations: "10",
    });

    expect(
      timelineFilters(
        view({
          scope: "person",
          personId: "p1",
          generations: 3,
        }),
      ),
    ).toEqual({
      scope: "person",
      personId: "p1",
      generations: "3",
    });
  });

  it("round-trips through the persisted state", () => {
    const original = view({
      scope: "ancestors",
      personId: "p1",
      generations: 5,
      sort: "type",
      sortDirection: "desc",
    });
    const patch = timelineViewPatch(original);
    const roundTripped = timelineViewFromState(stored({ ...patch }));
    expect(roundTripped).toEqual(original);
  });
});

describe("buildTimelineListParams", () => {
  it("maps the focus to timeline_list parameters", () => {
    expect(
      buildTimelineListParams(
        view({
          scope: "ancestors",
          personId: "p1",
          generations: 4,
        }),
      ),
    ).toEqual({
      scope: "ancestors",
      personId: "p1",
      generations: 4,
    });
  });

  it("requests the whole tree without extra parameters", () => {
    expect(buildTimelineListParams(view())).toEqual({ scope: "all" });
  });

  it("adds the shared types and half-open year bounds", () => {
    expect(
      buildTimelineListParams(view(), ["BIRTH", "DEATH"], "1900", "1950"),
    ).toEqual({
      scope: "all",
      types: ["BIRTH", "DEATH"],
      from: "1900-01-01",
      to: "1951-01-01",
    });
    expect(
      buildTimelineListParams(view(), [], "", "1950"),
    ).toEqual({ scope: "all", to: "1951-01-01" });
  });

  it("keeps 31 December of the upper year inside the request", () => {
    const params = buildTimelineListParams(view(), [], "", "1986");
    expect(params.to).toBe("1987-01-01");
    const to = params.to ? parseCivilDate(params.to) : null;
    const lastDay: DateValue = {
      start: "1986-12-31",
      end: null,
      precision: "DAY",
      qualifier: "EXACT",
      original: null,
    };
    expect(to).not.toBeNull();
    expect(dateOverlaps(lastDay, null, to)).toBe(true);
  });
});

describe("canRequestScope", () => {
  it("requests the whole tree for `all` without a person", () => {
    expect(
      canRequestScope({ scope: "all", personId: null, generations: 10 }),
    ).toBe(true);
  });

  it("requires a person for the person-based scopes", () => {
    expect(
      canRequestScope({ scope: "person", personId: null, generations: 10 }),
    ).toBe(false);
    expect(
      canRequestScope({ scope: "ancestors", personId: "p1", generations: 10 }),
    ).toBe(true);
  });
});

describe("createLineRequestGuard", () => {
  it("accepts only the newest request so a stale answer cannot write the line", () => {
    const guard = createLineRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.accepts(second)).toBe(true);
    expect(guard.accepts(first)).toBe(false);
    // An out-of-order stale response arriving after the fresh one is ignored.
    expect(guard.accepts(first)).toBe(false);
    expect(guard.accepts(second)).toBe(true);
  });

  it("ignores a response superseded by an incomplete focus", () => {
    const guard = createLineRequestGuard();
    const stale = guard.begin();
    guard.begin();

    expect(guard.accepts(stale)).toBe(false);
  });
});
