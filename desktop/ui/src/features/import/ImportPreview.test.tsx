import { Badge } from "@fluentui/react-components";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportPreview } from "./ImportPreview";

const MARKUP = renderToStaticMarkup(
  <ImportPreview
    counts={[
      { key: "persons", label: "People: 12" },
      { key: "relationships", label: "Relations: 8" },
      { key: "events", label: "Events: 5" },
      { key: "media", label: "Media: 3" },
    ]}
    notes="1 warning, 2 issues"
    mediaNotice="Media files are copied"
  />,
);

function classAttribute(markup: string): string {
  const match = /class="([^"]*)"/.exec(markup);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function badgeClasses(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*\bfui-Badge\b[^"]*)"/g)].map(
    (match) => match[1],
  );
}

describe("ImportPreview", () => {
  it("renders every count, the warning summary and the media notice", () => {
    for (const label of [
      "People: 12",
      "Relations: 8",
      "Events: 5",
      "Media: 3",
      "1 warning, 2 issues",
      "Media files are copied",
    ]) {
      expect(MARKUP).toContain(label);
    }
    expect(MARKUP).toContain("import-preview");
    expect(MARKUP).toContain("import-counts");
  });

  it("omits the optional lines when they are null", () => {
    const markup = renderToStaticMarkup(
      <ImportPreview
        counts={[{ key: "persons", label: "People: 1" }]}
        notes={null}
        mediaNotice={null}
      />,
    );
    expect(markup).not.toContain("import-muted");
    expect(badgeClasses(markup)).toHaveLength(1);
  });

  it("uses the same neutral tint as the other project badges", () => {
    // The shared neutral badge is `appearance="tint" color="informative"`.
    // Comparing the generated class list keeps the check behavioural: dropping
    // the tone would fall back to the dark brand tint and fail here.
    const reference = renderToStaticMarkup(
      <Badge appearance="tint" color="informative" size="medium">
        reference
      </Badge>,
    );
    const expected = classAttribute(reference);
    const badges = badgeClasses(MARKUP);
    expect(badges).toHaveLength(4);
    for (const classes of badges) expect(classes).toBe(expected);
  });
});
