import { describe, expect, it } from "vitest";
import {
  PROJECT_NAME_MAX_LENGTH,
  checkProjectName,
  renameErrorKey,
} from "./nameRules";

describe("checkProjectName", () => {
  it("trims a valid name", () => {
    expect(checkProjectName("  Family  ")).toEqual({
      ok: true,
      name: "Family",
    });
  });

  it("rejects blank names", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      expect(checkProjectName(raw)).toEqual({
        ok: false,
        errorKey: "project:nameRequired",
      });
    }
  });

  it("counts characters, not UTF-16 units", () => {
    expect(checkProjectName("a".repeat(PROJECT_NAME_MAX_LENGTH))).toEqual({
      ok: true,
      name: "a".repeat(PROJECT_NAME_MAX_LENGTH),
    });
    expect(checkProjectName("a".repeat(PROJECT_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      errorKey: "project:nameTooLong",
    });
    // Astral characters take two UTF-16 units but a single character.
    const astral = "\u{1F600}".repeat(PROJECT_NAME_MAX_LENGTH);
    expect(checkProjectName(astral).ok).toBe(true);
  });
});

describe("renameErrorKey", () => {
  it("maps validation rules to field messages", () => {
    const key = (rule?: string) =>
      renameErrorKey({ code: "VALIDATION_ERROR", params: { field: "name", ...(rule ? { rule } : {}) } });

    expect(key("required")).toBe("project:nameRequired");
    expect(key("maxLength")).toBe("project:nameTooLong");
    expect(key("duplicate")).toBe("project:nameDuplicate");
    expect(key()).toBe("project:nameInvalid");
    expect(key("somethingElse")).toBe("project:nameInvalid");
  });

  it("explains a read-only project", () => {
    expect(renameErrorKey({ code: "PROJECT_LOCKED" })).toBe(
      "project:nameReadOnly",
    );
  });

  it("falls back to the shared error dictionary", () => {
    expect(renameErrorKey({ code: "IO_ERROR" })).toBe("common:errors.IO_ERROR");
  });
});
