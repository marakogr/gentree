import { describe, expect, it } from "vitest";
import type { DateValue, ParentRef, Person, PersonName } from "../../api/types";
import {
  ageInCompletedYears,
  ageTone,
  buildPersonInput,
  capitalizeName,
  displayName,
  draftFromPerson,
  emptyPersonDraft,
  filterPersons,
  filterPersonsByYears,
  isProbablyLiving,
  isValidYearRange,
  lifeYears,
  parentEntries,
  parentSummary,
  sortPersons,
  splitGivenPatronymic,
  validatePersonDraft,
} from "./helpers";

const unknownDate: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function name(
  given: string | null,
  surname: string | null,
  isPrimary = true,
): PersonName {
  return {
    given,
    patronymic: null,
    surname,
    prefix: null,
    suffix: null,
    nameType: "BIRTH",
    isPrimary,
  };
}

function person(
  id: string,
  given: string | null,
  surname: string | null,
  birthYear?: number,
  deathYear?: number,
): Person {
  const date = (year: number): DateValue => ({
    start: `${year}-01-01`,
    end: `${year + 1}-01-01`,
    precision: "YEAR",
    qualifier: "EXACT",
    original: null,
  });
  return {
    id,
    gender: "UNKNOWN",
    names: [name(given, surname)],
    birth: birthYear ? date(birthYear) : unknownDate,
    death: deathYear ? date(deathYear) : unknownDate,
    notes: null,
    externalIds: [],
  };
}

describe("displayName", () => {
  it("puts surname first and uses the supplied unknown label", () => {
    expect(displayName(person("1", "Ivan", "Petrov"))).toBe("Petrov Ivan");
    expect(displayName(person("id-only", null, null), "Неизвестно")).toBe(
      "Неизвестно",
    );
    expect(displayName(person("id-only", null, null))).toBe("");
  });
});

describe("filterPersons", () => {
  const people = [
    person("1", "Ivan", "Petrov"),
    person("2", "Maria", "Sidorova"),
    person("3", "Anna", "Petrova"),
  ];

  it("matches given, surname and full display name case-insensitively", () => {
    expect(filterPersons(people, "IVA").map((item) => item.id)).toEqual(["1"]);
    expect(filterPersons(people, "petro").map((item) => item.id)).toEqual([
      "1",
      "3",
    ]);
    expect(filterPersons(people, "  sidorova ").map((item) => item.id)).toEqual([
      "2",
    ]);
  });

  it("returns everyone for an empty query", () => {
    expect(filterPersons(people, "   ")).toHaveLength(3);
  });
});

describe("sortPersons", () => {
  const people = [
    person("1", "Ivan", "Petrov", 1970),
    person("2", "Anna", "Sidorova", 1950),
    person("3", "Boris", "Ananov"),
  ];

  it("sorts by name without mutating the input", () => {
    const sorted = sortPersons(people, "name");
    expect(sorted.map((item) => item.id)).toEqual(["3", "1", "2"]);
    expect(people.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("sorts by birth and puts unknown dates last", () => {
    expect(sortPersons(people, "birth").map((item) => item.id)).toEqual([
      "2",
      "1",
      "3",
    ]);
  });
});

describe("sortPersons with death and direction", () => {
  const people = [
    person("1", "Ivan", "Petrov", 1970, 2000),
    person("2", "Anna", "Sidorova", 1950, 1990),
    person("3", "Boris", "Ananov"),
    person("4", "Lev", "Zaytsev", 1960),
  ];

  it("sorts by death ascending and keeps undated last", () => {
    expect(sortPersons(people, "death").map((item) => item.id)).toEqual([
      "2",
      "1",
      "3",
      "4",
    ]);
  });

  it("sorts by death descending and keeps undated last", () => {
    expect(
      sortPersons(people, "death", "desc").map((item) => item.id),
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("sorts by birth descending and keeps undated last", () => {
    expect(
      sortPersons(people, "birth", "desc").map((item) => item.id),
    ).toEqual(["1", "4", "2", "3"]);
  });

  it("sorts by name descending", () => {
    expect(
      sortPersons(people, "name", "desc").map((item) => item.id),
    ).toEqual(["4", "2", "1", "3"]);
  });
});

describe("sortPersons by age", () => {
  const people = [
    person("died40", "Anna", "Sidorova", 1950, 1990),
    person("died30", "Ivan", "Petrov", 1970, 2000),
    person("alive", "Lev", "Zaytsev", 1960),
    person("unknown", "Boris", "Ananov"),
  ];

  it("uses the death date for the deceased and today for the living", () => {
    expect(sortPersons(people, "age", "asc").map((item) => item.id)).toEqual([
      "died30",
      "died40",
      "alive",
      "unknown",
    ]);
  });

  it("keeps unknown ages last in both directions", () => {
    expect(sortPersons(people, "age", "desc").map((item) => item.id)).toEqual([
      "alive",
      "died40",
      "died30",
      "unknown",
    ]);
  });
});

describe("sortPersons birth descending (default order)", () => {
  it("puts the youngest first, ties by name, and undated last", () => {
    const people = [
      person("anna", "Анна", "Абрамова", 1990),
      person("boris", "Борис", "Зотов", 1990),
      person("youngest", "Вера", "Петрова", 2000),
      person("undated", "Глеб", "Иванов"),
    ];
    expect(
      sortPersons(people, "birth", "desc").map((item) => item.id),
    ).toEqual(["youngest", "anna", "boris", "undated"]);
  });
});

describe("splitGivenPatronymic", () => {
  it("treats the last word as the patronymic", () => {
    expect(
      splitGivenPatronymic("Анна Александровна", ""),
    ).toEqual({ given: "Анна", patronymic: "Александровна" });
    expect(splitGivenPatronymic("Иван Петрович", "")).toEqual({
      given: "Иван",
      patronymic: "Петрович",
    });
    expect(splitGivenPatronymic("John Paul", "")).toEqual({
      given: "John",
      patronymic: "Paul",
    });
  });

  it("keeps the last word of a longer given name as the patronymic", () => {
    expect(splitGivenPatronymic("Анна Мария Ивановна", "")).toEqual({
      given: "Анна Мария",
      patronymic: "Ивановна",
    });
  });

  it("keeps an existing patronymic untouched", () => {
    expect(
      splitGivenPatronymic("Анна Александровна", "Петровна"),
    ).toEqual({ given: "Анна Александровна", patronymic: "Петровна" });
    expect(splitGivenPatronymic("Анна", "")).toEqual({
      given: "Анна",
      patronymic: "",
    });
  });

  it("is not applied silently when a person is opened for editing", () => {
    const restored = draftFromPerson({
      ...person("p1", "Анна Александровна", "Сидорова"),
    });
    expect(restored.given).toBe("Анна Александровна");
    expect(restored.patronymic).toBe("");
  });
});

describe("capitalizeName", () => {
  it("upper-cases the first letter of every word", () => {
    expect(capitalizeName("иван иванов")).toBe("Иван Иванов");
    expect(capitalizeName("john smith")).toBe("John Smith");
  });

  it("handles hyphenated parts", () => {
    expect(capitalizeName("петров-водкин")).toBe("Петров-Водкин");
    expect(capitalizeName("анна-мария")).toBe("Анна-Мария");
  });

  it("keeps the rest of the user's case and trims the ends", () => {
    expect(capitalizeName("  иВАН  иванов  ")).toBe("ИВАН  Иванов");
  });

  it("leaves blank input and non-letter words untouched", () => {
    expect(capitalizeName("")).toBe("");
    expect(capitalizeName("   ")).toBe("");
    expect(capitalizeName("иван 123")).toBe("Иван 123");
  });
});

describe("birth surname", () => {
  it("round-trips the surname at birth as a separate BIRTH name", () => {
    const result = buildPersonInput({
      ...emptyPersonDraft(),
      given: "Анна",
      surname: "Сидорова",
      birthSurname: "Петрова",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.names).toHaveLength(2);
    expect(result.person.names[0]).toMatchObject({
      surname: "Сидорова",
      nameType: "MARRIED",
      isPrimary: true,
    });
    expect(result.person.names[1]).toMatchObject({
      surname: "Петрова",
      nameType: "BIRTH",
      isPrimary: false,
    });

    const restored = draftFromPerson({
      ...person("p1", "Анна", "Сидорова"),
      names: result.person.names,
    });
    expect(restored.birthSurname).toBe("Петрова");
    expect(restored.surname).toBe("Сидорова");
  });

  it("removes the extra birth name when the field is cleared", () => {
    const base: Person = {
      ...person("p1", "Анна", "Сидорова"),
      names: [
        { ...name("Анна", "Сидорова"), nameType: "MARRIED" },
        name("Анна", "Петрова", false),
      ],
    };
    const result = buildPersonInput(
      { ...draftFromPerson(base), birthSurname: "" },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.names).toHaveLength(1);
  });
});

describe("emptyPersonDraft", () => {
  it("defaults both dates to day precision with an exact qualifier", () => {
    const draft = emptyPersonDraft();
    expect(draft.birthPrecision).toBe("DAY");
    expect(draft.deathPrecision).toBe("DAY");
    expect(draft.birthQualifier).toBe("EXACT");
    expect(draft.deathQualifier).toBe("EXACT");
  });

  it("keeps the stored precision when an existing person is opened", () => {
    expect(draftFromPerson(person("p1", "Ivan", "Petrov")).birthPrecision).toBe(
      "UNKNOWN",
    );
    const dated = person("p2", "Ivan", "Petrov", 1950);
    expect(draftFromPerson(dated).birthPrecision).toBe("YEAR");
    expect(draftFromPerson(dated).birthQualifier).toBe("EXACT");
  });
});

describe("buildPersonInput", () => {
  it("creates a person without an id and parses dates", () => {
    const result = buildPersonInput({
      ...emptyPersonDraft(),
      given: " Ivan ",
      surname: "Petrov",
      birthDate: "1950",
      birthPrecision: "YEAR",
      notes: "  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.id).toBeUndefined();
    expect(result.person.names[0].given).toBe("Ivan");
    expect(result.person.birth.start).toBe("1950-01-01");
    expect(result.person.notes).toBeNull();
  });

  it("keeps secondary names and the id while editing", () => {
    const base: Person = {
      ...person("p-1", "Ivan", "Petrov"),
      names: [name("Ivan", "Petrov"), name("Ivan", "Sidorov", false)],
      notes: "old",
    };
    const draft = { ...draftFromPerson(base), surname: "Smirnov" };
    const result = buildPersonInput(draft, base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.id).toBe("p-1");
    expect(result.person.names).toHaveLength(2);
    expect(result.person.names[0].surname).toBe("Smirnov");
    expect(result.person.names[1].surname).toBe("Sidorov");
  });

  it("capitalises every name field on save", () => {
    const result = buildPersonInput({
      ...emptyPersonDraft(),
      given: "иван",
      surname: "петров-водкин",
      patronymic: "иванович",
      birthSurname: "сидоров",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.names[0]).toMatchObject({
      given: "Иван",
      surname: "Петров-Водкин",
      patronymic: "Иванович",
    });
    expect(result.person.names[1]).toMatchObject({
      surname: "Сидоров",
      nameType: "BIRTH",
    });
  });

  it("reports invalid date fields instead of inventing a value", () => {
    const result = buildPersonInput({
      ...emptyPersonDraft(),
      given: "Ivan",
      deathDate: "2023-02-29",
      deathPrecision: "DAY",
    });
    expect(result).toEqual({ ok: false, fields: { death: true } });
  });

  it("saves a blank date under a chosen precision as an unknown date", () => {
    const result = buildPersonInput({
      ...emptyPersonDraft(),
      given: "Ivan",
      birthPrecision: "DAY",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.birth).toEqual(unknownDate);
    expect(result.person.death).toEqual(unknownDate);
  });
});

describe("lifeYears", () => {
  const date = (iso: string | null): DateValue =>
    iso
      ? {
          start: iso,
          end: iso,
          precision: "YEAR",
          qualifier: "EXACT",
          original: null,
        }
      : unknownDate;

  it("prints both years, an ellipsis for a missing death and the em dash for nothing", () => {
    expect(
      lifeYears({ birth: date("1935-01-01"), death: date("1998-01-01") }),
    ).toBe("1935 \u2013 1998");
    expect(lifeYears({ birth: date("1935-01-01"), death: unknownDate })).toBe(
      "1935 \u2013 \u2026",
    );
    expect(lifeYears({ birth: unknownDate, death: unknownDate })).toBe("\u2014");
    expect(lifeYears({ birth: unknownDate, death: date("1998-01-01") })).toBe(
      "\u2014 \u2013 1998",
    );
  });
});

describe("ageInCompletedYears", () => {
  const today = new Date(Date.UTC(2026, 9, 31));
  const dated = (
    start: string | null,
    precision: DateValue["precision"],
    original: string | null = null,
  ): DateValue => ({
    start,
    end: null,
    precision,
    qualifier: start === null ? "UNKNOWN" : "EXACT",
    original,
  });
  const subject = (birth: DateValue, death: DateValue = unknownDate) => ({
    birth,
    death,
  });

  it("computes the age of a living person from the system date", () => {
    expect(
      ageInCompletedYears(subject(dated("1990-06-15", "DAY")), today),
    ).toBe(36);
    expect(
      ageInCompletedYears(
        subject(dated("1990-06-15", "DAY")),
        new Date(Date.UTC(2026, 5, 14)),
      ),
    ).toBe(35);
    expect(
      ageInCompletedYears(
        subject(dated("1990-06-15", "DAY")),
        new Date(Date.UTC(2026, 5, 15)),
      ),
    ).toBe(36);
  });

  it("stops at the death date for a deceased person", () => {
    expect(
      ageInCompletedYears(
        subject(
          dated("1900-04-12", "DAY"),
          dated("1980-01-02", "DAY"),
        ),
        today,
      ),
    ).toBe(79);
  });

  it("uses the coarser precision of the two dates", () => {
    expect(
      ageInCompletedYears(
        subject(dated("1900-01-01", "YEAR"), dated("1980-01-01", "YEAR")),
        today,
      ),
    ).toBe(80);
    expect(
      ageInCompletedYears(
        subject(dated("1900-06-01", "MONTH")),
        new Date(Date.UTC(2026, 4, 31)),
      ),
    ).toBe(125);
  });

  it("never invents an age without a usable birth date", () => {
    expect(ageInCompletedYears(subject(unknownDate), today)).toBeNull();
    expect(
      ageInCompletedYears(
        subject(dated("2030-01-01", "DAY")),
        new Date(Date.UTC(2026, 9, 31)),
      ),
    ).toBeNull();
  });

  it("returns nothing when the person is dead but the date is only free text", () => {
    expect(
      ageInCompletedYears(
        subject(
          dated("1900-04-12", "DAY"),
          dated(null, "UNKNOWN", "after 1980"),
        ),
        today,
      ),
    ).toBeNull();
  });
});

describe("isProbablyLiving", () => {
  const today = new Date(Date.UTC(2026, 9, 23));
  const born = (iso: string, deathIso: string | null = null): Person => ({
    ...person("living", "Ivan", "Petrov"),
    birth: {
      start: iso,
      end: null,
      precision: "DAY",
      qualifier: "EXACT",
      original: null,
    },
    death: deathIso
      ? {
          start: deathIso,
          end: null,
          precision: "DAY",
          qualifier: "EXACT",
          original: null,
        }
      : unknownDate,
  });

  it("flags a person without a death date as probably living", () => {
    expect(isProbablyLiving(born("1980-05-01"), today)).toBe(true);
  });

  it("keeps the 110-year threshold inclusive", () => {
    // Exactly 110 today.
    expect(isProbablyLiving(born("1916-10-23"), today)).toBe(true);
    // 110 tomorrow: the 111th year has not started yet.
    expect(isProbablyLiving(born("1915-10-24"), today)).toBe(true);
    // Turned 111 yesterday.
    expect(isProbablyLiving(born("1915-10-22"), today)).toBe(false);
  });

  it("never flags a person with a death date", () => {
    expect(isProbablyLiving(born("1980-05-01", "2020-01-01"), today)).toBe(
      false,
    );
  });

  it("requires a birth date", () => {
    expect(
      isProbablyLiving({ birth: unknownDate, death: unknownDate }, today),
    ).toBe(false);
  });

  it("does not flag a birth date in the future", () => {
    expect(isProbablyLiving(born("2030-01-01"), today)).toBe(false);
  });
});

describe("ageTone", () => {
  const today = new Date(Date.UTC(2026, 9, 23));
  const born = (iso: string | null, deathIso: string | null = null): Person => ({
    ...person("tone", "Ivan", "Petrov"),
    birth: iso
      ? {
          start: iso,
          end: null,
          precision: "DAY",
          qualifier: "EXACT",
          original: null,
        }
      : unknownDate,
    death: deathIso
      ? {
          start: deathIso,
          end: null,
          precision: "DAY",
          qualifier: "EXACT",
          original: null,
        }
      : unknownDate,
  });

  it("marks a living person green", () => {
    expect(ageTone(born("1980-05-01"), today)).toBe("living");
  });

  it("marks a known death red", () => {
    expect(ageTone(born("1980-05-01", "2020-01-01"), today)).toBe("dead");
  });

  it("marks a presumable death without a date red as well", () => {
    expect(ageTone(born("1900-01-01"), today)).toBe("dead");
  });

  it("leaves an unknown life span uncoloured", () => {
    expect(ageTone(born(null), today)).toBe("unknown");
  });
});

describe("filterPersonsByYears", () => {
  const people = [
    person("1", "Ivan", "Petrov", 1935, 1998),
    person("2", "Anna", "Sidorova", 1950),
    person("3", "Boris", "Ananov"),
    person("4", "Lev", "Zaytsev", 2001, 2020),
  ];

  it("matches a birth or a death year inside the range", () => {
    expect(
      filterPersonsByYears(people, "1990", "2000").map((item) => item.id),
    ).toEqual(["1"]);
    expect(
      filterPersonsByYears(people, "1940", "1960").map((item) => item.id),
    ).toEqual(["2"]);
    expect(
      filterPersonsByYears(people, "2010", "2030").map((item) => item.id),
    ).toEqual(["4"]);
  });

  it("supports an open-ended bound and excludes undated persons", () => {
    expect(
      filterPersonsByYears(people, "1990", "").map((item) => item.id),
    ).toEqual(["1", "4"]);
    expect(
      filterPersonsByYears(people, "", "1940").map((item) => item.id),
    ).toEqual(["1"]);
  });

  it("does nothing without bounds or with an inverted range", () => {
    expect(filterPersonsByYears(people, "", "")).toHaveLength(4);
    expect(filterPersonsByYears(people, "2000", "1900")).toHaveLength(4);
    expect(isValidYearRange("2000", "1900")).toBe(false);
    expect(isValidYearRange("1900", "2000")).toBe(true);
    expect(isValidYearRange("", "2000")).toBe(true);
  });
});

describe("parentEntries", () => {
  const ref = (id: string, name: string): ParentRef => ({
    id,
    name,
    gender: "MALE",
  });

  it("handles a missing map entry", () => {
    expect(parentEntries(undefined)).toEqual([]);
  });

  it("maps names and keeps an optional adoption flag", () => {
    const entries = parentEntries([
      ref("1", " Petrov Ivan "),
      { ...ref("2", "Petrova Anna"), adoptive: true } as ParentRef,
    ]);
    expect(entries).toEqual([
      { id: "1", name: "Petrov Ivan", gender: "MALE", adoptive: false },
      { id: "2", name: "Petrova Anna", gender: "MALE", adoptive: true },
    ]);
  });

  it("collapses the tail into a counter", () => {
    const entries = parentEntries([
      ref("1", "A"),
      ref("2", "B"),
      ref("3", "C"),
    ]);
    expect(parentSummary(entries).visible).toHaveLength(2);
    expect(parentSummary(entries).extra).toBe(1);
    expect(parentSummary(entries, 1).extra).toBe(2);
  });
});

describe("validatePersonDraft", () => {
  it("requires at least one of given name or surname", () => {
    expect(validatePersonDraft(emptyPersonDraft())).toEqual({
      name: "NAME_REQUIRED",
    });
    expect(
      validatePersonDraft({ ...emptyPersonDraft(), surname: " Petrov " }),
    ).toEqual({});
    expect(validatePersonDraft({ ...emptyPersonDraft(), given: "Ivan" })).toEqual(
      {},
    );
  });

  it("accepts a year-only date and an approximate qualifier", () => {
    const draft = {
      ...emptyPersonDraft(),
      given: "Ivan",
      birthDate: "1950",
      birthPrecision: "YEAR" as const,
      birthQualifier: "APPROXIMATE" as const,
    };
    expect(validatePersonDraft(draft)).toEqual({});
    const result = buildPersonInput(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.birth.start).toBe("1950-01-01");
    expect(result.person.birth.precision).toBe("YEAR");
    expect(result.person.birth.qualifier).toBe("APPROXIMATE");
  });

  it("rejects a broken date but keeps unknown precision free-form", () => {
    expect(
      validatePersonDraft({
        ...emptyPersonDraft(),
        given: "Ivan",
        birthDate: "2023-02-29",
        birthPrecision: "DAY",
      }),
    ).toEqual({ birth: "DATE_INVALID" });
    expect(
      validatePersonDraft({
        ...emptyPersonDraft(),
        given: "Ivan",
        birthDate: "spring, about 1900",
        birthPrecision: "UNKNOWN",
      }),
    ).toEqual({});
  });

  it("accepts a blank date for any precision", () => {
    expect(
      validatePersonDraft({
        ...emptyPersonDraft(),
        given: "Ivan",
        deathPrecision: "MONTH",
      }),
    ).toEqual({});
  });
});
