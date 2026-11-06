// The preview block used to draw a `--border` frame that reads as a black box
// in the dark theme. These rules keep a quiet tinted surface without a border.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("./import.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = CSS.match(new RegExp(`\\n${escaped} \\{([^}]*)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("import preview styles", () => {
  it("keeps a tinted surface and no frame", () => {
    const rule = ruleBody(".import-preview");
    expect(rule).toMatch(/background:/);
    expect(rule).not.toMatch(/(^|[\s;])border\s*:/m);
    expect(rule).not.toMatch(/outline\s*:/);
  });
});
