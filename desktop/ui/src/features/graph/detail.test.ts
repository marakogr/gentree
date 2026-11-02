import { describe, expect, it } from "vitest";
import {
  GRAPH_LABEL_MIN_SCALE,
  scalePercent,
  showsNodeLabels,
} from "./detail";

describe("scalePercent", () => {
  it("reports whole percents", () => {
    expect(scalePercent(1)).toBe(100);
    expect(scalePercent(0.4)).toBe(40);
    expect(scalePercent(1.8)).toBe(180);
    expect(scalePercent(0.6666667)).toBe(67);
  });

  it("rounds to the nearest percent", () => {
    expect(scalePercent(0.694)).toBe(69);
    expect(scalePercent(0.695)).toBe(70);
    expect(scalePercent(0.7049)).toBe(70);
  });

  it("falls back to 100% for non-finite input", () => {
    expect(scalePercent(Number.NaN)).toBe(100);
    expect(scalePercent(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("showsNodeLabels", () => {
  it("keeps captions at and above the threshold", () => {
    expect(showsNodeLabels(GRAPH_LABEL_MIN_SCALE)).toBe(true);
    expect(showsNodeLabels(0.85)).toBe(true);
    expect(showsNodeLabels(1)).toBe(true);
    expect(showsNodeLabels(1.8)).toBe(true);
  });

  it("hides captions below the threshold", () => {
    expect(showsNodeLabels(0.4)).toBe(false);
    expect(showsNodeLabels(0.69)).toBe(false);
    expect(showsNodeLabels(0.6949)).toBe(false);
  });

  it("treats float noise at the threshold as 70%", () => {
    expect(showsNodeLabels(0.6999999999)).toBe(true);
    expect(showsNodeLabels(GRAPH_LABEL_MIN_SCALE - 1e-9)).toBe(true);
  });

  it("keeps the detailed view for non-finite input", () => {
    expect(showsNodeLabels(Number.NaN)).toBe(true);
  });
});
