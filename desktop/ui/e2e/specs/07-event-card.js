// Event card (#17): a row click opens the side card instead of the form; the
// card shows the event facts, opens the form for editing and in a full window,
// and closing it clears the row selection.

import { save, shot } from "../lib/report.js";
import { consoleErrors, headingText, waitForShell } from "../lib/ui.js";

const PROJECT_NAME = `UX event card ${new Date().toISOString().slice(0, 19)}`;

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

async function addEvent() {
  const buttons = await $$('//button[contains(., "Новое событие")]');
  await buttons[0].click();

  const type = await $("#event-type");
  await type.waitForDisplayed({ timeout: 10000 });
  await type.selectByAttribute("value", "RESIDENCE");

  const date = await $("#event-date");
  await date.setValue("1990-01-01");
  await browser.keys(["Enter"]);
  await browser.pause(200);
  expect(await date.getValue()).toBe("1990-01-01");

  await $("#event-place").setValue("Казань");
  await $("#event-note").setValue("Тестовая запись");

  await $('//button[normalize-space(.)="Создать"]').click();
  await browser.waitUntil(
    async () => !(await $("#event-date").isExisting()),
    { timeout: 15000, timeoutMsg: "the event form did not close" },
  );
  await browser.pause(800);
}

describe("event card", () => {
  it("opens on a row click and edits through the card", async () => {
    await createProject();
    await createPerson("Иванов", "Иван", "Иванович");

    await $('//nav//button[normalize-space(.)="События"]').click();
    await browser.waitUntil(async () => (await headingText()) === "События", {
      timeout: 10000,
    });
    await browser.pause(700);

    await addEvent();
    const row = await $('//tr[contains(., "Место жительства")]');
    await row.click();

    const card = await $(".events-card");
    await card.waitForDisplayed({ timeout: 10000 });
    // The kicker is uppercased in CSS, which also uppercases the rendered text.
    const cardText = (await card.getText()).toLowerCase();
    expect(cardText).toContain("место жительства");
    expect(cardText).toContain("казань");
    expect(cardText).toContain("тестовая запись");
    expect(cardText).toContain("иванов иван иванович");
    expect(cardText).toContain("файлы");

    // The form opens from the card in the full window and closes back to it.
    await $('//button[normalize-space(.)="Изменить"]').click();
    await (await $("#event-type")).waitForDisplayed({ timeout: 10000 });
    const surface = await $(".fui-DialogSurface");
    const size = await surface.getSize();
    expect(size.width).toBeGreaterThan(800);
    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(400);
    expect(await $(".events-card").isExisting()).toBe(true);

    save("event-card", { text: cardText, fullWidth: size.width });
    await shot("event-card");

    // Closing the card clears the selection.
    const openCard = await $(".events-card");
    await (await openCard.$('button[aria-label="Закрыть"]')).click();
    await browser.pause(400);
    expect(await $(".events-card").isExisting()).toBe(false);

    expect(await consoleErrors()).toEqual([]);
  });
});
