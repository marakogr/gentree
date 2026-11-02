import { describe, expect, it } from "vitest";
import { shouldAutoStartTour } from "./storage";

describe("shouldAutoStartTour", () => {
  it("starts only on a genuine first run", () => {
    expect(shouldAutoStartTour(false, false)).toBe(true);
  });

  it("never repeats a finished tour", () => {
    expect(shouldAutoStartTour(true, false)).toBe(false);
  });

  it("stays out of scripted WebDriver sessions", () => {
    expect(shouldAutoStartTour(false, true)).toBe(false);
  });
});
