import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ruCommon from "../../i18n/locales/ru/common.json";
import ruEnums from "../../i18n/locales/ru/enums.json";
import ruEvent from "../../i18n/locales/ru/event.json";
import ruPerson from "../../i18n/locales/ru/person.json";
import ruRelationship from "../../i18n/locales/ru/relationship.json";
import type { Person, PersonDetail } from "../../api/types";
import PersonCard from "./PersonCard";

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "ru",
    fallbackLng: "ru",
    ns: ["person", "common", "enums", "relationship", "event"],
    defaultNS: "person",
    resources: {
      ru: {
        person: ruPerson,
        common: ruCommon,
        enums: ruEnums,
        relationship: ruRelationship,
        event: ruEvent,
      },
    },
    interpolation: { escapeValue: false },
  });
});

const noop = () => undefined;

function person(id: string, given: string): Person {
  return {
    id,
    gender: "MALE",
    names: [
      {
        given,
        patronymic: null,
        surname: "Тестов",
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

const detail: PersonDetail = {
  person: { entity: person("p1", "Иван"), version: "v1" },
  events: [],
  relationships: [
    {
      entity: {
        id: "r1",
        type: "PARENT_CHILD",
        personId: "p1",
        relatedPersonId: "p2",
        notes: null,
      },
      version: "v1",
    },
  ],
  relatedPersons: [{ entity: person("p2", "Пётр"), version: "v1" }],
};

function renderCard(): string {
  return renderToStaticMarkup(
    <PersonCard
      detail={detail}
      onEdit={noop}
      onDelete={noop}
      onChanged={noop}
      onBack={noop}
    />,
  );
}

describe("PersonCard polish (#131)", () => {
  it("replaces the text edit action with a labelled pencil", () => {
    const html = renderCard();
    expect(html).toContain('aria-label="Изменить"');
    expect(html).not.toContain(">Изменить<");
  });

  it("puts the close control after the other header actions", () => {
    const html = renderCard();
    const header = html.slice(
      html.indexOf('<header class="person-card-head">'),
      html.indexOf("</header>"),
    );
    const close = header.indexOf('aria-label="Закрыть карточку"');
    const edit = header.indexOf('aria-label="Изменить"');
    const more = header.indexOf('aria-label="Действия"');
    expect(close).toBeGreaterThan(edit);
    expect(close).toBeGreaterThan(more);
  });

  it("drops the relationship table headers", () => {
    const html = renderCard();
    expect(html).not.toContain("<thead");
    expect(html).not.toContain("Тип связи");
    expect(html).not.toContain(">Кто<");
  });

  it("keeps a single attach-file action in the files section", () => {
    const html = renderCard();
    const matches = html.match(/Приложить файл/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
