import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ruCommon from "../../i18n/locales/ru/common.json";
import ruEnums from "../../i18n/locales/ru/enums.json";
import ruEvent from "../../i18n/locales/ru/event.json";
import ruPerson from "../../i18n/locales/ru/person.json";
import ruTimeline from "../../i18n/locales/ru/timeline.json";
import type { DateValue, EventEntity, Person } from "../../api/types";
import { EMPTY_VALUE } from "../../lib/formatValue";
import { EventPopover } from "./EventPopover";

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "ru",
    fallbackLng: "ru",
    ns: ["timeline", "event", "common", "enums", "person"],
    defaultNS: "timeline",
    resources: {
      ru: {
        timeline: ruTimeline,
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

function person(id: string, surname: string, given: string): Person {
  return {
    id,
    gender: "MALE",
    names: [
      {
        given,
        patronymic: null,
        surname,
        prefix: null,
        suffix: null,
        nameType: "BIRTH",
        isPrimary: true,
      },
    ],
    birth: {
      start: null,
      end: null,
      precision: "UNKNOWN",
      qualifier: "EXACT",
      original: null,
    },
    death: {
      start: null,
      end: null,
      precision: "UNKNOWN",
      qualifier: "EXACT",
      original: null,
    },
    notes: null,
    externalIds: [],
  };
}

const dayDate: DateValue = {
  start: "1900-01-01",
  end: "1900-01-02",
  precision: "DAY",
  qualifier: "EXACT",
  original: null,
};

const unknownDate: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "EXACT",
  original: null,
};

function event(overrides: Partial<EventEntity> = {}): EventEntity {
  return {
    id: "event-1",
    personId: "person-1",
    type: "RESIDENCE",
    date: dayDate,
    place: "Казань",
    description: "Тестовая запись",
    sourceIds: ["source-1"],
    originalType: null,
    participantIds: ["person-1", "person-2"],
    details: {
      address: "Казань, улица Баумана",
      legacy_note: "старая заметка",
    },
    ...overrides,
  };
}

const persons = [
  person("person-1", "Иванов", "Иван"),
  person("person-2", "Петрова", "Анна"),
];

function renderPopover(overrides: Partial<EventEntity> = {}, people = persons) {
  return renderToStaticMarkup(
    <EventPopover
      event={event(overrides)}
      persons={people}
      onClose={noop}
      onOpenPerson={noop}
    />,
  );
}

function fieldOrder(html: string): string[] {
  return [...html.matchAll(/data-field="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("EventPopover read mode", () => {
  it("shows the event-card field set in the same order (#144)", () => {
    const html = renderPopover();
    expect(fieldOrder(html)).toEqual([
      "date",
      "precision",
      "place",
      "participants",
      "description",
      "detail:address",
      "detail:legacy_note",
      "files",
    ]);
  });

  it("uses the owner as the title and lists only co-participants", () => {
    const html = renderPopover();
    // Owner appears once, as the heading; it is not repeated in the list.
    expect(html.match(/Иванов Иван/g)).toHaveLength(1);
    expect(html).toContain("Петрова Анна");
    expect(html.match(/events-person-link/g)).toHaveLength(1);
  });

  it("renders date, precision and empty-value placeholders like the card", () => {
    const html = renderPopover();
    expect(html).toContain("Дата");
    expect(html).toContain("Точность");
    expect(html).toContain("День");
    expect(html).toContain("Казань");
    expect(html).toContain("Тестовая запись");
    expect(html).toContain("Казань, улица Баумана");
    // Unknown/legacy detail keys keep their raw label.
    expect(html).toContain("legacy_note");
    expect(html).toContain("старая заметка");
    expect(html).toContain("Файлы");
    expect(html).toContain(EMPTY_VALUE);
    expect(html).toContain("Источник");
  });

  it("keeps an honest unknown date and falls back to the localized type", () => {
    const html = renderPopover({ date: unknownDate }, []);
    const dateRow = /data-field="date"[\s\S]*?<dd>([^<]*)<\/dd>/.exec(html);
    expect(dateRow?.[1]).toBe(EMPTY_VALUE);
    expect(html).toContain("Неизвестно");
    // No person resolves the owner, so the title is the localized type.
    expect(html.match(/Проживание/g)).toHaveLength(2);
  });

  it("keeps the sources block next to the shared field set", () => {
    const html = renderPopover();
    expect(html).toContain("Источник: 1");
    expect(html).toContain("Источники пока не раскрываются");
  });
});
