// Pure list model for the projects screen: search, sort and the backup stamp
// lookup. No DOM, no IPC, so the table rules stay unit-testable.

import type { ProjectInfo } from "../../api/types";

export type ProjectSort = "recent" | "name" | "people";
export type SortDirection = "asc" | "desc";

/** The active sort column and its direction; the header toggles the latter. */
export type ProjectSortState = {
  key: ProjectSort;
  direction: SortDirection;
};

/** Default direction when a column is picked for the first time. */
export function defaultSortDirection(key: ProjectSort): SortDirection {
  return key === "name" ? "asc" : "desc";
}

/** Case-insensitive name filter in the active locale. */
export function matchesQuery(
  project: ProjectInfo,
  query: string,
  locale: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase(locale);
  if (needle === "") return true;
  return project.name.toLocaleLowerCase(locale).includes(needle);
}

function backupTime(
  project: ProjectInfo,
  backupOf: (projectId: string) => string | null,
): number {
  const raw = backupOf(project.projectId);
  if (!raw) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * Filtered and sorted copy. The open project is pinned first and stays visible
 * even when the query does not match it; search and sorting apply to the rest.
 * "Recent" puts the most recent backup first and projects without a backup
 * last; name is the stable tiebreaker everywhere.
 */
export function visibleProjects(
  projects: readonly ProjectInfo[],
  query: string,
  sort: ProjectSortState,
  locale: string,
  backupOf: (projectId: string) => string | null,
  pinnedProjectId: string | null = null,
): ProjectInfo[] {
  const byName = (a: ProjectInfo, b: ProjectInfo) =>
    a.name.localeCompare(b.name, locale, { sensitivity: "base" });
  const sign = sort.direction === "asc" ? 1 : -1;

  const pinned =
    pinnedProjectId === null
      ? undefined
      : projects.find((project) => project.projectId === pinnedProjectId);

  const sorted = projects
    .filter((project) => project.projectId !== pinned?.projectId)
    .filter((project) => matchesQuery(project, query, locale))
    .sort((a, b) => {
      if (sort.key === "name") return sign * byName(a, b);
      if (sort.key === "people") {
        return sign * (a.persons - b.persons) || byName(a, b);
      }

      const left = backupTime(a, backupOf);
      const right = backupTime(b, backupOf);
      if (left === right) return byName(a, b);
      // Missing backups stay last in both directions.
      if (left === Number.NEGATIVE_INFINITY) return 1;
      if (right === Number.NEGATIVE_INFINITY) return -1;
      return sign * (left - right) || byName(a, b);
    });

  return pinned ? [pinned, ...sorted] : sorted;
}
