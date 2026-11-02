import { describe, expect, it } from "vitest";
import { placeBubble } from "./place";

const VIEWPORT = { width: 1200, height: 800 };
const BUBBLE = { width: 360, height: 220 };

describe("placeBubble", () => {
  it("centers the bubble when there is no target", () => {
    expect(placeBubble(null, BUBBLE, VIEWPORT)).toEqual({
      left: 420,
      top: 290,
      centered: true,
    });
  });

  it("prefers the right side of the target", () => {
    const target = { left: 40, top: 120, width: 200, height: 40 };
    const point = placeBubble(target, BUBBLE, VIEWPORT);
    expect(point.left).toBe(254);
    expect(point.top).toBe(120);
    expect(point.centered).toBe(false);
  });

  it("moves left when the right side does not fit", () => {
    const target = { left: 900, top: 120, width: 200, height: 40 };
    const point = placeBubble(target, BUBBLE, VIEWPORT);
    expect(point.left).toBe(526);
    expect(point.top).toBe(120);
  });

  it("goes below the target when neither side fits", () => {
    const target = { left: 100, top: 120, width: 800, height: 40 };
    const point = placeBubble(target, BUBBLE, VIEWPORT);
    expect(point.left).toBe(320);
    expect(point.top).toBe(174);
  });

  it("keeps the bubble inside a short viewport", () => {
    const target = { left: 40, top: 700, width: 200, height: 40 };
    const point = placeBubble(target, BUBBLE, VIEWPORT);
    expect(point.top).toBe(800 - 220 - 16);
    expect(point.left).toBe(254);
  });

  it("pins the bubble to the top-right corner when asked", () => {
    const target = { left: 40, top: 120, width: 200, height: 40 };
    expect(placeBubble(target, BUBBLE, VIEWPORT, "top-right")).toEqual({
      left: 1200 - 360 - 16,
      top: 16,
      centered: false,
    });
  });
});
