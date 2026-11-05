import { describe, expect, it } from "vitest";
import type { DateValue, TimelineEntry } from "../../api/types";
import { entryYear, filterByYears, yearBounds } from "./range";

function entry(
  id: string,
  date: DateValue,
): TimelineEntry {
  return {
    personName: "Person",
    event: {
      id,
      personId: "person-1",
      type: "RESIDENCE",
      date,
      place: "Ивановка",
      placeGeo: {
        lat: 57.4321,
        lon: 49.1234,
        precision: "SETTLEMENT",
        source: "PHOTON",
      },
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
    },
  };
}

const unknown: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function year(value: number): DateValue {
  return {
    start: `${value}-01-01`,
    end: `${value + 1}-01-01`,
    precision: "YEAR",
    qualifier: "EXACT",
    original: null,
  };
}

describe("entryYear", () => {
  it("uses the start and falls back to an end-only date", () => {
    expect(entryYear(entry("a", year(1890)))).toBe(1890);
    expect(
      entryYear(
        entry("b", {
          start: null,
          end: "1850-01-01",
          precision: "YEAR",
          qualifier: "BEFORE",
          original: null,
        }),
      ),
    ).toBe(1850);
  });

  it("never invents a year for an unknown date", () => {
    expect(entryYear(entry("a", unknown))).toBeNull();
  });
});

describe("yearBounds", () => {
  it("spans the earliest and latest placed event", () => {
    expect(
      yearBounds([entry("a", year(1950)), entry("b", year(1890)), entry("c", unknown)]),
    ).toEqual({ min: 1890, max: 1950 });
  });

  it("is null when nothing is dated", () => {
    expect(yearBounds([entry("a", unknown)])).toBeNull();
  });
});

describe("filterByYears", () => {
  it("keeps both inclusive boundaries and drops undated rows", () => {
    const rows = [
      entry("a", year(1890)),
      entry("b", year(1900)),
      entry("c", year(1910)),
      entry("d", unknown),
    ];
    expect(filterByYears(rows, 1890, 1910).map((row) => row.event.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(filterByYears(rows, 1900, 1900).map((row) => row.event.id)).toEqual([
      "b",
    ]);
    expect(filterByYears(rows, 1901, 1909)).toEqual([]);
  });

  it("keeps a period that overlaps the chosen years", () => {
    const period = entry("p", {
      start: "1980-01-01",
      end: "1991-01-01",
      precision: "YEAR",
      qualifier: "RANGE",
      original: null,
    });
    expect(filterByYears([period], 1986, 1986).map((row) => row.event.id)).toEqual([
      "p",
    ]);
    expect(filterByYears([period], 1991, 1991)).toEqual([]);
  });
});
