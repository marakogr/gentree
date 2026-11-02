// Guards against tooling-injected "\n" escapes inside CSS (a real regression
// from a scripted edit: the rule silently does nothing and the build fails).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["../styles.css", "../theme.css"];

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
