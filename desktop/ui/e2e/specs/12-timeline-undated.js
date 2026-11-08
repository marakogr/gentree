// Timeline drawer field parity (#144): an event without a date opens from the
// undated list and shows the same field set as the events card — date,
// precision, place, participants, description, detail fields and files — never
// an invented date. Synthetic data only.

import { save, shot } from "../lib/report.js";
import {
  clickNav,
  consoleErrors,
  headingText,
  waitForShell,
} from "../lib/ui.js";

const PROJECT_NAME = `UX undated ${new Date().toISOString().slice(0, 19)}`;
const SURNAME = "Бездатов";
const GIVEN = "Иван";
const PLACE = "Синтетический город";
const NOTE = "Событие без даты";
const ADDRESS = "Синтетическая улица, 1";

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
  const surnameInput = await $("#person-surname");
  await surnameInput.waitForDisplayed({ timeout: 10000 });
  await surnameInput.setValue(SURNAME);
  await $("#person-given").setValue(GIVEN);
  await $('//button[normalize-space(.)="Сохранить"]').click();
  await browser.waitUntil(
    async () =>
      (
        await browser.execute(
          () =>
            document.querySelector("#person-card-title")?.textContent ?? "",
        )
      ).includes(SURNAME),
    { timeout: 15000, timeoutMsg: "the person was not saved" },
  );
  await browser.pause(400);
}

/** Add a RESIDENCE event with a blank date; it renders as "date unknown". */
async function addUndatedEvent() {
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

  // Deliberately no date: an empty date must save as an unknown date.
  await $("#event-place").setValue(PLACE);
  await $("#event-note").setValue(NOTE);
  const address = await $("#event-detail-address");
  if (await address.isExisting()) {
    await address.setValue(ADDRESS);
  }

  await $('//button[normalize-space(.)="Создать"]').click();
  await browser.waitUntil(
    async () => !(await $("#event-date").isExisting()),
    { timeout: 15000, timeoutMsg: "the event form did not close" },
  );
  await browser.pause(800);
}

async function openUndatedDrawer() {
  await clickNav("Хронология");
  await browser.waitUntil(async () => (await headingText()) === "Хронология", {
    timeout: 10000,
  });
  await browser.pause(900);

  const undated = await $('[data-testid="line-undated"]');
  await undated.waitForDisplayed({ timeout: 10000 });
  await (await undated.$("summary")).click();
  await browser.pause(400);

  const row = await $('[data-testid="line-undated-row"]');
  await row.waitForClickable({ timeout: 10000 });
  await row.click();

  const drawer = await $('[data-testid="event-popover"]');
  await drawer.waitForDisplayed({ timeout: 10000 });
  return drawer;
}

describe("timeline drawer matches the event card", () => {
  it("opens an undated event with the shared field set", async () => {
    await createProject();
    await createPerson();
    await addUndatedEvent();
    const drawer = await openUndatedDrawer();

    const text = (await drawer.getText()).toLowerCase();
    expect(text).toContain("проживание");
    expect(text).toContain("дата");
    expect(text).toContain("точность");
    expect(text).toContain("неизвестно");
    expect(text).toContain("место");
    expect(text).toContain(PLACE.toLowerCase());
    expect(text).toContain("участники");
    expect(text).toContain(`${SURNAME} ${GIVEN}`.toLowerCase());
    expect(text).toContain("описание");
    expect(text).toContain(NOTE.toLowerCase());
    expect(text).toContain("файлы");
    expect(text).toContain("источник");

    // The date row stays the honest em dash: no year is invented.
    const dateText = await browser.execute(() => {
      const row = document.querySelector(
        '[data-testid="event-popover"] [data-field="date"] dd',
      );
      return row?.textContent?.trim() ?? "";
    });
    expect(dateText).toBe("—");

    // Detail fields render in the same order as the card.
    const fields = await browser.execute(() =>
      [...document.querySelectorAll("[data-testid=event-popover] [data-field]")].map(
        (row) => row.getAttribute("data-field"),
      ),
    );
    expect(fields.slice(0, 5)).toEqual([
      "date",
      "precision",
      "place",
      "participants",
      "description",
    ]);
    expect(fields).toContain("detail:address");
    expect(fields[fields.length - 1]).toBe("files");

    save("timeline-undated-drawer", { text, fields, dateText });
    await shot("timeline-undated-drawer");

    // The inline edit flow opens for an undated event and cancels back.
    await $('//button[normalize-space(.)="Редактировать"]').click();
    await (await $("#event-date")).waitForDisplayed({ timeout: 10000 });
    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(500);
    expect(await $('[data-testid="event-popover"]').isExisting()).toBe(true);

    expect(await consoleErrors()).toEqual([]);
  });
});
