// Pure helpers for the confirmed event place point (ADR-0020). No React, no
// IPC: the form and the map share the same coordinate text.

import type { PlaceGeo, PlacePrecision } from "../../api/types";

/**
 * Human-readable coordinate pair. Four decimals is about 11 m, which matches
 * the map's grouping precision and never implies house-level accuracy.
 */
export function formatPlacePoint(point: Pick<PlaceGeo, "lat" | "lon">): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
}

/** i18n key for a point's precision label. */
export function placePrecisionLabelKey(precision: PlacePrecision): string {
  return `event:placePrecision.${precision}`;
}
