// Second-batch 0.6.0 feedback rules (#105): tree card geometry (#103/#112),
// automatic parent relations without a badge and event ↔ relation sync
// (#100), patronymic fill (#108), the eleven-year parent gap with a reachable
// footer (#101/#102), the event form order and date wheel (#102), timeline
// padding and navigation (#104/#122), the shared filter notice (#107/#118),
// the owner-only events column (#109/#120), the tree tooltip (#116/#119), the
// map find control (#113/#123), the import dialog (#114/#124) and the shared
// shell rhythm (#121).
//
// Everything here is synthetic: no archive, path or personal record is read.
// The import preview itself needs a native file picker that WebDriver cannot
// drive, and the first map suggestion needs the online geocoder; those checks
// are recorded as skipped when they cannot run and are covered by the
// component tests next to the source.

import { save, shot } from "../lib/report.js";
import { measureShellSpacing } from "../lib/spacing.js";
import {
  clickNav,
  consoleErrors,
  headingText,
  waitForShell,
} from "../lib/ui.js";

const PROJECT_NAME = `UX batch2 ${new Date().toISOString().slice(0, 19)}`;

const LONG_SURNAME = "Воронцов-Романовский-Дашков";
const LONG_GIVEN = "Николай";
const LONG_PATRONYMIC = "Александрович";
const LONG_NAME = `${LONG_SURNAME} ${LONG_GIVEN} ${LONG_PATRONYMIC}`;
const FATHER_NAME = "Воронцов Александр Константинович";
const MOTHER_NAME = "Воронцова Екатерина Александровна";
const SYNC_CHILD = "Тестов Синхрон";
const SYNC_FATHER = "Петров Пётр";
const YOUNG_CHILD = "Юный Малыш";
const YOUNG_PARENT = "Ранний Родитель";
const GROOM = "Смирнов Сергей";
const BRIDE = "Смирнова Ольга";
const MAP_PLACE = "Тестовый город";

const PARENT_GAP_TEXT =
  "Родитель должен быть старше ребёнка не менее чем на 11 лет";

/** Evidence collected for checks this harness cannot drive. */
const skips = {};

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

/** Create a person through the form; returns once the card shows the name. */
async function createPerson(
  surname,
  { given = "", patronymic = "", birth = "", gender = "" } = {},
) {
  await $('[data-tour="persons-add"]').click();
  const surnameInput = await $("#person-surname");
  await surnameInput.waitForDisplayed({ timeout: 10000 });
  await surnameInput.setValue(surname);
  if (given !== "") await $("#person-given").setValue(given);
  if (patronymic !== "") await $("#person-patronymic").setValue(patronymic);
  if (gender !== "") {
    await (await $("#person-gender")).selectByAttribute("value", gender);
    await browser.pause(200);
  }
  if (birth !== "") {
    const date = await $("#person-birth-date");
    await date.setValue(birth);
    await browser.keys(["Enter"]);
    await browser.pause(200);
    expect(await date.getValue()).toBe(birth);
  }

  const expected = [surname, given, patronymic]
    .filter((part) => part !== "")
    .join(" ");
  await $('//button[normalize-space(.)="Сохранить"]').click();
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

async function familyRows() {
  return browser.execute(() =>
    [...document.querySelectorAll(".person-card tr")].map((row) =>
      (row.innerText || "").replace(/\s+/g, " ").trim(),
    ),
  );
}

function rowWith(rows, ...parts) {
  return rows.find((row) => parts.every((part) => row.includes(part)));
}

/** Fill the relationship form on the open card with a parent. */
async function addParentFromCard(parentName) {
  await $('//button[normalize-space(.)="+ Добавить связь"]').click();
  const form = await $("form.person-relationship-form");
  await form.waitForDisplayed({ timeout: 5000 });

  const related = await $('[aria-label="Кто"]');
  await related.waitForClickable({ timeout: 10000 });
  await related.click();
  await browser.pause(400);
  // The form re-renders once the person list arrives, so the input can be
  // mid-layout right after it appears: wait for it to settle and retry one
  // click if the list did not open. Nothing about the flow under test changes.
  if ((await $$('//*[@role="option"]')).length === 0) {
    await related.click();
    await browser.pause(400);
  }
  const option = await $(
    `//*[@role="option"][contains(., "${parentName}")]`,
  );
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

/**
 * The delete confirmation is a `window.confirm`, i.e. a native dialog the
 * WebDriver bridge cannot reach. Only that dialog is stubbed; everything else
 * (relation delete + birth-event sync) runs through the real UI and backend.
 */
async function acceptNativeConfirm() {
  await browser.execute(() => {
    window.confirm = () => true;
  });
}

async function openEventForm() {
  await clickNav("События");
  await browser.waitUntil(async () => (await headingText()) === "События", {
    timeout: 10000,
  });
  await browser.pause(600);
  await $('[data-tour="events-add"]').click();
  const type = await $("#event-type");
  await type.waitForDisplayed({ timeout: 10000 });
  await browser.pause(400);
}

async function setEventType(value) {
  const type = await $("#event-type");
  await type.selectByAttribute("value", value);
  await browser.pause(500);
}

async function pickPerson(selector, name) {
  const input = await $(selector);
  await input.click();
  await browser.pause(400);
  const option = await $(
    `//*[@role="option"][contains(., "${name}")]`,
  );
  await option.waitForExist({ timeout: 5000 });
  await option.waitForClickable({ timeout: 5000 });
  await option.click();
  await browser.pause(300);
}

async function setDate(selector, value) {
  const field = await $(selector);
  await field.waitForDisplayed({ timeout: 5000 });
  await field.setValue(value);
  await browser.keys(["Enter"]);
  await browser.pause(200);
  expect(await field.getValue()).toBe(value);
}

/** Switch a range-capable event type to its period mode. */
async function setRange() {
  await $('//label[contains(normalize-space(.), "Период")]').click();
  await browser.pause(500);
}

async function submitEvent() {
  await $('//button[normalize-space(.)="Создать"]').click();
  await browser.waitUntil(
    async () => !(await $("#event-type").isExisting()),
    { timeout: 15000, timeoutMsg: "the event form did not close" },
  );
  await browser.pause(800);
}

/** Root the family tree at `name` through the root picker. */
async function rootGraphAt(name) {
  const picker = await $("#graph-root-person");
  await picker.waitForDisplayed({ timeout: 10000 });
  await picker.click();
  await browser.pause(400);
  const option = await $(
    `//*[@role="option"][contains(., "${name}")]`,
  );
  await option.waitForExist({ timeout: 5000 });
  await option.waitForClickable({ timeout: 5000 });
  await option.click();
  await browser.pause(1500);
}

/** Card geometry, caption box and tooltip of every rendered tree card. */
async function graphCards() {
  return browser.execute(() =>
    [...document.querySelectorAll(".graph-node")].map((card) => {
      const nameElement = card.querySelector(".graph-node-name");
      const metaElement = card.querySelector(".graph-node-meta");
      const main =
        card.querySelector(".graph-node-main") ??
        (card.tagName === "BUTTON" ? card : null);
      const nameRect = nameElement?.getBoundingClientRect() ?? null;
      const cardRect = card.getBoundingClientRect();
      const style = nameElement ? getComputedStyle(nameElement) : null;
      const declaredWidth = Number.parseFloat(card.style.width) || cardRect.width;
      return {
        name: (nameElement?.textContent ?? "").trim(),
        meta: (metaElement?.textContent ?? "").trim(),
        isRoot: card.classList.contains("root"),
        title: main?.getAttribute("title") ?? "",
        card: {
          top: cardRect.top,
          right: cardRect.right,
          bottom: cardRect.bottom,
          left: cardRect.left,
          width: cardRect.width,
        },
        nameBox: nameRect
          ? {
              top: nameRect.top,
              right: nameRect.right,
              bottom: nameRect.bottom,
              left: nameRect.left,
              width: nameRect.width,
              height: nameRect.height,
            }
          : null,
        clientWidth: nameElement?.clientWidth ?? 0,
        scrollWidth: nameElement?.scrollWidth ?? 0,
        scale: cardRect.width / declaredWidth,
        lineHeight: style ? Number.parseFloat(style.lineHeight) : null,
      };
    }),
  );
}

/** Open the read-only event card of the birth event in `year`. */
async function openBirthCard(year) {
  await clickNav("События");
  await browser.waitUntil(async () => (await headingText()) === "События", {
    timeout: 10000,
  });
  await browser.pause(700);
  const row = await $(
    `//tr[contains(., "Рождение") and contains(., "${year}")]`,
  );
  await row.waitForClickable({ timeout: 10000 });
  await row.click();
  const card = await $(".events-card");
  await card.waitForDisplayed({ timeout: 10000 });
  await browser.pause(300);
}

async function closeEventCard() {
  const close = await $('.events-card button[aria-label="Закрыть"]');
  await close.waitForClickable({ timeout: 5000 });
  await close.click();
  await browser.pause(400);
}

/** Value of one `dt`/`dd` row of the open read-only event card. */
async function eventCardRow(label) {
  return browser.execute((expected) => {
    const row = [...document.querySelectorAll(".events-card .events-card-row")].find(
      (candidate) =>
        (candidate.querySelector("dt")?.textContent ?? "").trim() === expected,
    );
    if (!row) return null;
    return (row.querySelector("dd")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }, label);
}

/** Track geometry plus every marker/cluster centre on the timeline. */
async function timelineItems() {
  return browser.execute(() => {
    const track = document.querySelector(
      '[data-testid="timeline-line-track"]',
    );
    if (!track) return null;
    const box = track.getBoundingClientRect();
    const items = [
      ...document.querySelectorAll(
        '[data-testid="line-marker"], [data-testid="line-cluster"]',
      ),
    ].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        kind: element.getAttribute("data-testid"),
        left: rect.left,
        right: rect.right,
        center: (rect.left + rect.right) / 2,
      };
    });
    return {
      track: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      },
      items,
    };
  });
}

function fractions(snapshot) {
  const { track, items } = snapshot;
  return items.map((item) => (item.center - track.left) / track.width);
}

async function dragTrack(fromFraction, toFraction) {
  const snapshot = await timelineItems();
  const { track } = snapshot;
  const y = Math.round(track.top + track.height - 30);
  await browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          origin: "viewport",
          x: Math.round(track.left + track.width * fromFraction),
          y,
        },
        { type: "pointerDown", button: 0 },
        {
          type: "pointerMove",
          duration: 200,
          origin: "viewport",
          x: Math.round(track.left + track.width * toFraction),
          y,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  await browser.pause(500);
}

/** Drag until the extreme marker sits on the track centre. */
async function centreEdge(edge) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const values = fractions(await timelineItems());
    const target = edge === "first" ? Math.min(...values) : Math.max(...values);
    if (Math.abs(target - 0.5) <= 0.02) return target;
    await dragTrack(0.5, 0.5 + (0.5 - target));
  }
  const values = fractions(await timelineItems());
  return edge === "first" ? Math.min(...values) : Math.max(...values);
}

async function resetTimelineWindow() {
  const fit = await $('[data-testid="line-zoom-fit"]');
  await fit.waitForClickable({ timeout: 10000 });
  await fit.click();
  await browser.pause(700);
}

/** Visible marker/cluster count; the line drops them when the filter hides all. */
async function markerCount() {
  return browser.execute(
    () =>
      document.querySelectorAll(
        '[data-testid="line-marker"], [data-testid="line-cluster"]',
      ).length,
  );
}

describe("second-batch feedback rules", () => {
  it("creates the project and shows automatic birth parents without a badge", async () => {
    await createProject();
    // No birth date on the form: the person screen would create the life event
    // itself, and a person may own only one BIRTH event. The event form below
    // creates that single event together with both parents.
    await createPerson(LONG_SURNAME, {
      given: LONG_GIVEN,
      patronymic: LONG_PATRONYMIC,
      gender: "MALE",
    });
    await createPerson("Воронцов", {
      given: "Александр",
      patronymic: "Константинович",
      gender: "MALE",
      birth: "1950-02-03",
    });
    await createPerson("Воронцова", {
      given: "Екатерина",
      patronymic: "Александровна",
      gender: "FEMALE",
      birth: "1952-08-09",
    });

    await openEventForm();
    await setEventType("BIRTH");
    await pickPerson("#event-person", LONG_NAME);
    await pickPerson("#event-parent-0", FATHER_NAME);
    await pickPerson("#event-parent-1", MOTHER_NAME);
    await setDate("#event-date", "1975-04-12");
    await submitEvent();

    await clickNav("Люди");
    await openPerson(LONG_NAME);
    const rows = await familyRows();
    expect(rowWith(rows, "Отец", FATHER_NAME)).toBeTruthy();
    expect(rowWith(rows, "Мать", MOTHER_NAME)).toBeTruthy();

    // #100: an event-derived relation is an ordinary row. The former
    // "Автоматически" badge and its source line must not come back.
    const automatic = await browser.execute(() => ({
      badges: document.querySelectorAll(".person-relation-origin").length,
      sources: document.querySelectorAll(".person-relation-source").length,
      text: document.querySelector(".person-card")?.innerText ?? "",
    }));
    expect(automatic.badges).toBe(0);
    expect(automatic.sources).toBe(0);
    expect(automatic.text).not.toContain("Автоматически");

    save("batch2-auto-relations", { rows, automatic });
    await shot("batch2-auto-relations");
    expect(await consoleErrors()).toEqual([]);
  });

  it("puts the type first and keeps the date wheel aligned", async () => {
    // #102: the type decides every other field, so it opens the form; the
    // parent-link hint that repeated the backend rule is gone.
    await openEventForm();
    const layout = await browser.execute(() => {
      const form = document.querySelector("form#event-form");
      const firstField = form?.querySelector(".field");
      const firstControl = firstField?.querySelector("select, input, textarea");
      const type = form?.querySelector("#event-type");
      const person = form?.querySelector("#event-person");
      return {
        firstLabel: (
          firstField?.querySelector(".field-label")?.textContent ?? ""
        ).trim(),
        firstControl: firstControl?.id ?? "",
        typeTop: type?.getBoundingClientRect().top ?? null,
        personTop: person?.getBoundingClientRect().top ?? null,
        linkBadges: form?.querySelectorAll(".events-link-badge").length ?? 0,
        hint: form?.innerText ?? "",
      };
    });
    expect(layout.firstLabel).toBe("Тип");
    expect(layout.firstControl).toBe("event-type");
    expect(layout.typeTop).toBeLessThan(layout.personTop);
    expect(layout.linkBadges).toBe(0);
    expect(layout.hint).not.toContain(
      "При сохранении создаётся связь «родитель — ребёнок»",
    );

    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(400);

    // A read-only card keeps the facts, not the storage-level qualifier.
    await openBirthCard("1975");
    const cardText = await browser.execute(
      () => document.querySelector(".events-card")?.innerText ?? "",
    );
    const qualifierRow = await eventCardRow("Характер даты");
    expect(cardText).toContain("Дата");
    expect(cardText).toContain("Точность");
    expect(qualifierRow).toBeNull();
    await closeEventCard();

    // The wheel centres the chosen day, month and year on one line.
    await openEventForm();
    const calendar = await $('button[aria-label="Дата"]');
    await calendar.waitForClickable({ timeout: 10000 });
    await calendar.click();
    await browser.pause(500);
    const wheel = await browser.execute(() => {
      const columns = [...document.querySelectorAll('[role="listbox"]')]
        .filter((column) =>
          ["День", "Месяц", "Год"].includes(
            column.getAttribute("aria-label") ?? "",
          ),
        )
        .map((column) => {
          const box = column.getBoundingClientRect();
          const selected = column.querySelector('[aria-selected="true"]');
          const row = selected?.getBoundingClientRect() ?? null;
          return {
            label: column.getAttribute("aria-label"),
            columnCenter: box.top + box.height / 2,
            rowCenter: row ? row.top + row.height / 2 : null,
            selected: (selected?.textContent ?? "").trim(),
          };
        });
      return {
        columns,
        surface: document.querySelectorAll('[role="dialog"]').length,
      };
    });
    expect(wheel.columns.map((column) => column.label)).toEqual([
      "День",
      "Месяц",
      "Год",
    ]);
    for (const column of wheel.columns) {
      expect(column.selected).not.toBe("");
      expect(Math.abs(column.rowCenter - column.columnCenter)).toBeLessThanOrEqual(2);
    }
    await browser.keys(["Escape"]);
    await browser.pause(400);
    // Escape only closes the wheel popover; the event dialog stays open.
    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(500);
    expect(await $("#event-type").isExisting()).toBe(false);

    save("batch2-event-form", { layout, wheel, qualifierRow });
    await shot("batch2-event-form");
    expect(await consoleErrors()).toEqual([]);
  });

  it("locks a second birth and keeps the footer and files inside the form", async () => {
    // #129: the long-name person already owns one BIRTH event. A short window
    // makes the form taller than the dialog body, so the geometry check also
    // proves the body scrolls instead of pushing the footer out.
    const originalSize = await browser.getWindowSize();
    await browser.setWindowSize(960, 600);
    await browser.pause(500);
    await openEventForm();
    await pickPerson("#event-person", LONG_NAME);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const option = document.querySelector(
            '#event-type option[value="BIRTH"]',
          );
          return option?.disabled === true;
        }),
      { timeout: 10000, timeoutMsg: "the existing birth type stayed selectable" },
    );

    const audit = await browser.execute(() => {
      const surface = document.querySelector('[role="dialog"]');
      const content = surface?.querySelector(".fui-DialogContent") ?? null;
      const actions = surface?.querySelector(".fui-DialogActions") ?? null;
      const form = document.querySelector("form#event-form");
      const box = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect
          ? {
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            }
          : null;
      };
      return {
        surface: box(surface),
        content: box(content),
        actions: box(actions),
        form: box(form),
        options: [...document.querySelectorAll("#event-type option")].map(
          (option) => ({
            value: option.value,
            disabled: option.disabled,
            text: (option.textContent ?? "").trim(),
          }),
        ),
        scrollable: content
          ? content.scrollHeight > content.clientHeight + 1
          : false,
      };
    });

    const birth = audit.options.find((option) => option.value === "BIRTH");
    const death = audit.options.find((option) => option.value === "DEATH");
    expect(birth.disabled).toBe(true);
    expect(birth.text).toContain("уже есть");
    expect(death.disabled).toBe(false);
    // The body is the scroller; the actions row sits between it and the
    // surface edge instead of floating over the fields.
    expect(audit.scrollable).toBe(true);
    expect(audit.actions.bottom).toBeLessThanOrEqual(audit.surface.bottom + 1);
    expect(audit.actions.top).toBeGreaterThanOrEqual(audit.content.bottom - 1);
    expect(audit.form.right).toBeLessThanOrEqual(audit.content.right + 1);
    expect(audit.form.left).toBeGreaterThanOrEqual(audit.content.left - 1);

    save("event-form-locked-type", audit);
    await shot("event-form-locked-type");
    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(400);
    await browser.setWindowSize(originalSize.width, originalSize.height);
    await browser.pause(400);
  });

  it("fits the long root caption and shows only kinship on hover", async () => {
    // #103/#112: the root card owns the depth-control columns, so its caption
    // needs the same width as every other card instead of half of it.
    await clickNav("Дерево");
    await browser.pause(800);
    await rootGraphAt(LONG_NAME);
    // The graph keeps the ancestor depth that was visible for the previous
    // root; a rootless start leaves it at zero, and the screen says so. Follow
    // the hint once so the parents are part of the measured tree.
    const parentShown = async () =>
      browser.execute(
        (name) =>
          [...document.querySelectorAll(".graph-node-name")].some(
            (element) => (element.textContent ?? "").trim() === name,
          ),
        FATHER_NAME,
      );
    if (!(await parentShown())) {
      const expand = await $(
        '//button[@aria-label="Показать ещё поколение предков"]',
      );
      if (await expand.isExisting()) {
        await expand.click();
        await browser.pause(1200);
      }
    }
    // Persons, relations and the layout load in parallel; wait until the
    // parents are actually drawn before measuring the root caption.
    await browser.waitUntil(parentShown, {
      timeout: 20000,
      timeoutMsg: "the parent cards did not render",
    });
    await browser.pause(400);

    const cards = await graphCards();
    const root = cards.find((card) => card.name === LONG_NAME);
    const father = cards.find((card) => card.name === FATHER_NAME);
    expect(root).toBeTruthy();
    expect(father).toBeTruthy();
    expect(root.isRoot).toBe(true);

    const lines = Math.round(
      root.nameBox.height / (root.lineHeight * root.scale),
    );
    expect(root.nameBox).not.toBeNull();
    expect(lines).toBeGreaterThanOrEqual(2);
    expect(lines).toBeLessThanOrEqual(3);
    // The caption is not squeezed to half the card and not clipped sideways.
    expect(root.nameBox.width).toBeGreaterThan(80);
    expect(Math.abs(root.nameBox.width - father.nameBox.width)).toBeLessThanOrEqual(2);
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
    expect(root.nameBox.bottom).toBeLessThanOrEqual(root.card.bottom + 1);
    expect(root.nameBox.right).toBeLessThanOrEqual(root.card.right + 1);

    // #116/#119: the tooltip carries the kinship to the root only. The card
    // body keeps its structural role; the tooltip must not repeat it after a
    // separator.
    const titles = cards.map((card) => ({
      name: card.name,
      title: card.title,
      meta: card.meta,
      isRoot: card.isRoot,
    }));
    for (const card of titles) {
      expect(card.title).not.toContain("·");
      if (card.isRoot) {
        expect(card.title).toBe("");
      } else {
        expect(card.title).toBe(card.meta);
      }
    }
    expect(
      titles.find((card) => card.name === FATHER_NAME)?.title.toLowerCase(),
    ).toBe("отец");

    save("batch2-tree", {
      lines,
      root: {
        nameBox: root.nameBox,
        card: root.card,
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
      },
      fatherCaption: father.nameBox,
      titles,
    });
    await shot("batch2-tree");
    expect(await consoleErrors()).toEqual([]);
  });

  it("fills an empty patronymic and keeps the birth event in sync", async () => {
    await clickNav("Люди");
    await browser.pause(600);
    await createPerson("Петров", {
      given: "Пётр",
      gender: "MALE",
      birth: "1940-03-01",
    });
    await createPerson("Тестов", {
      given: "Синхрон",
      gender: "MALE",
      birth: "1991-06-01",
    });

    // #108: a lone biological father with a usable given name fills the
    // child's empty patronymic.
    await openPerson(SYNC_CHILD);
    expect(await cardTitle()).toBe(SYNC_CHILD);
    await addParentFromCard(SYNC_FATHER);
    await browser.waitUntil(
      async () => (await cardTitle()) === `${SYNC_CHILD} Петрович`,
      { timeout: 15000, timeoutMsg: "the patronymic was not filled" },
    );
    expect(rowWith(await familyRows(), "Отец", SYNC_FATHER)).toBeTruthy();

    // #100: the parent relation is mirrored into the child's birth event.
    await openBirthCard("1991");
    const withParent = await eventCardRow("Участники");
    expect(withParent).toContain(SYNC_FATHER);
    await closeEventCard();

    // Deleting the relation removes the parent from the same event.
    await clickNav("Люди");
    await openPerson(`${SYNC_CHILD} Петрович`);
    await acceptNativeConfirm();
    const menu = await $(
      `//tr[contains(., "${SYNC_FATHER}")]//button[@aria-label="Действия"]`,
    );
    await menu.waitForClickable({ timeout: 10000 });
    await menu.click();
    await browser.pause(400);
    const remove = await $('//*[@role="menuitem"][normalize-space(.)="Удалить"]');
    await remove.waitForClickable({ timeout: 5000 });
    await remove.click();
    await browser.pause(1000);
    await browser.waitUntil(
      async () => rowWith(await familyRows(), "Отец", SYNC_FATHER) === undefined,
      { timeout: 15000, timeoutMsg: "the relation row did not disappear" },
    );

    await openBirthCard("1991");
    const withoutParent = await eventCardRow("Участники");
    expect(withoutParent).not.toContain(SYNC_FATHER);
    await closeEventCard();

    save("batch2-parent-sync", {
      patronymicTitle: `${SYNC_CHILD} Петрович`,
      participantsWithParent: withParent,
      participantsWithoutParent: withoutParent,
    });
    await shot("batch2-parent-sync");
    expect(await consoleErrors()).toEqual([]);
  });

  it("rejects a parent under eleven years older and keeps the footer usable", async () => {
    await clickNav("Люди");
    await browser.pause(600);
    await createPerson("Юный", {
      given: "Малыш",
      gender: "MALE",
      birth: "1990-01-01",
    });
    await createPerson("Ранний", {
      given: "Родитель",
      gender: "MALE",
      birth: "1985-01-01",
    });

    await openPerson(YOUNG_CHILD);
    await addParentFromCard(YOUNG_PARENT);

    const alert = await $('[role="alert"]');
    await alert.waitForDisplayed({ timeout: 10000 });
    const alertText = (await alert.getText()).trim();
    expect(alertText).toBe(PARENT_GAP_TEXT);
    expect(
      rowWith(await familyRows(), "Родитель", YOUNG_PARENT),
    ).toBeUndefined();

    // #101/#102: the error must not push the form actions away or cover them.
    const footer = await browser.execute(() => {
      const form = document.querySelector("form.person-relationship-form");
      if (!form) return null;
      const buttons = [...form.querySelectorAll(".person-relationship-actions button")];
      buttons[0]?.scrollIntoView({ block: "center" });
      const hit = buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          label: (button.textContent ?? "").trim(),
          width: box.width,
          height: box.height,
          top: box.top,
          bottom: box.bottom,
          disabled: button.disabled,
          reachable: top === button || (top !== null && button.contains(top)),
        };
      });
      return { buttons: hit, viewport: window.innerHeight };
    });
    expect(footer).not.toBeNull();
    expect(footer.buttons.length).toBe(2);
    for (const button of footer.buttons) {
      expect(button.width).toBeGreaterThan(0);
      expect(button.height).toBeGreaterThan(0);
      expect(button.reachable).toBe(true);
      expect(button.top).toBeGreaterThanOrEqual(0);
      expect(button.bottom).toBeLessThanOrEqual(footer.viewport + 1);
    }

    save("batch2-age-gap", {
      alert: alertText,
      family: await familyRows(),
      footer,
    });
    await shot("batch2-age-gap");
    expect(await consoleErrors()).toEqual([]);
  });

  it("shows only the owner in the events person column", async () => {
    await clickNav("Люди");
    await browser.pause(600);
    await createPerson("Смирнов", {
      given: "Сергей",
      gender: "MALE",
      birth: "1960-05-05",
    });
    await createPerson("Смирнова", {
      given: "Ольга",
      gender: "FEMALE",
      birth: "1962-07-07",
    });

    await openEventForm();
    await setEventType("MARRIAGE");
    await pickPerson("#event-person", GROOM);
    await pickPerson("#event-spouse", BRIDE);
    await setDate("#event-date", "1990-06-01");
    await submitEvent();

    // #109/#120: the cell names the owner; the spouse belongs to the card.
    const cell = await browser.execute(() => {
      const row = [...document.querySelectorAll("tr")].find((candidate) =>
        (candidate.innerText ?? "").includes("Брак"),
      );
      if (!row) return null;
      const links = row.querySelector(".events-person-links");
      return {
        rowText: (row.innerText ?? "").replace(/\s+/g, " ").trim(),
        text: (links?.innerText ?? "").replace(/\s+/g, " ").trim(),
        buttons: links?.querySelectorAll("button").length ?? 0,
      };
    });
    expect(cell).not.toBeNull();
    expect(cell.buttons).toBe(1);
    expect(cell.text).toBe(GROOM);
    expect(cell.text).not.toContain("Смирнова");

    save("batch2-person-column", { cell });
    await shot("batch2-person-column");
    expect(await consoleErrors()).toEqual([]);
  });

  it("pads the timeline edges and can centre the first and last event", async () => {
    await clickNav("Хронология");
    await browser.waitUntil(async () => (await headingText()) === "Хронология", {
      timeout: 10000,
    });
    const canvas = await $('[data-testid="line-canvas"]');
    await canvas.waitForDisplayed({ timeout: 15000 });
    await browser.pause(1200);
    await resetTimelineWindow();

    // #104/#122: the initial fit window keeps a tenth of the data span on each
    // side, so the first and last markers are not glued to the track edges.
    const initial = await timelineItems();
    expect(initial).not.toBeNull();
    expect(initial.items.length).toBeGreaterThan(1);
    const values = fractions(initial);
    const first = Math.min(...values);
    const last = Math.max(...values);
    expect(first).toBeGreaterThan(0.03);
    expect(last).toBeLessThan(0.97);
    const symmetric = Math.abs(first - (1 - last));
    expect(symmetric).toBeLessThanOrEqual(0.02);
    // span/(span+2·padding) = last-first -> padding/span ≈ 0.1
    const paddingRatio = (1 / (last - first) - 1) / 2;
    expect(paddingRatio).toBeGreaterThan(0.07);
    expect(paddingRatio).toBeLessThan(0.13);
    const edgePadding = first; // fraction of the window, not of the data span
    expect(edgePadding).toBeGreaterThan(0.06);
    expect(edgePadding).toBeLessThan(0.11);

    const centredFirst = await centreEdge("first");
    expect(Math.abs(centredFirst - 0.5)).toBeLessThanOrEqual(0.03);
    await shot("batch2-timeline-first-centred");

    await resetTimelineWindow();
    const centredLast = await centreEdge("last");
    expect(Math.abs(centredLast - 0.5)).toBeLessThanOrEqual(0.03);

    // #104/#122: panning may leave the loaded range, but never a window with
    // no event in it.
    for (let index = 0; index < 6; index += 1) {
      await dragTrack(0.55, 0.02);
    }
    const bounded = await timelineItems();
    expect(await $('[data-testid="line-empty-range"]').isExisting()).toBe(false);
    const visible = bounded.items.filter(
      (item) => item.center >= bounded.track.left - 1 &&
        item.center <= bounded.track.left + bounded.track.width + 1,
    );
    expect(visible.length).toBeGreaterThan(0);

    save("batch2-timeline", {
      initial: { first, last, paddingRatio, edgePadding },
      centredFirst,
      centredLast,
      visibleAfterPan: visible.length,
      emptyRange: await $('[data-testid="line-empty-range"]').isExisting(),
    });
    await shot("batch2-timeline-bounds");
    expect(await consoleErrors()).toEqual([]);
  });

  it("keeps a long period's marker visible when panning far right", async () => {
    // #122 follow-up: a period's end must not extend the navigation bound.
    // The clamp follows marker starts, so a 1980–2000 occupation cannot leave
    // a window that only overlaps its tail and draws nothing.
    await openEventForm();
    await setEventType("OCCUPATION");
    await pickPerson("#event-person", LONG_NAME);
    await setRange();
    await setDate("#event-date", "1980-01-01");
    await setDate("#event-date-end", "2000-12-31");
    await submitEvent();

    await clickNav("Хронология");
    await browser.waitUntil(async () => (await headingText()) === "Хронология", {
      timeout: 10000,
    });
    const canvas = await $('[data-testid="line-canvas"]');
    await canvas.waitForDisplayed({ timeout: 15000 });
    await browser.pause(1200);
    await resetTimelineWindow();

    // Drag hard to the right (window later) well past the long period's end.
    for (let index = 0; index < 10; index += 1) {
      await dragTrack(0.6, 0.02);
    }

    const bounded = await timelineItems();
    expect(bounded).not.toBeNull();
    expect(await $('[data-testid="line-empty-range"]').isExisting()).toBe(false);
    const visible = bounded.items.filter(
      (item) =>
        item.center >= bounded.track.left - 1 &&
        item.center <= bounded.track.left + bounded.track.width + 1,
    );
    expect(visible.length).toBeGreaterThan(0);

    // The stop is the latest marker start just inside the left edge; the
    // window must not slide further into the period's empty tail.
    const values = fractions(bounded);
    expect(Math.min(...values)).toBeLessThanOrEqual(0.05);

    save("batch2-timeline-long-period", {
      visibleMarkers: visible.length,
      firstVisibleFraction: Math.min(...values),
      emptyRange: await $('[data-testid="line-empty-range"]').isExisting(),
    });
    await shot("batch2-timeline-long-period");
    expect(await consoleErrors()).toEqual([]);
  });

  it("announces the active year filter and restores a hidden event", async () => {
    await clickNav("Люди");
    await browser.pause(500);
    await clickNav("Хронология");
    await browser.waitUntil(async () => (await headingText()) === "Хронология", {
      timeout: 10000,
    });
    await browser.pause(1200);

    // #107/#118: the timeline now offers the shared year control.
    const from = await $('[role="slider"][aria-label="Год от"]');
    await from.waitForDisplayed({ timeout: 10000 });
    const to = await $('[role="slider"][aria-label="Год до"]');
    expect(await to.isDisplayed()).toBe(true);

    const before = await timelineItems();
    expect(before.items.length).toBeGreaterThan(0);

    // Move the lower bound to the upper one: every dated event disappears.
    await from.click();
    await browser.keys(["End"]);
    await browser.pause(800);
    await browser.waitUntil(
      async () => (await markerCount()) === 0,
      { timeout: 15000, timeoutMsg: "the hidden range still shows markers" },
    );
    const emptyCount = (await (await $('[data-testid="line-count"]')).getText()).trim();
    expect(emptyCount).toMatch(/^0/);
    const notice = await $('[data-testid="timeline-filters-active"]');
    await notice.waitForDisplayed({ timeout: 5000 });
    const noticeText = (await notice.getText()).replace(/\s+/g, " ").trim();
    expect(noticeText).toContain("Сбросить фильтры");
    expect(noticeText).toMatch(/20\d\d/);

    const reset = await notice.$('//button[normalize-space(.)="Сбросить фильтры"]');
    await reset.waitForClickable({ timeout: 5000 });
    await reset.click();
    await browser.pause(900);

    await browser.waitUntil(async () => (await markerCount()) > 0, {
      timeout: 15000,
      timeoutMsg: "the hidden events did not come back after the reset",
    });
    expect(await $('[data-testid="timeline-filters-active"]').isExisting()).toBe(false);
    expect(await (await $('[role="slider"][aria-label="Год от"]')).isDisplayed()).toBe(true);

    save("batch2-filter-notice", {
      noticeText,
      emptyCount,
      markersBefore: before.items.length,
      markersAfter: await markerCount(),
      canvasBack: await $('[data-testid="line-canvas"]').isExisting(),
    });
    await shot("batch2-filter-notice");
    expect(await consoleErrors()).toEqual([]);
  });

  it("keeps the map find box stable and its first suggestion light", async () => {
    // An unresolved place gives the clarify panel its row.
    await openEventForm();
    await setEventType("RESIDENCE");
    await pickPerson("#event-person", LONG_NAME);
    await setDate("#event-date", "1980-01-01");
    const place = await $("#event-place");
    await place.setValue(MAP_PLACE);
    await browser.keys(["Tab"]);
    await browser.pause(400);
    await submitEvent();

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
      `//aside[@aria-label="Места без координат"]//button[contains(., "${MAP_PLACE}")]`,
    );
    await row.waitForClickable({ timeout: 10000 });
    await row.click();
    await browser.pause(500);

    // #124: the two review actions share one equal-width row (same rule as
    // 09-preview-actions, checked here together with the find control).
    const actions = await browser.execute(
      (labels) => {
        const buttons = labels.map((label) =>
          [...document.querySelectorAll(".map-clarify button")].find(
            (candidate) => (candidate.textContent ?? "").trim() === label,
          ),
        );
        return {
          sameParent:
            buttons[0] !== undefined &&
            buttons[0].parentElement === buttons[1]?.parentElement,
          boxes: buttons.map((button) => {
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return { width: rect.width, top: rect.top, left: rect.left };
          }),
        };
      },
      ["Применить к выбранным событиям", "Указать на карте"],
    );
    expect(actions.sameParent).toBe(true);
    expect(Math.abs(actions.boxes[0].width - actions.boxes[1].width)).toBeLessThanOrEqual(1);
    expect(Math.abs(actions.boxes[0].top - actions.boxes[1].top)).toBeLessThanOrEqual(1);

    // #113/#123: the box does not follow the current word. Fluent swaps it to
    // "Поиск…" while a request runs and disables it; probing the same element
    // with that label proves the width comes from the layout.
    const findProbe = await browser.execute(() => {
      const button = document.querySelector(".map-clarify-find");
      if (!button) return null;
      const idle = button.getBoundingClientRect();
      const original = button.textContent;
      button.textContent = "Поиск…";
      const loading = button.getBoundingClientRect();
      const probe = {
        idleWidth: idle.width,
        loadingWidth: loading.width,
        clientWidth: button.clientWidth,
        scrollWidth: button.scrollWidth,
      };
      button.textContent = original;
      return probe;
    });
    let candidates = 0;
    let firstCandidate = null;
    if (findProbe === null) {
      // The review config can switch the online geocoder off; the panel then
      // explains why the action is absent instead of drawing a dead control.
      skips.mapFind =
        "geocoder disabled in the review config; covered by ClarifyPanel.test.tsx";
      firstCandidate = { skipped: true, reason: skips.mapFind };
    } else {
      expect(findProbe.idleWidth).toBeGreaterThanOrEqual(112);
      expect(Math.abs(findProbe.idleWidth - findProbe.loadingWidth)).toBeLessThanOrEqual(1);
      expect(findProbe.scrollWidth).toBeLessThanOrEqual(findProbe.clientWidth + 1);

      // The suggestion list needs the online geocoder. Click Find once; if the
      // provider is unreachable the tone check is recorded as skipped instead
      // of failing the review for an offline machine.
      const find = await $('button.map-clarify-find');
      await find.click();
      await browser
        .waitUntil(async () => (await find.getAttribute("aria-busy")) !== "true", {
          timeout: 25000,
        })
        .catch(() => undefined);
      await browser.pause(600);
      candidates = await $$(".map-candidate").length;

      if (candidates > 0) {
        firstCandidate = await browser.execute(() => {
          const button =
            document.querySelector(".map-candidate-selected") ??
            document.querySelector(".map-candidate");
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return {
            selected: button.classList.contains("map-candidate-selected"),
            background: style.backgroundColor,
            borderColor: style.borderColor,
            width: rect.width,
          };
        });
        if (firstCandidate.selected) {
          const rgb = (firstCandidate.background.match(/\d+/g) ?? []).map(Number);
          expect(rgb.length).toBeGreaterThanOrEqual(3);
          const [red, green, blue] = rgb;
          const max = Math.max(red, green, blue);
          const spread = max - Math.min(red, green, blue);
          // Light neutral grey; the former brand tint was visibly blue (b - r 18).
          expect(max).toBeGreaterThanOrEqual(200);
          expect(spread).toBeLessThanOrEqual(8);
          await shot("batch2-map-suggestion");
        } else {
          skips.mapFirstSuggestion =
            "no suggestion carried a point, so nothing was selected; " +
            "tone covered by mapStyles.test.ts";
          firstCandidate = { ...firstCandidate, skipped: true, reason: skips.mapFirstSuggestion };
        }
      } else {
        skips.mapFirstSuggestion =
          "no geocoder result offline; tone covered by mapStyles.test.ts";
        firstCandidate = { skipped: true, reason: skips.mapFirstSuggestion };
      }
    }

    save("batch2-map", { actions, findProbe, candidates, firstCandidate });
    await shot("batch2-map");
    expect(await consoleErrors()).toEqual([]);
  });

  it("opens the import dialog and records the preview picker gap", async () => {
    await clickNav("Проекты");
    await browser.waitUntil(async () => (await headingText()) === "Проекты", {
      timeout: 10000,
    });
    await browser.pause(700);
    await $('//button[normalize-space(.)="Импорт"]').click();
    const dialog = await $('.fui-DialogSurface [class*="import-dialog"]');
    await dialog.waitForDisplayed({ timeout: 10000 });
    await browser.pause(300);

    const surface = await browser.execute(() => {
      const dialogElement = document.querySelector(".import-dialog");
      const dropzone = dialogElement?.querySelector(".import-dropzone");
      const footer = document.querySelector(".fui-DialogActions");
      const style = dropzone ? getComputedStyle(dropzone) : null;
      return {
        hasDialog: dialogElement !== null,
        dropzoneBorder: style?.borderColor ?? null,
        preview: dialogElement?.querySelectorAll(".import-preview").length ?? 0,
        badges: dialogElement?.querySelectorAll(".fui-Badge").length ?? 0,
        footer: (footer?.innerText ?? "").replace(/\s+/g, " ").trim(),
      };
    });
    expect(surface.hasDialog).toBe(true);
    // The dialog opens with no file yet, so the dry-run preview cannot render.
    expect(surface.preview).toBe(0);
    skips.importPreview =
      "preview needs a native file picker (see e2e README limits); " +
      "badge tone and frameless surface covered by ImportPreview.test.tsx";
    await shot("batch2-import-dialog");

    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(400);
    expect(await $(".import-dialog").isExisting()).toBe(false);

    save("batch2-import", { surface, skips });
    await shot("batch2-import");
    expect(await consoleErrors()).toEqual([]);
  });

  it("keeps the shared shell rhythm on the page blocks", async () => {
    for (const [label, slug] of [
      ["Люди", "persons"],
      ["События", "events"],
    ]) {
      await clickNav(label);
      await browser.pause(700);
      const spacing = await browser.execute(measureShellSpacing);
      expect(spacing).not.toBeNull();
      save(`batch2-spacing-${slug}`, spacing);
      expect(spacing.gutter).toBe(spacing.gap);
      if (spacing.pageGap !== null) {
        expect(spacing.pageGap).toBe(spacing.gap);
      }
    }

    save("batch2-skips", skips);
    // eslint-disable-next-line no-console
    console.log(`skipped scenarios: ${JSON.stringify(skips)}`);
    expect(await consoleErrors()).toEqual([]);
  });
});
