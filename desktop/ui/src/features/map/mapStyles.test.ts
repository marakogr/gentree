// Visual contract for the coordinate search panel (issue #113): the Find
// button must not depend on its current label, and a chosen suggestion uses the
// shared light-grey list surface rather than the brand tint. Layout itself is
// covered by the WebDriver batch (#105), so these rules are pinned by selector.
// Both clarify actions must share one row and one width, wrapping to a single
// full-width column only on a very narrow window.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./map.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{([^}]*)\\}`));
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("coordinate search styles", () => {
  it("sizes the Find button from the layout, not from its label", () => {
    const rule = ruleBody(".map-clarify-find");
    expect(rule).toMatch(/box-sizing:\s*border-box/);
    expect(rule).toMatch(/inline-size:\s*100%/);
    expect(rule).toMatch(/min-inline-size:/);
    expect(rule).toMatch(/justify-content:\s*center/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });

  it("paints a selected suggestion with the shared light-grey token", () => {
    const rule = ruleBody(".map-candidate-selected");
    expect(rule).toMatch(/background:\s*var\(--colorSubtleBackgroundSelected/);
    expect(rule).not.toMatch(/colorBrandBackground2/);
  });

  it("keeps hover and focus readable on the same list surface", () => {
    expect(ruleBody(".map-candidate:hover:not(:disabled)")).toMatch(
      /background:\s*var\(--colorSubtleBackgroundHover/,
    );
    expect(ruleBody(".map-candidate:focus-visible")).toMatch(
      /outline:\s*2px solid var\(--colorStrokeFocus2/,
    );
  });
});

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
    expect(css).toMatch(
      /@media \(max-width: 480px\) \{[\s\S]*?\.map-clarify-actions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
  });
});
