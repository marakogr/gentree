import { describe, expect, it } from "vitest";
import {
  SPLITTER_LARGE_STEP,
  SPLITTER_STEP,
  clampSplitterWidth,
  readSplitterWidth,
  roundSplitterWidth,
  splitterKeyTarget,
  splitterPointerWidth,
} from "./splitter";

const bounds = { defaultWidth: 58, min: 35, max: 75 };

describe("clampSplitterWidth", () => {
  it("keeps values inside the bounds", () => {
    expect(clampSplitterWidth(35, bounds)).toBe(35);
    expect(clampSplitterWidth(58, bounds)).toBe(58);
    expect(clampSplitterWidth(75, bounds)).toBe(75);
  });

  it("clamps both edges", () => {
    expect(clampSplitterWidth(0, bounds)).toBe(35);
    expect(clampSplitterWidth(120, bounds)).toBe(75);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampSplitterWidth(Number.NaN, bounds)).toBe(58);
    expect(clampSplitterWidth(Number.POSITIVE_INFINITY, bounds)).toBe(75);
  });
});

describe("readSplitterWidth", () => {
  it("reads a stored value and clamps it", () => {
    expect(readSplitterWidth("62", bounds)).toBe(62);
    expect(readSplitterWidth("10", bounds)).toBe(35);
    expect(readSplitterWidth("90", bounds)).toBe(75);
  });

  it("falls back for empty, missing and invalid values", () => {
    expect(readSplitterWidth(undefined, bounds)).toBe(58);
    expect(readSplitterWidth("", bounds)).toBe(58);
    expect(readSplitterWidth("wide", bounds)).toBe(58);
    expect(readSplitterWidth(62, bounds)).toBe(58);
  });
});

describe("roundSplitterWidth", () => {
  it("rounds after clamping", () => {
    expect(roundSplitterWidth(57.6, bounds)).toBe(58);
    expect(roundSplitterWidth(10.2, bounds)).toBe(35);
  });
});

describe("splitterPointerWidth", () => {
  it("converts a pointer position to a percentage", () => {
    expect(splitterPointerWidth(400, 200, 400, bounds)).toBe(50);
    expect(splitterPointerWidth(610, 200, 400, bounds)).toBe(75);
  });

  it("clamps at both edges", () => {
    expect(splitterPointerWidth(0, 200, 400, bounds)).toBe(35);
    expect(splitterPointerWidth(1000, 200, 400, bounds)).toBe(75);
  });

  it("returns null when the layout cannot be measured", () => {
    expect(splitterPointerWidth(400, 200, 0, bounds)).toBeNull();
    expect(splitterPointerWidth(400, 200, Number.NaN, bounds)).toBeNull();
  });
});

describe("splitterKeyTarget", () => {
  it("moves by the normal step", () => {
    expect(splitterKeyTarget("ArrowLeft", 58, bounds)).toBe(58 - SPLITTER_STEP);
    expect(splitterKeyTarget("ArrowRight", 58, bounds)).toBe(58 + SPLITTER_STEP);
  });

  it("moves by the coarse step with Shift", () => {
    expect(splitterKeyTarget("ArrowLeft", 58, bounds, true)).toBe(
      58 - SPLITTER_LARGE_STEP,
    );
    expect(splitterKeyTarget("ArrowRight", 58, bounds, true)).toBe(
      58 + SPLITTER_LARGE_STEP,
    );
  });

  it("jumps to the bounds with Home and End", () => {
    expect(splitterKeyTarget("Home", 58, bounds)).toBe(35);
    expect(splitterKeyTarget("End", 58, bounds)).toBe(75);
  });

  it("clamps at both edges", () => {
    expect(splitterKeyTarget("ArrowRight", 75, bounds)).toBe(75);
    expect(splitterKeyTarget("ArrowLeft", 35, bounds)).toBe(35);
  });

  it("ignores unhandled keys", () => {
    expect(splitterKeyTarget("Tab", 58, bounds)).toBeNull();
    expect(splitterKeyTarget("Enter", 58, bounds)).toBeNull();
  });
});
