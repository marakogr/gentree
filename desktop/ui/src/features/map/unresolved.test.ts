import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../api/types";
import { groupUnresolved, normalizePlaceText } from "./unresolved";

function entry(id: string, place: string | null, resolved = false): TimelineEntry {
  return {
    personName: "Person",
    event: {
      id,
      personId: "person-1",
      type: "RESIDENCE",
      date: {
        start: null,
        end: null,
        precision: "UNKNOWN",
        qualifier: "UNKNOWN",
        original: null,
      },
      place,
      placeGeo: resolved
        ? { lat: 57.4, lon: 49.1, precision: "SETTLEMENT", source: "PHOTON" }
        : null,
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
    },
  };
}

describe("normalizePlaceText", () => {
  it("ignores case and repeated whitespace", () => {
    expect(normalizePlaceText("  Ивановка   Кировская ")).toBe(
      normalizePlaceText("ивановка кировская"),
    );
  });
});

describe("groupUnresolved", () => {
  it("groups the same typed place and keeps the first display text", () => {
    const groups = groupUnresolved([
      entry("a", " Ивановка "),
      entry("b", "ивановка"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Ивановка");
    expect(groups[0].entries.map((row) => row.event.id)).toEqual(["a", "b"]);
  });

  it("ignores resolved and empty places", () => {
    expect(
      groupUnresolved([
        entry("a", "Ивановка", true),
        entry("b", null),
        entry("c", "  "),
      ]),
    ).toEqual([]);
  });

  it("sorts by event count, then by label", () => {
    const groups = groupUnresolved([
      entry("a", "Малая"),
      entry("b", "Большая"),
      entry("c", "большая"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Большая", "Малая"]);
  });
});
