// Pure grouping for the event map (ADR-0020).
//
// Level 1: events that share a confirmed point (four decimals, about 11 m) are
// one place. Level 2: distinct places whose markers collide on screen are one
// cluster at the current zoom. Names are never used for identity: two villages
// with the same name but different points stay apart.

import type {
  PlaceGeo,
  PlacePrecision,
  TimelineEntry,
} from "../../api/types";
import {
  projectToWorld,
  screenDistance,
  unprojectFromWorld,
  type ScreenPoint,
} from "./projection";

export type PlaceGroup = {
  key: string;
  lat: number;
  lon: number;
  precision: PlacePrecision;
  place: string | null;
  entries: TimelineEntry[];
};

export type MapCluster = {
  id: string;
  lat: number;
  lon: number;
  groups: PlaceGroup[];
  eventCount: number;
  placeCount: number;
};

/** About 11 m; matches `formatPlacePoint` and the merge point identity. */
export const PLACE_DECIMALS = 4;
export const DEFAULT_CLUSTER_PX = 44;

const PRECISION_RANK: Record<PlacePrecision, number> = {
  UNKNOWN: 0,
  COUNTRY: 1,
  REGION: 2,
  SETTLEMENT: 3,
  POINT: 4,
};

/** Four decimals is enough to separate villages, not houses next door. */
export function placeKey(point: Pick<PlaceGeo, "lat" | "lon">): string {
  return `${point.lat.toFixed(PLACE_DECIMALS)},${point.lon.toFixed(PLACE_DECIMALS)}`;
}

function coarsest(left: PlacePrecision, right: PlacePrecision): PlacePrecision {
  return PRECISION_RANK[right] < PRECISION_RANK[left] ? right : left;
}

function placeLabel(entry: TimelineEntry): string | null {
  const value = entry.event.place?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * One group per confirmed point. An event without `placeGeo` is ignored; the
 * caller lists it as unresolved instead.
 */
export function groupByPlace(
  entries: readonly TimelineEntry[],
): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  for (const entry of entries) {
    const point = entry.event.placeGeo;
    if (!point) continue;
    const key = placeKey(point);
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.precision = coarsest(existing.precision, point.precision);
      if (existing.place === null) existing.place = placeLabel(entry);
      continue;
    }
    groups.set(key, {
      key,
      lat: point.lat,
      lon: point.lon,
      precision: point.precision,
      place: placeLabel(entry),
      entries: [entry],
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

type Candidate = {
  group: PlaceGroup;
  screen: ScreenPoint;
};

/**
 * Greedy screen-space clustering around the seed marker. The selected group is
 * always a singleton so its card and highlight stay reachable.
 */
export function clusterPlaces(
  groups: readonly PlaceGroup[],
  zoom: number,
  options: { thresholdPx?: number; selectedKey?: string | null } = {},
): MapCluster[] {
  const threshold = options.thresholdPx ?? DEFAULT_CLUSTER_PX;
  const selectedKey = options.selectedKey ?? null;
  const selected = groups.find((group) => group.key === selectedKey) ?? null;
  const candidates: Candidate[] = groups
    .filter((group) => group.key !== selectedKey)
    .map((group) => ({
      group,
      screen: projectToWorld(group, zoom),
    }))
    .sort(
      (left, right) =>
        left.screen.x - right.screen.x || left.screen.y - right.screen.y,
    );

  const used = new Set<number>();
  const clusters: MapCluster[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    if (used.has(index)) continue;
    used.add(index);
    const members = [candidates[index]];
    for (let other = index + 1; other < candidates.length; other += 1) {
      if (used.has(other)) continue;
      if (
        screenDistance(candidates[index].screen, candidates[other].screen) <=
        threshold
      ) {
        used.add(other);
        members.push(candidates[other]);
      }
    }
    clusters.push(clusterOf(members, zoom));
  }

  if (selected) {
    clusters.push(clusterOf([{ group: selected, screen: projectToWorld(selected, zoom) }], zoom));
  }

  return clusters.sort((left, right) => left.id.localeCompare(right.id));
}

function clusterOf(members: Candidate[], zoom: number): MapCluster {
  const groups = members.map((member) => member.group);
  const screen = members.reduce(
    (sum, member) => ({
      x: sum.x + member.screen.x / members.length,
      y: sum.y + member.screen.y / members.length,
    }),
    { x: 0, y: 0 },
  );
  const center = unprojectFromWorld(screen.x, screen.y, zoom);
  const id = groups
    .map((group) => group.key)
    .sort((left, right) => left.localeCompare(right));
  return {
    id: id.join("|"),
    lat: center.lat,
    lon: center.lon,
    groups,
    eventCount: groups.reduce((sum, group) => sum + group.entries.length, 0),
    placeCount: groups.length,
  };
}

/** Every event in a cluster, in place order. */
export function clusterEntries(cluster: MapCluster): TimelineEntry[] {
  return cluster.groups.flatMap((group) => group.entries);
}
