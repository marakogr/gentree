import { describe, expect, it } from "vitest";
import type {
  DateValue,
  EventEntity,
  EventType,
  Person,
  Versioned,
} from "../../api/types";
import {
  ANOMALY_CODES,
  anomalySummary,
  detectAnomalies,
  todayCivilDate,
  type AnomalyCode,
} from "./anomalies";

const TODAY = "2026-10-23";

function unknownDate(): DateValue {
  return {
    start: null,
    end: null,
    precision: "UNKNOWN",
    qualifier: "UNKNOWN",
    original: null,
  };
}

function day(iso: string): DateValue {
  return {
    start: iso,
    end: null,
    precision: "DAY",
    qualifier: "EXACT",
    original: null,
  };
}

function month(iso: string): DateValue {
  return {
    start: `${iso}-01`,
    end: null,
    precision: "MONTH",
    qualifier: "EXACT",
    original: null,
  };
}

function year(value: number): DateValue {
  return {
    start: `${String(value).padStart(4, "0")}-01-01`,
    end: `${String(value + 1).padStart(4, "0")}-01-01`,
    precision: "YEAR",
    qualifier: "EXACT",
    original: null,
  };
}

function person(
  id: string,
  dates: { birth?: DateValue; death?: DateValue } = {},
): Versioned<Person> {
  return {
    version: "v1",
    entity: {
      id,
      gender: "UNKNOWN",
      names: [],
      birth: dates.birth ?? unknownDate(),
      death: dates.death ?? unknownDate(),
      notes: null,
      externalIds: [],
    },
  };
}

function event(
  id: string,
  personId: string,
  type: EventType,
  date: DateValue,
): Versioned<EventEntity> {
  return {
    version: "v1",
    entity: {
      id,
      personId,
      type,
      date,
      place: null,
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
    },
  };
}

function codesOf(
  anomalies: ReadonlyMap<string, readonly AnomalyCode[]>,
  eventId: string,
): readonly AnomalyCode[] | undefined {
  return anomalies.get(eventId);
}

describe("detectAnomalies", () => {
  it("says nothing about a coherent life", () => {
    const anomalies = detectAnomalies(
      [
        event("b", "p1", "BIRTH", day("1900-04-12")),
        event("m", "p1", "MARRIAGE", day("1925-06-01")),
        event("d", "p1", "DEATH", day("1980-01-02")),
        event("burial", "p1", "BURIAL", day("1980-01-05")),
      ],
      [person("p1", { birth: day("1900-04-12"), death: day("1980-01-02") })],
      TODAY,
    );
    expect(anomalies.size).toBe(0);
  });

  it("flags every DEATH event when a person has more than one", () => {
    const anomalies = detectAnomalies(
      [
        event("d1", "p1", "DEATH", day("1980-01-02")),
        event("d2", "p1", "DEATH", day("1982-03-04")),
        event("m", "p1", "MARRIAGE", day("1950-01-01")),
      ],
      [person("p1")],
      TODAY,
    );
    expect(codesOf(anomalies, "d1")).toEqual(["DUPLICATE_DEATH"]);
    expect(codesOf(anomalies, "d2")).toEqual(["DUPLICATE_DEATH"]);
    expect(codesOf(anomalies, "m")).toBeUndefined();
  });

  it("flags every BIRTH event when a person has more than one", () => {
    const anomalies = detectAnomalies(
      [
        event("b1", "p1", "BIRTH", day("1900-01-01")),
        event("b2", "p1", "BIRTH", day("1901-01-01")),
      ],
      [person("p1")],
      TODAY,
    );
    expect(codesOf(anomalies, "b1")).toEqual(["DUPLICATE_BIRTH"]);
    expect(codesOf(anomalies, "b2")).toEqual(["DUPLICATE_BIRTH"]);
  });

  it("flags a birth after death on both rows", () => {
    const anomalies = detectAnomalies(
      [
        event("b", "p1", "BIRTH", day("2000-01-01")),
        event("d", "p1", "DEATH", day("1990-01-01")),
      ],
      [person("p1", { birth: day("2000-01-01"), death: day("1990-01-01") })],
      TODAY,
    );
    expect(codesOf(anomalies, "b")).toEqual([
      "BIRTH_AFTER_DEATH",
      "EVENT_AFTER_DEATH",
    ]);
    expect(codesOf(anomalies, "d")).toEqual([
      "BIRTH_AFTER_DEATH",
      "EVENT_BEFORE_BIRTH",
    ]);
  });

  it("flags events after death except DEATH and BURIAL", () => {
    const anomalies = detectAnomalies(
      [
        event("d", "p1", "DEATH", day("1990-05-01")),
        event("burial", "p1", "BURIAL", day("1990-05-05")),
        event("marriage", "p1", "MARRIAGE", day("1995-01-01")),
      ],
      [person("p1", { death: day("1990-05-01") })],
      TODAY,
    );
    expect(codesOf(anomalies, "marriage")).toEqual(["EVENT_AFTER_DEATH"]);
    expect(codesOf(anomalies, "d")).toBeUndefined();
    expect(codesOf(anomalies, "burial")).toBeUndefined();
  });

  it("flags events before birth except BIRTH", () => {
    const anomalies = detectAnomalies(
      [
        event("b", "p1", "BIRTH", day("1950-01-01")),
        event("residence", "p1", "RESIDENCE", day("1940-01-01")),
        event("education", "p1", "EDUCATION", day("1960-01-01")),
      ],
      [person("p1", { birth: day("1950-01-01") })],
      TODAY,
    );
    expect(codesOf(anomalies, "residence")).toEqual(["EVENT_BEFORE_BIRTH"]);
    expect(codesOf(anomalies, "b")).toBeUndefined();
    expect(codesOf(anomalies, "education")).toBeUndefined();
  });

  it("flags future dates at the event's own precision", () => {
    const anomalies = detectAnomalies(
      [
        event("next-day", "p1", "RESIDENCE", day("2026-10-24")),
        event("today", "p1", "RESIDENCE", day("2026-10-23")),
        event("this-year", "p1", "RESIDENCE", year(2026)),
        event("next-year", "p1", "RESIDENCE", year(2027)),
        event("this-month", "p1", "RESIDENCE", month("2026-10")),
        event("next-month", "p1", "RESIDENCE", month("2026-11")),
      ],
      [person("p1")],
      TODAY,
    );
    expect(codesOf(anomalies, "next-day")).toEqual(["FUTURE_DATE"]);
    expect(codesOf(anomalies, "today")).toBeUndefined();
    expect(codesOf(anomalies, "this-year")).toBeUndefined();
    expect(codesOf(anomalies, "next-year")).toEqual(["FUTURE_DATE"]);
    expect(codesOf(anomalies, "this-month")).toBeUndefined();
    expect(codesOf(anomalies, "next-month")).toEqual(["FUTURE_DATE"]);
  });

  it("compares at the coarser precision and avoids YEAR false positives", () => {
    const anomalies = detectAnomalies(
      [
        event("same-year", "p1", "RESIDENCE", year(1900)),
        event("same-year-month", "p1", "RESIDENCE", month("1900-11")),
        event("earlier-year", "p1", "RESIDENCE", year(1899)),
      ],
      [person("p1", { birth: year(1900), death: year(1970) })],
      TODAY,
    );
    expect(codesOf(anomalies, "same-year")).toBeUndefined();
    expect(codesOf(anomalies, "same-year-month")).toBeUndefined();
    expect(codesOf(anomalies, "earlier-year")).toEqual(["EVENT_BEFORE_BIRTH"]);
  });

  it("flags open-ended and ranged starts before birth", () => {
    const anomalies = detectAnomalies(
      [
        event("open-before", "p1", "RESIDENCE", {
          ...day("1940-01-01"),
          end: null,
          qualifier: "RANGE",
        }),
        event("open-containing", "p2", "RESIDENCE", {
          ...year(1950),
          end: null,
          qualifier: "RANGE",
        }),
        event("range-before", "p3", "RESIDENCE", {
          ...year(1948),
          end: "1961-01-01",
          qualifier: "RANGE",
        }),
        event("range-containing", "p4", "RESIDENCE", {
          ...year(1950),
          end: "1961-01-01",
          qualifier: "RANGE",
        }),
      ],
      [
        person("p1", { birth: year(1950) }),
        person("p2", { birth: month("1950-05") }),
        person("p3", { birth: year(1950) }),
        person("p4", { birth: month("1950-05") }),
      ],
      TODAY,
    );
    expect(codesOf(anomalies, "open-before")).toEqual(["EVENT_BEFORE_BIRTH"]);
    expect(codesOf(anomalies, "open-containing")).toBeUndefined();
    expect(codesOf(anomalies, "range-before")).toEqual(["EVENT_BEFORE_BIRTH"]);
    expect(codesOf(anomalies, "range-containing")).toBeUndefined();
  });

  it("never invents a comparison for UNKNOWN or empty dates", () => {
    const anomalies = detectAnomalies(
      [
        event("unknown", "p1", "RESIDENCE", unknownDate()),
        event("d1", "p1", "DEATH", unknownDate()),
        event("d2", "p1", "DEATH", unknownDate()),
      ],
      [person("p1", { birth: day("1950-01-01"), death: unknownDate() })],
      TODAY,
    );
    // Both deaths are structurally duplicated but no date rule fires.
    expect(codesOf(anomalies, "d1")).toEqual(["DUPLICATE_DEATH"]);
    expect(codesOf(anomalies, "d2")).toEqual(["DUPLICATE_DEATH"]);
    expect(codesOf(anomalies, "unknown")).toBeUndefined();
  });

  it("does not compare a date with itself through the person boundary", () => {
    // The only known date is the DEATH event; nothing is before/after it.
    const anomalies = detectAnomalies(
      [event("d", "p1", "DEATH", day("1990-01-01"))],
      [person("p1", { death: day("1990-01-01") })],
      TODAY,
    );
    expect(anomalies.size).toBe(0);
  });

  it("reports several codes on one row in the canonical order", () => {
    const anomalies = detectAnomalies(
      [
        event("d", "p1", "DEATH", day("2005-01-01")),
        event("b", "p1", "BIRTH", day("2000-01-01")),
        event("late", "p1", "RESIDENCE", day("2030-01-01")),
      ],
      [person("p1", { birth: day("2000-01-01"), death: day("2005-01-01") })],
      TODAY,
    );
    expect(codesOf(anomalies, "late")).toEqual([
      "EVENT_AFTER_DEATH",
      "FUTURE_DATE",
    ]);
  });

  it("keeps FUTURE_DATE for events of a person missing from the list", () => {
    const anomalies = detectAnomalies(
      [
        event("orphan", "ghost", "RESIDENCE", day("2030-01-01")),
        event("past", "ghost", "RESIDENCE", day("1990-01-01")),
      ],
      [],
      TODAY,
    );
    expect(codesOf(anomalies, "orphan")).toEqual(["FUTURE_DATE"]);
    expect(codesOf(anomalies, "past")).toBeUndefined();
  });

  it("does not leak anomalies between persons", () => {
    const anomalies = detectAnomalies(
      [
        event("a-birth", "a", "BIRTH", day("1900-01-01")),
        event("b-marriage", "b", "MARRIAGE", day("1905-01-01")),
      ],
      [
        person("a", { birth: day("1900-01-01"), death: day("1980-01-01") }),
        person("b", { birth: day("1900-01-01"), death: day("1990-01-01") }),
      ],
      TODAY,
    );
    expect(anomalies.size).toBe(0);
  });
});

describe("todayCivilDate", () => {
  it("formats the reference moment as a UTC civil date", () => {
    expect(todayCivilDate(new Date("2026-10-23T23:59:59Z"))).toBe("2026-10-23");
    expect(todayCivilDate(new Date("2026-10-24T00:00:00Z"))).toBe("2026-10-24");
  });
});

describe("anomalySummary", () => {
  it("counts every code and keeps zero entries", () => {
    const anomalies = detectAnomalies(
      [
        event("d1", "p1", "DEATH", day("2005-01-01")),
        event("d2", "p1", "DEATH", day("2006-01-01")),
        event("late", "p1", "RESIDENCE", day("2030-01-01")),
      ],
      [person("p1", { birth: day("2000-01-01"), death: day("2005-01-01") })],
      TODAY,
    );
    const summary = anomalySummary(anomalies);
    expect(Object.keys(summary).sort()).toEqual([...ANOMALY_CODES].sort());
    expect(summary.DUPLICATE_DEATH).toBe(2);
    expect(summary.EVENT_AFTER_DEATH).toBe(1);
    expect(summary.FUTURE_DATE).toBe(1);
    expect(summary.DUPLICATE_BIRTH).toBe(0);
    expect(summary.BIRTH_AFTER_DEATH).toBe(0);
  });

  it("returns all zeros for an empty map", () => {
    const summary = anomalySummary(new Map());
    expect(Object.values(summary)).toEqual(
      ANOMALY_CODES.map(() => 0),
    );
  });
});
