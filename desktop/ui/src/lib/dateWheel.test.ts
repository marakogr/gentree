import { describe, expect, it } from "vitest";
import {
  WHEEL_COLUMN_HEIGHT,
  WHEEL_COLUMN_PADDING,
  WHEEL_ITEM_HEIGHT,
  WHEEL_VISIBLE_ROWS,
  wheelScrollTop,
} from "./dateWheel";

describe("date wheel geometry", () => {
  it("sizes the column from whole visible rows", () => {
    expect(WHEEL_VISIBLE_ROWS % 2).toBe(1);
    expect(WHEEL_COLUMN_HEIGHT).toBe(WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ROWS);
  });

  it("pads the column so the first and last rows can reach the centre", () => {
    expect(WHEEL_COLUMN_PADDING).toBe(
      (WHEEL_COLUMN_HEIGHT - WHEEL_ITEM_HEIGHT) / 2,
    );
    // Twelve months plus both paddings still overflow the viewport, so the
    // month column scrolls instead of stretching.
    expect(
      12 * WHEEL_ITEM_HEIGHT + 2 * WHEEL_COLUMN_PADDING,
    ).toBeGreaterThan(WHEEL_COLUMN_HEIGHT);
  });

  it("puts a selected row of any index on the same line", () => {
    const restingTop = (index: number) =>
      WHEEL_COLUMN_PADDING +
      index * WHEEL_ITEM_HEIGHT -
      wheelScrollTop(index);

    for (const index of [0, 1, 5, 11, 30, 1999]) {
      expect(restingTop(index)).toBe(WHEEL_COLUMN_PADDING);
    }
  });

  it("clamps unusable indexes to the first row", () => {
    expect(wheelScrollTop(-4)).toBe(0);
    expect(wheelScrollTop(Number.NaN)).toBe(0);
    expect(wheelScrollTop(3.7)).toBe(3 * WHEEL_ITEM_HEIGHT);
  });
});
