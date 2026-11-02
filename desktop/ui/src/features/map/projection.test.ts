import { describe, expect, it } from "vitest";
import {
  MAX_LATITUDE,
  TILE_SIZE,
  clampLatitude,
  projectToWorld,
  screenDistance,
  unprojectFromWorld,
} from "./projection";

describe("projectToWorld", () => {
  it("puts the null island at the centre of the world", () => {
    expect(projectToWorld({ lat: 0, lon: 0 }, 0)).toEqual({
      x: TILE_SIZE / 2,
      y: TILE_SIZE / 2,
    });
  });

  it("caps the poles at the tile-map latitude", () => {
    const north = projectToWorld({ lat: 90, lon: 0 }, 0);
    expect(north.y).toBeCloseTo(0, 0);
    expect(clampLatitude(90)).toBe(MAX_LATITUDE);
    expect(clampLatitude(-90)).toBe(-MAX_LATITUDE);
    expect(clampLatitude(Number.NaN)).toBe(0);
  });

  it("doubles the world with each zoom", () => {
    const z0 = projectToWorld({ lat: 55.75, lon: 37.61 }, 0);
    const z1 = projectToWorld({ lat: 55.75, lon: 37.61 }, 1);
    expect(z1.x).toBeCloseTo(z0.x * 2, 6);
    expect(z1.y).toBeCloseTo(z0.y * 2, 6);
  });

  it("keeps the date line at the world edge", () => {
    expect(projectToWorld({ lat: 0, lon: 180 }, 0).x).toBe(TILE_SIZE);
    expect(projectToWorld({ lat: 0, lon: -180 }, 0).x).toBe(0);
  });
});

describe("unprojectFromWorld", () => {
  it("round-trips a point at a city zoom", () => {
    const point = { lat: 57.4321, lon: 49.1234 };
    const restored = unprojectFromWorld(
      projectToWorld(point, 11).x,
      projectToWorld(point, 11).y,
      11,
    );
    expect(restored.lat).toBeCloseTo(point.lat, 8);
    expect(restored.lon).toBeCloseTo(point.lon, 8);
  });

  it("clamps a latitude outside the projection", () => {
    const restored = unprojectFromWorld(128, -100000, 0);
    expect(restored.lat).toBeLessThanOrEqual(MAX_LATITUDE);
  });
});

describe("screenDistance", () => {
  it("is the euclidean pixel distance", () => {
    expect(screenDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
