/**
 * Timing for the rotating progress line in chat.
 *
 * The line narrates what the assistant is doing while tool calls are hidden.
 * One phrase has to stay long enough to be read, so the default interval is
 * deliberately slow; reduced-motion users get an even slower, calmer cadence.
 */

/** Minimum time one phrase is visible (also the documented floor). */
export const SUGGESTION_INTERVAL_MS = 8_000;

/** Reduced motion: no animation and a calmer rotation. */
export const SUGGESTION_INTERVAL_REDUCED_MS = 12_000;

/** Rotation period for the current motion preference. */
export function rotationInterval(reducedMotion: boolean): number {
  return reducedMotion ? SUGGESTION_INTERVAL_REDUCED_MS : SUGGESTION_INTERVAL_MS;
}

/**
 * Rotation pauses while the user reads the line or writes the next message.
 * `hovered`/`focused` describe the progress block itself.
 */
export function shouldPauseRotation(
  input: string,
  hovered: boolean,
  focused: boolean,
): boolean {
  return hovered || focused || input.trim() !== "";
}
