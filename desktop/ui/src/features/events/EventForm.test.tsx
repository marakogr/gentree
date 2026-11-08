import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ruCommon from "../../i18n/locales/ru/common.json";
import ruEnums from "../../i18n/locales/ru/enums.json";
import ruEvent from "../../i18n/locales/ru/event.json";
import ruPerson from "../../i18n/locales/ru/person.json";
import type { DateValue, EventEntity, EventType, Gender, Person } from "../../api/types";
import EventForm from "./EventForm";

// Fluent renders a dialog into a client-side portal, which is empty on the
// server. The test only inspects the form body, so a plain container stands in
// for the portal.
vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({
    children,
    closeLabel,
  }: {
    children?: ReactNode;
    closeLabel?: string;
  }) => <div data-close-label={closeLabel}>{children}</div>,
}));

// Fluent renders the listbox only after the combobox is opened, which a server
// render never does. The stand-in keeps the visible contract of the field: the
// selected label in `value`, and every offered option in `data-items`.
vi.mock("../../components/ui/combobox", () => ({
  Combobox: ({
    id,
    items,
    value,
    disabled,
  }: {
    id?: string;
    items: { id: string; label: string }[];
    value: string;
    disabled?: boolean;
  }) => {
    const selected = items.find((item) => item.id === value) ?? null;
    return (
      <input
        id={id}
        value={selected?.label ?? ""}
        disabled={disabled}
        readOnly
        data-items={items.map((item) => item.label).join("|")}
      />
    );
  },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "ru",
    fallbackLng: "ru",
    ns: ["event", "common", "enums", "person"],
    defaultNS: "event",
    resources: {
      ru: {
        event: ruEvent,
        common: ruCommon,
        enums: ruEnums,
        person: ruPerson,
      },
    },
    interpolation: { escapeValue: false },
  });
});

const noop = () => undefined;

function renderForm(defaultType?: EventType): string {
  return renderToStaticMarkup(
    <EventForm
      initial={null}
      version={null}
      persons={[]}
      defaultType={defaultType}
      onSaved={noop}
      onCancel={noop}
      onReload={noop}
    />,
  );
}

function indexOfId(html: string, id: string): number {
  return html.indexOf(`id="${id}"`);
}

const unknownDate: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function person(id: string, given: string, gender: Gender): Person {
  return {
    id,
    gender,
    names: [
      {
        surname: null,
        given,
        patronymic: null,
        prefix: null,
        suffix: null,
        nameType: "BIRTH",
        isPrimary: true,
      },
    ],
    birth: unknownDate,
    death: unknownDate,
    notes: null,
    externalIds: [],
  };
}

/** `value` of the input that carries `id`, wherever the attribute order puts it. */
function inputValue(html: string, id: string): string {
  const at = indexOfId(html, id);
  if (at < 0) return "";
  const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  return /value="([^"]*)"/.exec(tag)?.[1] ?? "";
}

/** Labels the combobox behind `id` offers, read from the test stand-in. */
function itemLabels(html: string, id: string): string[] {
  const at = indexOfId(html, id);
  if (at < 0) return [];
  const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  const raw = /data-items="([^"]*)"/.exec(tag)?.[1] ?? "";
  return raw === "" ? [] : raw.split("|");
}

/** Opening tag of the type option with this value. */
function optionTag(html: string, value: string): string {
  return new RegExp(`<option[^>]*value="${value}"[^>]*>`).exec(html)?.[0] ?? "";
}

describe("EventForm layout", () => {
  it.each<[string, EventType | undefined]>([
    ["birth", undefined],
    ["marriage", "MARRIAGE"],
    ["residence", "RESIDENCE"],
  ])("opens the %s card with the type field", (_name, type) => {
    const html = renderForm(type);
    const typeIndex = indexOfId(html, "event-type");
    expect(typeIndex).toBeGreaterThanOrEqual(0);
    expect(indexOfId(html, "event-person")).toBeGreaterThan(typeIndex);
    expect(indexOfId(html, "event-place")).toBeGreaterThan(typeIndex);
    expect(indexOfId(html, "event-date")).toBeGreaterThan(typeIndex);
  });

  it("keeps the type before the birth parent pickers", () => {
    const html = renderForm();
    expect(html).toContain('id="event-parent-0"');
    expect(indexOfId(html, "event-parent-0")).toBeGreaterThan(
      indexOfId(html, "event-type"),
    );
  });

  it("no longer promises a parent-child link under the parent pickers", () => {
    const html = renderForm();
    expect(html).not.toContain("При сохранении создаётся связь");
    expect(html).not.toContain("родитель — ребёнок");
  });

  it("asks the dialog for a header close control", () => {
    expect(renderForm()).toContain('data-close-label="Закрыть"');
  });
});

describe("EventForm birth parent slots", () => {
  const child = person("child", "Иван", "MALE");
  const mother = person("mother", "Анна", "FEMALE");
  const father = person("father", "Пётр", "MALE");

  function birth(participantIds: string[]): EventEntity {
    return {
      id: "e-1",
      personId: child.id,
      type: "BIRTH",
      date: unknownDate,
      place: null,
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds,
    };
  }

  function renderBirth(event: EventEntity): string {
    return renderToStaticMarkup(
      <EventForm
        initial={event}
        version={null}
        persons={[child, mother, father].map((entity) => ({ entity }))}
        onSaved={noop}
        onCancel={noop}
        onReload={noop}
      />,
    );
  }

  it("shows each stored parent in the slot its gender names", () => {
    const html = renderBirth(birth([mother.id, father.id]));
    expect(inputValue(html, "event-parent-0")).toBe("Пётр");
    expect(inputValue(html, "event-parent-1")).toBe("Анна");
  });

  it("keeps the mother in the mother slot after the father is deleted", () => {
    const html = renderBirth(birth([mother.id]));
    expect(inputValue(html, "event-parent-0")).toBe("");
    expect(inputValue(html, "event-parent-1")).toBe("Анна");
  });

  it("keeps the father in the father slot after the mother is deleted", () => {
    const html = renderBirth(birth([father.id]));
    expect(inputValue(html, "event-parent-0")).toBe("Пётр");
    expect(inputValue(html, "event-parent-1")).toBe("");
  });
});

describe("EventForm life-event person picker (issue #145)", () => {
  const ivan = person("ivan", "Иван", "MALE");
  const anna = person("anna", "Анна", "FEMALE");

  function stored(id: string, personId: string, type: EventType): EventEntity {
    return {
      id,
      personId,
      type,
      date: unknownDate,
      place: null,
      description: null,
      sourceIds: [],
      originalType: null,
      participantIds: [],
    };
  }

  function render(
    options: {
      initial?: EventEntity;
      type?: EventType;
      defaultPersonId?: string;
      persons?: Person[];
      events?: EventEntity[];
    } = {},
  ): string {
    return renderToStaticMarkup(
      <EventForm
        initial={options.initial ?? null}
        version={null}
        persons={(options.persons ?? [ivan, anna]).map((entity) => ({ entity }))}
        events={options.events ?? []}
        defaultPersonId={options.defaultPersonId}
        defaultType={options.type}
        onSaved={noop}
        onCancel={noop}
        onReload={noop}
      />,
    );
  }

  it("type first: offers only people without the chosen life event", () => {
    const html = render({
      type: "BIRTH",
      events: [stored("birth-ivan", ivan.id, "BIRTH")],
    });
    expect(itemLabels(html, "event-person")).toEqual(["Анна"]);
  });

  it("keeps the full person list for repeatable event types", () => {
    const html = render({
      type: "MARRIAGE",
      defaultPersonId: ivan.id,
      events: [stored("marriage-ivan", ivan.id, "MARRIAGE")],
    });
    expect(itemLabels(html, "event-person")).toEqual(["Иван", "Анна"]);
    expect(itemLabels(html, "event-spouse")).toEqual(["Анна"]);
  });

  it("says so when nobody is left for the chosen life event", () => {
    const html = render({
      type: "DEATH",
      events: [
        stored("death-ivan", ivan.id, "DEATH"),
        stored("death-anna", anna.id, "DEATH"),
      ],
    });
    expect(itemLabels(html, "event-person")).toEqual([]);
    expect(html).toContain("У всех людей уже есть событие этого типа");
  });

  it("person first: locks the type that person already has", () => {
    const html = render({
      type: "BIRTH",
      defaultPersonId: ivan.id,
      events: [stored("birth-ivan", ivan.id, "BIRTH")],
    });
    // The chosen person stays visible, but the type is offered as unavailable.
    expect(itemLabels(html, "event-person")).toEqual(["Иван", "Анна"]);
    expect(optionTag(html, "BIRTH")).toContain("disabled");
    expect(html).toContain("Такой тип нельзя добавить повторно");
  });

  it("edit mode keeps the current person and type for a legacy duplicate", () => {
    const edited = stored("birth-ivan", ivan.id, "BIRTH");
    const html = render({
      initial: edited,
      events: [edited, stored("birth-ivan-2", ivan.id, "BIRTH")],
    });
    expect(inputValue(html, "event-person")).toBe("Иван");
    expect(itemLabels(html, "event-person")).toEqual(["Иван", "Анна"]);
    expect(optionTag(html, "BIRTH")).not.toContain("disabled");
  });
});
