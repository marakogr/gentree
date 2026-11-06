import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClarifyActions } from "./ClarifyPanel";

const MARKUP = renderToStaticMarkup(
  <ClarifyActions
    applyLabel="Apply to the selected events"
    manualLabel="Point on the map"
    applyDisabled={false}
    manualDisabled={false}
    onApply={() => undefined}
    onManual={() => undefined}
  />,
);

describe("ClarifyActions", () => {
  it("renders both review actions in one labelled row", () => {
    expect(MARKUP).toContain("map-clarify-actions");
    expect(MARKUP).toContain("Apply to the selected events");
    expect(MARKUP).toContain("Point on the map");
    expect(MARKUP.match(/<button/g)).toHaveLength(2);
    expect(MARKUP).not.toContain("disabled");
  });

  it("keeps each action independently enabled", () => {
    const disabled = renderToStaticMarkup(
      <ClarifyActions
        applyLabel="Apply to the selected events"
        manualLabel="Point on the map"
        applyDisabled
        manualDisabled={false}
        onApply={() => undefined}
        onManual={() => undefined}
      />,
    );
    expect(disabled.match(/disabled/g)).toHaveLength(1);
  });
});
