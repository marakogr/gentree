import { describe, expect, it } from "vitest";
import {
  normalizePlaceText,
  placeQuery,
  placeSuggestionText,
} from "./place";

describe("placeQuery", () => {
  it("trims a query that is long enough to send", () => {
    expect(placeQuery("  Moscow  ")).toBe("Moscow");
  });

  it("rejects blank and too-short input", () => {
    expect(placeQuery("")).toBeNull();
    expect(placeQuery("   ")).toBeNull();
    expect(placeQuery(" ab ")).toBeNull();
  });

  it("counts code points, not UTF-16 units", () => {
    expect(placeQuery("aaa")).toBe("aaa");
    // Two surrogate pairs are four UTF-16 units but only two characters.
    expect(placeQuery("\u{1F600}\u{1F600}")).toBeNull();
  });
});

describe("normalizePlaceText", () => {
  it("composes decomposed accents into one code point", () => {
    expect(normalizePlaceText("Tverska\u0301ya")).toBe("Tversk\u00e1ya");
  });

  it("keeps an already composed label unchanged", () => {
    expect(normalizePlaceText("Tversk\u00e1ya, 1")).toBe("Tversk\u00e1ya, 1");
  });
});

describe("placeSuggestionText", () => {
  it("returns the label as free text, never an id", () => {
    const text = placeSuggestionText("Tverskaya street, 1, Moscow");
    expect(text).toBe("Tverskaya street, 1, Moscow");
  });
});
