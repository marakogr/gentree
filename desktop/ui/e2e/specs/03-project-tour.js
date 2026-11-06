import { auditPage } from "../lib/audit.js";
import { save, shot } from "../lib/report.js";
import { measureShellSpacing } from "../lib/spacing.js";
import {
  clickNav,
  consoleErrors,
  headingText,
  waitForShell,
} from "../lib/ui.js";

const PROJECT_NAME = `UX review ${new Date().toISOString().slice(0, 19)}`;

/** Russian label -> artifact slug. Order follows the project sidebar. */
const PAGES = [
  ["Люди", "persons"],
  ["События", "events"],
  ["Карта", "map"],
  ["Хронология", "timeline"],
  ["Дерево", "graph"],
  ["Родство", "kinship"],
  ["Поиск", "search"],
  ["Чат", "chat"],
  ["Настройки", "settings"],
  ["Проекты", "projects"],
];

describe("project tour", () => {
  it("creates a synthetic project through the header dialog", async () => {
    await waitForShell();
    await browser.pause(800);

    await $(".projects-create-open").click();

    const input = await $('input[placeholder="Название проекта"]');
    await input.waitForDisplayed({ timeout: 10000 });
    await input.setValue(PROJECT_NAME);
    await $(".projects-create-submit").click();

    await browser.waitUntil(async () => (await headingText()) === "Люди", {
      timeout: 20000,
      timeoutMsg: "the new project did not open",
    });

    const audit = await browser.execute(auditPage);
    save("project-created", audit);
    await shot("project-created");
    // eslint-disable-next-line no-console
    console.log("created project:", PROJECT_NAME);
  });

  it("visits every project section and captures evidence", async () => {
    expect(await headingText()).not.toBe("");

    for (const [label, slug] of PAGES) {
      await clickNav(label);
      const heading = await headingText();
      const audit = await browser.execute(auditPage);

      save(`page-${slug}`, { label, heading, ...audit });
      await shot(`page-${slug}`);

      // eslint-disable-next-line no-console
      console.log(
        `${slug}: heading="${heading}" controls=${audit.controls.length} unnamed=${audit.unnamedControls.length} small=${audit.smallTargets.length} contrast=${audit.contrastIssues.length} overflow=${audit.overflow.length} i18n=${JSON.stringify(audit.i18nLeaks)}`,
      );

      if (slug === "timeline") {
        // The person filter is shared with the events screen and defaults to
        // "all people"; the placeholder is the shared filter-row copy.
        const person = await $("#timeline-focus-person");
        await person.waitForDisplayed({ timeout: 5000 });
        expect(await person.getValue()).toBe("Все люди");
        expect(await person.getAttribute("placeholder")).toBe(
          "Начните вводить имя",
        );
        await shot("timeline-filters-empty");
      }

      if (!heading) {
        throw new Error(`section ${label} renders no heading`);
      }
      expect(heading).not.toBe("");

      // Issue #115: the sidebar → page block gutter and the page-internal row
      // step are the same token, on every screen that shows a page block.
      if (["persons", "events", "graph", "kinship"].includes(slug)) {
        const spacing = await browser.execute(measureShellSpacing);
        expect(spacing).not.toBeNull();
        save(`spacing-${slug}`, spacing);
        // eslint-disable-next-line no-console
        console.log(`spacing ${slug}: ${JSON.stringify(spacing)}`);
        expect(spacing.gutter).toBe(spacing.gap);
        if (spacing.pageGap !== null) {
          expect(spacing.pageGap).toBe(spacing.gap);
        }
      }
    }

    expect(await consoleErrors()).toEqual([]);
  });
});
