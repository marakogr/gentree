import { describe, expect, it } from "vitest";
import {
  isFilterResetDisabled,
  showsFilterChips,
  showsFilterPanelToggle,
} from "./filterBarRules";

describe("isFilterResetDisabled", () => {
  it("stays disabled while search, chips and the active count are empty", () => {
    expect(isFilterResetDisabled(0, "", 0)).toBe(true);
  });

  it("enables on any filter", () => {
    expect(isFilterResetDisabled(1, "", 0)).toBe(false);
    expect(isFilterResetDisabled(0, "ann", 0)).toBe(false);
    expect(isFilterResetDisabled(0, "", 1)).toBe(false);
  });
});

describe("showsFilterChips", () => {
  it("shows when there is a chip", () => {
    expect(showsFilterChips(1, false)).toBe(true);
  });

  it("shows when the screen keeps the reset action", () => {
    expect(showsFilterChips(0, true)).toBe(true);
  });

  it("hides when there is neither", () => {
    expect(showsFilterChips(0, false)).toBe(false);
  });
});

describe("showsFilterPanelToggle", () => {
  it("needs children and the panel mode", () => {
    expect(showsFilterPanelToggle(true, false)).toBe(true);
    expect(showsFilterPanelToggle(true, true)).toBe(false);
    expect(showsFilterPanelToggle(false, false)).toBe(false);
  });
});
