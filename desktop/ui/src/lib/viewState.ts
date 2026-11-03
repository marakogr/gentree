// Persisted per-project view state (query, filters, sort, page, scroll,
// selection). Pure module: no React, no DOM. `window.localStorage` is only
// touched when it exists; tests inject a fake storage instead.
//
// Layout of the stored blob, keyed by `gentree.views.v1.<projectId>`:
//   { "persons": SectionViewState, "events": SectionViewState, ... }
// Anything unreadable is ignored, never thrown, and a project never inherits
// another project's state.

/** Sections that keep their own view state. */
export type SectionKey =
  | "persons"
  | "events"
  | "filters"
  | "timeline"
  | "map"
  | "search"
  | "chat";

export const SECTION_KEYS: readonly SectionKey[] = [
  "persons",
  "events",
  "filters",
  "timeline",
  "map",
  "search",
  "chat",
];

export type SortDirection = "asc" | "desc";

export type SortState = { key: string; direction: SortDirection };

/** Only serialisable primitives: a scalar filter or a list of them. */
export type ViewFilterValue = string | string[];
export type ViewFilters = Record<string, ViewFilterValue>;

export type SectionViewState = {
  query: string;
  filters: ViewFilters;
  sort: SortState | null;
  /** 0-based list page. */
  page: number;
  /** Restored scroll offset of the section's scroll container. */
  scrollTop: number;
  selectedId: string | null;
};

export type ProjectViews = Record<string, SectionViewState>;

/** Minimal storage surface: tests pass a plain object, the browser `localStorage`. */
export type ViewStorage = Pick<Storage, "getItem" | "setItem">;

export const VIEW_STORAGE_PREFIX = "gentree.views.v1.";

/** Older projects fall out of the store so localStorage cannot grow forever. */
export const MAX_STORED_PROJECTS = 3;

/**
 * Shared immutable defaults. `mergeViewState` always returns a fresh object, so
 * callers may mutate the result.
 */
export const DEFAULT_VIEW_STATE: SectionViewState = deepFreeze({
  query: "",
  filters: {},
  sort: null,
  page: 0,
  scrollTop: 0,
  selectedId: null,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanQuery(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanFilters(value: unknown): ViewFilters {
  if (!isRecord(value)) return {};
  const filters: ViewFilters = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "") continue;
    if (typeof raw === "string") {
      if (raw !== "") filters[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      const list = raw.filter(
        (item): item is string => typeof item === "string" && item !== "",
      );
      if (list.length > 0) filters[key] = list;
    }
  }
  return filters;
}

function cleanSort(value: unknown): SortState | null {
  if (!isRecord(value)) return null;
  const key = value.key;
  const direction = value.direction;
  if (typeof key !== "string" || key === "") return null;
  if (direction !== "asc" && direction !== "desc") return null;
  return { key, direction };
}

function cleanCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function cleanSelectedId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Validates one stored section state and merges it with the defaults. Garbage
 * of any shape (non-object, wrong field types, negative counters, unknown
 * keys) collapses to the matching default instead of reaching the UI.
 */
export function mergeViewState(stored: unknown): SectionViewState {
  if (!isRecord(stored)) return mergeViewState({});
  return {
    query: cleanQuery(stored.query),
    filters: cleanFilters(stored.filters),
    sort: cleanSort(stored.sort),
    page: cleanCount(stored.page),
    scrollTop: cleanCount(stored.scrollTop),
    selectedId: cleanSelectedId(stored.selectedId),
  };
}

/** True when the section shows anything but its pristine listing. */
export function hasActiveFilters(state: SectionViewState): boolean {
  if (state.query.trim() !== "") return true;
  if (state.sort !== null) return true;
  if (state.page > 0) return true;
  if (state.selectedId !== null) return true;
  return Object.values(state.filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== "",
  );
}

export function viewStorageKey(projectId: string): string {
  return `${VIEW_STORAGE_PREFIX}${projectId}`;
}

function browserStorage(): ViewStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // Access to localStorage can throw in hardened webviews.
    return null;
  }
}

/** Raw parsed blob; never throws, never returns a non-object. */
function readRawStore(
  projectId: string,
  storage: ViewStorage | null,
): Record<string, unknown> {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(viewStorageKey(projectId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Reads every known section of one project. Unknown sections, invalid JSON and
 * broken field types are dropped; a missing project yields `{}` (the caller
 * falls back to `DEFAULT_VIEW_STATE`).
 */
export function readProjectViews(
  projectId: string,
  storage: ViewStorage | null = browserStorage(),
): ProjectViews {
  const raw = readRawStore(projectId, storage);
  const views: ProjectViews = {};
  for (const section of SECTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, section)) {
      views[section] = mergeViewState(raw[section]);
    }
  }
  return views;
}

/**
 * Writes the given sections of one project, keeping the sections that are not
 * mentioned. Every kept section is re-validated and unknown keys are dropped,
 * so a rotted blob heals on the next write. Storage quota/security errors are
 * swallowed: a lost preference must not break the screen.
 */
export function writeProjectViews(
  projectId: string,
  views: ProjectViews,
  storage: ViewStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  const raw = readRawStore(projectId, storage);
  const next: Record<string, SectionViewState> = {};
  for (const section of SECTION_KEYS) {
    const source = views[section] ?? raw[section];
    if (source !== undefined) next[section] = mergeViewState(source);
  }
  try {
    storage.setItem(viewStorageKey(projectId), JSON.stringify(next));
  } catch {
    // Quota exceeded or storage disabled; keep the in-memory state only.
  }
}

/**
 * Keeps at most `maxProjects` projects from `keepIds` (caller order is the
 * priority order: most recently used first). Only entries that are actually
 * present in `store` are returned, so the result is deterministic.
 */
export function pruneProjects(
  store: Record<string, unknown>,
  keepIds: readonly string[],
  maxProjects: number = MAX_STORED_PROJECTS,
): Record<string, unknown> {
  if (!isRecord(store)) return {};
  const limit = Number.isFinite(maxProjects)
    ? Math.max(0, Math.floor(maxProjects))
    : MAX_STORED_PROJECTS;
  const kept: Record<string, unknown> = {};
  const seen = new Set<string>();
  let count = 0;
  for (const id of keepIds) {
    if (count >= limit) break;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(store, id)) continue;
    kept[id] = store[id];
    count += 1;
  }
  return kept;
}
