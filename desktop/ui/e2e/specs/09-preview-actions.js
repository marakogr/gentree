// Import preview follow-up (#114) on the real window. The import dialog itself
// needs a native file picker that WebDriver cannot drive, so its badge tone and
// border are covered by the component/CSS tests next to the source. This spec
// covers the visible review actions that the issue groups with that preview:
// "apply to the selected events" and "point on the map" must sit in one row,
// share one width and keep their accessible names.
//
// Everything here is synthetic: no archive, path or personal record is read.

import { save, shot } from "../lib/report.js";
import { clickNav, consoleErrors, headingText, waitForShell } from "../lib/ui.js";

const PROJECT_NAME = `UX preview ${new Date().toISOString().slice(0, 19)}`;
const PERSON = "Проверочный Тест";
const PLACE = "Тестовый город";
const APPLY_LABEL = "Применить к выбранным событиям";
const MANUAL_LABEL = "Указать на карте";

async function createProject() {
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
  await browser.pause(600);
}

async function createPerson() {
  await $('[data-tour="persons-add"]').click();
  const surname = await $("#person-surname");
  await surname.waitForDisplayed({ timeout: 10000 });
  await surname.setValue("Проверочный");
  await $("#person-given").setValue("Тест");
  await $('//button[normalize-space(.)="Сохранить"]').click();
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () =>
          document.querySelector("#person-card-title")?.textContent?.trim() ??
          "",
      )) === PERSON,
    { timeout: 15000, timeoutMsg: `person ${PERSON} was not saved` },
  );
  await browser.pause(300);
}

/** A residence with a typed place but no confirmed point stays unresolved. */
async function createUnresolvedEvent() {
  await clickNav("События");
  await browser.waitUntil(async () => (await headingText()) === "События", {
    timeout: 10000,
  });
  await browser.pause(600);
  await $('[data-tour="events-add"]').click();
  const type = await $("#event-type");
  await type.waitForDisplayed({ timeout: 10000 });
  await type.selectByAttribute("value", "RESIDENCE");
  await browser.pause(400);

  const person = await $("#event-person");
  await person.click();
  await browser.pause(400);
  const option = await $(
    `//*[@role="option"][contains(., "${PERSON}")]`,
  );
  await option.waitForExist({ timeout: 5000 });
  await option.click();
  await browser.pause(300);

  const place = await $("#event-place");
  await place.setValue(PLACE);
  // Tab blurs the free-text combobox without closing the dialog (Escape would
  // dismiss the whole event form).
  await browser.keys(["Tab"]);
  await browser.pause(400);

  await $('//button[normalize-space(.)="Создать"]').click();
  await browser.waitUntil(
    async () => !(await $("#event-type").isExisting()),
    { timeout: 15000, timeoutMsg: "the event form did not close" },
  );
  await browser.pause(800);
}

async function openClarifyActions() {
  await clickNav("Карта");
  await browser.waitUntil(async () => (await headingText()) === "Карта", {
    timeout: 10000,
  });
  await browser.pause(1000);

  const open = await $('//button[normalize-space(.)="Места без координат"]');
  await open.waitForClickable({ timeout: 10000 });
  await open.click();
  await browser.pause(500);

  const row = await $(
    `//aside[@aria-label="Места без координат"]//button[contains(., "${PLACE}")]`,
  );
  await row.waitForClickable({ timeout: 10000 });
  await row.click();
  await browser.pause(500);
}

async function actionRects() {
  return browser.execute(
    (labels) => {
      const buttons = labels.map((label) =>
        [...document.querySelectorAll("button")].find(
          (candidate) => (candidate.textContent ?? "").trim() === label,
        ),
      );
      return {
        sameParent:
          buttons[0] !== undefined &&
          buttons[0].parentElement === buttons[1]?.parentElement,
        actions: buttons.map((button) => {
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          return { width: rect.width, top: rect.top, left: rect.left };
        }),
      };
    },
    [APPLY_LABEL, MANUAL_LABEL],
  );
}

describe("import preview follow-up", () => {
  it("keeps both clarify actions in one equal-width row", async () => {
    await createProject();
    await createPerson();
    await createUnresolvedEvent();
    await openClarifyActions();

    const { sameParent, actions } = await actionRects();
    const [apply, manual] = actions;
    expect(apply).not.toBeNull();
    expect(manual).not.toBeNull();
    expect(sameParent).toBe(true);

    // Equal width and one row: the labels wrap inside the buttons instead of
    // dropping one action below the other.
    expect(Math.abs(apply.width - manual.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(apply.top - manual.top)).toBeLessThanOrEqual(1);
    expect(manual.left).toBeGreaterThan(apply.left);

    save("preview-actions", { sameParent, apply, manual });
    await shot("preview-actions");
    expect(await consoleErrors()).toEqual([]);
  });
});
