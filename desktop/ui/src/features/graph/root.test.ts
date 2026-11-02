import { describe, expect, it } from "vitest";
import type { DateValue, Person, PersonName } from "../../api/types";
import { selectRootPerson } from "./root";

const unknownDate: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function person(id: string, birthYear: number | null): Person {
  const name: PersonName = {
    given: "Test",
    patronymic: null,
    surname: id,
    prefix: null,
    suffix: null,
    nameType: "BIRTH",
    isPrimary: true,
  };
  return {
    id,
    gender: "UNKNOWN",
    names: [name],
    birth:
      birthYear === null
        ? unknownDate
        : {
            start: `${birthYear}-01-01`,
            end: `${birthYear + 1}-01-01`,
            precision: "YEAR",
            qualifier: "EXACT",
            original: null,
          },
    death: unknownDate,
    notes: null,
    externalIds: [],
  };
}

describe("selectRootPerson", () => {
  it("prefers the home person when it still exists", () => {
    const persons = [person("a", 1970), person("b", 1950)];
    expect(selectRootPerson(persons, "a")?.id).toBe("a");
    expect(selectRootPerson(persons, "b")?.id).toBe("b");
  });

  it("falls back to the earliest birth when home is missing", () => {
    const persons = [person("a", 1970), person("b", 1950), person("c", 1960)];
    expect(selectRootPerson(persons, null)?.id).toBe("b");
    expect(selectRootPerson(persons, "deleted-person")?.id).toBe("b");
  });

  it("puts unknown births last", () => {
    const persons = [person("a", null), person("b", 1950), person("c", null)];
    expect(selectRootPerson(persons, null)?.id).toBe("b");
  });

  it("uses the smallest id when no birth date is known", () => {
    const persons = [person("c", null), person("a", null), person("b", null)];
    expect(selectRootPerson(persons, null)?.id).toBe("a");
  });

  it("returns null for an empty project", () => {
    expect(selectRootPerson([], null)).toBeNull();
  });
});
