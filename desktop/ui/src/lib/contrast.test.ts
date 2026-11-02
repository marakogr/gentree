import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TEXT_TOKEN_PAIRS,
  WCAG_AA_NORMAL,
  contrastRatio,
  evaluateTheme,
  oklchToSrgb,
  parseOklch,
  relativeLuminance,
} from "./contrast";

const THEME_CSS = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

describe("parseOklch", () => {
  it("reads the three components of a plain token", () => {
    expect(parseOklch("oklch(0.96 0.005 255)")).toEqual({
      l: 0.96,
      c: 0.005,
      h: 255,
    });
    expect(parseOklch("  oklch(1 0 0)  ")).toEqual({ l: 1, c: 0, h: 0 });
  });

  it("accepts commas, percentages and an alpha channel", () => {
    expect(parseOklch("oklch(0.5, 0.1, 200)")).toEqual({
      l: 0.5,
      c: 0.1,
      h: 200,
    });
    expect(parseOklch("oklch(96% 0.005 255)").l).toBeCloseTo(0.96, 6);
    expect(parseOklch("oklch(50% 0.1 200 / 40%)")).toEqual({
      l: 0.5,
      c: 0.1,
      h: 200,
    });
  });

  it("rejects anything that is not a complete oklch() color", () => {
    expect(() => parseOklch("rgb(0 0 0)")).toThrow(/oklch/);
    expect(() => parseOklch("oklch(0.5 0.1)")).toThrow(/three components/);
    expect(() => parseOklch("oklch(light dark blue)")).toThrow(/lightness/);
    expect(() => parseOklch("")).toThrow(/oklch/);
  });
});

describe("oklchToSrgb", () => {
  it("maps the achromatic extremes to black and white", () => {
    expect(oklchToSrgb({ l: 0, c: 0, h: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    for (const channel of Object.values(oklchToSrgb({ l: 1, c: 0, h: 0 }))) {
      expect(channel).toBeCloseTo(1, 4);
    }
  });

  it("stays inside the sRGB gamut", () => {
    const rgb = oklchToSrgb({ l: 0.7, c: 0.4, h: 30 });
    for (const channel of Object.values(rgb)) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe("relativeLuminance and contrastRatio", () => {
  it("uses the WCAG extremes", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 6);
    expect(relativeLuminance({ r: 1, g: 0, b: 0 })).toBeCloseTo(0.2126, 6);
  });

  it("measures the maximum and minimum ratios", () => {
    const black = { l: 0, c: 0, h: 0 };
    const white = { l: 1, c: 0, h: 0 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 4);
    expect(contrastRatio(black, black)).toBeCloseTo(1, 6);
    expect(contrastRatio(white, black)).toBeCloseTo(
      contrastRatio(black, white),
      10,
    );
  });

  it("grows with lightness distance", () => {
    const low = contrastRatio({ l: 0.5, c: 0, h: 0 }, { l: 0.55, c: 0, h: 0 });
    const high = contrastRatio({ l: 0.2, c: 0, h: 0 }, { l: 0.9, c: 0, h: 0 });
    expect(low).toBeLessThan(1.5);
    expect(high).toBeGreaterThan(10);
  });
});

describe("evaluateTheme on a synthetic stylesheet", () => {
  it("reports failures per theme", () => {
    const css = `
      :root {
        --background: oklch(0.5 0 0);
        --card: oklch(0.55 0 0);
        --foreground: oklch(0.6 0 0);
        --muted-foreground: oklch(0.62 0 0);
        --primary: oklch(0.5 0.1 200);
        --primary-foreground: oklch(0.55 0.02 200);
      }
      :root[data-theme="light"] {
        --background: oklch(1 0 0);
        --card: oklch(1 0 0);
        --foreground: oklch(0.2 0 0);
        --muted-foreground: oklch(0.3 0 0);
        --primary: oklch(0.4 0.1 200);
        --primary-foreground: oklch(1 0 0);
      }
    `;
    const report = evaluateTheme(css);
    expect(report.dark.passes).toBe(false);
    expect(report.dark.pairs).toHaveLength(TEXT_TOKEN_PAIRS.length);
    expect(report.dark.pairs.every((pair) => pair.passes)).toBe(false);
    expect(report.light.passes).toBe(true);
  });

  it("fails loudly when a token is missing", () => {
    expect(() =>
      evaluateTheme(`
        :root { --background: oklch(0 0 0); }
        :root[data-theme="light"] { --background: oklch(1 0 0); }
      `),
    ).toThrow(/missing the token/);
  });
});

describe("theme.css contrast", () => {
  const report = evaluateTheme(THEME_CSS);

  it("parses both palettes from the real stylesheet", () => {
    for (const theme of [report.light, report.dark]) {
      expect(Object.keys(theme.tokens).length).toBeGreaterThan(0);
      expect(theme.pairs).toHaveLength(TEXT_TOKEN_PAIRS.length);
      for (const pair of theme.pairs) {
        expect(pair.foregroundValue).toMatch(/^oklch\(/);
        expect(pair.backgroundValue).toMatch(/^oklch\(/);
      }
    }
  });

  it("keeps body text readable on background and card", () => {
    for (const theme of [report.light, report.dark]) {
      for (const name of ["foreground/background", "foreground/card"]) {
        const pair = theme.pairs.find((item) => item.name === name);
        expect(pair, `${theme.theme}: ${name}`).toBeDefined();
        expect(pair?.ratio, `${theme.theme}: ${name}`).toBeGreaterThanOrEqual(
          WCAG_AA_NORMAL,
        );
      }
    }
  });

  it("keeps muted text readable on cards", () => {
    for (const theme of [report.light, report.dark]) {
      const pair = theme.pairs.find(
        (item) => item.name === "muted-foreground/card",
      );
      expect(pair, `${theme.theme}: muted-foreground/card`).toBeDefined();
      expect(
        pair?.ratio,
        `${theme.theme}: muted-foreground/card`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    }
  });

  it("keeps the primary button label readable", () => {
    for (const theme of [report.light, report.dark]) {
      const pair = theme.pairs.find(
        (item) => item.name === "primary-foreground/primary",
      );
      expect(pair, `${theme.theme}: primary-foreground/primary`).toBeDefined();
      expect(
        pair?.ratio,
        `${theme.theme}: primary-foreground/primary`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    }
  });

  it("passes WCAG AA for every text pair in both themes", () => {
    expect(report.light.passes).toBe(true);
    expect(report.dark.passes).toBe(true);
  });
});
