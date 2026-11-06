import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ruCommon from "../../i18n/locales/ru/common.json";
import ruEnums from "../../i18n/locales/ru/enums.json";
import ruEvent from "../../i18n/locales/ru/event.json";
import ruPerson from "../../i18n/locales/ru/person.json";
import type { EventType } from "../../api/types";
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
