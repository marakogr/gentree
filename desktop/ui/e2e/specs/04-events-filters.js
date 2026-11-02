// Event filters (#18): the person picker with avatars and the multi-select
// event-type dropdown. Creates its own project and people, then drives the
// filters with the keyboard exactly as a user would.

import { auditPage } from "../lib/audit.js";
import { save, shot } from "../lib/report.js";
import { clickNav, consoleErrors, headingText, waitForShell } from "../lib/ui.js";

const PROJECT_NAME = `UX filters ${new Date().toISOString().slice(0, 19)}`;

const TYPE_TRIGGER = 'button[aria-haspopup="listbox"]';
const TYPE_LIST = '[role="listbox"][aria-multiselectable="true"]';
const TYPE_SEARCH = 'input[aria-label="Поиск типов"]';
const PERSON_INPUT = "#events-person-filter";

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
  const saveButton = await $('//button[normalize-space(.)="Сохранить"]');
  await saveButton.click();
  await browser.waitUntil(async () => (await bodyText()).includes(surname), {
    timeout: 10000,
    timeoutMsg: `person ${surname} was not saved`,
  });
  await browser.pause(400);
}

async function triggerText() {
  return browser.execute(
    (selector) => document.querySelector(selector)?.textContent?.trim() ?? "",
    TYPE_TRIGGER,
  );
}

async function selectedCount() {
  return browser.execute(
    (selector) =>
      document.querySelectorAll(`${selector} [role="option"][aria-selected="true"]`)
        .length,
    TYPE_LIST,
  );
}

async function optionTexts() {
  return browser.execute(
    (selector) =>
      [...document.querySelectorAll(`${selector} [role="option"]`)].map((item) =>
        (item.textContent ?? "").trim(),
      ),
    TYPE_LIST,
  );
}

async function openTypes() {
  await (await $(TYPE_TRIGGER)).click();
  await (await $(TYPE_LIST)).waitForDisplayed({ timeout: 5000 });
}

async function closeTypes() {
  await browser.keys(["Escape"]);
  await browser.pause(300);
}

describe("event filters", () => {
  it("creates two people to feed the person filter", async () => {
    await createProject();
    await createPerson("Иванов", "Иван", "Иванович");
    await createPerson("Петрова", "Анна", "Сергеевна");

    const text = await bodyText();
    expect(text).toContain("Иванов");
    expect(text).toContain("Петрова");
  });

  it("shows the shared person picker with avatars and name search", async () => {
    await clickNav("События");
    await browser.pause(800);

    const input = await $(PERSON_INPUT);
    await input.waitForDisplayed({ timeout: 10000 });
    // The empty value is "all people", so the field says so before any pick.
    expect(await input.getValue()).toBe("Все люди");

    await input.click();
    const allRow = await $('//*[@role="option"][contains(., "Все люди")]');
    await allRow.waitForExist({ timeout: 5000 });

    await input.setValue("Иван");
    await browser.pause(500);

    const avatars = await browser.execute(
      () => document.querySelectorAll(".person-search-avatar").length,
    );
    const initials = await browser.execute(
      () =>
        document.querySelector(".person-search-initials")?.textContent?.trim() ??
        "",
    );
    expect(avatars).toBeGreaterThan(0);
    expect(initials.length).toBeGreaterThan(0);

    const person = await $('//*[@role="option"][contains(., "Иванов")]');
    await person.click();
    await browser.pause(500);
    expect(await input.getValue()).toContain("Иванов");

    // Clearing returns to the "all people" state instead of an empty field.
    // Fluent renders the clear affordance as a hidden span, not a button.
    const clear = await $(".fui-Combobox__clearIcon");
    await clear.click();
    await browser.pause(400);
    expect(await input.getValue()).toBe("Все люди");
    // The clear icon can leave the suggestion list open; focus the field and
    // close it so the next click lands on the type dropdown instead of
    // dismissing an overlay.
    await browser.execute(() => {
      document.querySelector("#events-person-filter")?.focus();
    });
    await browser.keys(["Escape"]);
    await browser.pause(400);

    save("filters-person", {
      avatars,
      initials,
      value: await input.getValue(),
    });
    await shot("filters-person");
    expect(await consoleErrors()).toEqual([]);
  });

  it("selects several event types in the dropdown and keeps icons", async () => {
    const trigger = await $(TYPE_TRIGGER);
    await trigger.waitForDisplayed({ timeout: 10000 });
    expect((await trigger.getText()).trim()).toBe("Все типы");
    expect(await trigger.getAttribute("aria-haspopup")).toBe("listbox");

    await openTypes();
    const all = await optionTexts();
    expect(all[0]).toBe("Все типы");
    expect(all.length).toBe(10);
    const icons = await browser.execute(
      (selector) =>
        document.querySelectorAll(`${selector} .multi-select-icon svg`).length,
      TYPE_LIST,
    );
    expect(icons).toBe(9);

    const search = await $(TYPE_SEARCH);
    await search.setValue("рожд");
    await browser.pause(300);
    expect(await optionTexts()).toEqual(["Все типы", "Рождение"]);

    // Enter takes the first real match, not the fixed "all" row.
    await browser.keys(["Enter"]);
    await browser.pause(300);
    expect((await triggerText()).trim()).toBe("Рождение");
    const iconInValue = await browser.execute(
      (selector) =>
        document.querySelectorAll(`${selector} .multi-select-trigger-icon svg`)
          .length,
      TYPE_TRIGGER,
    );
    expect(iconInValue).toBe(1);
    await shot("filters-types-one");

    await closeTypes();
    expect(await $(TYPE_LIST).isExisting()).toBe(false);
    const focusOnTrigger = await browser.execute(
      (selector) => document.activeElement === document.querySelector(selector),
      TYPE_TRIGGER,
    );
    expect(focusOnTrigger).toBe(true);

    // Reopening starts from an empty search, so the whole list is back.
    await openTypes();
    expect(await optionTexts()).toHaveLength(10);
    const death = await $('//*[@role="option"][contains(., "Смерть")]');
    await death.click();
    await browser.pause(300);
    expect((await triggerText()).trim()).toBe("2 типа");
    expect(await selectedCount()).toBe(2);
    await shot("filters-types-two");

    await closeTypes();

    // The all-row clears the selection again.
    await openTypes();
    await $('//*[@role="option"][contains(., "Все типы")]').click();
    await browser.pause(300);
    expect((await triggerText()).trim()).toBe("Все типы");
    expect(await selectedCount()).toBe(1); // only the all-row is selected

    const audit = await browser.execute(auditPage);
    save("filters-types", {
      options: all,
      icons,
      trigger: await triggerText(),
      selected: await selectedCount(),
      unnamedControls: audit.unnamedControls.length,
    });
    await shot("filters-types");
    expect(await consoleErrors()).toEqual([]);
  });
});
