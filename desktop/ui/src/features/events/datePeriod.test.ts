import { describe, expect, it } from "vitest";
import {
  parsePeriodInput,
  periodFromDate,
  supportsDateRange,
} from "./datePeriod";

describe("supportsDateRange", () => {
  it("offers a period for residence, occupation and education", () => {
    expect(supportsDateRange("RESIDENCE")).toBe(true);
    expect(supportsDateRange("OCCUPATION")).toBe(true);
    expect(supportsDateRange("EDUCATION")).toBe(true);
  });

  it("keeps a single date for life events and other types", () => {
    expect(supportsDateRange("BIRTH")).toBe(false);
    expect(supportsDateRange("MARRIAGE")).toBe(false);
    expect(supportsDateRange("OTHER")).toBe(false);
  });
});

describe("parsePeriodInput", () => {
  it("builds a half-open RANGE date from two years", () => {
    expect(parsePeriodInput("1980", "1985", "YEAR")).toEqual({
      ok: true,
      value: {
        start: "1980-01-01",
        end: "1986-01-01",
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      },
    });
  });

  it("keeps month precision on both bounds", () => {
    expect(parsePeriodInput("1980-03", "1981-02", "MONTH")).toEqual({
      ok: true,
      value: {
        start: "1980-03-01",
        end: "1981-03-01",
        precision: "MONTH",
        qualifier: "RANGE",
        original: null,
      },
    });
  });

  it("accepts a one-unit period where both ends are equal", () => {
    expect(parsePeriodInput("1980", "1980", "YEAR")).toEqual({
      ok: true,
      value: {
        start: "1980-01-01",
        end: "1981-01-01",
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      },
    });
  });

  it("saves two blank fields as an unknown date", () => {
    expect(parsePeriodInput("  ", "", "YEAR")).toEqual({
      ok: true,
      value: {
        start: null,
        end: null,
        precision: "UNKNOWN",
        qualifier: "UNKNOWN",
        original: null,
      },
    });
  });

  it("refuses a half-filled period instead of inventing a bound", () => {
    expect(parsePeriodInput("1980", "", "YEAR")).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });

  it("refuses an inverted period", () => {
    expect(parsePeriodInput("1985", "1980", "YEAR")).toEqual({
      ok: false,
      reason: "order",
    });
  });

  it("reports malformed bounds", () => {
    expect(parsePeriodInput("1980-13", "1981", "MONTH")).toEqual({
      ok: false,
      reason: "format",
    });
  });
});

describe("periodFromDate", () => {
  it("round-trips a stored range back into the two inputs", () => {
    expect(
      periodFromDate({
        start: "1980-01-01",
        end: "1986-01-01",
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      }),
    ).toEqual({ from: "1980", to: "1985" });
  });

  it("returns null for a single date, an unknown date or a partial range", () => {
    expect(
      periodFromDate({
        start: "1980-01-01",
        end: "1981-01-01",
        precision: "YEAR",
        qualifier: "EXACT",
        original: null,
      }),
    ).toBeNull();
    expect(
      periodFromDate({
        start: null,
        end: null,
        precision: "UNKNOWN",
        qualifier: "UNKNOWN",
        original: "about 1850",
      }),
    ).toBeNull();
    expect(
      periodFromDate({
        start: "1980-01-01",
        end: null,
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      }),
    ).toBeNull();
  });
});
