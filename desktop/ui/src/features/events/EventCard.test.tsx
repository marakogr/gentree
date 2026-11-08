import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ruCommon from "../../i18n/locales/ru/common.json";
import ruEnums from "../../i18n/locales/ru/enums.json";
import ruEvent from "../../i18n/locales/ru/event.json";
import ruPerson from "../../i18n/locales/ru/person.json";
import type { EventEntity } from "../../api/types";
import { EventCard } from "./EventCard";

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

const birthEvent: EventEntity = {
  id: "event-1",
  personId: "person-1",
  type: "BIRTH",
  date: {
    start: "1900-01-01",
    end: "1900-12-31",
    precision: "DAY",
    qualifier: "RANGE",
    original: null,
  },
  place: null,
  description: null,
  sourceIds: [],
  originalType: null,
  participantIds: [],
};

describe("EventCard", () => {
  it("keeps the date and precision rows in the read-only card", () => {
    const html = renderToStaticMarkup(
      <EventCard
        event={{ entity: birthEvent, version: "v1" }}
        persons={[]}
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain("Дата");
    expect(html).toContain("Точность");
    expect(html).toContain("День");
  });

  it("hides the date qualifier because it cannot be edited here", () => {
    const html = renderToStaticMarkup(
      <EventCard
        event={{ entity: birthEvent, version: "v1" }}
        persons={[]}
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(html).not.toContain("Характер даты");
    expect(html).not.toContain("Интервал");
  });

  it("renders a labelled pencil instead of the text edit button (#131)", () => {
    const html = renderToStaticMarkup(
      <EventCard
        event={{ entity: birthEvent, version: "v1" }}
        persons={[]}
        onEdit={noop}
        onClose={noop}
      />,
    );
    const edit = html.indexOf('aria-label="Изменить"');
    const close = html.indexOf('aria-label="Закрыть"');
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(html).not.toContain(">Изменить<");
    expect(close).toBeGreaterThan(edit);
  });

  it("keeps the shared field order and legacy detail keys (#144)", () => {
    const withDetails: EventEntity = {
      ...birthEvent,
      place: "Казань",
      description: "Запись",
      details: { hospital: "Городская больница", legacy_note: "старое" },
    };
    const html = renderToStaticMarkup(
      <EventCard
        event={{ entity: withDetails, version: "v1" }}
        persons={[]}
        onEdit={noop}
        onClose={noop}
      />,
    );
    const order = [...html.matchAll(/data-field="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(order).toEqual([
      "date",
      "precision",
      "place",
      "participants",
      "description",
      "detail:birth_certificate",
      "detail:hospital",
      "detail:legacy_note",
      "files",
    ]);
    expect(html).toContain("старое");
  });
});
