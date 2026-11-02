import { describe, expect, it } from "vitest";
import type { DateValue, EventType } from "../../api/types";
import type { EventTimelineRow } from "./eventTimeline";
import { occupationPositions } from "./occupations";

const UNKNOWN_DATE: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function row(
  id: string,
  position: string | undefined,
  type: EventType = "OCCUPATION",
): EventTimelineRow {
  return {
    kind: "event",
    id,
    version: `${id}-version`,
    event: {
      id,
      personId: "person-1",
      type,
      date: UNKNOWN_DATE,
      place: null,
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
      ...(position === undefined ? {} : { details: { position } }),
    },
    date: UNKNOWN_DATE,
    dateLabel: "",
    typeLabel: "",
    place: null,
    description: null,
    meta: [],
    isLast: false,
  } as EventTimelineRow;
}

describe("occupationPositions", () => {
  it("keeps only occupation events and skips blank positions", () => {
    const result = occupationPositions([
      row("e1", "Carpenter"),
      row("e2", "Higher education", "EDUCATION"),
      row("e3", "  "),
      row("e4", "Bookkeeper"),
    ]);

    expect(result).toEqual(["Carpenter", "Bookkeeper"]);
  });

  it("keeps the timeline order and drops a repeated role", () => {
    const result = occupationPositions([
      row("first", "Carpenter"),
      row("second", "Bookkeeper"),
      row("third", "Carpenter"),
    ]);

    expect(result).toEqual(["Carpenter", "Bookkeeper"]);
  });

  it("deduplicates case-insensitively, keeping the first spelling", () => {
    const result = occupationPositions([
      row("e1", "Carpenter"),
      row("e2", "CARPENTER"),
      row("e3", " carpenter "),
    ]);

    expect(result).toEqual(["Carpenter"]);
  });
});
