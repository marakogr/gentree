import { describe, expect, it } from "vitest";
import { toggleMultiSelect } from "./multiSelectRules";

describe("toggleMultiSelect", () => {
  it("clears the selection when the all-row is chosen", () => {
    expect(toggleMultiSelect(["BIRTH", "DEATH"], "")).toEqual([]);
    expect(toggleMultiSelect([], "")).toEqual([]);
  });

  it("adds an option that is not selected", () => {
    expect(toggleMultiSelect([], "BIRTH")).toEqual(["BIRTH"]);
    expect(toggleMultiSelect(["BIRTH"], "DEATH")).toEqual(["BIRTH", "DEATH"]);
  });

  it("removes an option that is already selected", () => {
    expect(toggleMultiSelect(["BIRTH", "DEATH"], "BIRTH")).toEqual(["DEATH"]);
    expect(toggleMultiSelect(["DEATH"], "DEATH")).toEqual([]);
  });

  it("keeps the order of the remaining values and does not mutate", () => {
    const values = ["BIRTH", "DEATH", "MARRIAGE"];
    expect(toggleMultiSelect(values, "DEATH")).toEqual(["BIRTH", "MARRIAGE"]);
    expect(values).toEqual(["BIRTH", "DEATH", "MARRIAGE"]);
  });
});
