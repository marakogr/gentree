// Both clarify actions must share one row and one width, wrapping to a single
// full-width column only on a very narrow window.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("./map.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = CSS.match(new RegExp(`\\n${escaped} \\{([^}]*)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("map clarify action styles", () => {
  it("lays the two actions out as equal-width columns", () => {
    const rule = ruleBody(".map-clarify-actions");
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(rule).not.toMatch(/flex-wrap/);
  });

  it("stretches each action to its column", () => {
    const rule = ruleBody(".map-clarify-actions > button");
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
  });

  it("falls back to one full-width action on a narrow window", () => {
    expect(CSS).toMatch(
      /@media \(max-width: 480px\) \{[\s\S]*?\.map-clarify-actions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
  });
});
