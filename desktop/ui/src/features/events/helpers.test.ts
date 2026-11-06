import { describe, expect, it } from "vitest";
import type { DateValue, EventEntity, EventType, PlaceGeo, Versioned } from "../../api/types";
import {
  buildEventInput,
  clearEventFilterValues,
  clearEventPersonFilter,
  countActiveEventFilters,
  dateOverlaps,
  draftFromEvent,
  emptyEventDraft,
  eventDateLabel,
  eventMatchesFilters,
  eventOwnerId,
  eventPersonIds,
  eventYear,
  eventYearBounds,
  eventYearOverlaps,
  filterEventRows,
  isEventDraftDirty,
  isEventPersonFilterStale,
  isYearRangeInvalid,
  matchesEventQuery,
  normalizeEventText,
  paginateEventRows,
  readEventFilters,
  resolveEventColumns,
  sanitizeEventDetails,
  shouldShowPlaceColumn,
  sortEventRows,
  sortEventsByDate,
  withFilterValue,
  type EventListFilters,
  type EventRowContext,
} from "./helpers";

const unknownDate: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

type EventOptions = {
  type?: EventType;
  place?: string | null;
  placeGeo?: PlaceGeo | null;
  description?: string | null;
  date?: DateValue | null;
  participantIds?: string[];
  details?: Record<string, string>;
};

function event(
  id: string,
  personId: string,
  year: number | null,
  options: EventOptions = {},
): EventEntity {
  return {
    id,
    personId,
    type: options.type ?? "BIRTH",
    date:
      options.date === undefined
        ? year
          ? {
              start: `${year}-01-01`,
              end: `${year + 1}-01-01`,
              precision: "YEAR",
              qualifier: "EXACT",
              original: null,
            }
          : unknownDate
        : options.date ?? unknownDate,
    place: options.place ?? null,
    ...(options.placeGeo ? { placeGeo: options.placeGeo } : {}),
    description: options.description ?? null,
    sourceIds: [],
    originalType: null,
    participantIds: options.participantIds ?? [],
    ...(options.details ? { details: options.details } : {}),
  };
}

function versioned(entity: EventEntity): Versioned<EventEntity> {
  return { entity, version: `v-${entity.id}` };
}

const names: Record<string, string> = {
  a: "Ivanov Ivan",
  b: "Petrova Anna",
  c: "Sidorov Petr",
};

function contextOf(entity: EventEntity): EventRowContext {
  return {
    personName: names[entity.personId] ?? "",
    typeLabel: `label:${entity.type}`,
  };
}

const noFilters: EventListFilters = {
  personId: "",
  personScope: "person",
  types: [],
  fromYear: "",
  toYear: "",
};

describe("eventMatchesFilters (API range contract)", () => {
  const rows = [
    event("1", "a", 1950, { type: "BIRTH" }),
    event("2", "a", 1970, { type: "MARRIAGE" }),
    event("3", "b", 1990, { type: "BIRTH" }),
    event("4", "b", 1990, { type: "OTHER" }),
  ];

  it("filters by person and type", () => {
    expect(
      rows
        .filter((row) =>
          eventMatchesFilters(row, {
            personId: "a",
            eventType: "",
            from: "",
            to: "",
          }),
        )
        .map((row) => row.id),
    ).toEqual(["1", "2"]);

    expect(
      rows
        .filter((row) =>
          eventMatchesFilters(row, {
            personId: "",
            eventType: "BIRTH",
            from: "",
            to: "",
          }),
        )
        .map((row) => row.id),
    ).toEqual(["1", "3"]);
  });

  it("keeps events that intersect the half-open range", () => {
    const filters = {
      personId: "",
      eventType: "" as const,
      from: "1960-01-01",
      to: "1990-01-01",
    };
    expect(
      rows.filter((row) => eventMatchesFilters(row, filters)).map((row) => row.id),
    ).toEqual(["2"]);
  });

  it("excludes unknown dates from a bounded range", () => {
    expect(dateOverlaps(unknownDate, "1900-01-01", null)).toBe(false);
    expect(
      eventMatchesFilters(event("5", "a", null), {
        personId: "",
        eventType: "",
        from: "1900-01-01",
        to: "",
      }),
    ).toBe(false);
  });
});

describe("sortEventsByDate", () => {
  it("puts the oldest dated events first and undated last", () => {
    const rows = [
      versioned(event("1", "a", 1970)),
      versioned(event("2", "a", null)),
      versioned(event("3", "a", 1950)),
      versioned(event("4", "a", 1990)),
    ];
    expect(sortEventsByDate(rows, "oldest").map((item) => item.entity.id)).toEqual([
      "3",
      "1",
      "4",
      "2",
    ]);
  });

  it("falls back to the end bound when the start is missing", () => {
    const openStart: Versioned<EventEntity> = versioned(
      event("5", "a", null, {
        date: {
          start: null,
          end: "1980-01-01",
          precision: "YEAR",
          qualifier: "BEFORE",
          original: null,
        },
      }),
    );
    const rows = [versioned(event("6", "a", 1990)), openStart];
    expect(sortEventsByDate(rows, "oldest").map((item) => item.entity.id)).toEqual([
      "5",
      "6",
    ]);
  });
});

describe("emptyEventDraft", () => {
  it("defaults a new event to day precision with an exact qualifier", () => {
    const draft = emptyEventDraft();
    expect(draft.precision).toBe("DAY");
    expect(draft.qualifier).toBe("EXACT");
    expect(draft.details).toEqual({});
  });

  it("keeps the stored precision when an existing event is opened", () => {
    const base = event("e-1", "person-1", 1950);
    expect(draftFromEvent(base).precision).toBe("YEAR");
  });

  it("round-trips birth parents through the draft and the save payload", () => {
    const base = event("e-1", "person-1", 2000, {
      type: "BIRTH",
      participantIds: ["parent-1", "parent-2"],
    });
    const draft = draftFromEvent(base);
    expect(draft.parentIds).toEqual(["parent-1", "parent-2"]);
    expect(isEventDraftDirty(draft, base)).toBe(false);

    draft.parentIds = ["parent-2", ""];
    expect(isEventDraftDirty(draft, base)).toBe(true);
    const result = buildEventInput({ ...draft, parentIds: ["parent-2"] }, base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.participantIds).toEqual(["parent-2"]);
    }
  });

  it("never lets the child or a non-birth event become a parent", () => {
    const base = event("e-1", "person-1", 2000, {
      type: "BIRTH",
      participantIds: ["parent-1"],
    });
    const result = buildEventInput(
      { ...draftFromEvent(base), parentIds: ["person-1", "parent-2"] },
      base,
    );
    expect(result.ok && result.event.participantIds).toEqual(["parent-2"]);

    const occupation = emptyEventDraft("person-1", "OCCUPATION");
    const built = buildEventInput({ ...occupation, parentIds: ["parent-1"] });
    expect(built.ok && built.event.participantIds).toEqual([]);
  });

  it("copies the confirmed place point into the draft and back", () => {
    const point: PlaceGeo = {
      lat: 57.4321,
      lon: 49.1234,
      precision: "SETTLEMENT",
      source: "PHOTON",
      providerRef: "N123",
      label: "Ivanovka, Kirov Oblast",
    };
    const base = event("e-1", "person-1", 1950, {
      place: "Ivanovka",
      placeGeo: point,
    });
    const draft = draftFromEvent(base);
    expect(draft.placeGeo).toEqual(point);

    const result = buildEventInput(draft, base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.placeGeo).toEqual(point);
  });

  it("omits a point when the draft has none", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      place: "Ivanovka",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.placeGeo).toBeUndefined();
  });
});

describe("buildEventInput", () => {
  it("saves a blank date as an unknown date", () => {
    const result = buildEventInput(emptyEventDraft("person-1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.date).toEqual(unknownDate);
  });

  it("parses the date and trims text fields", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      date: "1950-05-01",
      precision: "DAY",
      place: "  Moscow  ",
      description: " ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.id).toBeUndefined();
    expect(result.event.place).toBe("Moscow");
    expect(result.event.description).toBeNull();
    expect(result.event.date.end).toBe("1950-05-02");
    expect(result.event.date.qualifier).toBe("EXACT");
  });

  it("passes the approximate qualifier through", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      date: "1950",
      precision: "YEAR",
      qualifier: "APPROXIMATE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.date).toEqual({
      start: "1950-01-01",
      end: "1951-01-01",
      precision: "YEAR",
      qualifier: "APPROXIMATE",
      original: null,
    });
  });

  it("keeps the original text of an unknown date", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      date: "  about spring  ",
      precision: "UNKNOWN",
      qualifier: "APPROXIMATE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.date.precision).toBe("UNKNOWN");
    expect(result.event.date.qualifier).toBe("UNKNOWN");
    expect(result.event.date.original).toBe("about spring");
    expect(result.event.date.start).toBeNull();
  });

  it("requires a person and keeps the id when editing", () => {
    const base = event("e-1", "person-1", 1950);
    const draft = draftFromEvent(base);
    expect(buildEventInput({ ...draft, personId: "" }).ok).toBe(false);
    const result = buildEventInput({ ...draft, precision: "YEAR" }, base);
    expect(result.ok && result.event.id).toBe("e-1");
  });

  it("reports a malformed date", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      date: "1950-13-01",
      precision: "DAY",
    });
    expect(result).toEqual({ ok: false, fields: { date: true } });
  });

  it("round-trips the qualifier from an existing event", () => {
    const base = event("e-2", "person-1", 1950, {
      date: {
        start: "1950-01-01",
        end: "1951-01-01",
        precision: "YEAR",
        qualifier: "APPROXIMATE",
        original: null,
      },
    });
    expect(draftFromEvent(base).qualifier).toBe("APPROXIMATE");
  });

  it("trims details and drops blank keys and values", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      eventType: "EDUCATION",
      details: {
        institution: "  State University  ",
        " faculty ": " History ",
        specialty: "   ",
        "  ": "orphan",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.details).toEqual({
      institution: "State University",
      faculty: "History",
    });
  });

  it("omits details when nothing is left, so an update clears them", () => {
    const base = event("e-3", "person-1", 1950, {
      type: "BIRTH",
      details: { certificate: "A-1" },
    });
    const result = buildEventInput(
      {
        ...draftFromEvent(base),
        details: { certificate: "   " },
      },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("details" in result.event).toBe(false);
  });

  it("round-trips every kept detail of an existing event", () => {
    const base = event("e-4", "person-1", 1950, {
      type: "BIRTH",
      details: { certificate: "A-1", hospital: "City" },
    });
    const draft = draftFromEvent(base);
    const result = buildEventInput(
      { ...draft, details: { ...draft.details, hospital: "Regional" } },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.details).toEqual({
      certificate: "A-1",
      hospital: "Regional",
    });
  });
});

describe("period dates in the draft", () => {
  it("starts on a single date with an empty period end", () => {
    const draft = emptyEventDraft();
    expect(draft.dateMode).toBe("single");
    expect(draft.dateEnd).toBe("");
  });

  it("opens a stored RANGE date as a period", () => {
    const base = event("e-5", "person-1", null, {
      type: "OCCUPATION",
      date: {
        start: "1980-01-01",
        end: "1986-01-01",
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      },
    });
    const draft = draftFromEvent(base);
    expect(draft.dateMode).toBe("range");
    expect(draft.date).toBe("1980");
    expect(draft.dateEnd).toBe("1985");
  });

  it("does not offer a period for a type that has none", () => {
    const base = event("e-6", "person-1", null, {
      type: "BIRTH",
      date: {
        start: "1980-01-01",
        end: "1986-01-01",
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      },
    });
    expect(draftFromEvent(base).dateMode).toBe("single");
  });

  it("reopens an open-ended residence as an ongoing period", () => {
    const base: EventEntity = {
      ...event("event-1", "person-1", null, { type: "RESIDENCE" }),
      date: {
        start: "1980-01-01",
        end: null,
        precision: "YEAR",
        qualifier: "RANGE",
        original: null,
      },
    };
    const draft = draftFromEvent(base);
    expect(draft.dateMode).toBe("range");
    expect(draft.dateOngoing).toBe(true);
    expect(draft.dateEnd).toBe("");
  });

  it("builds one half-open RANGE value and keeps the period qualifier", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1", "OCCUPATION"),
      dateMode: "range",
      date: "1980",
      dateEnd: "1985",
      precision: "YEAR",
      qualifier: "RANGE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.date).toEqual({
      start: "1980-01-01",
      end: "1986-01-01",
      precision: "YEAR",
      qualifier: "RANGE",
      original: null,
    });
  });

  it("builds an open-ended residence range without inventing an end", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1", "RESIDENCE"),
      dateMode: "range",
      date: "1980",
      dateEnd: "",
      dateOngoing: true,
      precision: "YEAR",
      qualifier: "RANGE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.date).toEqual({
      start: "1980-01-01",
      end: null,
      precision: "YEAR",
      qualifier: "RANGE",
      original: null,
    });
  });

  it("reports a half-filled period as a date error", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1", "EDUCATION"),
      dateMode: "range",
      date: "1980",
      dateEnd: "",
      precision: "YEAR",
      qualifier: "RANGE",
    });
    expect(result).toEqual({ ok: false, fields: { date: true } });
  });

  it("saves two blank period bounds as an unknown date", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1", "RESIDENCE"),
      dateMode: "range",
      date: "",
      dateEnd: "",
      precision: "YEAR",
      qualifier: "RANGE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.date).toEqual(unknownDate);
  });
});

describe("paired participants", () => {
  it("requires two participants for a new marriage", () => {
    expect(
      buildEventInput({ ...emptyEventDraft("person-1"), eventType: "MARRIAGE" }),
    ).toEqual({
      ok: false,
      fields: { participantIds: true },
    });
  });

  it("stores the second participant for a new marriage", () => {
    const result = buildEventInput({
      ...emptyEventDraft("person-1"),
      eventType: "MARRIAGE",
      spouseId: "person-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.participantIds).toEqual(["person-2"]);
  });

  it("requires two participants for a new divorce", () => {
    expect(
      buildEventInput({ ...emptyEventDraft("person-1"), eventType: "DIVORCE" }),
    ).toEqual({
      ok: false,
      fields: { participantIds: true },
    });
  });

  it("keeps a legacy one-participant divorce saveable", () => {
    const base = event("e-7", "person-1", 1980, {
      type: "DIVORCE",
      participantIds: [],
    });
    const result = buildEventInput(draftFromEvent(base), base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.participantIds).toEqual([]);
  });

  it("keeps the stored second participant of a non-paired event", () => {
    const base = event("e-8", "person-1", 1980, {
      type: "BURIAL",
      participantIds: ["person-2"],
    });
    const result = buildEventInput(draftFromEvent(base), base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.participantIds).toEqual(["person-2"]);
  });
});

describe("isEventDraftDirty", () => {
  it("is clean right after opening a stored event", () => {
    const base = event("e-9", "person-1", 1950, {
      details: { hospital: "City" },
    });
    expect(isEventDraftDirty(draftFromEvent(base), base)).toBe(false);
  });

  it("notices a changed detail, date or participant", () => {
    const base = event("e-10", "person-1", 1950, {
      details: { hospital: "City" },
    });
    const draft = draftFromEvent(base);
    expect(
      isEventDraftDirty({ ...draft, details: { hospital: "Regional" } }, base),
    ).toBe(true);
    expect(isEventDraftDirty({ ...draft, date: "1951" }, base)).toBe(true);
    expect(isEventDraftDirty({ ...draft, spouseId: "person-2" }, base)).toBe(
      true,
    );
  });
});

describe("sanitizeEventDetails", () => {
  it("trims keys and values without renaming keys", () => {
    expect(
      sanitizeEventDetails({
        " institution ": "  State University ",
        Faculty: " History ",
        blank: "   ",
        "  ": "lost",
      }),
    ).toEqual({ institution: "State University", Faculty: "History" });
  });

  it("returns an empty map for empty input", () => {
    expect(sanitizeEventDetails({})).toEqual({});
  });
});

describe("eventDateLabel", () => {
  const format = (value: DateValue): string =>
    value.start ?? value.original ?? "unknown";

  it("uses the formatter for dated and free-text values", () => {
    const dated = event("1", "a", 1950).date;
    expect(eventDateLabel(dated, format)).toBe("1950-01-01");
    expect(
      eventDateLabel(
        { ...unknownDate, original: "about 1850" },
        format,
      ),
    ).toBe("about 1850");
  });

  it("renders the em dash for a truly blank date", () => {
    expect(eventDateLabel(unknownDate, format)).toBe("\u2014");
  });
});

describe("eventYear", () => {  it("reads the year for every precision and falls back to the end bound", () => {
    const day = event("d", "a", null, {
      date: {
        start: "1935-04-12",
        end: "1935-04-13",
        precision: "DAY",
        qualifier: "EXACT",
        original: null,
      },
    });
    expect(eventYear(day)).toBe(1935);
    expect(eventYear(event("y", "a", 1900))).toBe(1900);
    const openStart = event("o", "a", null, {
      date: {
        start: null,
        end: "1880-01-01",
        precision: "YEAR",
        qualifier: "BEFORE",
        original: null,
      },
    });
    expect(eventYear(openStart)).toBe(1880);
    expect(eventYear(event("u", "a", null))).toBeNull();
  });
});

describe("filterEventRows", () => {
  const rows = [
    versioned(
      event("1", "a", 1950, {
        type: "BIRTH",
        place: "Moscow",
        description: "born at home",
      }),
    ),
    versioned(
      event("2", "b", 1970, { type: "MARRIAGE", place: "Kazan" }),
    ),
    versioned(event("3", "c", 1990, { type: "DEATH", place: "  " })),
    versioned(event("4", "a", null, { type: "OTHER" })),
  ];

  it("searches place, description, person name and type label", () => {
    expect(
      filterEventRows(rows, "kazan", noFilters, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["2"]);
    expect(
      filterEventRows(rows, "home", noFilters, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1"]);
    expect(
      filterEventRows(rows, "petrova", noFilters, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["2"]);
    expect(
      filterEventRows(rows, "label:DEATH", noFilters, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["3"]);
    expect(
      filterEventRows(rows, "birth", noFilters, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1"]);
  });

  it("folds the Cyrillic yo letter in both query and data", () => {
    const cyrillic = versioned(
      event("5", "c", 1980, { place: "\u041f\u0451\u0442\u0440" }),
    );
    expect(
      filterEventRows([cyrillic], "\u043f\u0435\u0442\u0440", noFilters, contextOf)
        .map((item) => item.entity.id),
    ).toEqual(["5"]);
    expect(normalizeEventText("\u041b\u0401\u041d")).toBe(
      "\u043b\u0435\u043d",
    );
  });

  it("searches the stored detail values", () => {
    const row = versioned(
      event("6", "a", 1950, {
        type: "EDUCATION",
        place: "Kazan",
        details: {
          institution: "State University",
          specialty: "History",
        },
      }),
    );
    const context = contextOf(row.entity);
    expect(matchesEventQuery(row.entity, context, "university")).toBe(true);
    expect(matchesEventQuery(row.entity, context, "history")).toBe(true);
    expect(matchesEventQuery(row.entity, context, "chemistry")).toBe(false);
    expect(matchesEventQuery(row.entity, context, "  ")).toBe(true);
  });

  it("filters by person, several types and year bounds", () => {
    expect(
      filterEventRows(
        rows,
        "",
        { ...noFilters, personId: "a" },
        contextOf,
      ).map((item) => item.entity.id),
    ).toEqual(["1", "4"]);

    expect(
      filterEventRows(
        rows,
        "",
        { ...noFilters, types: ["BIRTH", "OTHER"] },
        contextOf,
      ).map((item) => item.entity.id),
    ).toEqual(["1", "4"]);

    expect(
      filterEventRows(
        rows,
        "",
        { ...noFilters, fromYear: "1960", toYear: "1990" },
        contextOf,
      ).map((item) => item.entity.id),
    ).toEqual(["2", "3"]);
  });

  it("filters by a resolved person set", () => {
    const both = new Set(["a", "b"]);
    expect(
      filterEventRows(rows, "", noFilters, contextOf, both).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1", "2", "4"]);
    expect(
      filterEventRows(rows, "", noFilters, contextOf, new Set(["b"])).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["2"]);
    expect(
      filterEventRows(rows, "", noFilters, contextOf, new Set(["c"])).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["3"]);
    expect(
      filterEventRows(rows, "", noFilters, contextOf, new Set(["z"])),
    ).toHaveLength(0);
  });

  it("keeps undated rows only while the year range is open", () => {
    expect(filterEventRows(rows, "", noFilters, contextOf)).toHaveLength(4);
    expect(
      filterEventRows(rows, "", { ...noFilters, toYear: "2000" }, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1", "2", "3"]);
  });

  it("supports year-only bounds for YEAR-precision rows", () => {
    const yearRow = versioned(event("7", "a", 1950));
    expect(
      filterEventRows([yearRow], "", { ...noFilters, fromYear: "1950", toYear: "1950" }, contextOf),
    ).toHaveLength(1);
    expect(
      filterEventRows([yearRow], "", { ...noFilters, fromYear: "1951" }, contextOf),
    ).toHaveLength(0);
  });

  it("is case-insensitive and ignores a blank query", () => {
    expect(
      filterEventRows(rows, "  MOSCOW ", noFilters, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1"]);
    expect(matchesEventQuery(rows[0].entity, contextOf(rows[0].entity), "")).toBe(
      true,
    );
  });
});

describe("isYearRangeInvalid", () => {
  it("flags a lower bound after the upper one", () => {
    expect(isYearRangeInvalid("1990", "1950")).toBe(true);
    expect(isYearRangeInvalid("1950", "1990")).toBe(false);
    expect(isYearRangeInvalid("1950", "")).toBe(false);
    expect(isYearRangeInvalid("", "")).toBe(false);
  });
});

describe("year filter over event periods (issue #83)", () => {
  const day = (start: string, end: string | null): DateValue => ({
    start,
    end,
    precision: "DAY",
    qualifier: "EXACT",
    original: null,
  });
  const point = versioned(
    event("point", "a", null, {
      type: "EDUCATION",
      date: day("1980-09-01", "1980-09-02"),
    }),
  );
  const period = versioned(
    event("period", "a", null, {
      type: "EDUCATION",
      date: day("1980-01-01", "1991-01-01"),
    }),
  );
  const openEnd = event("open", "a", null, {
    type: "EDUCATION",
    date: day("1970-05-01", null),
  });
  const undated = versioned(event("undated", "a", null));
  const byYear = (fromYear: string, toYear: string) =>
    filterEventRows(
      [point, period, undated],
      "",
      { ...noFilters, fromYear, toYear },
      contextOf,
    ).map((item) => item.entity.id);

  it("shows a dated event from its start year", () => {
    expect(byYear("1980", "")).toEqual(["point", "period"]);
  });

  it("shows a period from a year inside it", () => {
    expect(byYear("1986", "")).toEqual(["period"]);
  });

  it("excludes an event that starts after the upper year", () => {
    expect(byYear("", "1979")).toEqual([]);
  });

  it("excludes a period that ends at the from-year boundary", () => {
    const ended = versioned(
      event("ended", "a", null, {
        type: "EDUCATION",
        date: day("1980-01-01", "1986-01-01"),
      }),
    );
    expect(
      filterEventRows(
        [ended],
        "",
        { ...noFilters, fromYear: "1986" },
        contextOf,
      ),
    ).toHaveLength(0);
  });

  it("treats an open end as running up to now", () => {
    const today = new Date(2026, 10, 5);
    expect(eventYearOverlaps(openEnd, "2020", "", today)).toBe(true);
    expect(eventYearOverlaps(openEnd, "", "1979", today)).toBe(true);
    expect(eventYearOverlaps(openEnd, "2030", "", today)).toBe(false);
  });

  it("never matches an unknown date against a bounded filter", () => {
    expect(eventYearOverlaps(undated.entity, "1980", "")).toBe(false);
    expect(eventYearOverlaps(undated.entity, "", "2000")).toBe(false);
    expect(eventYearOverlaps(undated.entity, "", "")).toBe(true);
  });
});

describe("eventYearBounds", () => {
  it("spans from the earliest dated row to the current year", () => {
    const rows = [
      versioned(event("1", "a", 1990)),
      versioned(event("2", "b", 1950)),
      versioned(event("3", "c", null)),
    ];
    expect(eventYearBounds(rows, 2026)).toEqual({
      minYear: 1950,
      maxYear: 2026,
      hasDated: true,
    });
  });

  it("collapses to the current year when nothing is dated", () => {
    expect(eventYearBounds([], 2026)).toEqual({
      minYear: 2026,
      maxYear: 2026,
      hasDated: false,
    });
    expect(eventYearBounds([versioned(event("1", "a", null))], 2026)).toEqual({
      minYear: 2026,
      maxYear: 2026,
      hasDated: false,
    });
  });

  it("never starts after the current year", () => {
    const future = [versioned(event("1", "a", 2030))];
    expect(eventYearBounds(future, 2026)).toEqual({
      minYear: 2026,
      maxYear: 2026,
      hasDated: true,
    });
  });
});

describe("paginateEventRows", () => {
  const rows = Array.from({ length: 120 }, (_, index) =>
    versioned(event(String(index), "a", 1900 + index)),
  );

  it("splits rows into 50-row pages", () => {
    const first = paginateEventRows(rows, 0);
    expect(first.total).toBe(120);
    expect(first.totalPages).toBe(3);
    expect(first.rows).toHaveLength(50);
    expect(first.offset).toBe(0);

    const last = paginateEventRows(rows, 2);
    expect(last.rows).toHaveLength(20);
    expect(last.offset).toBe(100);
    expect(last.rows[0].entity.id).toBe("100");
  });

  it("clamps an out-of-range or negative page", () => {
    expect(paginateEventRows(rows, 9).page).toBe(2);
    expect(paginateEventRows(rows, -4).page).toBe(0);
    expect(paginateEventRows(rows, Number.NaN).page).toBe(0);
  });

  it("keeps an empty list on page 0", () => {
    const empty = paginateEventRows([], 3);
    expect(empty.rows).toEqual([]);
    expect(empty.page).toBe(0);
    expect(empty.totalPages).toBe(1);
    expect(empty.total).toBe(0);
  });
});

describe("shouldShowPlaceColumn", () => {
  const withPlace = (id: string): Versioned<EventEntity> =>
    versioned(event(id, "a", 1900, { place: "Moscow" }));
  const withoutPlace = (id: string): Versioned<EventEntity> =>
    versioned(event(id, "a", 1900, { place: null }));

  it("hides place when at least 80% of rows have none", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) => withoutPlace(String(index))),
      withPlace("p1"),
      withPlace("p2"),
    ];
    expect(shouldShowPlaceColumn(rows)).toBe(false);
  });

  it("keeps place when more than 20% of rows have one", () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, index) => withoutPlace(String(index))),
      withPlace("p1"),
      withPlace("p2"),
      withPlace("p3"),
    ];
    expect(shouldShowPlaceColumn(rows)).toBe(true);
  });

  it("treats whitespace as empty and handles an empty list", () => {
    expect(
      shouldShowPlaceColumn([
        versioned(event("1", "a", 1900, { place: "   " })),
        versioned(event("2", "a", 1900, { place: "" })),
      ]),
    ).toBe(false);
    expect(shouldShowPlaceColumn([])).toBe(false);
  });
});

describe("resolveEventColumns", () => {
  const mostlyEmpty = [
    ...Array.from({ length: 9 }, (_, index) =>
      versioned(event(String(index), "a", 1900)),
    ),
    versioned(event("p", "a", 1900, { place: "Moscow" })),
  ];

  it("defaults to hiding place for mostly-empty data", () => {
    expect(resolveEventColumns(undefined, mostlyEmpty)).toEqual([
      "date",
      "type",
      "person",
    ]);
  });

  it("uses the stored choice in canonical order", () => {
    expect(resolveEventColumns(["person", "date"], mostlyEmpty)).toEqual([
      "date",
      "person",
    ]);
    expect(resolveEventColumns(["place", "type", "date", "person"], mostlyEmpty)).toEqual([
      "date",
      "type",
      "person",
      "place",
    ]);
  });

  it("ignores unknown columns and falls back for an empty choice", () => {
    expect(resolveEventColumns(["place"], mostlyEmpty)).toEqual(["place"]);
    expect(resolveEventColumns([], mostlyEmpty)).toEqual([
      "date",
      "type",
      "person",
    ]);
    expect(resolveEventColumns(["bogus"], mostlyEmpty)).toEqual([
      "date",
      "type",
      "person",
    ]);
  });
});

describe("sortEventRows", () => {
  const rows = [
    versioned(event("1", "a", 1970, { type: "BIRTH" })),
    versioned(event("2", "b", 1950, { type: "DEATH" })),
    versioned(event("3", "c", null, { type: "MARRIAGE" })),
  ];

  it("sorts by date and keeps undated rows last in both directions", () => {
    expect(
      sortEventRows(rows, { key: "date", direction: "asc" }, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["2", "1", "3"]);
    expect(
      sortEventRows(rows, { key: "date", direction: "desc" }, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1", "2", "3"]);
  });

  it("sorts by type label and by person name", () => {
    expect(
      sortEventRows(rows, { key: "type", direction: "asc" }, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1", "2", "3"]);
    expect(
      sortEventRows(rows, { key: "person", direction: "asc" }, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["1", "2", "3"]);
    expect(
      sortEventRows(rows, { key: "person", direction: "desc" }, contextOf).map(
        (item) => item.entity.id,
      ),
    ).toEqual(["3", "2", "1"]);
  });

  it("defaults to the oldest date first and does not mutate the input", () => {
    const sorted = sortEventRows(rows, null, contextOf);
    expect(sorted.map((item) => item.entity.id)).toEqual(["2", "1", "3"]);
    expect(rows.map((item) => item.entity.id)).toEqual(["1", "2", "3"]);
  });
});

describe("eventPersonIds", () => {
  it("keeps the display order: personId first, then participantIds", () => {
    const marriage = event("m", "a", 1950, {
      type: "MARRIAGE",
      participantIds: ["b", "c"],
    });
    expect(eventPersonIds(marriage)).toEqual(["a", "b", "c"]);
  });

  it("removes duplicates when participantIds repeats personId", () => {
    const marriage = event("m", "a", 1950, {
      type: "MARRIAGE",
      participantIds: ["a", "b", "b"],
    });
    expect(eventPersonIds(marriage)).toEqual(["a", "b"]);
  });

  it("returns a single id when there are no participants", () => {
    expect(eventPersonIds(event("1", "a", 1950))).toEqual(["a"]);
  });

  it("filters out empty ids", () => {
    const blankParticipants = event("1", "a", 1950, {
      participantIds: ["", "b", ""],
    });
    expect(eventPersonIds(blankParticipants)).toEqual(["a", "b"]);
  });
});

describe("eventOwnerId", () => {
  it("returns only the owner for a birth with both parents", () => {
    const birth = event("b1", "child", 1990, {
      type: "BIRTH",
      participantIds: ["mother", "father"],
    });
    expect(eventOwnerId(birth)).toBe("child");
  });

  it("returns null for an event without an owner", () => {
    const orphan = event("1", "", 1950, {
      participantIds: ["mother"],
    });
    expect(eventOwnerId(orphan)).toBeNull();
  });
});

describe("view-state helpers", () => {
  it("reads typed filters and drops unknown event types", () => {
    expect(
      readEventFilters({
        personId: "p1",
        personScope: "ancestors",
        types: ["BIRTH", "NOPE", "DEATH"],
        fromYear: "1900",
        toYear: "1920",
      }),
    ).toEqual({
      personId: "p1",
      personScope: "ancestors",
      types: ["BIRTH", "DEATH"],
      fromYear: "1900",
      toYear: "1920",
    });
    expect(readEventFilters({})).toEqual({
      personId: "",
      personScope: "person",
      types: [],
      fromYear: "",
      toYear: "",
    });
  });

  it("sets and removes filter values without empty entries", () => {
    expect(withFilterValue({}, "personId", "p1")).toEqual({ personId: "p1" });
    expect(withFilterValue({ personId: "p1" }, "personId", "")).toEqual({});
    expect(withFilterValue({}, "types", [])).toEqual({});
    expect(withFilterValue({}, "types", ["BIRTH"])).toEqual({
      types: ["BIRTH"],
    });
    expect(withFilterValue({ personId: "p1" }, "types", ["BIRTH"])).toEqual({
      personId: "p1",
      types: ["BIRTH"],
    });
  });

  it("clears event filters but keeps the column choice", () => {
    expect(
      clearEventFilterValues({
        personId: "p1",
        types: ["BIRTH"],
        fromYear: "1900",
        toYear: "1950",
        columns: ["date", "person"],
      }),
    ).toEqual({ columns: ["date", "person"] });
  });
});

describe("shared event filter state (issue #107)", () => {
  // A complete BIRTH event whose participant list is empty: the owner stored in
  // `person_id` is the only person of the event.
  const owner = "a";
  const birth = event("birth-1", owner, 1950, { participantIds: [] });

  it("shows an event with no participants to its owner under default filters", () => {
    const rows = [versioned(birth)];
    expect(filterEventRows(rows, "", noFilters, contextOf)).toEqual(rows);
    // The events screen narrows through the resolved person set as well, so an
    // empty participant list must not fall out of the owner's list.
    expect(
      filterEventRows(
        rows,
        "",
        { ...noFilters, personId: owner },
        contextOf,
        new Set([owner]),
      ),
    ).toEqual(rows);
  });

  it("hides the same event behind a stored year range and shows it after a reset", () => {
    const rows = [versioned(birth)];
    const stored = { fromYear: "1990", toYear: "2000" };
    const stale = readEventFilters(stored);
    expect(countActiveEventFilters(stale)).toBe(1);
    expect(filterEventRows(rows, "", stale, contextOf)).toHaveLength(0);

    const cleared = readEventFilters(clearEventFilterValues(stored));
    expect(countActiveEventFilters(cleared)).toBe(0);
    expect(filterEventRows(rows, "", cleared, contextOf)).toEqual(rows);
  });

  it("treats a person filter as stale only when the person list is known", () => {
    const gone = readEventFilters({ personId: "gone" });
    expect(isEventPersonFilterStale(gone, null)).toBe(false);
    expect(isEventPersonFilterStale(gone, new Set())).toBe(false);
    expect(isEventPersonFilterStale(gone, new Set(["kept"]))).toBe(true);
    expect(isEventPersonFilterStale(gone, new Set(["kept", "gone"]))).toBe(
      false,
    );
    expect(isEventPersonFilterStale(readEventFilters({}), new Set(["kept"]))).toBe(
      false,
    );
  });

  it("drops the person and its scope, keeping types, years and columns", () => {
    expect(
      clearEventPersonFilter({
        personId: "p1",
        personScope: "descendants",
        types: ["BIRTH"],
        fromYear: "1900",
        columns: ["date"],
      }),
    ).toEqual({ types: ["BIRTH"], fromYear: "1900", columns: ["date"] });
  });

  it("counts the person, every type and the year range once", () => {
    expect(countActiveEventFilters(readEventFilters({}))).toBe(0);
    expect(countActiveEventFilters(readEventFilters({ personId: "p1" }))).toBe(1);
    expect(
      countActiveEventFilters(readEventFilters({ types: ["BIRTH", "DEATH"] })),
    ).toBe(2);
    expect(
      countActiveEventFilters(readEventFilters({ fromYear: "1900" })),
    ).toBe(1);
    expect(
      countActiveEventFilters(
        readEventFilters({
          personId: "p1",
          types: ["BIRTH"],
          fromYear: "1900",
          toYear: "1950",
        }),
      ),
    ).toBe(3);
  });
});
