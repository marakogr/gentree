// Occupation fact (#23): the facts section shows the distinct positions of
// OCCUPATION events as plain text, in timeline order. Nothing is clickable and
// there is no separate add action: jobs stay ordinary events.

import { save, shot } from "../lib/report.js";
import { consoleErrors, headingText, waitForShell } from "../lib/ui.js";

const PROJECT_NAME = `UX occupation ${new Date().toISOString().slice(0, 19)}`;

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

async function occupationFact() {
  return (await $('[data-testid="person-occupation"]')).getText();
}

async function addOccupation(position, date) {
  // The section header and the empty state both offer "New event" until the
  // first one exists; the header action is first in the DOM.
  const buttons = await $$('//button[contains(., "Новое событие")]');
  await buttons[0].click();

  const type = await $("#event-type");
  await type.waitForDisplayed({ timeout: 10000 });
  await type.selectByAttribute("value", "OCCUPATION");

  const detail = await $("#event-detail-position");
  await detail.waitForDisplayed({ timeout: 10000 });
  await detail.setValue(position);

  const dateInput = await $("#event-date");
  await dateInput.setValue(date);
  await browser.keys(["Enter"]);
  await browser.pause(200);
  expect(await dateInput.getValue()).toBe(date);

  await $('//button[normalize-space(.)="Создать"]').click();
  await browser.waitUntil(
    async () => !(await $("#event-detail-position").isExisting()),
    { timeout: 15000, timeoutMsg: "the event form did not close" },
  );
  await browser.pause(700);
}

describe("occupation fact", () => {
  it("shows unique positions in timeline order as plain text", async () => {
    await createProject();
    await createPerson("Иванов", "Иван", "Иванович");

    // Open the person card from the list row.
    await $('//tr[contains(., "Иванов")]').click();
    await browser.waitUntil(
      async () => (await $("#person-card-title")).isExisting(),
      { timeout: 10000, timeoutMsg: "the person card did not open" },
    );
    await browser.pause(600);

    await addOccupation("Плотник", "1970-01-01");
    expect(await occupationFact()).toBe("Плотник");

    await addOccupation("Бухгалтер", "1980-01-01");
    expect(await occupationFact()).toBe("Плотник, Бухгалтер");

    // A repeated role is not shown twice.
    await addOccupation("Плотник", "1990-01-01");
    expect(await occupationFact()).toBe("Плотник, Бухгалтер");

    // Plain text: no links or extra actions inside the fact.
    const links = await browser.execute(
      () =>
        document.querySelectorAll(
          '[data-testid="person-occupation"] a, [data-testid="person-occupation"] button',
        ).length,
    );
    expect(links).toBe(0);

    save("occupation-fact", { fact: await occupationFact() });
    await shot("occupation-fact");

    expect(await consoleErrors()).toEqual([]);
  });
});
