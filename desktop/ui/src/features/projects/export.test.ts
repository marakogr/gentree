import { describe, expect, it } from "vitest";
import { exportFileName, safeExportStem } from "./export";

describe("safeExportStem", () => {
  it("keeps letters, digits, underscores and dashes", () => {
    expect(safeExportStem("Family_archive-2")).toBe("Family_archive-2");
  });

  it("replaces path and reserved characters", () => {
    expect(safeExportStem("a/b:c*?")).toBe("a_b_c");
  });

  it("trims the result and falls back for an empty name", () => {
    expect(safeExportStem("  /  ")).toBe("gentree");
    expect(safeExportStem("")).toBe("gentree");
  });

  it("caps the stem at 64 characters", () => {
    expect(safeExportStem("x".repeat(100))).toHaveLength(64);
  });
});

describe("exportFileName", () => {
  it("adds the zip extension", () => {
    expect(exportFileName("Family archive")).toBe("Family_archive.zip");
    expect(exportFileName("")).toBe("gentree.zip");
  });
});
