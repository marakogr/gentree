import { describe, expect, it } from "vitest";
import {
  COMBOBOX_LISTBOX_PADDING_PX,
  COMBOBOX_OPTION_HEIGHT_PX,
  COMBOBOX_POSITIONING,
  COMBOBOX_VISIBLE_OPTIONS,
  clampActiveIndex,
  comboListboxMaxHeightPx,
  filterComboItems,
  isActivationKey,
  moveActiveIndex,
  normalizeSearchText,
  type ComboItem,
} from "./helpers";

const items: ComboItem[] = [
  { id: "1", label: "Иван Петров", hint: "1850 — 1900" },
  { id: "2", label: "Пётр Иванов" },
  { id: "3", label: "Анна Смирнова", hint: "Москва" },
];

describe("normalizeSearchText", () => {
  it("lowercases and folds ё to е", () => {
    expect(normalizeSearchText("ПЁТР")).toBe("петр");
    expect(normalizeSearchText("Ёлка")).toBe("елка");
  });
});

describe("filterComboItems", () => {
  it("returns every item for an empty query", () => {
    expect(filterComboItems(items, "")).toEqual(items);
    expect(filterComboItems(items, "   ")).toEqual(items);
  });

  it("matches case-insensitive substrings", () => {
    expect(filterComboItems(items, "петров").map((i) => i.id)).toEqual(["1"]);
    expect(filterComboItems(items, "ИВАН").map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("treats ё and е as the same letter", () => {
    const folding: ComboItem[] = [
      { id: "yo", label: "Пётр" },
      { id: "other", label: "Анна" },
    ];
    expect(filterComboItems(folding, "петр").map((i) => i.id)).toEqual(["yo"]);
    expect(filterComboItems(folding, "пётр").map((i) => i.id)).toEqual(["yo"]);
  });

  it("searches hints as well as labels", () => {
    expect(filterComboItems(items, "москва").map((i) => i.id)).toEqual(["3"]);
    expect(filterComboItems(items, "1900").map((i) => i.id)).toEqual(["1"]);
  });

  it("returns nothing when there is no match", () => {
    expect(filterComboItems(items, "zzz")).toEqual([]);
  });

  it("does not mutate the source array", () => {
    const snapshot = [...items];
    filterComboItems(items, "иван");
    expect(items).toEqual(snapshot);
  });
});

describe("clampActiveIndex", () => {
  it("keeps indices inside the list", () => {
    expect(clampActiveIndex(0, 3)).toBe(0);
    expect(clampActiveIndex(2, 3)).toBe(2);
    expect(clampActiveIndex(9, 3)).toBe(2);
  });

  it("keeps -1 for an empty selection and empty lists", () => {
    expect(clampActiveIndex(-1, 3)).toBe(-1);
    expect(clampActiveIndex(0, 0)).toBe(-1);
    expect(clampActiveIndex(5, 0)).toBe(-1);
  });

  it("truncates fractional indices", () => {
    expect(clampActiveIndex(1.9, 3)).toBe(1);
  });
});

describe("moveActiveIndex", () => {
  it("wraps down and up", () => {
    expect(moveActiveIndex(0, 1, 3)).toBe(1);
    expect(moveActiveIndex(2, 1, 3)).toBe(0);
    expect(moveActiveIndex(0, -1, 3)).toBe(2);
    expect(moveActiveIndex(1, -1, 3)).toBe(0);
  });

  it("enters the list from no selection", () => {
    expect(moveActiveIndex(-1, 1, 3)).toBe(0);
    expect(moveActiveIndex(-1, -1, 3)).toBe(2);
    expect(moveActiveIndex(-1, 0, 3)).toBe(0);
  });

  it("handles empty lists", () => {
    expect(moveActiveIndex(0, 1, 0)).toBe(-1);
    expect(moveActiveIndex(-1, -1, 0)).toBe(-1);
  });

  it("supports multi-step moves with wrapping", () => {
    expect(moveActiveIndex(0, 4, 3)).toBe(1);
    expect(moveActiveIndex(1, -4, 3)).toBe(0);
  });
});

describe("isActivationKey", () => {
  it("recognises Enter and Space", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("Spacebar")).toBe(true);
  });

  it("rejects other keys", () => {
    expect(isActivationKey("Tab")).toBe(false);
    expect(isActivationKey("ArrowDown")).toBe(false);
    expect(isActivationKey("Escape")).toBe(false);
  });
});

describe("combobox listbox height", () => {
  it("fits five full option rows plus the listbox padding", () => {
    expect(COMBOBOX_VISIBLE_OPTIONS).toBe(5);
    expect(comboListboxMaxHeightPx()).toBe(
      COMBOBOX_VISIBLE_OPTIONS * COMBOBOX_OPTION_HEIGHT_PX +
        COMBOBOX_LISTBOX_PADDING_PX,
    );
    expect(comboListboxMaxHeightPx()).toBeGreaterThan(
      COMBOBOX_VISIBLE_OPTIONS * COMBOBOX_OPTION_HEIGHT_PX,
    );
  });

  it("keeps Fluent from sizing the popup height itself", () => {
    // `autoSize: true` makes Fluent write `max-height`/`height` onto the
    // listbox, so the popup fills the window and the cap above is ignored.
    expect(COMBOBOX_POSITIONING.autoSize).toBe("width");
  });
});
