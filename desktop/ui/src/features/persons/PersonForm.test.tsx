import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ruCommon from "../../i18n/locales/ru/common.json";
import ruEnums from "../../i18n/locales/ru/enums.json";
import ruPerson from "../../i18n/locales/ru/person.json";
import PersonForm from "./PersonForm";

// Fluent renders a dialog into a client-side portal, which is empty on the
// server. Mirror the close-label contract so the test can assert that the form
// asks for a header close control.
vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({
    children,
    closeLabel,
  }: {
    children?: ReactNode;
    closeLabel?: string;
  }) => <div data-close-label={closeLabel}>{children}</div>,
}));

vi.mock("../../components/ui/toast", () => ({
  useToast: () => ({
    notify: () => undefined,
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
  }),
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "ru",
    fallbackLng: "ru",
    ns: ["person", "common", "enums"],
    defaultNS: "person",
    resources: {
      ru: { person: ruPerson, common: ruCommon, enums: ruEnums },
    },
    interpolation: { escapeValue: false },
  });
});

const noop = () => undefined;

describe("PersonForm dialog chrome (#131)", () => {
  it("asks the dialog for a header close control", () => {
    const html = renderToStaticMarkup(
      <PersonForm
        initial={null}
        version={null}
        onSaved={noop}
        onCancel={noop}
        onReload={noop}
      />,
    );
    expect(html).toContain('data-close-label="Закрыть"');
    expect(html).toContain('id="person-surname"');
  });
});
