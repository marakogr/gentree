import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_STATE,
  MAX_STORED_PROJECTS,
  SECTION_KEYS,
  hasActiveFilters,
  mergeViewState,
  pruneProjects,
  readProjectViews,
  viewStorageKey,
  writeProjectViews,
  type ProjectViews,
  type SectionViewState,
  type ViewStorage,
} from "./viewState";

/** localStorage stand-in; can simulate a broken getItem/setItem. */
function fakeStorage(initial: Record<string, string> = {}): ViewStorage & {
  values: Record<string, string>;
  failRead: boolean;
  failWrite: boolean;
} {
  const values = { ...initial };
  const storage = {
    values,
    failRead: false,
    failWrite: false,
    getItem(key: string): string | null {
      if (storage.failRead) throw new Error("blocked");
      return values[key] ?? null;
    },
    setItem(key: string, value: string): void {
      if (storage.failWrite) throw new Error("QuotaExceededError");
      values[key] = value;
    },
  };
  return storage;
}

function state(overrides: Partial<SectionViewState> = {}): SectionViewState {
  return { ...mergeViewState(undefined), ...overrides };
}

describe("viewStorageKey", () => {
  it("namespaces one key per project", () => {
    expect(viewStorageKey("p1")).toBe("gentree.views.v1.p1");
    expect(viewStorageKey("p2")).not.toBe(viewStorageKey("p1"));
  });
});

describe("DEFAULT_VIEW_STATE", () => {
  it("is the pristine empty state", () => {
    expect(DEFAULT_VIEW_STATE).toEqual({
      query: "",
      filters: {},
      sort: null,
      page: 0,
      scrollTop: 0,
      selectedId: null,
    });
    expect(SECTION_KEYS).toEqual([
      "persons",
      "events",
      "timeline",
      "map",
      "search",
      "chat",
    ]);
  });

  it("cannot be mutated by accident", () => {
    expect(Object.isFrozen(DEFAULT_VIEW_STATE)).toBe(true);
    expect(() => {
      (DEFAULT_VIEW_STATE as SectionViewState).page = 3;
    }).toThrow();
    expect(DEFAULT_VIEW_STATE.page).toBe(0);
  });
});

describe("mergeViewState", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const stored of [undefined, null, 0, 42, "persons", [], true]) {
      expect(mergeViewState(stored)).toEqual(DEFAULT_VIEW_STATE);
    }
  });

  it("returns a fresh object that does not alias the defaults", () => {
    const merged = mergeViewState(undefined);
    expect(merged).not.toBe(DEFAULT_VIEW_STATE);
    merged.filters.gender = "FEMALE";
    expect(DEFAULT_VIEW_STATE.filters).toEqual({});
  });

  it("keeps the valid fields and drops broken ones", () => {
    const merged = mergeViewState({
      query: "ann",
      filters: { gender: "FEMALE", tags: ["a", "b"] },
      sort: { key: "birth", direction: "desc" },
      page: 2,
      scrollTop: 640,
      selectedId: "person-1",
      unknownKey: "ignored",
    });
    expect(merged).toEqual({
      query: "ann",
      filters: { gender: "FEMALE", tags: ["a", "b"] },
      sort: { key: "birth", direction: "desc" },
      page: 2,
      scrollTop: 640,
      selectedId: "person-1",
    });
    expect("unknownKey" in merged).toBe(false);
  });

  it("repairs garbage field types", () => {
    const merged = mergeViewState({
      query: 5,
      filters: "gender",
      sort: { key: "birth", direction: "sideways" },
      page: -4,
      scrollTop: -1,
      selectedId: 7,
    });
    expect(merged).toEqual(DEFAULT_VIEW_STATE);
  });

  it("sanitises filter keys and nested values", () => {
    const merged = mergeViewState({
      filters: {
        gender: "FEMALE",
        empty: "",
        list: ["a", 2, null, ""],
        emptyList: [3],
        nested: { value: "x" },
      },
    });
    expect(merged.filters).toEqual({ gender: "FEMALE", list: ["a"] });
  });

  it("floors fractional counters and ignores non-finite ones", () => {
    expect(mergeViewState({ page: 2.9, scrollTop: 10.5 }).page).toBe(2);
    expect(mergeViewState({ page: 2.9, scrollTop: 10.5 }).scrollTop).toBe(10);
    expect(mergeViewState({ page: Infinity }).page).toBe(0);
    expect(mergeViewState({ scrollTop: NaN }).scrollTop).toBe(0);
  });

  it("treats empty strings as no selection and no query", () => {
    expect(mergeViewState({ query: "", selectedId: "" })).toEqual(
      DEFAULT_VIEW_STATE,
    );
  });
});

describe("hasActiveFilters", () => {
  it("is false only for the pristine state", () => {
    expect(hasActiveFilters(DEFAULT_VIEW_STATE)).toBe(false);
    expect(hasActiveFilters(mergeViewState(undefined))).toBe(false);
    expect(
      hasActiveFilters(
        state({ query: "   ", filters: { gender: "" }, page: 0 }),
      ),
    ).toBe(false);
  });

  it("reacts to every source of state", () => {
    expect(hasActiveFilters(state({ query: "ann" }))).toBe(true);
    expect(hasActiveFilters(state({ query: "  ann  " }))).toBe(true);
    expect(hasActiveFilters(state({ filters: { gender: "FEMALE" } }))).toBe(
      true,
    );
    expect(hasActiveFilters(state({ filters: { tags: ["a"] } }))).toBe(true);
    expect(
      hasActiveFilters(state({ sort: { key: "name", direction: "asc" } })),
    ).toBe(true);
    expect(hasActiveFilters(state({ page: 1 }))).toBe(true);
    expect(hasActiveFilters(state({ selectedId: "person-1" }))).toBe(true);
  });

  it("ignores empty filter collections", () => {
    expect(hasActiveFilters(state({ filters: { tags: [] } }))).toBe(false);
  });
});

describe("storage", () => {
  it("is a no-op without window (node environment)", () => {
    expect(typeof window).toBe("undefined");
    expect(readProjectViews("p1")).toEqual({});
    expect(() => {
      writeProjectViews("p1", { persons: state({ query: "ann" }) });
    }).not.toThrow();
  });

  it("restores every section after a restart", () => {
    const storage = fakeStorage();
    const views: ProjectViews = {
      persons: state({
        query: "ann",
        filters: { gender: "FEMALE", tags: ["a", "b"] },
        sort: { key: "birth", direction: "asc" },
        page: 2,
        scrollTop: 480,
        selectedId: "person-1",
      }),
      events: state({ query: "marriage", page: 1 }),
      timeline: state({ scrollTop: 1200 }),
    };
    writeProjectViews("project-a", views, storage);

    // A fresh read simulates the next app start with the same storage.
    expect(readProjectViews("project-a", storage)).toEqual(views);
  });

  it("keeps sections that were not written by the last call", () => {
    const storage = fakeStorage();
    writeProjectViews(
      "project-a",
      { persons: state({ query: "ann" }), events: state({ page: 1 }) },
      storage,
    );
    writeProjectViews(
      "project-a",
      { persons: state({ query: "bob" }) },
      storage,
    );
    const restored = readProjectViews("project-a", storage);
    expect(restored.persons?.query).toBe("bob");
    expect(restored.events?.page).toBe(1);
  });

  it("isolates projects from each other", () => {
    const storage = fakeStorage();
    writeProjectViews(
      "project-a",
      { persons: state({ query: "ann", page: 3 }) },
      storage,
    );
    writeProjectViews(
      "project-b",
      { persons: state({ query: "bob" }) },
      storage,
    );

    expect(readProjectViews("project-a", storage).persons).toEqual(
      state({ query: "ann", page: 3 }),
    );
    expect(readProjectViews("project-b", storage).persons).toEqual(
      state({ query: "bob" }),
    );
  });

  it("starts clean when the project changes", () => {
    const storage = fakeStorage();
    writeProjectViews("project-a", { persons: state({ query: "ann" }) }, storage);

    // Switching to a project without stored state yields the defaults.
    const switched = readProjectViews("project-c", storage);
    expect(switched.persons).toBeUndefined();
    expect(mergeViewState(switched.persons)).toEqual(DEFAULT_VIEW_STATE);
    // ...and does not disturb the first project.
    expect(readProjectViews("project-a", storage).persons?.query).toBe("ann");
  });

  it("survives garbage in localStorage", () => {
    const storage = fakeStorage({
      [viewStorageKey("broken-json")]: "{not json",
      [viewStorageKey("array")]: "[1,2,3]",
      [viewStorageKey("null")]: "null",
      [viewStorageKey("garbage")]: JSON.stringify({
        persons: { query: 42, page: -9, filters: ["x"], sort: "name" },
        events: "nope",
        unknownSection: { query: "ignored" },
      }),
    });

    expect(readProjectViews("broken-json", storage)).toEqual({});
    expect(readProjectViews("array", storage)).toEqual({});
    expect(readProjectViews("null", storage)).toEqual({});
    expect(readProjectViews("missing", storage)).toEqual({});

    const views = readProjectViews("garbage", storage);
    expect(views.persons).toEqual(DEFAULT_VIEW_STATE);
    expect(views.events).toEqual(DEFAULT_VIEW_STATE);
    expect(views.unknownSection).toBeUndefined();
  });

  it("drops unknown sections and broken keys on write", () => {
    const storage = fakeStorage({
      [viewStorageKey("p1")]: JSON.stringify({ persons: { page: 1 } }),
    });
    writeProjectViews(
      "p1",
      {
        timeline: state({ page: 2 }),
        madeUp: state({ page: 3 }),
      } as ProjectViews,
      storage,
    );
    const stored = JSON.parse(storage.values[viewStorageKey("p1")] ?? "{}");
    expect(Object.keys(stored).sort()).toEqual(["persons", "timeline"]);
    // The untouched section survives, but is re-validated and normalised.
    expect(stored.persons).toEqual(state({ page: 1 }));
    expect(stored.timeline.page).toBe(2);
  });

  it("never throws on broken storage", () => {
    const readFailure = fakeStorage();
    readFailure.failRead = true;
    expect(readProjectViews("p1", readFailure)).toEqual({});
    expect(() => {
      writeProjectViews("p1", { persons: state() }, readFailure);
    }).not.toThrow();

    const writeFailure = fakeStorage();
    writeFailure.failWrite = true;
    expect(() => {
      writeProjectViews("p1", { persons: state({ query: "ann" }) }, writeFailure);
    }).not.toThrow();
    expect(writeFailure.values).toEqual({});
  });
});

describe("pruneProjects", () => {
  const store = {
    a: { persons: "a" },
    b: { persons: "b" },
    c: { persons: "c" },
    d: { persons: "d" },
    e: { persons: "e" },
  };

  it("keeps only the listed projects, in caller priority order", () => {
    expect(Object.keys(pruneProjects(store, ["e", "a"]))).toEqual(["e", "a"]);
  });

  it("caps the store at three projects by default", () => {
    const kept = pruneProjects(store, ["e", "d", "c", "b", "a"]);
    expect(MAX_STORED_PROJECTS).toBe(3);
    expect(Object.keys(kept)).toEqual(["e", "d", "c"]);
    expect(kept.e).toEqual({ persons: "e" });
  });

  it("honours an explicit cap and de-duplicates ids", () => {
    expect(Object.keys(pruneProjects(store, ["b", "b", "a", "c"], 2))).toEqual([
      "b",
      "a",
    ]);
    expect(pruneProjects(store, ["a"], 0)).toEqual({});
  });

  it("skips ids that are not stored and leaves the input untouched", () => {
    const kept = pruneProjects(store, ["missing", "b"]);
    expect(Object.keys(kept)).toEqual(["b"]);
    expect(Object.keys(store)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("is deterministic regardless of object key order", () => {
    const reordered = { d: store.d, c: store.c, b: store.b, a: store.a };
    expect(Object.keys(pruneProjects(reordered, ["a", "b"]))).toEqual([
      "a",
      "b",
    ]);
  });
});
