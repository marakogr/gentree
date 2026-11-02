import { describe, expect, it } from "vitest";
import type { DateValue, TimelineEntry } from "../../api/types";
import {
  civilToTimestamp,
  inclusiveCivilBoundary,
  toApiDate,
  toTimelineEvent,
} from "./adapter";
import { toTimelineDate } from "./dates";

function dateValue(overrides: Partial<DateValue> = {}): DateValue {
  return {
    start: "1950-01-01",
    end: "1951-01-01",
    precision: "YEAR",
    qualifier: "EXACT",
    original: null,
    ...overrides,
  };
}

describe("civilToTimestamp", () => {
  it("turns a civil date into a UTC midnight timestamp", () => {
    expect(civilToTimestamp("1950-01-01")).toBe("1950-01-01T00:00:00.000Z");
    expect(civilToTimestamp(null)).toBeNull();
    expect(civilToTimestamp("1950-01-01T12:00:00.000Z")).toBe(
      "1950-01-01T12:00:00.000Z",
    );
  });
});

describe("toApiDate", () => {
  it("drops the exclusive end of an exact date", () => {
    const value = toApiDate(dateValue());
    expect(value.start).toBe("1950-01-01T00:00:00.000Z");
    expect(value.end).toBeNull();
    expect(value.precision).toBe("YEAR");
    expect(value.qualifier).toBe("EXACT");
  });

  it("keeps the only bound of a BEFORE date", () => {
    const value = toApiDate(
      dateValue({ start: null, end: "1900-01-01", qualifier: "BEFORE" }),
    );
    expect(value.start).toBeNull();
    expect(value.end).toBe("1900-01-01T00:00:00.000Z");
  });

  it("turns a range end back into its inclusive boundary", () => {
    const years = toApiDate(
      dateValue({
        start: "1950-01-01",
        end: "1956-01-01",
        qualifier: "RANGE",
      }),
    );
    expect(years.end).toBe("1955-01-01T00:00:00.000Z");

    const months = toApiDate(
      dateValue({
        start: "1950-01-01",
        end: "1950-03-01",
        precision: "MONTH",
        qualifier: "RANGE",
      }),
    );
    expect(months.end).toBe("1950-02-01T00:00:00.000Z");

    const days = toApiDate(
      dateValue({
        start: "1950-05-01",
        end: "1950-05-03",
        precision: "DAY",
        qualifier: "RANGE",
      }),
    );
    expect(days.end).toBe("1950-05-02T00:00:00.000Z");
  });
});

describe("inclusiveCivilBoundary", () => {
  it("never produces a year below one", () => {
    expect(inclusiveCivilBoundary("0001-01-01", "YEAR")).toBe("0001-01-01");
  });
});

describe("toTimelineEvent", () => {
  it("builds the line event from a desktop row", () => {
    const entry: TimelineEntry = {
      personName: "Ivan Petrov",
      event: {
        id: "e1",
        personId: "p1",
        type: "BIRTH",
        date: dateValue({ start: "1950-06-01", end: "1950-06-02", precision: "DAY" }),
        place: "Kazan",
        description: "note",
        sourceIds: ["s1"],
        originalType: "BIRT",
        participantIds: [],
      },
    };
    const event = toTimelineEvent(entry);
    expect(event.id).toBe("e1");
    expect(event.type).toBe("BIRT");
    expect(event.place).toBe("Kazan");
    expect(event.description).toBe("note");
    expect(event.participants).toEqual([
      {
        personId: "p1",
        firstName: "Ivan Petrov",
        lastName: null,
        role: "SUBJECT",
      },
    ]);
    expect(event.sourceIds).toEqual(["s1"]);
    expect(event.date?.start).toBe("1950-06-01T00:00:00.000Z");
  });

  it("falls back to the typed event type when originalType is absent", () => {
    const entry: TimelineEntry = {
      personName: "",
      event: {
        id: "e2",
        personId: "p2",
        type: "OTHER",
        date: dateValue({ start: null, end: null, precision: "UNKNOWN", qualifier: "UNKNOWN" }),
        place: null,
        description: null,
        sourceIds: [],
        originalType: null,
        participantIds: [],
      },
    };
    const event = toTimelineEvent(entry);
    expect(event.type).toBe("OTHER");
    expect(event.participants[0]?.firstName).toBeNull();
  });
});

describe("toTimelineDate", () => {
  it("accepts both civil dates and timestamps", () => {
    expect(toTimelineDate("1950-01-01")?.getFullYear()).toBe(1950);
    expect(toTimelineDate("1950-01-01T00:00:00.000Z")?.getDate()).toBe(1);
    expect(toTimelineDate("")).toBeNull();
    expect(toTimelineDate(null)).toBeNull();
  });
});
