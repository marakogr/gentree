import { describe, expect, it } from "vitest";
import {
  YEAR_PAGE_STEP,
  YEAR_STEP,
  clampYear,
  moveHandle,
  normalizeYearRange,
  parseYear,
  percentForYear,
  rangeFill,
  yearAtPointer,
  yearForKey,
  type YearRangeBounds,
} from "./yearRangeRules";

const bounds: YearRangeBounds = {
  lowest: 1700,
  highest: 2000,
  lower: 1800,
  upper: 1900,
};

const rect = { left: 100, width: 400 };

describe("parseYear", () => {
  it("accepts one to four digits and trims the value", () => {
    expect(parseYear("1943")).toBe(1943);
    expect(parseYear(" 71 ")).toBe(71);
    expect(parseYear("0000")).toBe(0);
  });

  it("rejects empty, partial and foreign text", () => {
    expect(parseYear("")).toBeNull();
    expect(parseYear("   ")).toBeNull();
    expect(parseYear("12a")).toBeNull();
    expect(parseYear("19430")).toBeNull();
    expect(parseYear("-5")).toBeNull();
  });
});

describe("normalizeYearRange", () => {
  it("uses the scale ends for empty bounds", () => {
    expect(normalizeYearRange("", "", 1700, 2000)).toEqual({
      lowest: 1700,
      highest: 2000,
      lower: 1700,
      upper: 2000,
    });
  });

  it("swaps an inverted stored pair", () => {
    expect(normalizeYearRange("1950", "1900", 1700, 2026)).toEqual({
      lowest: 1700,
      highest: 2026,
      lower: 1900,
      upper: 1950,
    });
  });

  it("clamps values outside the scale and ignores foreign text", () => {
    expect(normalizeYearRange("1000", "3000", 1700, 2000)).toMatchObject({
      lower: 1700,
      upper: 2000,
    });
    expect(normalizeYearRange("abc", "1950", 1700, 2000)).toMatchObject({
      lower: 1700,
      upper: 1950,
    });
  });

  it("orders a reversed scale", () => {
    expect(normalizeYearRange("", "", 2000, 1700)).toEqual({
      lowest: 1700,
      highest: 2000,
      lower: 1700,
      upper: 2000,
    });
  });

  it("keeps a zero-width range representable", () => {
    expect(normalizeYearRange("1850", "1850", 1700, 2000)).toMatchObject({
      lower: 1850,
      upper: 1850,
    });
  });
});

describe("clampYear", () => {
  it("clamps to the inclusive interval", () => {
    expect(clampYear(1600, 1700, 2000)).toBe(1700);
    expect(clampYear(2100, 1700, 2000)).toBe(2000);
    expect(clampYear(1850, 1700, 2000)).toBe(1850);
  });
});

describe("moveHandle", () => {
  it("moves the lower handle inside its zone", () => {
    expect(moveHandle("from", 1850, bounds)).toBe(1850);
    expect(moveHandle("from", 1600, bounds)).toBe(bounds.lowest);
    expect(moveHandle("to", 1950, bounds)).toBe(1950);
    expect(moveHandle("to", 2100, bounds)).toBe(bounds.highest);
  });

  it("never lets the handles cross", () => {
    expect(moveHandle("from", 1950, bounds)).toBe(bounds.upper);
    expect(moveHandle("from", 2000, bounds)).toBe(bounds.upper);
    expect(moveHandle("to", 1750, bounds)).toBe(bounds.lower);
    expect(moveHandle("to", 1600, bounds)).toBe(bounds.lower);
  });

  it("allows the handles to meet exactly", () => {
    const meeting = { ...bounds, lower: 1850, upper: 1850 };
    expect(moveHandle("from", 1850, meeting)).toBe(1850);
    expect(moveHandle("to", 1850, meeting)).toBe(1850);
    expect(moveHandle("from", 1900, meeting)).toBe(1850);
    expect(moveHandle("to", 1800, meeting)).toBe(1850);
  });

  it("rounds fractional years and ignores non-finite input", () => {
    expect(moveHandle("from", 1849.6, bounds)).toBe(1850);
    expect(moveHandle("from", Number.NaN, bounds)).toBe(bounds.lower);
    expect(moveHandle("to", Number.POSITIVE_INFINITY, bounds)).toBe(
      bounds.upper,
    );
  });

  it("stays ordered even with inverted bounds", () => {
    expect(moveHandle("from", 1950, { ...bounds, lower: 1900, upper: 1800 })).toBe(
      1900,
    );
    expect(moveHandle("to", 1750, { ...bounds, lower: 1900, upper: 1800 })).toBe(
      1800,
    );
  });
});

describe("yearForKey", () => {
  it("steps by one year with the arrows", () => {
    expect(yearForKey("ArrowRight", 1900, 1700, 2000)).toBe(1901);
    expect(yearForKey("ArrowLeft", 1900, 1700, 2000)).toBe(1899);
    expect(yearForKey("ArrowUp", 1900, 1700, 2000)).toBe(1901);
    expect(yearForKey("ArrowDown", 1900, 1700, 2000)).toBe(1899);
    expect(YEAR_STEP).toBe(1);
  });

  it("steps by ten years with PageUp/PageDown", () => {
    expect(yearForKey("PageUp", 1900, 1700, 2000)).toBe(1910);
    expect(yearForKey("PageDown", 1900, 1700, 2000)).toBe(1890);
    expect(YEAR_PAGE_STEP).toBe(10);
  });

  it("jumps to the edges with Home/End", () => {
    expect(yearForKey("Home", 1900, 1700, 2000)).toBe(1700);
    expect(yearForKey("End", 1900, 1700, 2000)).toBe(2000);
  });

  it("clamps at the edges and ignores other keys", () => {
    expect(yearForKey("ArrowRight", 2000, 1700, 2000)).toBe(2000);
    expect(yearForKey("PageDown", 1700, 1700, 2000)).toBe(1700);
    expect(yearForKey("Enter", 1900, 1700, 2000)).toBeNull();
    expect(yearForKey("Tab", 1900, 1700, 2000)).toBeNull();
  });
});

describe("percentForYear", () => {
  it("maps the scale ends to 0 and 100", () => {
    expect(percentForYear(1700, 1700, 2000)).toBe(0);
    expect(percentForYear(2000, 1700, 2000)).toBe(100);
    expect(percentForYear(1850, 1700, 2000)).toBe(50);
  });

  it("clamps out-of-scale years", () => {
    expect(percentForYear(1600, 1700, 2000)).toBe(0);
    expect(percentForYear(2100, 1700, 2000)).toBe(100);
  });

  it("pins a zero-width scale to the start", () => {
    expect(percentForYear(1850, 1850, 1850)).toBe(0);
  });
});

describe("rangeFill", () => {
  it("runs from the lower handle centre to the upper one", () => {
    const fill = rangeFill(1800, 1900, 1700, 2000);
    expect(fill.start).toBeCloseTo(100 / 3);
    expect(fill.end).toBeCloseTo(200 / 3);
  });

  it("leaves both outer segments unfilled", () => {
    const fill = rangeFill(1800, 1900, 1700, 2000);
    expect(fill.start).toBeGreaterThan(0);
    expect(fill.end).toBeLessThan(100);
  });

  it("handles the scale ends and a zero-width range", () => {
    expect(rangeFill(1700, 2000, 1700, 2000)).toEqual({ start: 0, end: 100 });
    expect(rangeFill(1850, 1850, 1700, 2000)).toEqual({
      start: 50,
      end: 50,
    });
  });

  it("stays ordered for an inverted pair", () => {
    expect(rangeFill(1900, 1800, 1700, 2000)).toEqual(
      rangeFill(1800, 1900, 1700, 2000),
    );
  });
});

describe("yearAtPointer", () => {
  it("maps the layer edges to the scale ends", () => {
    expect(yearAtPointer(100, rect, 1700, 2000)).toBe(1700);
    expect(yearAtPointer(500, rect, 1700, 2000)).toBe(2000);
    expect(yearAtPointer(300, rect, 1700, 2000)).toBe(1850);
  });

  it("clamps a pointer outside the layer", () => {
    expect(yearAtPointer(0, rect, 1700, 2000)).toBe(1700);
    expect(yearAtPointer(900, rect, 1700, 2000)).toBe(2000);
  });

  it("mirrors the mapping for right-to-left layouts", () => {
    expect(yearAtPointer(100, rect, 1700, 2000, true)).toBe(2000);
    expect(yearAtPointer(500, rect, 1700, 2000, true)).toBe(1700);
    expect(yearAtPointer(300, rect, 1700, 2000, true)).toBe(1850);
  });

  it("rounds to the nearest year", () => {
    expect(yearAtPointer(101, rect, 1700, 2000)).toBe(1701);
    expect(yearAtPointer(103, rect, 1700, 2000)).toBe(1702);
  });

  it("falls back to the scale start for a collapsed or invalid layer", () => {
    expect(yearAtPointer(300, { left: 100, width: 0 }, 1700, 2000)).toBe(
      1700,
    );
    expect(yearAtPointer(Number.NaN, rect, 1700, 2000)).toBe(1700);
  });
});
