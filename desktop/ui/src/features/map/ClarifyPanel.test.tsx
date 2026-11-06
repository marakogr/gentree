import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClarifyFindButton } from "./ClarifyPanel";

function classes(html: string): string[] {
  const match = html.match(/class="([^"]*)"/);
  return match?.[1].split(/\s+/) ?? [];
}

const props = {
  label: "Find",
  searchingLabel: "Searching…",
  onClick: () => undefined,
};

describe("ClarifyFindButton", () => {
  it("keeps one layout class in the idle state", () => {
    const html = renderToStaticMarkup(
      <ClarifyFindButton {...props} loading={false} disabled={false} />,
    );
    expect(classes(html)).toContain("map-clarify-find");
    expect(html).toContain("Find");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toMatch(/\sdisabled(?:="")?[\s>]/);
  });

  it("keeps the same layout class while loading and announces it", () => {
    const html = renderToStaticMarkup(
      <ClarifyFindButton {...props} loading disabled={false} />,
    );
    expect(classes(html)).toContain("map-clarify-find");
    expect(html).toContain("Searching…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/\sdisabled(?:="")?[\s>]/);
  });
});
