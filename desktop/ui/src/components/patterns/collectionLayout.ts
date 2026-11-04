// Pure layout rules for the master-detail collection shell.

import {
  clampSplitterWidth,
  readSplitterWidth,
  type SplitterBounds,
} from "./splitter";

/** Initial width from the stored filters value. */
export function readCollectionWidth(
  stored: unknown,
  bounds: SplitterBounds,
): number {
  return readSplitterWidth(stored, bounds);
}

/** Width after a drag or key press, clamped for layout. */
export function clampCollectionWidth(
  value: number,
  bounds: SplitterBounds,
): number {
  return clampSplitterWidth(value, bounds);
}

/** Persisted value written back to the filters map. */
export function commitCollectionWidth(
  value: number,
  bounds: SplitterBounds,
): { width: number; stored: string } {
  const width = Math.round(clampCollectionWidth(value, bounds));
  return { width, stored: String(width) };
}
