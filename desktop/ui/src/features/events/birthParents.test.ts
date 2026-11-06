import { describe, expect, it } from "vitest";
import type { Gender, Person } from "../../api/types";
import { birthParentCandidates, birthParentSlots } from "./birthParents";

const unknownDate = {
  start: null,
  end: null,
  precision: "UNKNOWN" as const,
  qualifier: "UNKNOWN" as const,
  original: null,
};

function person(id: string, gender: Gender): Person {
  return {
    id,
    gender,
    names: [],
    birth: unknownDate,
    death: unknownDate,
    notes: null,
    externalIds: [],
  };
}

const male = person("male", "MALE");
const female = person("female", "FEMALE");
const unknown = person("unknown", "UNKNOWN");
const child = person("child", "MALE");
const people = [male, female, unknown, child];

describe("birthParentCandidates", () => {
  it("offers only men in the father slot and only women in the mother slot", () => {
    expect(birthParentCandidates(people, 0, [], "child").map((row) => row.id)).toEqual([
      "male",
    ]);
    expect(birthParentCandidates(people, 1, [], "child").map((row) => row.id)).toEqual([
      "female",
    ]);
  });

  it("never offers an unknown-gender person in a new slot", () => {
    expect(birthParentCandidates(people, 0, [], "child")).not.toContainEqual(unknown);
    expect(birthParentCandidates(people, 1, [], "child")).not.toContainEqual(unknown);
  });

  it("excludes the child and the other selected parent", () => {
    const rows = birthParentCandidates(people, 0, [], "child");
    expect(rows.map((row) => row.id)).toEqual(["male"]);
    expect(rows).not.toContainEqual(child);

    const otherMale = person("other-male", "MALE");
    const otherSelected = birthParentCandidates(
      [male, otherMale],
      0,
      ["", "other-male"],
      "child",
    );
    expect(otherSelected.map((row) => row.id)).toEqual(["male"]);
  });

  it("removes duplicates and nil ids", () => {
    const nil = person("00000000-0000-0000-0000-000000000000", "MALE");
    const rows = birthParentCandidates(
      [male, male, nil, person("", "MALE")],
      0,
      [],
      "child",
    );
    expect(rows).toEqual([male]);
  });

  it("returns an empty list when nobody matches the slot gender", () => {
    expect(birthParentCandidates([female, unknown], 0, [], "child")).toEqual([]);
  });

  it("keeps a preselected unknown-gender parent visible", () => {
    const rows = birthParentCandidates(people, 0, ["unknown", ""], "child");
    expect(rows.map((row) => row.id)).toEqual(["male", "unknown"]);
  });
});

describe("birthParentSlots", () => {
  it("keeps a stored father-first pair in its slots", () => {
    expect(birthParentSlots(["male", "female"], people)).toEqual([
      "male",
      "female",
    ]);
  });

  it("resolves slots by gender, not by array index", () => {
    expect(birthParentSlots(["female", "male"], people)).toEqual([
      "male",
      "female",
    ]);
  });

  it("keeps a lone mother in the mother slot after the father is deleted", () => {
    // Deleting the father leaves the compact array `[mother]`; index 0 must
    // still not turn her into the father.
    expect(birthParentSlots(["female"], people)).toEqual(["", "female"]);
  });

  it("keeps a lone father in the father slot after the mother is deleted", () => {
    expect(birthParentSlots(["male"], people)).toEqual(["male", ""]);
  });

  it("gives an unknown-gender parent the first free slot", () => {
    expect(birthParentSlots(["unknown"], people)).toEqual(["unknown", ""]);
    expect(birthParentSlots(["female", "unknown"], people)).toEqual([
      "unknown",
      "female",
    ]);
    expect(birthParentSlots(["male", "unknown"], people)).toEqual([
      "male",
      "unknown",
    ]);
  });

  it("treats an id without a stored person as unknown gender", () => {
    expect(birthParentSlots(["missing"], people)).toEqual(["missing", ""]);
  });

  it("drops blank, nil and duplicate ids", () => {
    expect(
      birthParentSlots(
        ["", "00000000-0000-0000-0000-000000000000", "female", "female"],
        people,
      ),
    ).toEqual(["", "female"]);
  });
});
