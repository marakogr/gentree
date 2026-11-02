import { describe, expect, it } from "vitest";
import type { ImportReport } from "../../api/types";
import {
  IMPORT_EXTENSIONS,
  canImport,
  importFileLabel,
  modeLabelKey,
  reportCounts,
  reportNotes,
} from "./helpers";

function report(overrides: Partial<ImportReport> = {}): ImportReport {
  return {
    persons: 0,
    relationships: 0,
    events: 0,
    media: 0,
    warnings: [],
    issues: [],
    conflicts: [],
    ...overrides,
  };
}

describe("IMPORT_EXTENSIONS", () => {
  it("offers both supported formats in one picker", () => {
    expect(IMPORT_EXTENSIONS).toEqual(["at5", "ged", "gedcom"]);
  });
});

describe("importFileLabel", () => {
  it("takes the last segment for Windows and Unix paths", () => {
    expect(importFileLabel("C:\\family\\tree.at5")).toBe("tree.at5");
    expect(importFileLabel("/home/me/tree.ged")).toBe("tree.ged");
    expect(importFileLabel("C:\\family with spaces\\tree.ged")).toBe(
      "tree.ged",
    );
  });

  it("handles folders, trailing separators and blank input", () => {
    expect(importFileLabel("C:\\family\\photos\\")).toBe("photos");
    expect(importFileLabel("C:\\family\\photos")).toBe("photos");
    expect(importFileLabel("  ")).toBe("");
  });
});

describe("modeLabelKey", () => {
  it("maps the detected reader to the badge label", () => {
    expect(modeLabelKey("at5")).toBe("import:modeAt5");
    expect(modeLabelKey("gedcom")).toBe("import:modeGedcom");
  });
});

describe("reportCounts", () => {
  it("formats all four counters in a fixed order", () => {
    expect(
      reportCounts(
        report({ persons: 5, relationships: 2, events: 3, media: 1 }),
      ),
    ).toEqual([
      { key: "persons", count: 5 },
      { key: "relationships", count: 2 },
      { key: "events", count: 3 },
      { key: "media", count: 1 },
    ]);
  });

  it("keeps zero counters visible", () => {
    expect(reportCounts(report()).map(({ count }) => count)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe("reportNotes", () => {
  it("counts warnings and issues separately", () => {
    expect(
      reportNotes(
        report({
          warnings: ["a", "b"],
          issues: ["c"],
        }),
      ),
    ).toEqual({ warnings: 2, issues: 1 });
  });
});

describe("canImport", () => {
  it("is false before a preview", () => {
    expect(canImport(null)).toBe(false);
  });

  it("is true after a successful preview, even for an empty report", () => {
    expect(canImport(report())).toBe(true);
  });
});
