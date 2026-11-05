import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TreeSpouseToggle from "./TreeSpouseToggle";

describe("TreeSpouseToggle", () => {
  it("renders its off state and label", () => {
    const html = renderToStaticMarkup(
      <TreeSpouseToggle
        pressed={false}
        label="Show spouses"
        hint="Show partners next to relatives"
        onToggle={() => undefined}
      />,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Show spouses");
    expect(html).toContain('title="Show partners next to relatives"');
  });

  it("announces the pressed state", () => {
    const html = renderToStaticMarkup(
      <TreeSpouseToggle
        pressed
        label="Show spouses"
        hint="Show partners next to relatives"
        onToggle={() => undefined}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
  });
});
