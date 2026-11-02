// Small helpers shared by the specs.
//
// Selectors deliberately use roles and accessible names instead of CSS classes:
// the review should break when the UI stops being usable with a keyboard or a
// screen reader, not when a class is renamed.

export async function waitForShell() {
  await browser.waitUntil(
    async () => (await browser.getTitle()) === "Gentree",
    { timeout: 20000, timeoutMsg: "the Gentree window did not attach" },
  );
}

export function navButton(label) {
  return $(
    `//*[@role="navigation"]//button[normalize-space(.)="${label}"]`,
  );
}

export async function clickNav(label) {
  const button = await navButton(label);
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await browser.pause(600);
}

/** Visible page heading; empty when a screen renders no title at all. */
export async function headingText() {
  return browser.execute(() => {
    const heading = document.querySelector("h1, [role='heading']");
    return (heading?.textContent || "").replace(/\s+/g, " ").trim();
  });
}

/** Severe browser console entries; WebView2 may report none at all. */
export async function consoleErrors() {
  const logs = await browser.getLogs("browser").catch(() => []);
  return logs
    .filter((entry) => entry.level === "SEVERE" || entry.level === "ERROR")
    .map((entry) => entry.message.slice(0, 300));
}
