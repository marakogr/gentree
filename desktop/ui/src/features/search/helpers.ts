// Pure helpers for the search screen: highlight segmentation and group
// counting. No DOM, no IPC. Snippet offsets come from Rust as Unicode scalar
// values, so the text is segmented by code points (`Array.from`), not UTF-16
// code units.

import type {
  SearchEntityType,
  SearchGroup,
  SearchHighlight,
  SearchResponse,
} from "../../api/types";
import type { ViewFilters } from "../../lib/viewState";

/** Queries shorter than this never reach the backend (search-ui spec). */
export const MIN_QUERY_LENGTH = 3;

/** Idle time before a typed query is sent automatically. */
export const QUERY_DEBOUNCE_MS = 250;

/** Entity groups in the order they are rendered. */
export const SEARCH_ENTITY_TYPES: readonly SearchEntityType[] = [
  "person",
  "event",
  "source",
];

/** Name of the persisted filter that holds the selected entity types. */
export const SEARCH_TYPE_FILTER = "type";

function isEntityType(value: string): value is SearchEntityType {
  return (SEARCH_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Selected entity types from the persisted filters. Empty means "no type
 * filter" (all groups are visible).
 */
export function searchTypeFilter(
  filters: ViewFilters,
): SearchEntityType[] {
  const raw = filters[SEARCH_TYPE_FILTER];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const selected: SearchEntityType[] = [];
  for (const value of SEARCH_ENTITY_TYPES) {
    if (list.includes(value)) selected.push(value);
  }
  return selected;
}

/** Adds the type when missing and removes it when present (stable order). */
export function toggleSearchType(
  selected: readonly SearchEntityType[],
  type: SearchEntityType,
): SearchEntityType[] {
  const next = selected.includes(type)
    ? selected.filter((value) => value !== type)
    : [...selected, type];
  return SEARCH_ENTITY_TYPES.filter((value) => next.includes(value));
}

/** Persisted filter value for the selected types; `[]` means no filter. */
export function searchTypeFilters(
  selected: readonly SearchEntityType[],
): string[] {
  return SEARCH_ENTITY_TYPES.filter((type) => selected.includes(type));
}

/** Keeps only the requested groups; an empty list keeps every group. */
export function filterGroups(
  response: SearchResponse | null,
  types: readonly SearchEntityType[],
): SearchGroup[] {
  if (!response) return [];
  return response.groups.filter(
    (group) =>
      (types.length === 0 || types.includes(group.entityType)) &&
      isEntityType(group.entityType) &&
      group.count > 0 &&
      group.items.length > 0,
  );
}

/** Trimmed query when it is long enough to send, otherwise `null`. */
export function normalizeQuery(query: string): string | null {
  const trimmed = query.trim();
  return trimmed.length >= MIN_QUERY_LENGTH ? trimmed : null;
}

export function isSearchable(query: string): boolean {
  return normalizeQuery(query) !== null;
}

export type Segment = { text: string; highlighted: boolean };

type Range = { start: number; end: number };

/** Event type codes the search index puts at the start of an event snippet. */
export const EVENT_SNIPPET_CODES = [
  "birth",
  "death",
  "marriage",
  "divorce",
  "burial",
  "residence",
  "occupation",
  "education",
  "other",
] as const;

/**
 * Replaces the leading locale-free event code (`birth`, `marriage`, …) with a
 * localized label and shifts the highlight ranges that follow it. Snippets of
 * other entity types are returned unchanged.
 */
export function localizeEventSnippet(
  snippet: string,
  highlights: readonly SearchHighlight[],
  labels: Readonly<Record<string, string>>,
): { text: string; highlights: SearchHighlight[] } {
  const match = /^([a-z]+)\b/i.exec(snippet);
  if (match === null) return { text: snippet, highlights: [...highlights] };
  const code = match[1].toLowerCase();
  if (!(EVENT_SNIPPET_CODES as readonly string[]).includes(code)) {
    return { text: snippet, highlights: [...highlights] };
  }
  const label = labels[code];
  if (label === undefined || label === "") {
    return { text: snippet, highlights: [...highlights] };
  }
  const consumed = match[0].length;
  const labelLength = Array.from(label).length;
  const delta = labelLength - consumed;
  const shifted = highlights.map((range) => {
    if (range.end <= consumed) {
      return { start: 0, end: labelLength };
    }
    if (range.start >= consumed) {
      return { start: range.start + delta, end: range.end + delta };
    }
    return { start: 0, end: labelLength };
  });
  return { text: `${label}${snippet.slice(consumed)}`, highlights: shifted };
}

/**
 * Splits `text` into plain/marked segments. Invalid ranges are dropped, ranges
 * outside the text are clamped, and adjacent/overlapping ranges are merged.
 */
export function segmentHighlights(
  text: string,
  ranges: readonly SearchHighlight[],
): Segment[] {
  const chars = Array.from(text);
  const length = chars.length;
  const normalized: Range[] = ranges
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        Number.isInteger(range.start) &&
        Number.isInteger(range.end),
    )
    .map((range) => ({
      start: Math.max(0, range.start),
      end: Math.min(length, range.end),
    }))
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: Range[] = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  if (merged.length === 0) {
    return length === 0 ? [] : [{ text, highlighted: false }];
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      segments.push({
        text: chars.slice(cursor, range.start).join(""),
        highlighted: false,
      });
    }
    segments.push({
      text: chars.slice(range.start, range.end).join(""),
      highlighted: true,
    });
    cursor = range.end;
  }
  if (cursor < length) {
    segments.push({ text: chars.slice(cursor).join(""), highlighted: false });
  }
  return segments;
}

/** Non-empty groups in response order (`person`, `event`, `source`). */
export function visibleGroups(
  response: SearchResponse | null,
  types: readonly SearchEntityType[] = [],
): SearchGroup[] {
  return filterGroups(response, types);
}

/** Number of rendered results across the visible groups. */
export function resultCount(
  response: SearchResponse | null,
  types: readonly SearchEntityType[] = [],
): number {
  return visibleGroups(response, types).reduce(
    (total, group) => total + group.items.length,
    0,
  );
}

/**
 * Duplicates hidden behind one row: the backend collapses hits with the same
 * normalized snippet and reports how many documents shared it, so the badge
 * shows the rest. `null` when there is nothing to announce.
 *
 * The normalization itself stays on the server; the UI only derives the label.
 */
export function similarBadgeCount(item: {
  similarCount?: number;
}): number | null {
  const count = Math.trunc(item.similarCount ?? 1);
  return count > 1 ? count - 1 : null;
}
