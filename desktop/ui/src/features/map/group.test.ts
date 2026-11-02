import { describe, expect, it } from "vitest";
import type { PlacePrecision, TimelineEntry } from "../../api/types";
import { clusterEntries, clusterPlaces, groupByPlace, placeKey } from "./group";

const unknownDate = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
} as const;

function entry(
  id: string,
  lat: number,
  lon: number,
  place: string | null = "Ивановка",
  precision: PlacePrecision = "SETTLEMENT",
): TimelineEntry {
  return {
    personName: `Person ${id}`,
    event: {
      id,
      personId: "person-1",
      type: "RESIDENCE",
      date: unknownDate,
      place,
      placeGeo: { lat, lon, precision, source: "PHOTON" },
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
    },
  };
}

describe("placeKey", () => {
  it("groups points four decimals apart and separates villages", () => {
    expect(placeKey({ lat: 57.43211, lon: 49.12344 })).toBe(
      placeKey({ lat: 57.43214, lon: 49.12341 }),
    );
    expect(placeKey({ lat: 57.4321, lon: 49.1234 })).not.toBe(
      placeKey({ lat: 57.4421, lon: 49.1234 }),
    );
  });
});

describe("groupByPlace", () => {
  it("collapses events at the same chosen point", () => {
    const groups = groupByPlace([
      entry("a", 57.4321, 49.1234),
      entry("b", 57.43211, 49.12341),
      entry("c", 57.5, 49.2),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].entries.map((row) => row.event.id)).toEqual(["a", "b"]);
    expect(groups[0].place).toBe("Ивановка");
  });

  it("keeps the coarsest precision of the group", () => {
    const groups = groupByPlace([
      entry("a", 57.4321, 49.1234, "Ивановка", "POINT"),
      entry("b", 57.4321, 49.1234, "Ивановка", "REGION"),
    ]);
    expect(groups[0].precision).toBe("REGION");
  });

  it("ignores events without a point", () => {
    const plain = entry("a", 57.4, 49.1);
    plain.event.placeGeo = null;
    expect(groupByPlace([plain])).toEqual([]);
  });
});

describe("clusterPlaces", () => {
  const groups = groupByPlace([
    entry("a", 57.4321, 49.1234),
    entry("b", 57.5321, 49.1234),
  ]);

  it("merges nearby places at a low zoom and separates them when zoomed in", () => {
    const low = clusterPlaces(groups, 6);
    expect(low).toHaveLength(1);
    expect(low[0].placeCount).toBe(2);
    expect(low[0].eventCount).toBe(2);

    const high = clusterPlaces(groups, 12);
    expect(high).toHaveLength(2);
  });

  it("keeps the selected place separate", () => {
    const clusters = clusterPlaces(groups, 6, {
      selectedKey: groups[0].key,
    });
    expect(clusters).toHaveLength(2);
    expect(
      clusters.some(
        (cluster) =>
          cluster.placeCount === 1 &&
          cluster.groups[0].key === groups[0].key,
      ),
    ).toBe(true);
  });

  it("is deterministic and exposes every event", () => {
    const first = clusterPlaces(groups, 6);
    const second = clusterPlaces([...groups].reverse(), 6);
    expect(second.map((cluster) => cluster.id)).toEqual(
      first.map((cluster) => cluster.id),
    );
    expect(clusterEntries(first[0]).map((row) => row.event.id).sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
