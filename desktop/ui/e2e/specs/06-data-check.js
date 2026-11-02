// Data-check popup (#19): the anomaly badge on Events opens the same report the
// project check screen renders, without leaving the events screen.

import { save, shot } from "../lib/report.js";
import { consoleErrors, headingText, waitForShell } from "../lib/ui.js";

const PROJECT_NAME = `UX check ${new Date().toISOString().slice(0, 19)}`;

async function bodyText() {
  return browser.execute(() => document.body.innerText);
}

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
}

async function createPerson(surname, given, patronymic) {
  await $('[data-tour="persons-add"]').click();
  const surnameInput = await $("#person-surname");
  await surnameInput.waitForDisplayed({ timeout: 10000 });
  await surnameInput.setValue(surname);
  await $("#person-given").setValue(given);
  await $("#person-patronymic").setValue(patronymic);
  await $('//button[normalize-space(.)="Сохранить"]').click();
  await browser.waitUntil(async () => (await bodyText()).includes(surname), {
    timeout: 10000,
    timeoutMsg: `person ${surname} was not saved`,
  });
  await browser.pause(400);
}

async function addEvent(type, date) {
  const buttons = await $$('//button[contains(., "Новое событие")]');
  await buttons[0].click();

  const typeSelect = await $("#event-type");
  await typeSelect.waitForDisplayed({ timeout: 10000 });
  await typeSelect.selectByAttribute("value", type);

  const dateInput = await $("#event-date");
  await dateInput.setValue(date);
  await browser.keys(["Enter"]);
  await browser.pause(200);
  expect(await dateInput.getValue()).toBe(date);

  await $('//button[normalize-space(.)="Создать"]').click();
  await browser.waitUntil(
    async () => !(await $("#event-date").isExisting()),
    { timeout: 15000, timeoutMsg: "the event form did not close" },
  );
  await browser.pause(700);
}

async function setBirthDate(date) {
  // The person card edits the same entity the report validates.
  await $('//tr[contains(., "Иванов")]').click();
  await browser.waitUntil(
    async () => (await $("#person-card-title")).isExisting(),
    { timeout: 10000, timeoutMsg: "the person card did not open" },
  );
  await $('//button[normalize-space(.)="Изменить"]').click();

  // An edited person may start with UNKNOWN precision (plain text field); a
  // calendar date needs DAY precision so the wheel parses it.
  await (
    await $("#person-birth-precision")
  ).selectByAttribute("value", "DAY");
  await browser.pause(300);

  const birth = await $("#person-birth-date");
  await birth.waitForDisplayed({ timeout: 10000 });
  await birth.setValue(date);
  // Leave the field with Tab to commit the parsed date; Enter submits the form.
  await browser.keys(["Tab"]);
  await browser.pause(300);

  await $('//button[normalize-space(.)="Сохранить"]').click();
  await browser.waitUntil(
    async () => !(await $("#person-birth-date").isExisting()),
    { timeout: 15000, timeoutMsg: "the person form did not close" },
  );
  await browser.pause(700);
}

describe("data-check popup", () => {
  it("opens the validation report from the anomaly badge", async () => {
    await createProject();
    await createPerson("Иванов", "Иван", "Иванович");

    await $('//nav//button[normalize-space(.)="События"]').click();
    await browser.waitUntil(async () => (await headingText()) === "События", {
      timeout: 10000,
    });
    await browser.pause(700);

    // An event before the (later) birth date makes the badge and the backend
    // report agree on the same problem.
    await addEvent("RESIDENCE", "1990-01-01");
    await $('//nav//button[normalize-space(.)="Люди"]').click();
    await browser.pause(600);
    await setBirthDate("2000-01-01");
    await $('//nav//button[normalize-space(.)="События"]').click();
    await browser.pause(700);

    const badge = await $(".events-anomalies");
    await badge.waitForDisplayed({ timeout: 10000 });
    // The old shortcut button is gone: the badge itself is the entry point.
    expect(
      await $$('//button[normalize-space(.)="Проверить данные"]'),
    ).toHaveLength(0);

    await badge.click();
    const report = await $(".projects-report");
    await report.waitForDisplayed({ timeout: 15000 });
    const reportText = (await report.getText()).trim();
    expect(reportText.length).toBeGreaterThan(0);
    const issues = await $$(".projects-issue");
    expect(issues.length).toBeGreaterThan(0);

    // Still on Events, not on Projects.
    expect(await headingText()).toBe("События");

    save("data-check", { report: reportText, heading: await headingText() });
    await shot("data-check");

    await $('//button[normalize-space(.)="Закрыть"]').click();
    await browser.pause(400);
    expect(await $(".projects-report").isExisting()).toBe(false);

    expect(await consoleErrors()).toEqual([]);
  });
});
