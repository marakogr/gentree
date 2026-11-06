// The events table «person» column shows the event owner only. Participants
// still appear in the event card, which the second block guards.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DateValue, EventEntity, Person, Versioned } from "../../api/types";
import { EMPTY_VALUE } from "../../lib/formatValue";
import { EventCard } from "./EventCard";
import { EventPersonCell } from "./EventPersonCell";
import { eventOwnerId } from "./helpers";

// The card reads translations; the assertions only cover person names.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const date: DateValue = {
  start: "1990-01-01",
  end: "1991-01-01",
  precision: "YEAR",
  qualifier: "EXACT",
  original: null,
};

function person(
  id: string,
  surname: string,
  given: string,
  gender: Person["gender"],
): Person {
  return {
    id,
    gender,
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
    birth: date,
    death: date,
    notes: null,
    externalIds: [],
  };
}

const child = person("child", "Ivanov", "Ivan", "MALE");
const mother = person("mother", "Ivanova", "Anna", "FEMALE");
const father = person("father", "Ivanov", "Petr", "MALE");

// Owner plus both parents: the shape the issue describes.
const birth: EventEntity = {
  id: "e1",
  personId: child.id,
  type: "BIRTH",
  date,
  place: null,
  description: null,
  sourceIds: [],
  originalType: null,
  participantIds: [mother.id, father.id],
};

function nameOf(personId: string): string {
  const entry = [child, mother, father].find((item) => item.id === personId);
  return entry ? `${entry.names[0].surname} ${entry.names[0].given}` : "";
}

describe("EventPersonCell", () => {
  it("shows only the event owner, never the participants", () => {
    const ownerId = eventOwnerId(birth);
    const html = renderToStaticMarkup(
      <EventPersonCell
        ownerId={ownerId}
        name={ownerId === null ? "" : nameOf(ownerId)}
        onOpenPerson={() => undefined}
      />,
    );
    expect(html).toContain("Ivanov Ivan");
    expect(html).not.toContain("Ivanova Anna");
    expect(html).not.toContain("Ivanov Petr");
    expect(html).not.toContain(",");
  });

  it("falls back to the neutral empty value without an owner", () => {
    const html = renderToStaticMarkup(
      <EventPersonCell ownerId={null} name="" onOpenPerson={() => undefined} />,
    );
    expect(html).toContain(EMPTY_VALUE);
    expect(html).not.toContain("<button");
  });
});

describe("EventCard", () => {
  it("still exposes the participants of the event", () => {
    const versioned: Versioned<EventEntity> = { entity: birth, version: "1" };
    const html = renderToStaticMarkup(
      <EventCard
        event={versioned}
        persons={[child, mother, father]}
        onEdit={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("Ivanov Ivan");
    expect(html).toContain("Ivanova Anna");
    expect(html).toContain("Ivanov Petr");
  });
});
