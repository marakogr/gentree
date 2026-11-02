import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../api/types";
import { matchesQuery, visibleProjects } from "./listView";

function project(
  id: string,
  name: string,
  persons: number,
): ProjectInfo {
  return {
    projectId: id,
    name,
    persons,
    contentHash: `hash-${id}`,
    locked: false,
    readOnly: false,
    updatedAt: "2026-10-01T00:00:00.000Z",
    homePersonId: null,
  };
}

const A = project("a", "Архив Волковых", 2);
const B = project("b", "Семья", 5);
const C = project("c", "Тест", 1);

const STAMPS: Record<string, string> = {
  a: "2026-10-01T10:00:00.000Z",
  b: "2026-10-30T10:00:00.000Z",
};

const backupOf = (id: string) => STAMPS[id] ?? null;

const LIST = [A, B, C];

describe("matchesQuery", () => {
  it("matches anywhere in the name, case-insensitively", () => {
    expect(matchesQuery(A, "", "ru")).toBe(true);
    expect(matchesQuery(A, "волк", "ru")).toBe(true);
    expect(matchesQuery(A, "нет", "ru")).toBe(false);
  });
});

describe("visibleProjects", () => {
  it("sorts by backup date and puts projects without a backup last", () => {
    expect(
      visibleProjects(LIST, "", "recent", "ru", backupOf).map(
        (item) => item.projectId,
      ),
    ).toEqual(["b", "a", "c"]);
  });

  it("sorts by people, then name", () => {
    expect(
      visibleProjects(LIST, "", "people", "ru", backupOf).map(
        (item) => item.projectId,
      ),
    ).toEqual(["b", "a", "c"]);
  });

  it("sorts alphabetically in the active locale", () => {
    expect(
      visibleProjects(LIST, "", "name", "ru", backupOf).map(
        (item) => item.projectId,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("uses the name as a stable tiebreaker for equal stamps", () => {
    const same: Record<string, string> = {
      ...STAMPS,
      a: STAMPS.b,
      c: STAMPS.b,
    };
    expect(
      visibleProjects(LIST, "", "recent", "ru", (id) => same[id] ?? null).map(
        (item) => item.projectId,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("filters before sorting and keeps the input untouched", () => {
    const input = [B, A, C];
    const visible = visibleProjects(input, "сем", "name", "ru", backupOf);
    expect(visible.map((item) => item.projectId)).toEqual(["b"]);
    expect(input.map((item) => item.projectId)).toEqual(["b", "a", "c"]);
  });

  it("pins the open project first and keeps it when the query misses", () => {
    expect(
      visibleProjects(LIST, "", "name", "ru", backupOf, "c").map(
        (item) => item.projectId,
      ),
    ).toEqual(["c", "a", "b"]);

    expect(
      visibleProjects(LIST, "сем", "name", "ru", backupOf, "a").map(
        (item) => item.projectId,
      ),
    ).toEqual(["a", "b"]);
  });

  it("ignores a pinned id that is not in the list", () => {
    expect(
      visibleProjects(LIST, "", "name", "ru", backupOf, "missing").map(
        (item) => item.projectId,
      ),
    ).toEqual(["a", "b", "c"]);
  });
});
