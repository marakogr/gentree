import i18next from "i18next";
import { describe, expect, it } from "vitest";
import enPerson from "./locales/en/person.json";
import ruPerson from "./locales/ru/person.json";

async function instance(lng: "ru" | "en") {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: false,
    defaultNS: "person",
    resources: {
      ru: { person: ruPerson },
      en: { person: enPerson },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("plural counts", () => {
  it("uses Russian one/few/many forms", async () => {
    const i18n = await instance("ru");
    expect(i18n.t("count", { count: 1 })).toBe("1 человек");
    expect(i18n.t("count", { count: 2 })).toBe("2 человека");
    expect(i18n.t("count", { count: 5 })).toBe("5 человек");
  });

  it("uses English one/other forms", async () => {
    const i18n = await instance("en");
    expect(i18n.t("count", { count: 1 })).toBe("1 person");
    expect(i18n.t("count", { count: 2 })).toBe("2 people");
  });
});
