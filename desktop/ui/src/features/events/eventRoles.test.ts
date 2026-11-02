import { describe, expect, it } from "vitest";
import {
  dateModeKeys,
  isPairedEventType,
  personPlaceholderKey,
  personRoleKey,
  placePlaceholderKey,
} from "./eventRoles";

describe("person roles", () => {
  it("names the primary participant by the event meaning", () => {
    expect(personRoleKey("BIRTH")).toBe("roleChild");
    expect(personRoleKey("DEATH")).toBe("roleDeceased");
    expect(personRoleKey("BURIAL")).toBe("roleDeceasedBurial");
    expect(personRoleKey("MARRIAGE")).toBe("roleSpouseFirst");
    expect(personRoleKey("DIVORCE")).toBe("roleSpouseFirst");
    expect(personRoleKey("RESIDENCE")).toBe("rolePerson");
    expect(personRoleKey("OCCUPATION")).toBe("rolePerson");
    expect(personRoleKey("EDUCATION")).toBe("rolePerson");
    expect(personRoleKey("OTHER")).toBe("rolePerson");
  });

  it("uses two equal spouse roles for paired events", () => {
    expect(personRoleKey("MARRIAGE", "secondary")).toBe("roleSpouseSecond");
    expect(personRoleKey("DIVORCE", "secondary")).toBe("roleSpouseSecond");
  });

  it("asks for the child by name instead of promising free-text creation", () => {
    expect(personPlaceholderKey("BIRTH")).toBe("personPlaceholderChild");
    expect(personPlaceholderKey("BIRTH", "secondary")).toBe(
      "personPlaceholderSpouse",
    );
    expect(personPlaceholderKey("DEATH")).toBe("personPlaceholder");
  });
});

describe("paired event types", () => {
  it("is marriage and divorce only", () => {
    expect(isPairedEventType("MARRIAGE")).toBe(true);
    expect(isPairedEventType("DIVORCE")).toBe(true);
    expect(isPairedEventType("BURIAL")).toBe(false);
    expect(isPairedEventType("BIRTH")).toBe(false);
  });
});

describe("place placeholders", () => {
  it("separates the settlement from a cemetery or a street address", () => {
    expect(placePlaceholderKey("BURIAL")).toBe("placePlaceholderCityRegion");
    expect(placePlaceholderKey("RESIDENCE")).toBe("placePlaceholderCity");
    expect(placePlaceholderKey("BIRTH")).toBeNull();
  });
});

describe("date mode labels", () => {
  it("uses graduation wording for education", () => {
    expect(dateModeKeys("EDUCATION")).toEqual({
      single: "dateModeGraduation",
      range: "dateModeStudyPeriod",
    });
  });

  it("uses residence wording for a residence period", () => {
    expect(dateModeKeys("RESIDENCE")).toEqual({
      single: "dateModeSingle",
      range: "dateModeResidencePeriod",
    });
  });

  it("uses the generic exact/period wording for occupation", () => {
    expect(dateModeKeys("OCCUPATION")).toEqual({
      single: "dateModeSingle",
      range: "dateModePeriod",
    });
  });

  it("has no switch for types without a period", () => {
    expect(dateModeKeys("BIRTH")).toBeNull();
    expect(dateModeKeys("MARRIAGE")).toBeNull();
  });
});
