import { describe, expect, it } from "vitest";
import type { DateValue, Person } from "../../api/types";
import { diffPerson, formatPersonName } from "./confirm";

function name(
  given: string,
  surname: string,
  nameType: "BIRTH" | "MARRIED" | "RELIGIOUS" | "OTHER" = "BIRTH",
  isPrimary = true,
): Person["names"][number] {
  return { given, surname, patronymic: null, prefix: null, suffix: null, nameType, isPrimary };
}

function date(value: DateValue): string {
  if (value.precision === "UNKNOWN" || (!value.start && !value.end)) return "unknown";
  return value.start ?? value.end ?? "unknown";
}

function gender(value: Person["gender"]): string {
  return value.toLowerCase();
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "p1",
    gender: "MALE",
    names: [name("Ivan", "Petrov")],
    birth: { start: "1950-01-01", end: "1951-01-01", precision: "YEAR", qualifier: "EXACT", original: "1950" },
    death: { start: null, end: null, precision: "UNKNOWN", qualifier: "UNKNOWN", original: null },
    notes: null,
    externalIds: [],
    ...overrides,
  };
}

const format = { name: (_: Person) => "x", date, gender };

describe("formatPersonName", () => {
  it("joins surname, given and patronymic", () => {
    expect(formatPersonName(name("Ivan", "Petrov"))).toBe("Petrov Ivan");
  });
});

describe("diffPerson", () => {
  it("reports a changed name", () => {
    const before = person();
    const after = person({ names: [name("Ivan", "Petrovsky")] });
    expect(diffPerson(before, after, format)).toEqual([
      { field: "names", nameType: "BIRTH", before: "Petrov Ivan", after: "Petrovsky Ivan" },
    ]);
  });

  it("reports an added and a removed name", () => {
    const before = person();
    const after = person({ names: [name("Ivan", "Petrov"), name("Ivan", "Petrov", "MARRIED", false)] });
    const rows = diffPerson(before, after, format);
    expect(rows).toContainEqual({
      field: "names",
      nameType: "MARRIED",
      before: "",
      after: "Petrov Ivan",
    });

    const removed = diffPerson(
      person({ names: [name("Ivan", "Petrov"), name("Ivan", "Petrov", "MARRIED", false)] }),
      person(),
      format,
    );
    expect(removed).toContainEqual({
      field: "names",
      nameType: "MARRIED",
      before: "Petrov Ivan",
      after: "",
    });
  });

  it("groups names by nameType and matches by position", () => {
    const before = person({
      names: [name("Ivan", "Petrov"), name("Anna", "Petrova", "MARRIED", false)],
    });
    const after = person({
      names: [name("Ivan", "Petrovsky"), name("Anna", "Petrova", "MARRIED", false)],
    });
    const rows = diffPerson(before, after, format);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      field: "names",
      nameType: "BIRTH",
      before: "Petrov Ivan",
      after: "Petrovsky Ivan",
    });
  });

  it("reports a gender change", () => {
    const rows = diffPerson(person(), person({ gender: "FEMALE" }), format);
    expect(rows).toContainEqual({ field: "gender", before: "male", after: "female" });
  });

  it("reports a date change", () => {
    const rows = diffPerson(
      person(),
      person({ birth: { start: "1960-01-01", end: "1961-01-01", precision: "YEAR", qualifier: "EXACT", original: "1960" } }),
      format,
    );
    expect(rows).toContainEqual({ field: "birth", before: "1950-01-01", after: "1960-01-01" });
  });

  it("reports clearing notes", () => {
    const rows = diffPerson(
      person({ notes: "some text" }),
      person({ notes: null }),
      format,
    );
    expect(rows).toEqual([{ field: "notes", before: "some text", after: "\u2014" }]);
  });

  it("returns no rows when nothing changed", () => {
    expect(diffPerson(person(), person(), format)).toEqual([]);
  });

  it("ignores externalIds", () => {
    const rows = diffPerson(
      person(),
      person({ externalIds: [{ source: "AT5", value: "x" }] }),
      format,
    );
    expect(rows).toEqual([]);
  });
});
