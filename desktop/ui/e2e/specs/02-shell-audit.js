import { auditPage, focusState } from "../lib/audit.js";
import { save, shot } from "../lib/report.js";
import { consoleErrors, waitForShell } from "../lib/ui.js";

function summarize(label, audit) {
  const summary = {
    label,
    viewport: audit.viewport,
    scroll: audit.scroll,
    controls: audit.controls.length,
    unnamedControls: audit.unnamedControls.length,
    smallTargets: audit.smallTargets.length,
    contrastCandidates: audit.contrastIssues.length,
    overflowing: audit.overflow.length,
    i18nLeaks: audit.i18nLeaks,
  };
  // eslint-disable-next-line no-console
  console.log(`${label}: ${JSON.stringify(summary)}`);
  return summary;
}

describe("shell audit", () => {
  it("captures the empty state at the default window size", async () => {
    await waitForShell();
    await browser.pause(1200);

    const audit = await browser.execute(auditPage);
    save("shell-1200x800", audit);
    await shot("shell-1200x800");
    summarize("shell-1200x800", audit);

    expect(audit.bodyText.length).toBeGreaterThan(20);
    expect(await consoleErrors()).toEqual([]);
  });

  it("captures the minimum supported window size", async () => {
    try {
      await browser.setWindowSize(960, 600);
    } catch (error) {
      // tauri-driver cannot resize on every platform; the screenshot still
      // shows whatever the OS gave us.
      // eslint-disable-next-line no-console
      console.warn("window resize failed:", String(error).slice(0, 200));
    }
    await browser.pause(700);

    const audit = await browser.execute(auditPage);
    const actual = await browser.getWindowSize();
    const payload = { requested: { w: 960, h: 600 }, actual, ...audit };
    save("shell-960x600", payload);
    await shot("shell-960x600");
    summarize("shell-960x600", audit);
  });

  it("records the keyboard focus order and focus indicators", async () => {
    try {
      await browser.setWindowSize(1200, 800);
    } catch {
      // Keep the current size.
    }
    await browser.pause(500);

    const order = [];
    await browser.execute(() => document.body.focus());
    for (let step = 1; step <= 20; step += 1) {
      await browser.keys(["Tab"]);
      await browser.pause(120);
      const state = await browser.execute(focusState);
      if (state) order.push({ step, ...state });
    }

    save("focus-order", order);
    await shot("focus-order-last");

    // eslint-disable-next-line no-console
    console.log(
      "focus without a detectable indicator:",
      JSON.stringify(
        order
          .filter((item) => !item.indicator)
          .map((item) => `${item.tag}:${item.name || item.role}`),
      ),
    );
    expect(order.length).toBeGreaterThan(0);
  });
});

