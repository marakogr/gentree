// Guards against tooling-injected "\n" escapes inside CSS (a real regression
// from a scripted edit: the rule silently does nothing and the build fails).
// Also pins the node caption clamp, which has no DOM test of its own.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["../styles.css", "../theme.css"];

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{([^}]*)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("stylesheets", () => {
  it.each(FILES)("%s has no escaped line breaks", (file) => {
    const css = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(css).not.toMatch(/\\n/);
    expect(css).not.toMatch(/\\r/);
  });

  it.each(FILES)("%s keeps braces balanced", (file) => {
    const css = readFileSync(new URL(file, import.meta.url), "utf8");
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe("person captions", () => {
  const css = readFileSync(
    new URL("../styles.css", import.meta.url),
    "utf8",
  );

  it.each([".graph-node-name", ".path-node-name"])(
    "%s wraps and clamps to three lines",
    (selector) => {
      const rule = ruleBody(css, selector);
      expect(rule).toMatch(/display:\s*-webkit-box/);
      expect(rule).toMatch(/-webkit-box-orient:\s*vertical/);
      expect(rule).toMatch(/-webkit-line-clamp:\s*3/);
      expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule).not.toMatch(/white-space:\s*nowrap/);
    },
  );
});

// Issue #115: the sidebar gutter, the gaps between page blocks and the
// page-internal rows must share one shell step (SH-1). The pages read the
// token instead of repeating a pixel value, so they stay aligned.
describe("shell rhythm", () => {
  const css = readFileSync(
    new URL("../styles.css", import.meta.url),
    "utf8",
  );

  it("declares one shell spacing step and derives the page height from it", () => {
    const root = ruleBody(css, ":root");
    expect(root).toMatch(/--shell-space:\s*16px/);
    expect(root).toMatch(/--shell-page-height:\s*calc\(/);
    expect(root).toContain("var(--shell-space) * 2");
  });

  it("derives the content gutter and gap from the shell step", () => {
    const content = ruleBody(css, ".content");
    expect(content).toMatch(/gap:\s*var\(--shell-space\)/);
    expect(content).toMatch(/padding:\s*var\(--shell-space\)/);
  });

  it.each([
    ["../features/persons/persons.css", ".persons-page"],
    ["../features/events/events.css", ".events-page"],
  ])("%s uses the shell step for its page frame", (file, selector) => {
    const pageCss = readFileSync(new URL(file, import.meta.url), "utf8");
    const page = ruleBody(pageCss, selector);
    expect(page).toMatch(/gap:\s*var\(--shell-space\)/);
    expect(page).toMatch(/height:\s*var\(--shell-page-height\)/);
    expect(page).not.toMatch(/calc\(100vh/);
  });
});
