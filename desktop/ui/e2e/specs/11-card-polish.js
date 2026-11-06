// Card and table polish (#131): the person/event card headers, the relationship
// table, the single attach action, thin scrollbars and the neutral column-resize
// handle. Synthetic data only: no archive, path or personal record is read.

import { save, shot } from "../lib/report.js";
import {
  clickNav,
  consoleErrors,
  headingText,
  waitForShell,
} from "../lib/ui.js";

const PROJECT_NAME = `UX polish ${new Date().toISOString().slice(0, 19)}`;
const CHILD = "Полиров Тест";
const PARENT = "Полиров Отец";

async function cardTitle() {
  return browser.execute(
    () =>
      document.querySelector("#person-card-title")?.textContent?.trim() ?? "",
  );
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
  await browser.pause(600);
}

async function createPerson(surname, given, birth) {
  await $('[data-tour="persons-add"]').click();
  const surnameInput = await $("#person-surname");
  await surnameInput.waitForDisplayed({ timeout: 10000 });
  await surnameInput.setValue(surname);
  await $("#person-given").setValue(given);
  const date = await $("#person-birth-date");
  await date.setValue(birth);
  await browser.keys(["Enter"]);
  await browser.pause(200);
  await $('//button[normalize-space(.)="Сохранить"]').click();
  const expected = `${surname} ${given}`;
  await browser.waitUntil(
    async () => (await cardTitle()).toLowerCase() === expected.toLowerCase(),
    { timeout: 15000, timeoutMsg: `person ${expected} was not saved` },
  );
  await browser.pause(300);
}

async function openPerson(name) {
  const link = await $(
    `//button[contains(@class,"person-name")][normalize-space(.)="${name}"]`,
  );
  await link.waitForClickable({ timeout: 10000 });
  await link.click();
  await browser.waitUntil(async () => (await cardTitle()) === name, {
    timeout: 10000,
    timeoutMsg: `card for ${name} did not open`,
  });
  await browser.pause(300);
}

async function addParentFromCard(parentName) {
  await $('//button[normalize-space(.)="Добавить связь"]').click();
  const form = await $("form.person-relationship-form");
  await form.waitForDisplayed({ timeout: 5000 });
  const related = await $('[aria-label="Кто"]');
  await related.waitForClickable({ timeout: 10000 });
  await related.click();
  await browser.pause(400);
  if ((await $$('//*[@role="option"]')).length === 0) {
    await related.click();
    await browser.pause(400);
  }
  const option = await $(`//*[@role="option"][contains(., "${parentName}")]`);
  await option.waitForExist({ timeout: 5000 });
  await option.waitForClickable({ timeout: 5000 });
  await option.click();
  await browser.pause(300);
  await form.$('button[type="submit"]').click();
  await browser.waitUntil(
    async () =>
      !(await $("form.person-relationship-form").isExisting()) ||
      (await $('[role="alert"]').isExisting()),
    { timeout: 10000, timeoutMsg: "the relationship form did not settle" },
  );
  await browser.pause(600);
}

/** Geometry of the card header actions and the section add control. */
async function cardMetrics() {
  return browser.execute(() => {
    const buttons = [...document.querySelectorAll(".person-card-actions button")];
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        centerY: rect.top + rect.height / 2,
      };
    };
    const add = [...document.querySelectorAll(".person-section-head button")].find(
      (button) => (button.textContent ?? "").includes("Новое событие"),
    );
    const title = [...document.querySelectorAll(".person-section-title")].find(
      (element) => (element.textContent ?? "").includes("События"),
    );
    const list = document.querySelector(".persons-list");
    return {
      actions: buttons.map((button) => ({
        label: button.getAttribute("aria-label") ?? "",
        text: (button.textContent ?? "").trim(),
        box: box(button),
      })),
      addHasIcon: Boolean(add?.querySelector("svg")),
      addCenterY: add ? box(add).centerY : null,
      titleCenterY: title ? box(title).centerY : null,
      tableHeaders: document.querySelectorAll(".person-card table thead").length,
      tableText:
        document.querySelector(".person-card table")?.innerText ?? "",
      attachButtons: [...document.querySelectorAll(".person-card button")].filter(
        (button) => (button.textContent ?? "").trim() === "Приложить файл",
      ).length,
      listScrollbar: list ? list.offsetWidth - list.clientWidth : null,
      listScrollbarWidth: list
        ? getComputedStyle(list).scrollbarWidth
        : null,
    };
  });
}

describe("card and table polish", () => {
  it("aligns the add action and tidies the card controls", async () => {
    await createProject();
    await createPerson("Полиров", "Отец", "1950-03-01");
    await createPerson("Полиров", "Тест", "1990-05-05");
    await openPerson(CHILD);
    await addParentFromCard(PARENT);
    await browser.pause(500);

    const metrics = await cardMetrics();
    // 1: the "+" is an icon inside the button label, on the title's line.
    expect(metrics.addHasIcon).toBe(true);
    expect(
      Math.abs(metrics.addCenterY - metrics.titleCenterY),
    ).toBeLessThanOrEqual(2);

    // 2: the relationship table keeps its rows but drops the header row.
    expect(metrics.tableHeaders).toBe(0);
    expect(metrics.tableText).not.toContain("Тип связи");
    expect(metrics.tableText).toContain(PARENT);

    // 3: the editor is a pencil with an accessible name and no text.
    const edit = metrics.actions.find((action) => action.label === "Изменить");
    expect(edit).toBeTruthy();
    expect(edit.text).toBe("");

    // 4: the close control is the rightmost header action.
    const rightmost = metrics.actions.reduce((best, action) =>
      action.box.right > best.box.right ? action : best,
    );
    expect(rightmost.label).toBe("Закрыть карточку");

    // 5: the files section offers exactly one attach action.
    expect(metrics.attachButtons).toBe(1);

    // 6: the list scrollbar stays thin (no overflow here, so 0 is expected;
    // a thin platform scrollbar is around 11px, never the old thick slab).
    expect(metrics.listScrollbar).toBeLessThanOrEqual(12);
    expect(["thin", "auto"]).toContain(metrics.listScrollbarWidth);

    save("polish-person-card", metrics);
    await shot("polish-person-card");
    expect(await consoleErrors()).toEqual([]);
  });

  it("leaves the resize handle neutral after a keyboard resize", async () => {
    const handle = await $(".col-resize-handle");
    await handle.waitForDisplayed({ timeout: 10000 });
    const before = await handle.getAttribute("aria-valuenow");
    await browser.execute(() => {
      document.querySelector(".col-resize-handle")?.focus();
    });
    await browser.keys(["ArrowRight"]);
    await browser.pause(300);

    const state = await browser.execute(() => {
      const element = document.querySelector(".col-resize-handle");
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        outline: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
        selection: window.getSelection()?.toString() ?? "",
        value: element.getAttribute("aria-valuenow"),
        focused: document.activeElement === element,
      };
    });
    expect(state).not.toBeNull();
    expect(state.outline).toBe("none");
    expect(state.boxShadow).toBe("none");
    expect(state.selection).toBe("");
    expect(state.value).not.toBe(before);

    save("polish-resize", { before, ...state });
    await shot("polish-resize");
    expect(await consoleErrors()).toEqual([]);
  });

  it("labels the event card pencil and keeps close on the right", async () => {
    await clickNav("События");
    await browser.waitUntil(async () => (await headingText()) === "События", {
      timeout: 10000,
    });
    await browser.pause(700);
    const row = await $('//tr[contains(., "Рождение")]');
    await row.waitForClickable({ timeout: 10000 });
    await row.click();
    const card = await $(".events-card");
    await card.waitForDisplayed({ timeout: 10000 });
    await browser.pause(300);

    const metrics = await browser.execute(() => {
      const buttons = [...document.querySelectorAll(".events-card-actions button")];
      return buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label") ?? "",
          text: (button.textContent ?? "").trim(),
          right: rect.right,
        };
      });
    });
    const edit = metrics.find((action) => action.label === "Изменить");
    expect(edit).toBeTruthy();
    expect(edit.text).toBe("");
    const rightmost = metrics.reduce((best, action) =>
      action.right > best.right ? action : best,
    );
    expect(rightmost.label).toBe("Закрыть");

    save("polish-event-card", metrics);
    await shot("polish-event-card");
    expect(await consoleErrors()).toEqual([]);
  });
});
