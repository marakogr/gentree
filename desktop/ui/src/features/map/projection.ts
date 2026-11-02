// Web Mercator helpers for the event map. Leaflet uses the same 256 px world
// grid, so screen clustering here matches what the map draws. Pure: no DOM, no
// Leaflet import.

export type LatLon = { lat: number; lon: number };
export type ScreenPoint = { x: number; y: number };

export const TILE_SIZE = 256;
/** Web Mercator cannot show the poles; this is the usual tile-map cap. */
export const MAX_LATITUDE = 85.05112878;

export function clampLatitude(lat: number): number {
  if (!Number.isFinite(lat)) return 0;
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
}

export function clampLongitude(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  // Keep the date line a valid point instead of wrapping into an infinite loop.
  return Math.max(-180, Math.min(180, lon));
}

/** World pixel position at `zoom`; the whole world is `256 * 2^zoom` px. */
export function projectToWorld(point: LatLon, zoom: number): ScreenPoint {
  const size = TILE_SIZE * 2 ** zoom;
  const lat = clampLatitude(point.lat);
  const lon = clampLongitude(point.lon);
  const x = ((lon + 180) / 360) * size;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  return { x, y };
}

/** Inverse of `projectToWorld`; values outside the world are clamped by the
 * latitude cap but the longitude may stay outside [-180, 180] near a wrapped
 * world copy, which Leaflet accepts. */
export function unprojectFromWorld(
  x: number,
  y: number,
  zoom: number,
): LatLon {
  const size = TILE_SIZE * 2 ** zoom;
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: clampLatitude(lat), lon };
}

export function screenDistance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
