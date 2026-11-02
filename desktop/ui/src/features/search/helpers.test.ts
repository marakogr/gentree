import { describe, expect, it } from "vitest";
import type {
  SearchEntityType,
  SearchGroup,
  SearchHighlight,
  SearchItem,
  SearchResponse,
} from "../../api/types";
import {
  filterGroups,
  isSearchable,
  localizeEventSnippet,
  MIN_QUERY_LENGTH,
  normalizeQuery,
  QUERY_DEBOUNCE_MS,
  resultCount,
  SEARCH_ENTITY_TYPES,
  SEARCH_TYPE_FILTER,
  searchTypeFilter,
  searchTypeFilters,
  segmentHighlights,
  similarBadgeCount,
  toggleSearchType,
  visibleGroups,
} from "./helpers";

function item(
  entityType: SearchEntityType,
  entityId: string,
): SearchItem {
  return {
    entityType,
    entityId,
    snippet: entityId,
    highlights: [],
    similarCount: 1,
  };
}

function group(
  entityType: SearchEntityType,
  items: SearchItem[],
): SearchGroup {
  return { entityType, count: items.length, items };
}

function response(groups: SearchGroup[]): SearchResponse {
  const matchCount = groups.reduce(
    (total, current) => total + current.items.length,
    0,
  );
  return { groups, matchCount, truncated: false };
}

function marked(segments: ReturnType<typeof segmentHighlights>): string[] {
  return segments
    .filter((segment) => segment.highlighted)
    .map((segment) => segment.text);
}

describe("segmentHighlights", () => {
  it("merges adjacent and overlapping ranges", () => {
    const ranges: SearchHighlight[] = [
      { start: 1, end: 3 },
      { start: 3, end: 5 },
      { start: 4, end: 6 },
    ];
    expect(segmentHighlights("abcdef", ranges)).toEqual([
      { text: "a", highlighted: false },
      { text: "bcdef", highlighted: true },
    ]);
  });

  it("clamps ranges to the text and drops empty or inverted ones", () => {
    const ranges: SearchHighlight[] = [
      { start: -2, end: 2 },
      { start: 5, end: 99 },
      { start: 3, end: 3 },
      { start: 4, end: 2 },
    ];
    expect(segmentHighlights("abcdef", ranges)).toEqual([
      { text: "ab", highlighted: true },
      { text: "cde", highlighted: false },
      { text: "f", highlighted: true },
    ]);
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    expect(segmentHighlights("a😀b", [{ start: 1, end: 2 }])).toEqual([
      { text: "a", highlighted: false },
      { text: "😀", highlighted: true },
      { text: "b", highlighted: false },
    ]);
  });

  it("returns plain text when there are no ranges and nothing for empty text", () => {
    expect(segmentHighlights("abc", [])).toEqual([
      { text: "abc", highlighted: false },
    ]);
    expect(segmentHighlights("", [])).toEqual([]);
    expect(marked(segmentHighlights("abc", []))).toEqual([]);
  });

  it("ignores non-integer and non-finite offsets", () => {
    const ranges = [
      { start: 0.5, end: 2 },
      { start: Number.NaN, end: 2 },
      { start: 1, end: 2 },
    ] as SearchHighlight[];
    expect(marked(segmentHighlights("abc", ranges))).toEqual(["b"]);
  });
});

describe("visibleGroups and resultCount", () => {
  it("drops empty groups and counts rendered results", () => {
    const result = response([
      group("person", [item("person", "p1"), item("person", "p2")]),
      group("event", []),
      group("source", [item("source", "s1")]),
    ]);
    expect(visibleGroups(result).map((entry) => entry.entityType)).toEqual([
      "person",
      "source",
    ]);
    expect(resultCount(result)).toBe(3);
  });

  it("treats an empty response as no groups", () => {
    const empty = response([
      group("person", []),
      group("event", []),
      group("source", []),
    ]);
    expect(visibleGroups(empty)).toEqual([]);
    expect(resultCount(empty)).toBe(0);
    expect(visibleGroups(null)).toEqual([]);
    expect(resultCount(null)).toBe(0);
  });
});

describe("isSearchable and normalizeQuery", () => {
  it("requires at least three non-space characters", () => {
    expect(MIN_QUERY_LENGTH).toBe(3);
    expect(isSearchable("")).toBe(false);
    expect(isSearchable("  a ")).toBe(false);
    expect(isSearchable("он")).toBe(false);
    expect(isSearchable("  он  ")).toBe(false);
    expect(isSearchable("онк")).toBe(true);
    expect(isSearchable("  онк  ")).toBe(true);
  });

  it("trims a searchable query and rejects short input", () => {
    expect(normalizeQuery("  онколо ")).toBe("онколо");
    expect(normalizeQuery("он")).toBeNull();
    expect(normalizeQuery("   ")).toBeNull();
    expect(normalizeQuery("")).toBeNull();
  });
});

describe("auto-search timing", () => {
  it("debounces for 250 ms so typing does not fire a request per keystroke", () => {
    expect(QUERY_DEBOUNCE_MS).toBe(250);
  });
});

describe("entity type filter", () => {
  it("reads and sanitizes the persisted type filter in render order", () => {
    expect(searchTypeFilter({})).toEqual([]);
    expect(
      searchTypeFilter({ [SEARCH_TYPE_FILTER]: ["source", "unknown", "person"] }),
    ).toEqual(["person", "source"]);
    expect(searchTypeFilter({ [SEARCH_TYPE_FILTER]: "event" })).toEqual([
      "event",
    ]);
    expect(SEARCH_ENTITY_TYPES).toEqual(["person", "event", "source"]);
    expect(searchTypeFilters(["source", "person"])).toEqual([
      "person",
      "source",
    ]);
    expect(searchTypeFilters([])).toEqual([]);
  });

  it("toggles a type and keeps the canonical order", () => {
    expect(toggleSearchType([], "event")).toEqual(["event"]);
    expect(toggleSearchType(["event"], "person")).toEqual(["person", "event"]);
    expect(toggleSearchType(["person", "event"], "event")).toEqual(["person"]);
    expect(toggleSearchType(["person"], "person")).toEqual([]);
  });

  it("filters groups and counts by the selected types", () => {
    const result = response([
      group("person", [item("person", "p1")]),
      group("event", [item("event", "e1"), item("event", "e2")]),
      group("source", [item("source", "s1")]),
    ]);

    expect(filterGroups(result, []).map((entry) => entry.entityType)).toEqual([
      "person",
      "event",
      "source",
    ]);
    expect(
      filterGroups(result, ["event", "source"]).map((entry) => entry.entityType),
    ).toEqual(["event", "source"]);
    expect(resultCount(result, ["event"])).toBe(2);
    expect(resultCount(result, ["source"])).toBe(1);
    expect(visibleGroups(result, ["source"])).toHaveLength(1);
    expect(resultCount(null, ["source"])).toBe(0);
  });
});

describe("localizeEventSnippet", () => {
  it("replaces the leading type code and shifts following highlights", () => {
    const result = localizeEventSnippet(
      "birth Иван Петров",
      [{ start: 6, end: 10 }],
      { birth: "Рождение" },
    );
    expect(result.text).toBe("Рождение Иван Петров");
    expect(result.highlights).toEqual([{ start: 9, end: 13 }]);
    expect(marked(segmentHighlights(result.text, result.highlights))).toEqual([
      "Иван",
    ]);
  });

  it("maps a highlight that covered the code onto the whole label", () => {
    const result = localizeEventSnippet(
      "marriage Анна",
      [{ start: 0, end: 8 }],
      { marriage: "Брак" },
    );
    expect(result.text).toBe("Брак Анна");
    expect(result.highlights).toEqual([{ start: 0, end: 4 }]);
  });

  it("keeps non-event snippets and unknown codes untouched", () => {
    const highlights = [{ start: 0, end: 1 }];
    expect(
      localizeEventSnippet("Иван Петров", highlights, { birth: "Рождение" }),
    ).toEqual({ text: "Иван Петров", highlights });
    expect(
      localizeEventSnippet("wedding Анна", highlights, { birth: "Рождение" }),
    ).toEqual({ text: "wedding Анна", highlights });
  });
});

describe("collapsed duplicate snippets", () => {
  it("derives the hidden-duplicate badge from the server count", () => {
    expect(similarBadgeCount({ similarCount: 5 })).toBe(4);
    expect(similarBadgeCount({ similarCount: 2 })).toBe(1);
    expect(similarBadgeCount({ similarCount: 1 })).toBeNull();
    // Older payloads omit the field; malformed values never render a badge.
    expect(similarBadgeCount({})).toBeNull();
    expect(similarBadgeCount({ similarCount: 0 })).toBeNull();
    expect(similarBadgeCount({ similarCount: Number.NaN })).toBeNull();
    expect(similarBadgeCount({ similarCount: 2.9 })).toBe(1);
  });

  it("counts rows, not hidden duplicates, when a group collapses", () => {
    const collapsed: SearchItem = { ...item("person", "p1"), similarCount: 5 };
    const result: SearchResponse = {
      groups: [{ entityType: "person", count: 1, items: [collapsed] }],
      matchCount: 1,
      truncated: false,
    };

    expect(visibleGroups(result)).toHaveLength(1);
    expect(resultCount(result)).toBe(1);
    expect(similarBadgeCount(collapsed)).toBe(4);
  });
});
