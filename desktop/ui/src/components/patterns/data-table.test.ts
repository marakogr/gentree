import { describe, expect, it } from "vitest";
import { columnWidthStyle } from "../../lib/tableColumns";
import {
  fluentSortDirection,
  nextSortDirection,
} from "./tableState";

describe("nextSortDirection", () => {
  it("flips the active column", () => {
    expect(nextSortDirection("name", "name", "asc")).toBe("desc");
    expect(nextSortDirection("name", "name", "desc")).toBe("asc");
  });

  it("uses the first direction of a newly active column", () => {
    expect(nextSortDirection("years", "name", "desc")).toBe("asc");
  });

  it("accepts a per-column first direction", () => {
    const directionForKey = (key: string) => (key === "birth" ? "desc" : "asc");
    expect(nextSortDirection("birth", "name", "asc", directionForKey)).toBe(
      "desc",
    );
    expect(nextSortDirection("age", "name", "asc", directionForKey)).toBe("asc");
  });
});

describe("fluentSortDirection", () => {
  it("maps active directions and leaves inactive cells undefined", () => {
    expect(fluentSortDirection(true, "asc")).toBe("ascending");
    expect(fluentSortDirection(true, "desc")).toBe("descending");
    expect(fluentSortDirection(false, "asc")).toBeUndefined();
  });
});

describe("column width helpers", () => {
  it("returns an inline width only for a stored column", () => {
    expect(columnWidthStyle({ name: 240 }, "name")).toEqual({ width: "240px" });
    expect(columnWidthStyle({ name: 240 }, "parents")).toBeUndefined();
  });
});
