import { describe, expect, it } from "vitest";
import type { PersonName } from "../../api/types";
import {
  createEntityIndex,
  linkifyEntities,
  type EntityPerson,
  type EntitySegment,
} from "./entityLinks";

function name(
  surname: string | null,
  given: string | null,
  patronymic: string | null = null,
  isPrimary = true,
): PersonName {
  return {
    surname,
    given,
    patronymic,
    prefix: null,
    suffix: null,
    nameType: "BIRTH",
    isPrimary,
  };
}

function person(
  id: string,
  surname: string | null,
  given: string | null,
  patronymic: string | null = null,
): EntityPerson {
  return { id, names: [name(surname, given, patronymic)] };
}

function linked(segments: EntitySegment[]): Array<[string, string | undefined]> {
  return segments.map((segment) => [segment.text, segment.personId]);
}

describe("linkifyEntities", () => {
  const ivan = person("p-ivan", "Петров", "Иван", "Иванович");

  it("links the full Surname Given Patronymic form", () => {
    expect(linked(linkifyEntities("Это Петров Иван Иванович.", [ivan]))).toEqual([
      ["Это ", undefined],
      ["Петров Иван Иванович", "p-ivan"],
      [".", undefined],
    ]);
  });

  it("links the Given Surname form", () => {
    expect(linked(linkifyEntities("Спросите Ивана? Нет, Иван Петров знает.", [ivan]))).toEqual([
      ["Спросите Ивана? Нет, ", undefined],
      ["Иван Петров", "p-ivan"],
      [" знает.", undefined],
    ]);
  });

  it("links several different persons in one answer", () => {
    const anna = person("p-anna", "Сидорова", "Анна");
    const segments = linkifyEntities(
      "Иван Петров и Анна Сидорова — супруги.",
      [ivan, anna],
    );
    expect(linked(segments)).toEqual([
      ["Иван Петров", "p-ivan"],
      [" и ", undefined],
      ["Анна Сидорова", "p-anna"],
      [" — супруги.", undefined],
    ]);
  });

  it("respects word boundaries and does not match a longer surname", () => {
    const segments = linkifyEntities("Петровский Иван Петров-Водкин", [ivan]);
    expect(segments.every((segment) => segment.personId === undefined)).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "Петровский Иван Петров-Водкин",
    );
  });

  it("is case-insensitive for Cyrillic and folds ё to е", () => {
    const fedor = person("p-fedor", "Королёв", "Фёдор");
    const segments = linkifyEntities("королев федор рассказал", [fedor]);
    expect(linked(segments)).toEqual([
      ["королев федор", "p-fedor"],
      [" рассказал", undefined],
    ]);
  });

  it("never links short names or single-word names", () => {
    const short = person("p-short", "Ли", "Ян");
    const single = person("p-single", null, "Александр");
    for (const text of ["Ян Ли пришёл", "Александр пришёл"]) {
      const segments = linkifyEntities(text, [short, single]);
      expect(segments.every((segment) => segment.personId === undefined)).toBe(
        true,
      );
    }
  });

  it("leaves a name shared by two persons unlinked", () => {
    const first = person("p-1", "Иванов", "Иван");
    const second = person("p-2", "Иванов", "Иван");
    const segments = linkifyEntities("Иван Иванов", [first, second]);
    expect(segments).toEqual([{ text: "Иван Иванов" }]);
  });

  it("returns the source text unchanged when nobody is known or mentioned", () => {
    expect(linkifyEntities("Просто текст", [])).toEqual([
      { text: "Просто текст" },
    ]);
    expect(linkifyEntities("Просто текст", [ivan])).toEqual([
      { text: "Просто текст" },
    ]);
    expect(linkifyEntities("", [ivan])).toEqual([]);
  });

  it("builder index reuses the same dictionary for several fragments", () => {
    const index = createEntityIndex([ivan]);
    expect(index.linkify("Петров Иван")[0]?.personId).toBe("p-ivan");
    expect(index.linkify("Иван Петров")[0]?.personId).toBe("p-ivan");
    expect(index.linkify("Иван")[0]?.personId).toBeUndefined();
  });
});
