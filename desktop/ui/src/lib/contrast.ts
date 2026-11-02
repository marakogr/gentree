// WCAG contrast measurement for the theme tokens in `src/theme.css`.
// Pure math (OKLCH -> sRGB -> relative luminance) plus a small CSS reader, so
// the token palette can be asserted in a node test instead of by eye.

export type Oklch = { l: number; c: number; h: number };

/** Gamma-encoded sRGB, channels in the 0..1 range. */
export type Srgb = { r: number; g: number; b: number };

export type ThemeName = "light" | "dark";

/** WCAG AA for normal-size text. */
export const WCAG_AA_NORMAL = 4.5;

/** Token pairs that carry text and therefore must reach `WCAG_AA_NORMAL`. */
export const TEXT_TOKEN_PAIRS: readonly {
  name: string;
  foreground: string;
  background: string;
}[] = [
  {
    name: "foreground/background",
    foreground: "--foreground",
    background: "--background",
  },
  {
    name: "foreground/card",
    foreground: "--foreground",
    background: "--card",
  },
  {
    name: "muted-foreground/card",
    foreground: "--muted-foreground",
    background: "--card",
  },
  {
    name: "primary-foreground/primary",
    foreground: "--primary-foreground",
    background: "--primary",
  },
];

/** All tokens `evaluateTheme` insists on finding in each theme block. */
export const REQUIRED_TOKENS: readonly string[] = [
  "--background",
  "--card",
  "--foreground",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
];

export type ContrastPair = {
  name: string;
  /** Token names, e.g. `--foreground` and `--background`. */
  foregroundToken: string;
  backgroundToken: string;
  /** Raw oklch() values as written in the CSS. */
  foregroundValue: string;
  backgroundValue: string;
  ratio: number;
  minRatio: number;
  passes: boolean;
};

export type ThemeContrast = {
  theme: ThemeName;
  tokens: Record<string, string>;
  pairs: ContrastPair[];
  passes: boolean;
};

export type ThemeContrastReport = Record<ThemeName, ThemeContrast>;

const OKLCH_PATTERN = /^oklch\(\s*([^)]*)\)$/i;
const COLOR_TOKENS_PATTERN = /([^{}]+)\{([^{}]*)\}/g;

function parseNumber(token: string, what: string, value: string): number {
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(%)?$/.exec(token);
  if (!match) {
    throw new Error(`oklch(): unsupported ${what} "${token}" in ${value}`);
  }
  return Number.parseFloat(token);
}

/**
 * Parses `oklch(L C H)` / `oklch(L C H / A)` (commas allowed, `%` allowed for
 * lightness, `none` treated as 0). Alpha is accepted and ignored: the tokens
 * are opaque.
 */
export function parseOklch(value: string): Oklch {
  const match = OKLCH_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Not an oklch() color: ${value}`);
  const tokens = match[1]
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter((token) => token !== "");
  if (tokens.length < 3) {
    throw new Error(`oklch() needs three components: ${value}`);
  }
  const [lToken, cToken, hToken] = tokens;
  let l = parseNumber(lToken, "lightness", value);
  if (lToken.endsWith("%")) l /= 100;
  let c = parseNumber(cToken, "chroma", value);
  // CSS maps 100% chroma to 0.4.
  if (cToken.endsWith("%")) c = (c / 100) * 0.4;
  const h = hToken === "none" ? 0 : parseNumber(hToken, "hue", value);
  return { l, c, h };
}

function linearToSrgbChannel(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** OKLCH -> gamma-encoded sRGB, channels clipped to the sRGB gamut. */
export function oklchToSrgb(color: Oklch): Srgb {
  const hue = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hue);
  const b = color.c * Math.sin(hue);

  const l_ = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: linearToSrgbChannel(
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    ),
    g: linearToSrgbChannel(
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    ),
    b: linearToSrgbChannel(
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ),
  };
}

function srgbToLinear(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.04045
    ? clamped / 12.92
    : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a gamma-encoded sRGB color. */
export function relativeLuminance(rgb: Srgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) +
    0.7152 * srgbToLinear(rgb.g) +
    0.0722 * srgbToLinear(rgb.b)
  );
}

/** WCAG 2.x contrast ratio, `(L1 + 0.05) / (L2 + 0.05)`, 1..21. */
export function contrastRatio(foreground: Oklch, background: Oklch): number {
  const a = relativeLuminance(oklchToSrgb(foreground));
  const b = relativeLuminance(oklchToSrgb(background));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `:root` carries the default (dark) palette; `[data-theme]` overrides it. */
function selectorTheme(selector: string): ThemeName | null {
  const normalised = selector.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    normalised.includes('[data-theme="light"]') ||
    normalised.includes("[data-theme='light']")
  ) {
    return "light";
  }
  if (
    normalised.includes('[data-theme="dark"]') ||
    normalised.includes("[data-theme='dark']")
  ) {
    return "dark";
  }
  if (normalised === ":root" || normalised === "html") return "dark";
  return null;
}

function collectTokens(
  cssText: string,
): Record<ThemeName, Record<string, string>> {
  const tokens: Record<ThemeName, Record<string, string>> = {
    light: {},
    dark: {},
  };
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of withoutComments.matchAll(COLOR_TOKENS_PATTERN)) {
    const selectorList = block[1];
    const body = block[2];
    const themes = new Set<ThemeName>();
    for (const selector of selectorList.split(",")) {
      const theme = selectorTheme(selector);
      if (theme !== null) themes.add(theme);
    }
    if (themes.size === 0) continue;

    const declarations = new Map<string, string>();
    for (const part of body.split(";")) {
      const colon = part.indexOf(":");
      if (colon <= 0) continue;
      const name = part.slice(0, colon).trim();
      if (!name.startsWith("--")) continue;
      declarations.set(name, part.slice(colon + 1).trim());
    }
    for (const theme of themes) {
      for (const [name, value] of declarations) {
        if (name.startsWith("--color-")) continue;
        tokens[theme][name] = value;
      }
    }
  }
  return tokens;
}

function requireToken(
  tokens: Record<string, string>,
  name: string,
  theme: ThemeName,
): string {
  const value = tokens[name];
  if (value === undefined || value === "") {
    throw new Error(`theme "${theme}" is missing the token ${name}`);
  }
  return value;
}

function buildTheme(
  theme: ThemeName,
  tokens: Record<string, string>,
): ThemeContrast {
  for (const token of REQUIRED_TOKENS) requireToken(tokens, token, theme);

  const pairs: ContrastPair[] = TEXT_TOKEN_PAIRS.map((pair) => {
    const foregroundValue = requireToken(tokens, pair.foreground, theme);
    const backgroundValue = requireToken(tokens, pair.background, theme);
    const ratio = contrastRatio(
      parseOklch(foregroundValue),
      parseOklch(backgroundValue),
    );
    return {
      name: pair.name,
      foregroundToken: pair.foreground,
      backgroundToken: pair.background,
      foregroundValue,
      backgroundValue,
      ratio,
      minRatio: WCAG_AA_NORMAL,
      passes: ratio >= WCAG_AA_NORMAL,
    };
  });

  return {
    theme,
    tokens,
    pairs,
    passes: pairs.every((pair) => pair.passes),
  };
}

/**
 * Reads both palettes out of the theme stylesheet and measures every text pair.
 * Throws when a required token or an oklch() value is missing, so a broken
 * palette fails the test instead of silently measuring nothing.
 */
export function evaluateTheme(cssText: string): ThemeContrastReport {
  const tokens = collectTokens(cssText);
  return {
    light: buildTheme("light", tokens.light),
    dark: buildTheme("dark", tokens.dark),
  };
}
