import { describe, expect, it } from "vitest";
import type {
  DateValue,
  MergeEvent,
  MergeEventMatch,
  MergePerson,
  MergePersonMatch,
  MergePreview,
  PersonName,
} from "../../api/types";
import {
  buildMergeDecisions,
  defaultEventChoice,
  defaultMergeDraft,
  defaultPersonChoice,
  detailKey,
  fieldPolicies,
  mergePersonLabel,
} from "./merge";

const UNKNOWN_DATE: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function year(start: string): DateValue {
  return {
    start: `${start}-01-01`,
    end: null,
    precision: "YEAR",
    qualifier: "EXACT",
    original: `${start}`,
  };
}

function name(surname: string, given: string): PersonName {
  return {
    given,
    patronymic: null,
    surname,
    prefix: null,
    suffix: null,
    nameType: "BIRTH",
    isPrimary: true,
  };
}

function person(
  id: string,
  surname: string,
  given: string,
  birth: string,
  notes: string | null = null,
): MergePerson {
  return {
    id,
    names: [name(surname, given)],
    gender: "UNKNOWN",
    birth: year(birth),
    death: UNKNOWN_DATE,
    notes,
    externalIds: [],
  };
}

function event(
  id: string,
  place: string | null,
  details: Record<string, string> = {},
): MergeEvent {
  return {
    id,
    type: "BIRTH",
    date: year("1950"),
    place,
    description: null,
    details,
    participantIds: [],
    sourceIds: [],
    originalType: null,
  };
}

function eventMatch(
  left: MergeEvent,
  right: MergeEvent,
  fieldDiffs: string[],
): MergeEventMatch {
  return {
    id: `${left.id}:${right.id}`,
    left,
    right,
    confidence: "High",
    evidence: [],
    fieldDiffs,
  };
}

function personMatch(
  overrides: Partial<MergePersonMatch> = {},
): MergePersonMatch {
  const left = person("left-person", "Petrova", "Anna", "1950");
  const right = person("right-person", "Petrova", "Anna", "1950");
  return {
    id: `${left.id}:${right.id}`,
    left,
    right,
    confidence: "High",
    evidence: [],
    leftEvents: [],
    rightEvents: [],
    eventMatches: [],
    fieldDiffs: [],
    ...overrides,
  };
}

function preview(matches: MergePersonMatch[]): MergePreview {
  return {
    matches,
    unmatchedRight: [],
    warnings: [],
    counts: {
      leftPeople: 1,
      rightPeople: 1,
      leftEvents: 0,
      rightEvents: 0,
      matchedPeople: matches.length,
      matchedEvents: 0,
      ambiguousPeople: 0,
    },
  };
}

describe("defaultPersonChoice", () => {
  it("pre-selects Merge only for High confidence", () => {
    expect(defaultPersonChoice(personMatch({ confidence: "High" }))).toEqual({
      action: "Merge",
      base: "Left",
      fields: {},
    });
    for (const confidence of ["Medium", "Ambiguous"] as const) {
      expect(
        defaultPersonChoice(personMatch({ confidence })).action,
      ).toBe("KeepBoth");
    }
  });

  it("takes Left for scalar fields and Both for two non-empty notes", () => {
    const match = personMatch({
      left: person("l", "Petrova", "Anna", "1950", "Left note"),
      right: person("r", "Petrova", "Anna", "1951", "Right note"),
      fieldDiffs: ["gender", "birth", "death", "notes"],
    });

    expect(defaultPersonChoice(match).fields).toEqual({
      gender: "Left",
      birth: "Left",
      death: "Left",
      notes: "Both",
    });
  });

  it("keeps notes on the left when either side is blank", () => {
    const match = personMatch({
      left: person("l", "Petrova", "Anna", "1950", "Left note"),
      right: person("r", "Petrova", "Anna", "1950", "   "),
      fieldDiffs: ["notes"],
    });

    expect(defaultPersonChoice(match).fields).toEqual({ notes: "Left" });
  });
});

describe("defaultEventChoice", () => {
  it("pre-selects Merge for High and Left for every differing field", () => {
    const left = event("left-event", "Moscow", { cause: "old" });
    const right = event("right-event", "Tver", { cause: "new" });
    const match = eventMatch(left, right, [
      "place",
      "description",
      "details.cause",
    ]);

    expect(defaultEventChoice(match)).toEqual({
      action: "Merge",
      base: "Left",
      fields: {
        place: "Left",
        description: "Left",
        "details.cause": "Left",
      },
    });
  });

  it("keeps both for lower confidence", () => {
    const match = {
      ...eventMatch(event("l", null), event("r", null), []),
      confidence: "Medium" as const,
    };

    expect(defaultEventChoice(match).action).toBe("KeepBoth");
  });
});

describe("fieldPolicies", () => {
  it("offers Both only for text fields", () => {
    expect(fieldPolicies("notes", "person")).toEqual(["Left", "Right", "Both"]);
    expect(fieldPolicies("gender", "person")).toEqual(["Left", "Right"]);
    expect(fieldPolicies("date", "event")).toEqual(["Left", "Right"]);
    expect(fieldPolicies("place", "event")).toEqual(["Left", "Right", "Both"]);
    expect(fieldPolicies("description", "event")).toEqual([
      "Left",
      "Right",
      "Both",
    ]);
    expect(fieldPolicies("details.cause", "event")).toEqual([
      "Left",
      "Right",
      "Both",
    ]);
  });

  it("extracts a details key and leaves other fields alone", () => {
    expect(detailKey("details.cause")).toBe("cause");
    expect(detailKey("notes")).toBeNull();
  });
});

describe("defaultMergeDraft", () => {
  it("covers every suggested person and event pair", () => {
    const leftEvent = event("left-event", "Moscow");
    const rightEvent = event("right-event", "Moscow");
    const match = personMatch({
      eventMatches: [eventMatch(leftEvent, rightEvent, ["place"])],
    });

    const draft = defaultMergeDraft(preview([match]));

    expect(Object.keys(draft.persons)).toEqual([match.id]);
    expect(Object.keys(draft.events)).toEqual([
      `${leftEvent.id}:${rightEvent.id}`,
    ]);
  });
});

describe("buildMergeDecisions", () => {
  it("always sends base and fields for every person decision", () => {
    const match = personMatch({ fieldDiffs: ["notes"] });

    const decisions = buildMergeDecisions(preview([match]), {
      persons: {},
      events: {},
    });

    expect(decisions).toEqual({
      persons: [
        {
          leftId: "left-person",
          rightId: "right-person",
          action: "Merge",
          base: "Left",
          fields: { notes: "Left" },
        },
      ],
      events: [],
    });
  });

  it("omits event decisions under a KeepBoth person", () => {
    const leftEvent = event("left-event", "Moscow");
    const rightEvent = event("right-event", "Tver");
    const match = personMatch({
      confidence: "Medium",
      leftEvents: [leftEvent],
      rightEvents: [rightEvent],
      eventMatches: [eventMatch(leftEvent, rightEvent, ["place"])],
    });
    const draft = defaultMergeDraft(preview([match]));

    const decisions = buildMergeDecisions(preview([match]), draft);

    expect(decisions.persons).toHaveLength(1);
    expect(decisions.persons[0].action).toBe("KeepBoth");
    expect(decisions.events).toEqual([]);
  });

  it("includes event decisions when the person is merged", () => {
    const leftEvent = event("left-event", "Moscow");
    const rightEvent = event("right-event", "Tver");
    const match = personMatch({
      eventMatches: [eventMatch(leftEvent, rightEvent, ["place"])],
    });
    const draft = defaultMergeDraft(preview([match]));

    const decisions = buildMergeDecisions(preview([match]), draft);

    expect(decisions.events).toEqual([
      {
        leftEventId: "left-event",
        rightEventId: "right-event",
        action: "Merge",
        base: "Left",
        fields: { place: "Left" },
      },
    ]);
  });

  it("preserves explicit user overrides", () => {
    const match = personMatch({ fieldDiffs: ["gender", "notes"] });

    const decisions = buildMergeDecisions(preview([match]), {
      persons: {
        [match.id]: {
          action: "Merge",
          base: "Right",
          fields: { gender: "Right", notes: "Right" },
        },
      },
      events: {},
    });

    expect(decisions.persons[0]).toMatchObject({
      base: "Right",
      fields: { gender: "Right", notes: "Right" },
    });
  });
});

describe("mergePersonLabel", () => {
  it("builds a surname-first display name", () => {
    expect(mergePersonLabel(person("p", "Petrova", "Anna", "1950"))).toBe(
      "Petrova Anna",
    );
    expect(mergePersonLabel(person("p", "Petrova", "Anna", "1950"), "—")).toBe(
      "Petrova Anna",
    );
  });
});
