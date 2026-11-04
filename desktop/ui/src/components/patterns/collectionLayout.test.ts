import { describe, expect, it } from "vitest";
import {
  clampCollectionWidth,
  commitCollectionWidth,
  readCollectionWidth,
} from "./collectionLayout";

const bounds = { defaultWidth: 58, min: 35, max: 75 };

describe("collection width", () => {
  it("reads the default when nothing is stored", () => {
    expect(readCollectionWidth(undefined, bounds)).toBe(58);
    expect(readCollectionWidth("", bounds)).toBe(58);
  });

  it("reads and clamps a stored value", () => {
    expect(readCollectionWidth("62", bounds)).toBe(62);
    expect(readCollectionWidth("10", bounds)).toBe(35);
    expect(readCollectionWidth("90", bounds)).toBe(75);
  });

  it("clamps live widths", () => {
    expect(clampCollectionWidth(20, bounds)).toBe(35);
    expect(clampCollectionWidth(80, bounds)).toBe(75);
  });

  it("commits a rounded value and its stored form", () => {
    expect(commitCollectionWidth(57.6, bounds)).toEqual({
      width: 58,
      stored: "58",
    });
    expect(commitCollectionWidth(10, bounds)).toEqual({
      width: 35,
      stored: "35",
    });
  });
});
