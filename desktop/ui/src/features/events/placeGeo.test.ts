import { describe, expect, it } from "vitest";
import { formatPlacePoint, placePrecisionLabelKey } from "./placeGeo";

describe("formatPlacePoint", () => {
  it("keeps four decimals and the lat, lon order", () => {
    expect(formatPlacePoint({ lat: 57.43215, lon: 49.12344 })).toBe(
      "57.4322, 49.1234",
    );
  });

  it("handles negative values and the date line", () => {
    expect(formatPlacePoint({ lat: -33.8688, lon: 151.2093 })).toBe(
      "-33.8688, 151.2093",
    );
    expect(formatPlacePoint({ lat: 0, lon: -180 })).toBe("0.0000, -180.0000");
  });
});

describe("placePrecisionLabelKey", () => {
  it("maps every precision to its event dictionary key", () => {
    expect(placePrecisionLabelKey("POINT")).toBe("event:placePrecision.POINT");
    expect(placePrecisionLabelKey("SETTLEMENT")).toBe(
      "event:placePrecision.SETTLEMENT",
    );
    expect(placePrecisionLabelKey("REGION")).toBe(
      "event:placePrecision.REGION",
    );
    expect(placePrecisionLabelKey("COUNTRY")).toBe(
      "event:placePrecision.COUNTRY",
    );
    expect(placePrecisionLabelKey("UNKNOWN")).toBe(
      "event:placePrecision.UNKNOWN",
    );
  });
});
