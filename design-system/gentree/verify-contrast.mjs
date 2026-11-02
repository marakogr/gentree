#!/usr/bin/env node
/*
 * Gentree "Swiss archive" palette — WCAG 2.1 contrast verification.
 *
 * The palette below is checked against the values the app actually ships in
 * `desktop/ui/src/swiss.css`, so this file cannot drift from the UI tokens.
 *
 * Run:  node design-system/gentree/verify-contrast.mjs
 * Exit: 0 when every pair meets its threshold, 1 otherwise.
 *
 * Thresholds (WCAG 2.1):
 *   1.4.3 Contrast (Minimum)  — normal text 4.5:1; large text (>=24px, or
 *                               >=18.66px bold) 3:1.
 *   1.4.11 Non-text Contrast  — UI component boundaries, focus indicators and
 *                               meaningful icons/graphics 3:1 vs adjacent colour.
 *   Disabled controls are exempt from 1.4.3, but the palette keeps disabled
 *   text at >=3:1 so it stays legible.
 *
 * Alpha colours (scrim) are composited over the canvas before measuring; the
 * dialog surface is opaque, so its own border/edge is measured separately.
 */

const LIGHT = {
  name: "light / Paper",
  canvas: "#f2f3ef",
  surface: "#fbfbf8",
  raised: "#ffffff",
  sunken: "#e7e9e4",
  ink: "#12161a",
  "ink-2": "#3a4247",
  "ink-3": "#5b6469",
  "rule-subtle": "#d3d7cf",
  "rule-strong": "#767f7a",
  accent: "#0b6577",
  "accent-solid": "#0b6577",
  "on-accent-solid": "#ffffff",
  tint: "#dce8e6",
  ring: "#0b6577",
  danger: "#a3231a",
  "danger-solid": "#a3231a",
  success: "#1f6b3a",
  warning: "#7a4f00",
  "text-disabled": "#868e89",
  scrim: "rgba(18, 22, 26, 0.55)",
};

const DARK = {
  name: "dark / Ink",
  canvas: "#111415",
  surface: "#181c1d",
  raised: "#1f2425",
  sunken: "#212627",
  ink: "#e9ebe8",
  "ink-2": "#b4bab7",
  "ink-3": "#8f9795",
  "rule-subtle": "#2b3132",
  "rule-strong": "#68716e",
  accent: "#5fd6ec",
  "accent-solid": "#127a90",
  "on-accent-solid": "#ffffff",
  tint: "#1d2b2d",
  ring: "#8ce6f7",
  danger: "#ff8f85",
  "danger-solid": "#b3352b",
  success: "#7fd3a0",
  warning: "#e8c46a",
  "text-disabled": "#727a77",
  scrim: "rgba(5, 8, 9, 0.72)",
};

/** label, foreground token, background token, minimum ratio, criterion */
const PAIRS = [
  ["body text / canvas", "ink", "canvas", 4.5, "1.4.3"],
  ["body text / surface", "ink", "surface", 4.5, "1.4.3"],
  ["body text / sunken (table header)", "ink", "sunken", 4.5, "1.4.3"],
  ["body text / raised (dialog, menu)", "ink", "raised", 4.5, "1.4.3"],
  ["secondary text / surface", "ink-2", "surface", 4.5, "1.4.3"],
  ["secondary text / canvas", "ink-2", "canvas", 4.5, "1.4.3"],
  ["muted text / surface", "ink-3", "surface", 4.5, "1.4.3"],
  ["muted text / canvas", "ink-3", "canvas", 4.5, "1.4.3"],
  ["muted text / sunken (table header)", "ink-3", "sunken", 4.5, "1.4.3"],
  ["link + icon accent / surface", "accent", "surface", 4.5, "1.4.3"],
  ["link + icon accent / canvas", "accent", "canvas", 4.5, "1.4.3"],
  ["label on primary button", "on-accent-solid", "accent-solid", 4.5, "1.4.3"],
  ["label on danger button", "on-accent-solid", "danger-solid", 4.5, "1.4.3"],
  ["danger text / surface", "danger", "surface", 4.5, "1.4.3"],
  ["danger text / canvas", "danger", "canvas", 4.5, "1.4.3"],
  ["success text / surface", "success", "surface", 4.5, "1.4.3"],
  ["warning text / surface", "warning", "surface", 4.5, "1.4.3"],
  ["body text on selected row", "ink", "tint", 4.5, "1.4.3"],
  ["disabled label (exempt, kept legible)", "text-disabled", "surface", 3, "1.4.3 note"],
  ["focus ring / canvas", "ring", "canvas", 3, "1.4.11"],
  ["focus ring / surface", "ring", "surface", 3, "1.4.11"],
  ["focus ring / sunken", "ring", "sunken", 3, "1.4.11"],
  ["focus ring / selected row", "ring", "tint", 3, "1.4.11"],
  ["field + table border / surface", "rule-strong", "surface", 3, "1.4.11"],
  ["field + table border / canvas", "rule-strong", "canvas", 3, "1.4.11"],
  ["field + table border / sunken", "rule-strong", "sunken", 3, "1.4.11"],
  ["selected-row accent edge / tint", "accent", "tint", 3, "1.4.11 state"],
  ["primary button fill / surface", "accent-solid", "surface", 3, "1.4.11"],
  ["row divider / surface (decorative)", "rule-subtle", "surface", 1.2, "decorative"],
];

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Maps the report's names to the `--swiss-*` names used by swiss.css. */
const CSS_NAMES = {
  canvas: "canvas",
  surface: "surface",
  raised: "raised",
  sunken: "sunken",
  ink: "ink",
  "ink-2": "ink-2",
  "ink-3": "ink-3",
  "rule-subtle": "rule",
  "rule-strong": "rule-strong",
  accent: "accent",
  "accent-solid": "accent-solid",
  "on-accent-solid": "on-accent",
  tint: "tint",
  ring: "ring",
  danger: "danger",
  "danger-solid": "danger-solid",
  success: "success",
  warning: "warning",
  "text-disabled": "disabled",
};

/** Reads the two `:root[data-style="swiss"][data-theme=...]` blocks. */
function readSwissCss() {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(
    join(here, "..", "..", "desktop", "ui", "src", "swiss.css"),
    "utf8",
  );
  const blocks = {};
  const pattern = /:root\[data-style="swiss"\]\[data-theme="(light|dark)"\]\s*\{([^}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const values = {};
    for (const line of match[2].split(";")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      if (name.startsWith("--swiss-")) {
        values[name.slice("--swiss-".length)] = line.slice(colon + 1).trim();
      }
    }
    blocks[match[1]] = values;
  }
  return blocks;
}

/**
 * Fails when the implementation and this report disagree, so a palette edit
 * must be reflected in both places.
 */
function checkImplementation(cssBlocks) {
  const problems = [];
  for (const [mode, expected] of [["light", LIGHT], ["dark", DARK]]) {
    const actual = cssBlocks[mode];
    if (!actual) {
      problems.push(`swiss.css: missing the ${mode} palette block`);
      continue;
    }
    for (const [reportName, cssName] of Object.entries(CSS_NAMES)) {
      const wanted = expected[reportName];
      const found = actual[cssName];
      if (found !== wanted) {
        problems.push(
          `swiss.css (${mode}) --swiss-${cssName}: ${found ?? "missing"} != ${wanted}`,
        );
      }
    }
  }
  return problems;
}

function rgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function parse(color, over) {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgb(color);
  const [r, g, b, a = 1] = m[1].split(",").map((v) => parseFloat(v));
  const base = rgb(over);
  return [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)));
}

function luminance(channels) {
  const [r, g, b] = channels.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fgChannels, bgChannels) {
  const [hi, lo] = [luminance(fgChannels), luminance(bgChannels)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function hex(channels) {
  return "#" + channels.map((v) => v.toString(16).padStart(2, "0")).join("");
}

const implementation = checkImplementation(readSwissCss());
const rows = [];
let failed = implementation.length;

for (const theme of [LIGHT, DARK]) {
  const scrimOverCanvas = parse(theme.scrim, theme.canvas);
  for (const [label, fgName, bgName, min, criterion] of PAIRS) {
    const fg = parse(theme[fgName], theme.canvas);
    const bg = parse(theme[bgName], theme.canvas);
    const value = ratio(fg, bg);
    const pass = value >= min;
    if (!pass) failed += 1;
    rows.push([
      theme.name,
      label,
      `${fgName} ${hex(fg)}`,
      `${bgName} ${hex(bg)}`,
      `${value.toFixed(2)}:1`,
      `${min.toFixed(2)}:1`,
      criterion,
      pass ? "PASS" : "FAIL",
    ]);
  }

  // Scrim: the dialog surface is opaque, so the measurable edges are
  // (a) dialog surface vs the scrim-composited canvas and (b) the 1px dialog
  // border, which carries the separation when the scrim is very dark.
  const dialogVsScrim = ratio(parse(theme.raised, theme.canvas), scrimOverCanvas);
  const borderVsSurface = ratio(parse(theme["rule-strong"], theme.canvas), parse(theme.raised, theme.canvas));
  const composites = [
    ["dialog surface / scrimmed canvas", "raised", dialogVsScrim, 1.2, "visible edge"],
    ["dialog border / dialog surface", "rule-strong", borderVsSurface, 3, "1.4.11"],
  ];
  for (const [label, fgName, value, min, criterion] of composites) {
    const pass = value >= min;
    if (!pass) failed += 1;
    rows.push([
      theme.name,
      label,
      fgName,
      `scrim ${theme.scrim} over canvas`,
      `${value.toFixed(2)}:1`,
      `${min.toFixed(2)}:1`,
      criterion,
      pass ? "PASS" : "FAIL",
    ]);
  }
}

const header = ["Theme", "Pair", "Foreground", "Background", "Ratio", "Min", "WCAG", "Result"];
const md = [
  "| " + header.join(" | ") + " |",
  "|" + header.map(() => "---").join("|") + "|",
  ...rows.map((r) => `| ${r.join(" | ")} |`),
].join("\n");

console.log(md);
if (implementation.length > 0) {
  console.log("\nImplementation drift (swiss.css vs this report):");
  for (const problem of implementation) console.log(`  - ${problem}`);
}
console.log(`\n${rows.length} pairs checked, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
