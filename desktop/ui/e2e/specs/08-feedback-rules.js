// 0.6.0 feedback rules (#95): name capitalisation, direction-aware relation
// labels, tree geometry, spouse visibility, period/year filtering, timeline
// navigation bounds, open-ended residences, event-derived relations and the
// parent age gap. Creates one synthetic project and drives the real window.
//
// Everything here is synthetic: no archive, path or personal record is read.

import { save, shot } from "../lib/report.js";
import { clickNav, consoleErrors, headingText, waitForShell } from "../lib/ui.js";

const PROJECT_NAME = `UX feedback ${new Date().toISOString().slice(0, 19)}`;

const LONG_CHILD = "Николай Александрович Воронцов-Романовский-Дашков";
const LONG_FATHER = "Александр Константинович Воронцов";
const LONG_MOTHER = "Екатерина Александровна Воронцова";

async function bodyText() {
  return browser.execute(() => document.body.innerText);
}

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
    async () =>
      (await cardTitle()).toLowerCase() === expected.toLowerCase(),
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
  await related.click();
  await browser.pause(400);
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

async function setRange() {
  // Fluent renders the radio input and its text in sibling nodes; the label
  // carries the period caption and toggles the input.
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

async function graphCards() {
  return browser.execute(() => {
    return [...document.querySelectorAll(".graph-node")].map((card) => {
      const nameElement = card.querySelector(".graph-node-name");
      const nameRect = nameElement?.getBoundingClientRect() ?? null;
      const cardRect = card.getBoundingClientRect();
      const style = nameElement ? getComputedStyle(nameElement) : null;
      const declaredWidth = Number.parseFloat(card.style.width) || cardRect.width;
      return {
        name: (nameElement?.textContent ?? "").trim(),
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
              height: nameRect.height,
            }
          : null,
        lineHeight: style ? Number.parseFloat(style.lineHeight) : null,
        scale: cardRect.width / declaredWidth,
      };
    });
  });
}

async function graphNameVisible(name) {
  return browser.execute(
    (expected) =>
      [...document.querySelectorAll(".graph-node-name")].some(
        (element) => (element.textContent ?? "").trim() === expected,
      ),
    name,
  );
}

async function axisYears() {
  const labels = await browser.execute(() =>
    [...document.querySelectorAll('[data-testid="line-axis-tick"]')].map(
      (tick) => (tick.textContent ?? "").trim(),
    ),
  );
  return labels
    .filter((label) => /^\d{4}$/.test(label))
    .map((label) => Number(label));
}

describe("0.6.0 feedback rules", () => {
  it("creates the synthetic project and capitalises a lowercase name", async () => {
    await createProject();
    // The feedback case: type the whole name in the first field, in lowercase.
    await createPerson("иван иванов", { gender: "MALE" });

    expect(await cardTitle()).toBe("Иван Иванов");
    const text = await bodyText();
    expect(text).toContain("Иван Иванов");

    save("feedback-name", { cardTitle: await cardTitle() });
    await shot("feedback-name");
    expect(await consoleErrors()).toEqual([]);
  });

  it("labels one parent edge from the child and from the parent", async () => {
    await createPerson("Пётр Петров", { gender: "MALE" });
    await openPerson("Иван Иванов");
    await addParentFromCard("Пётр Петров");

    const childRows = await familyRows();
    const childView = rowWith(childRows, "Отец", "Пётр Петров");
    expect(childView).toBeTruthy();
    expect(childView.startsWith("Отец")).toBe(true);

    // Opening the related person flips the same edge to the child role.
    await $(
      '//section[contains(@class,"person-card")]//button[normalize-space(.)="Пётр Петров"]',
    ).click();
    await browser.waitUntil(async () => (await cardTitle()) === "Пётр Петров", {
      timeout: 10000,
      timeoutMsg: "the parent card did not open",
    });
    await browser.pause(400);

    const parentRows = await familyRows();
    const parentView = rowWith(parentRows, "Сын", "Иван Иванов");
    expect(parentView).toBeTruthy();
    expect(parentView.startsWith("Сын")).toBe(true);

    save("feedback-relation-labels", {
      childView,
      parentView,
      parentCard: await cardTitle(),
    });
    await shot("feedback-relation-labels");
    expect(await consoleErrors()).toEqual([]);
  });

  it("links birth parents and shows them on the child card", async () => {
    await createPerson(LONG_FATHER, { gender: "MALE" });
    await createPerson(LONG_MOTHER, { gender: "FEMALE" });
    await createPerson(LONG_CHILD);

    await openEventForm();
    await setEventType("BIRTH");
    await pickPerson("#event-person", LONG_CHILD);
    await pickPerson("#event-parent-0", LONG_FATHER);

    // The mother slot offers women only: the already picked father and another
    // male person are absent from the list.
    const mother = await $("#event-parent-1");
    await mother.click();
    await browser.pause(600);
    const motherOptions = await browser.execute(() =>
      [...document.querySelectorAll('[role="option"]')].map((option) =>
        (option.textContent || "").replace(/\s+/g, " ").trim(),
      ),
    );
    const motherText = motherOptions.join(" | ");
    expect(motherText).not.toContain(LONG_FATHER);
    expect(motherText).not.toContain("Иван Иванов");
    expect(motherText).toContain(LONG_MOTHER);
    const motherOption = await $(
      `//*[@role="option"][contains(., "${LONG_MOTHER}")]`,
    );
    await motherOption.waitForExist({ timeout: 5000 });
    await motherOption.waitForClickable({ timeout: 5000 });
    await motherOption.click();
    await browser.pause(300);

    await setDate("#event-date", "1990-05-17");
    await submitEvent();

    await clickNav("Люди");
    await openPerson(LONG_CHILD);
    const rows = await familyRows();
    const fatherRow = rowWith(rows, "Отец", LONG_FATHER);
    const motherRow = rowWith(rows, "Мать", LONG_MOTHER);
    expect(fatherRow).toBeTruthy();
    expect(motherRow).toBeTruthy();
    expect(fatherRow.startsWith("Отец")).toBe(true);
    expect(motherRow.startsWith("Мать")).toBe(true);

    save("feedback-birth-parents", { rows, motherOptions });
    await shot("feedback-birth-parents");
    expect(await consoleErrors()).toEqual([]);
  });

  it("keeps both parents on one level and clamps a long name", async () => {
    await clickNav("Дерево");
    await browser.pause(800);
    await rootGraphAt(LONG_CHILD);

    const cards = await graphCards();
    const father = cards.find((card) => card.name === LONG_FATHER);
    const mother = cards.find((card) => card.name === LONG_MOTHER);
    const child = cards.find((card) => card.name === LONG_CHILD);
    expect(father).toBeTruthy();
    expect(mother).toBeTruthy();
    expect(child).toBeTruthy();

    // Same generation -> same vertical position.
    expect(Math.abs(father.card.top - mother.card.top)).toBeLessThanOrEqual(1);

    // The long caption wraps, never exceeds three lines and stays in the card.
    expect(child.nameBox).not.toBeNull();
    const lineHeight = child.lineHeight * child.scale;
    const lines = Math.round(child.nameBox.height / lineHeight);
    expect(lines).toBeGreaterThanOrEqual(2);
    expect(lines).toBeLessThanOrEqual(3);
    expect(child.nameBox.bottom).toBeLessThanOrEqual(child.card.bottom + 1);
    expect(child.nameBox.right).toBeLessThanOrEqual(child.card.right + 1);

    const clamp = await browser.execute(() => {
      const name = [...document.querySelectorAll(".graph-node-name")].find(
        (element) =>
          (element.textContent ?? "").trim() ===
          "Николай Александрович Воронцов-Романовский-Дашков",
      );
      if (!name) return null;
      const style = getComputedStyle(name);
      return {
        clamp: style.webkitLineClamp || style.lineClamp,
        overflow: style.overflow,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(clamp).not.toBeNull();
    expect(clamp.clamp).toBe("3");
    expect(clamp.overflow).toBe("hidden");

    save("feedback-tree-levels", {
      levels: {
        fatherTop: father.card.top,
        motherTop: mother.card.top,
        childTop: child.card.top,
      },
      longName: {
        name: child.name,
        lines,
        lineHeight,
        box: child.nameBox,
        card: child.card,
        clamp,
      },
    });
    await shot("feedback-tree-levels");
    expect(await consoleErrors()).toEqual([]);
  });

  it("makes two marriage participants spouses on their cards", async () => {
    await clickNav("Люди");
    await browser.pause(600);
    await createPerson("Сергей Смирнов");
    await createPerson("Ольга Смирнова");

    await openEventForm();
    await setEventType("MARRIAGE");
    await pickPerson("#event-person", "Сергей Смирнов");
    await pickPerson("#event-spouse", "Ольга Смирнова");
    await setDate("#event-date", "1990-06-01");
    await submitEvent();

    await clickNav("Люди");
    await openPerson("Сергей Смирнов");
    let rows = await familyRows();
    expect(rowWith(rows, "Супруг(а)", "Ольга Смирнова")).toBeTruthy();

    await openPerson("Ольга Смирнова");
    rows = await familyRows();
    expect(rowWith(rows, "Супруг(а)", "Сергей Смирнов")).toBeTruthy();

    save("feedback-marriage", { rows });
    await shot("feedback-marriage");
    expect(await consoleErrors()).toEqual([]);
  });

  it("hides the spouse layer until the tree toggle is switched on", async () => {
    await clickNav("Дерево");
    await browser.pause(800);
    await rootGraphAt("Сергей Смирнов");

    const toggle = await $('//button[normalize-space(.)="Показывать супругов"]');
    await toggle.waitForDisplayed({ timeout: 10000 });
    // A previous run may have persisted the toggle; normalise to "off".
    if ((await toggle.getAttribute("aria-pressed")) === "true") {
      await toggle.click();
      await browser.pause(800);
    }
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await graphNameVisible("Ольга Смирнова")).toBe(false);
    await shot("feedback-spouse-hidden");

    await toggle.click();
    await browser.waitUntil(
      async () => await graphNameVisible("Ольга Смирнова"),
      { timeout: 10000, timeoutMsg: "the spouse node did not appear" },
    );
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    save("feedback-spouse-shown", {
      pressed: await toggle.getAttribute("aria-pressed"),
      cards: (await graphCards()).map((card) => card.name),
    });
    await shot("feedback-spouse-shown");

    await toggle.click();
    await browser.waitUntil(
      async () => !(await graphNameVisible("Ольга Смирнова")),
      { timeout: 10000, timeoutMsg: "the spouse node did not disappear" },
    );
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await consoleErrors()).toEqual([]);
  });

  it("matches a 1980-1990 period event when the year filter starts in 1986", async () => {
    await openEventForm();
    await setEventType("OCCUPATION");
    await pickPerson("#event-person", "Иван Иванов");
    await setRange();
    await setDate("#event-date", "1970-01-01");
    await setDate("#event-date-end", "1975-12-31");
    await submitEvent();

    await openEventForm();
    await setEventType("OCCUPATION");
    await pickPerson("#event-person", "Иван Иванов");
    await setRange();
    await setDate("#event-date", "1980-01-01");
    await setDate("#event-date-end", "1990-12-31");
    await submitEvent();

    const oldRow = await $('//tr[contains(., "Занятие") and contains(., "1970")]');
    expect(await oldRow.isExisting()).toBe(true);
    await shot("feedback-year-before");

    const from = await $('[role="slider"][aria-label="Год от"]');
    await from.waitForDisplayed({ timeout: 10000 });
    await from.click();
    await browser.keys(["Home"]);
    await browser.pause(250);
    for (let index = 0; index < 16; index += 1) {
      await browser.keys(["ArrowRight"]);
      await browser.pause(80);
    }
    await browser.pause(700);
    expect(
      await (await $('[role="slider"][aria-label="Год от"]')).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("1986");

    const periodRow = await $(
      '//tr[contains(., "Занятие") and contains(., "1980")]',
    );
    expect(await periodRow.isDisplayed()).toBe(true);
    expect(
      await $('//tr[contains(., "Занятие") and contains(., "1970")]').isExisting(),
    ).toBe(false);

    save("feedback-year-filter", {
      from: await (await $('[role="slider"][aria-label="Год от"]')).getAttribute(
        "aria-valuenow",
      ),
      periodVisible: await periodRow.isDisplayed(),
      oldVisible: await $('//tr[contains(., "Занятие") and contains(., "1970")]').isExisting(),
    });
    await shot("feedback-year-filter");

    // Back to the full range before the next scenario.
    const reset = await $('[role="slider"][aria-label="Год от"]');
    await reset.click();
    await browser.keys(["Home"]);
    await browser.pause(400);
    expect(
      await $('//tr[contains(., "Занятие") and contains(., "1970")]').isExisting(),
    ).toBe(true);
    expect(await consoleErrors()).toEqual([]);
  });

  it("keeps an open-ended residence and rejects an overlapping second one", async () => {
    await openEventForm();
    await setEventType("RESIDENCE");
    await pickPerson("#event-person", "Иван Иванов");
    await setRange();
    await setDate("#event-date", "1980-01-01");
    const ongoing = await $('[role="switch"]');
    await ongoing.click();
    await browser.pause(400);
    expect(await ongoing.isSelected()).toBe(true);
    await submitEvent();

    // Reopen the saved event: the start is there, the end stays open.
    const row = await $(
      '//tr[contains(., "Место жительства") and contains(., "1980")]',
    );
    await row.click();
    const card = await $(".events-card");
    await card.waitForDisplayed({ timeout: 10000 });
    await $('//button[normalize-space(.)="Изменить"]').click();
    const end = await $("#event-date-end");
    await end.waitForDisplayed({ timeout: 10000 });
    expect(await end.getValue()).toBe("");
    const reopenSwitch = await $('[role="switch"]');
    expect(await reopenSwitch.isSelected()).toBe(true);
    save("feedback-residence-open", {
      openEnd: await end.getValue(),
      ongoing: await reopenSwitch.isSelected(),
      start: await (await $("#event-date")).getValue(),
    });
    await shot("feedback-residence-open");
    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(500);

    // A second residence starting inside the open period must be rejected.
    await openEventForm();
    await setEventType("RESIDENCE");
    await pickPerson("#event-person", "Иван Иванов");
    await setRange();
    await setDate("#event-date", "1985-01-01");
    const secondSwitch = await $('[role="switch"]');
    await secondSwitch.click();
    await browser.pause(300);
    await $('//button[normalize-space(.)="Создать"]').click();

    const alert = await $('[role="alert"]');
    await alert.waitForDisplayed({ timeout: 10000 });
    expect((await alert.getText()).trim()).toBe(
      "Периоды проживания пересекаются",
    );
    save("feedback-residence-overlap", {
      alert: (await alert.getText()).trim(),
      stillOpen: await $("#event-type").isExisting(),
    });
    await shot("feedback-residence-overlap");

    await $('//button[normalize-space(.)="Отмена"]').click();
    await browser.pause(400);
    expect(await consoleErrors()).toEqual([]);
  });

  it("stops timeline panning and zooming at the loaded data bound", async () => {
    await clickNav("Хронология");
    await browser.waitUntil(async () => (await headingText()) === "Хронология", {
      timeout: 10000,
    });
    const canvas = await $('[data-testid="line-canvas"]');
    await canvas.waitForDisplayed({ timeout: 15000 });
    await browser.pause(1200);

    const initial = await axisYears();
    expect(initial.length).toBeGreaterThan(0);
    const initialMax = Math.max(...initial);
    expect(initialMax).toBeLessThanOrEqual(1991);

    const rect = await browser.execute(() => {
      const track = document.querySelector('[data-testid="timeline-line-track"]');
      const box = track.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    });

    // Zoom in around a quarter of the full range with a real wheel action.
    const zoomX = Math.round(rect.x + rect.width * 0.25);
    const zoomY = Math.round(rect.y + rect.height * 0.5);
    await browser.performActions([
      {
        type: "wheel",
        id: "wheel",
        actions: [
          {
            type: "scroll",
            x: zoomX,
            y: zoomY,
            deltaX: 0,
            deltaY: -400,
            duration: 100,
            origin: "viewport",
          },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.pause(700);

    for (let index = 0; index < 4; index += 1) {
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
              x: Math.round(rect.x + rect.width * 0.85),
              y: Math.round(rect.y + rect.height - 40),
            },
            { type: "pointerDown", button: 0 },
            {
              type: "pointerMove",
              duration: 250,
              origin: "viewport",
              x: Math.round(rect.x + rect.width * 0.15),
              y: Math.round(rect.y + rect.height - 40),
            },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await browser.pause(350);
    }

    const moved = await axisYears();
    expect(moved.length).toBeGreaterThan(0);
    // The gesture really moved the window (otherwise the bound assertion is
    // vacuous), but never beyond the latest event end.
    expect(Math.min(...moved)).toBeGreaterThan(Math.min(...initial));
    expect(Math.max(...moved)).toBeLessThanOrEqual(1991);
    expect(await $('[data-testid="line-empty-range"]').isExisting()).toBe(false);
    const visibleItems = await browser.execute(() => ({
      markers: document.querySelectorAll('[data-testid="line-marker"]').length,
      clusters: document.querySelectorAll('[data-testid="line-cluster"]').length,
    }));
    // Dense neighbours collapse into one cluster, so count both kinds.
    expect(visibleItems.markers + visibleItems.clusters).toBeGreaterThan(0);

    save("feedback-timeline-bounds", {
      initial,
      moved,
      dataBound: initialMax,
      visibleItems,
      emptyRange: await $('[data-testid="line-empty-range"]').isExisting(),
    });
    await shot("feedback-timeline-bounds");
    expect(await consoleErrors()).toEqual([]);
  });

  it("rejects a parent less than nine years older than the child", async () => {
    await clickNav("Люди");
    await browser.pause(600);
    await createPerson("Малыш Тестов", { birth: "1990-01-01" });
    await createPerson("Юный Родитель", { birth: "1985-01-01" });

    await openPerson("Малыш Тестов");
    await addParentFromCard("Юный Родитель");

    const alert = await $('[role="alert"]');
    await alert.waitForDisplayed({ timeout: 10000 });
    expect((await alert.getText()).trim()).toBe(
      "Родитель должен быть старше ребёнка не менее чем на 9 лет",
    );
    expect(
      rowWith(await familyRows(), "Родитель", "Юный Родитель"),
    ).toBeUndefined();

    save("feedback-age-gap", {
      alert: (await alert.getText()).trim(),
      family: await familyRows(),
    });
    await shot("feedback-age-gap");
    expect(await consoleErrors()).toEqual([]);
  });
});
