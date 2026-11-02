import { describe, expect, it } from "vitest";
import { genderLabelKey, genderMarker } from "./gender";

describe("genderMarker", () => {
  it("maps male to Mars/blue, female to Venus/pink", () => {
    const male = genderMarker("MALE");
    expect(male.icon).toBe("mars");
    expect(male.tone).toBe("male");
    expect(male.swatch).toContain("sky");
    expect(male.text).toContain("sky");

    const female = genderMarker("FEMALE");
    expect(female.icon).toBe("venus");
    expect(female.tone).toBe("female");
    expect(female.swatch).toContain("pink");
    expect(female.text).toContain("pink");
  });

  it("uses a neutral glyph and colour for unknown or missing gender", () => {
    for (const gender of ["UNKNOWN", null, undefined] as const) {
      const marker = genderMarker(gender);
      expect(marker.icon).toBe("neutral");
      expect(marker.tone).toBe("unknown");
      expect(marker.swatch).toContain("slate");
    }
  });

  it("keeps the three tones visually distinct", () => {
    const swatches = [
      genderMarker("MALE").swatch,
      genderMarker("FEMALE").swatch,
      genderMarker("UNKNOWN").swatch,
    ];
    expect(new Set(swatches).size).toBe(3);
  });
});

describe("genderLabelKey", () => {
  it("maps to the timeline dictionary keys", () => {
    expect(genderLabelKey("MALE")).toBe("gender.male");
    expect(genderLabelKey("FEMALE")).toBe("gender.female");
    expect(genderLabelKey("UNKNOWN")).toBe("gender.unknown");
    expect(genderLabelKey(null)).toBe("gender.unknown");
  });
});
