import { describe, expect, it } from "vitest";
import {
  SUGGESTION_INTERVAL_MS,
  SUGGESTION_INTERVAL_REDUCED_MS,
  rotationInterval,
  shouldPauseRotation,
} from "./rotation";

describe("rotationInterval", () => {
  it("keeps every phrase visible for at least eight seconds", () => {
    expect(SUGGESTION_INTERVAL_MS).toBeGreaterThanOrEqual(8_000);
    expect(rotationInterval(false)).toBe(SUGGESTION_INTERVAL_MS);
  });

  it("rotates no more often than every twelve seconds with reduced motion", () => {
    expect(SUGGESTION_INTERVAL_REDUCED_MS).toBeGreaterThanOrEqual(12_000);
    expect(rotationInterval(true)).toBe(SUGGESTION_INTERVAL_REDUCED_MS);
  });
});

describe("shouldPauseRotation", () => {
  it("pauses on hover, on focus and while the input has text", () => {
    expect(shouldPauseRotation("", true, false)).toBe(true);
    expect(shouldPauseRotation("", false, true)).toBe(true);
    expect(shouldPauseRotation("next question", false, false)).toBe(true);
  });

  it("rotates when the user is idle", () => {
    expect(shouldPauseRotation("", false, false)).toBe(false);
    expect(shouldPauseRotation("   ", false, false)).toBe(false);
  });
});
