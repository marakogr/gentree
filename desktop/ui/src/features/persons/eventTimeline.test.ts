import { describe, expect, it } from "vitest";
import type {
  DateValue,
  EventEntity,
  EventType,
  Person,
  RelationshipEntity,
  Versioned,
} from "../../api/types";
import type { EventDetailEntry } from "../events/fields";
import {
  buildEventTimeline,
  childrenOf,
  hasBirthEvent,
  type EventTimelineOptions,
} from "./eventTimeline";

function date(
  value: string | null,
  precision: DateValue["precision"] = "DAY",
): DateValue {
  return {
    start: value,
    end: value,
    precision,
    qualifier: "EXACT",
    original: null,
  };
}

const unknownDate: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function event(
  id: string,
  overrides: Partial<EventEntity> = {},
): { entity: EventEntity; version: string } {
  return {
    version: `v-${id}`,
    entity: {
      id,
      personId: "person-1",
      type: "OTHER" as EventType,
      date: unknownDate,
      place: null,
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
      ...overrides,
    },
  };
}

function options(
  overrides: Partial<EventTimelineOptions> = {},
): EventTimelineOptions {
  return {
    formatDate: (value) => (value.start ? `date:${value.start}` : "unknown"),
    typeLabel: (item) => `type:${item.type}`,
    detailEntries: () => [],
    ...overrides,
  };
}

function person(
  id: string,
  birth: DateValue = unknownDate,
  overrides: Partial<Person> = {},
): Person {
  return {
    id,
    gender: "UNKNOWN",
    names: [],
    birth,
    death: unknownDate,
    notes: null,
    externalIds: [],
    ...overrides,
  };
}

function relationship(
  id: string,
  type: RelationshipEntity["type"],
  personId: string,
  relatedPersonId: string,
): Versioned<RelationshipEntity> {
  return {
    version: `v-${id}`,
    entity: { id, type, personId, relatedPersonId, notes: null },
  };
}

const childOptions = {
  childBirthLabel: "child-birth",
  personName: (item: Person) => `name:${item.id}`,
};

describe("buildEventTimeline", () => {
  it("returns no rows for no events", () => {
    expect(buildEventTimeline([], options())).toEqual([]);
  });

  it("orders oldest first, keeps equal dates stable and puts undated last", () => {
    const rows = buildEventTimeline(
      [
        event("late", { date: date("1990-01-01") }),
        event("undated"),
        event("early", { date: date("1900-01-01") }),
        event("tie", { date: date("1990-01-01") }),
      ],
      options(),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "early",
      "late",
      "tie",
      "undated",
    ]);
  });

  it("marks only the final row as last", () => {
    const rows = buildEventTimeline(
      [
        event("a", { date: date("1900-01-01") }),
        event("b", { date: date("1901-01-01") }),
      ],
      options(),
    );

    expect(rows.map((row) => row.isLast)).toEqual([false, true]);
  });

  it("marks a single row as last and keeps its entity version", () => {
    const [row] = buildEventTimeline([event("only")], options());

    expect(row.isLast).toBe(true);
    expect(row.kind).toBe("event");
    if (row.kind !== "event") throw new Error("expected an event row");
    expect(row.version).toBe("v-only");
    expect(row.event.id).toBe("only");
  });

  it("uses the injected labels and never invents an unknown date", () => {
    const formatDate = (value: DateValue) =>
      value.precision === "UNKNOWN" ? "unknown" : "formatted";
    const rows = buildEventTimeline(
      [
        event("unknown", { date: unknownDate, type: "RESIDENCE" }),
        event("year", {
          date: date("1910-01-01", "YEAR"),
          type: "OTHER",
          originalType: "Awards",
        }),
      ],
      options({
        formatDate,
        typeLabel: (item) =>
          item.type === "OTHER" ? (item.originalType ?? "other") : item.type,
      }),
    );

    expect(rows.map((row) => row.dateLabel)).toEqual(["formatted", "unknown"]);
    // Oldest first: the dated year event precedes the undated one.
    expect(rows.map((row) => row.typeLabel)).toEqual(["Awards", "RESIDENCE"]);
  });

  it("drops blank place and description instead of rendering a placeholder", () => {
    const [row] = buildEventTimeline(
      [event("blank", { place: "   ", description: "\n\t" })],
      options(),
    );

    expect(row.place).toBeNull();
    expect(row.description).toBeNull();
  });

  it("trims place and description but keeps their text", () => {
    const [row] = buildEventTimeline(
      [event("filled", { place: "  Kazan ", description: "  Note  " })],
      options(),
    );

    expect(row.place).toBe("Kazan");
    expect(row.description).toBe("Note");
  });

  it("composes metadata from the place and the detail entries, in order", () => {
    const details: EventDetailEntry[] = [
      { key: "age", label: "Age", value: "30" },
      { key: "cause", label: "Cause", value: "Unknown" },
    ];
    const [row] = buildEventTimeline(
      [event("filled", { place: "Kazan" })],
      options({ detailEntries: () => details }),
    );

    expect(row.meta).toEqual([
      { key: "place", text: "Kazan" },
      { key: "detail-age", text: "Age: 30" },
      { key: "detail-cause", text: "Cause: Unknown" },
    ]);
  });

  it("keeps only the detail entries when the place is blank", () => {
    const [row] = buildEventTimeline(
      [event("no-place", { place: "  " })],
      options({
        detailEntries: () => [{ key: "age", label: "Age", value: "30" }],
      }),
    );

    expect(row.meta).toEqual([{ key: "detail-age", text: "Age: 30" }]);
  });

  it("has no metadata when the event has neither place nor details", () => {
    const [row] = buildEventTimeline([event("bare")], options());

    expect(row.meta).toEqual([]);
  });
});

describe("childrenOf", () => {
  it("collects children from both parent-child edge types in edge order", () => {
    const persons = [person("parent"), person("s1"), person("s2"), person("s3")];
    const children = childrenOf(
      "parent",
      [
        relationship("r1", "PARENT_CHILD", "parent", "s1"),
        relationship("r2", "ADOPTIVE_PARENT_CHILD", "parent", "s2"),
        relationship("r3", "PARENT_CHILD", "parent", "s3"),
      ],
      persons,
    );

    expect(children.map((child) => child.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("ignores the other endpoint of the edge and non-parent relations", () => {
    const persons = [person("parent"), person("other")];
    const children = childrenOf(
      "parent",
      [
        // Person is the child here, not the parent.
        relationship("r1", "PARENT_CHILD", "other", "parent"),
        relationship("r2", "SPOUSE", "parent", "other"),
        relationship("r3", "PARTNER", "parent", "other"),
      ],
      persons,
    );

    expect(children).toEqual([]);
  });

  it("keeps one row per child and skips an unknown person", () => {
    const persons = [person("parent"), person("child")];
    const children = childrenOf(
      "parent",
      [
        relationship("r1", "PARENT_CHILD", "parent", "child"),
        relationship("r2", "ADOPTIVE_PARENT_CHILD", "parent", "child"),
        relationship("r3", "PARENT_CHILD", "parent", "missing"),
        relationship("r4", "PARENT_CHILD", "parent", "parent"),
      ],
      persons,
    );

    expect(children.map((child) => child.id)).toEqual(["child"]);
  });
});

describe("hasBirthEvent", () => {
  it("matches the owner and a participant, and nothing else", () => {
    const events = [
      event("owned", { type: "BIRTH", personId: "child" }),
      event("shared", {
        type: "BIRTH",
        personId: "someone",
        participantIds: ["child"],
      }),
      event("other-type", { type: "RESIDENCE", personId: "child" }),
    ];

    expect(hasBirthEvent([events[0]], "child")).toBe(true);
    expect(hasBirthEvent([events[1]], "child")).toBe(true);
    expect(hasBirthEvent([events[2]], "child")).toBe(false);
    expect(hasBirthEvent([events[0]], "someone-else")).toBe(false);
  });
});

describe("buildEventTimeline with children", () => {
  it("adds a derived birth row with the child's date and name", () => {
    const child = person("child", date("1905-02-03"));
    const [row] = buildEventTimeline(
      [],
      options({ children: [child], ...childOptions }),
    );

    expect(row).toMatchObject({
      kind: "childBirth",
      id: "child-birth:child",
      personId: "child",
      childName: "name:child",
      typeLabel: "child-birth",
      dateLabel: "date:1905-02-03",
      place: null,
      description: null,
      meta: [],
      isLast: true,
    });
  });

  it("interleaves derived rows with events, oldest first, undated last", () => {
    const rows = buildEventTimeline(
      [
        event("event-late", { date: date("1980-01-01") }),
        event("event-undated"),
      ],
      options({
        children: [
          person("child-late", date("1985-05-05")),
          person("child-early", date("1950-05-05")),
          person("child-undated"),
        ],
        ...childOptions,
      }),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "child-birth:child-early",
      "event-late",
      "child-birth:child-late",
      "event-undated",
      "child-birth:child-undated",
    ]);
    expect(rows.map((row) => row.isLast)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("keeps event order among equal dates", () => {
    const rows = buildEventTimeline(
      [
        event("first", { date: date("1900-01-01") }),
        event("second", { date: date("1900-01-01") }),
      ],
      options({
        children: [person("child", date("1900-01-01"))],
        ...childOptions,
      }),
    );

    expect(rows.map((row) => row.id)).toEqual(["first", "second", "child-birth:child"]);
  });

  it("skips a child whose birth is already an event they own or attend", () => {
    const owned = buildEventTimeline(
      [
        event("birth", {
          type: "BIRTH",
          personId: "child",
          date: date("1901-01-01"),
        }),
      ],
      options({ children: [person("child", date("1901-01-01"))], ...childOptions }),
    );
    const attended = buildEventTimeline(
      [
        event("birth", {
          type: "BIRTH",
          personId: "other",
          participantIds: ["child"],
          date: date("1901-01-01"),
        }),
      ],
      options({ children: [person("child", date("1901-01-01"))], ...childOptions }),
    );

    expect(owned.map((row) => row.id)).toEqual(["birth"]);
    expect(attended.map((row) => row.id)).toEqual(["birth"]);
  });

  it("keeps the events timeline unchanged without children", () => {
    const rows = buildEventTimeline(
      [event("a", { date: date("1900-01-01") })],
      options({ children: [] }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "event", id: "a", isLast: true });
  });
});
