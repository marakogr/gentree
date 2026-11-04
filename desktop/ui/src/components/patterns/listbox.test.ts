import { describe, expect, it } from "vitest";
import {
  firstActiveIndex,
  lastActiveIndex,
  listboxKeyAction,
  optionElementId,
} from "./listbox";

describe("active index bounds", () => {
  it("handles empty and non-empty lists", () => {
    expect(firstActiveIndex(0)).toBe(-1);
    expect(lastActiveIndex(0)).toBe(-1);
    expect(firstActiveIndex(3)).toBe(0);
    expect(lastActiveIndex(3)).toBe(2);
  });
});

describe("single-select key map", () => {
  it("moves and wraps", () => {
    expect(listboxKeyAction("ArrowDown", 0, 3)).toEqual({ type: "move", index: 1 });
    expect(listboxKeyAction("ArrowDown", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(listboxKeyAction("ArrowUp", 0, 3)).toEqual({ type: "move", index: 2 });
  });

  it("jumps with Home and End", () => {
    expect(listboxKeyAction("Home", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(listboxKeyAction("End", 0, 3)).toEqual({ type: "move", index: 2 });
  });

  it("activates only the highlighted row", () => {
    expect(listboxKeyAction("Enter", 1, 3)).toEqual({ type: "activate", index: 1 });
    expect(listboxKeyAction("Enter", -1, 3)).toEqual({ type: "ignore" });
    expect(listboxKeyAction("Enter", 3, 3)).toEqual({ type: "ignore" });
  });

  it("closes on Escape with focus and on Tab without", () => {
    expect(listboxKeyAction("Escape", 0, 3)).toEqual({
      type: "close",
      restoreFocus: true,
    });
    expect(listboxKeyAction("Tab", 0, 3)).toEqual({
      type: "close",
      restoreFocus: false,
    });
  });

  it("ignores other keys", () => {
    expect(listboxKeyAction("a", 0, 3)).toEqual({ type: "ignore" });
  });
});

describe("multi-select key map", () => {
  it("includes the all-row in the length", () => {
    // Two options plus the all-row: down from the all-row reaches option 1.
    expect(listboxKeyAction("ArrowDown", 0, 3)).toEqual({ type: "move", index: 1 });
    expect(listboxKeyAction("End", 0, 3)).toEqual({ type: "move", index: 2 });
  });
});

describe("optionElementId", () => {
  it("maps the empty id to the all-row", () => {
    expect(optionElementId("base", "")).toBe("base-option-all");
    expect(optionElementId("base", "type")).toBe("base-option-type");
  });
});
