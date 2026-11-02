import { save, shot } from "../lib/report.js";
import { consoleErrors, waitForShell } from "../lib/ui.js";

describe("smoke", () => {
  it("attaches to the isolated Tauri window", async () => {
    await waitForShell();

    const title = await browser.getTitle();
    const url = await browser.getUrl();
    const windowSize = await browser.getWindowSize();
    const page = await browser.execute(() => ({
      lang: document.documentElement.lang,
      theme: document.documentElement.getAttribute("data-theme"),
      text: document.body.innerText.slice(0, 600),
    }));

    save("smoke", { title, url, windowSize, ...page });
    await shot("smoke");

    // The harness forces GENTREE_APP_LANGUAGE=ru; a different locale means the
    // environment did not reach the app and every text selector is unreliable.
    expect(page.lang).toMatch(/^ru/);
    expect(page.text.length).toBeGreaterThan(20);
    expect(await consoleErrors()).toEqual([]);
  });
});

