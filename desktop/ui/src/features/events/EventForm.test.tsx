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
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
