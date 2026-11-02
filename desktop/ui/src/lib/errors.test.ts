import { describe, expect, it } from "vitest";
import {
  errorKey,
  fieldErrors,
  isAppError,
  normalizeError,
  pickFieldError,
} from "./errors";

describe("normalizeError", () => {
  it("keeps envelopes coming from Rust", () => {
    const envelope = {
      code: "VALIDATION_ERROR",
      params: { field: "death", rule: "beforeBirth" },
      message: "Validation failed",
    };
    expect(normalizeError(envelope)).toBe(envelope);
    expect(isAppError(envelope)).toBe(true);
  });

  it("wraps anything else as UNKNOWN", () => {
    expect(normalizeError("boom").code).toBe("UNKNOWN");
    expect(normalizeError(new Error("boom")).code).toBe("UNKNOWN");
    expect(isAppError(null)).toBe(false);
  });
});

describe("field-level mapping", () => {
  it("maps params.field to errors.<code>", () => {
    const errors = fieldErrors({
      code: "VALIDATION_ERROR",
      params: { field: "death", rule: "beforeBirth" },
    });
    expect(errors).toEqual({ death: "VALIDATION_ERROR" });
    expect(errorKey(errors.death)).toBe("errors.VALIDATION_ERROR");
  });

  it("has no field errors without params.field", () => {
    expect(fieldErrors({ code: "STALE_WRITE" })).toEqual({});
  });

  it("picks the first matching field, including Rust's name field", () => {
    const errors = { name: "VALIDATION_ERROR" };
    expect(pickFieldError(errors, "given", "name")).toBe("VALIDATION_ERROR");
    expect(pickFieldError(errors, "death")).toBeNull();
  });
});
