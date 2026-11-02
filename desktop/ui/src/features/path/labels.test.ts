import i18next from "i18next";
import { describe, expect, it } from "vitest";
import type { Gender, PathStep } from "../../api/types";
import enPath from "../../i18n/locales/en/path.json";
import ruPath from "../../i18n/locales/ru/path.json";
import {
  edgesFromPath,
  pathChainLinks,
  stepWordKey,
} from "./labels";

async function instance(lng: "ru" | "en") {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: false,
    defaultNS: "path",
    resources: {
      ru: { path: ruPath },
      en: { path: enPath },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe("stepWordKey", () => {
  it("maps every direction and gender to a path key", () => {
    expect(stepWordKey("UP", "MALE")).toBe("step.UP.MALE");
    expect(stepWordKey("UP", "FEMALE")).toBe("step.UP.FEMALE");
    expect(stepWordKey("UP", "UNKNOWN")).toBe("step.UP.UNKNOWN");
    expect(stepWordKey("DOWN", "MALE")).toBe("step.DOWN.MALE");
    expect(stepWordKey("DOWN", "FEMALE")).toBe("step.DOWN.FEMALE");
    expect(stepWordKey("DOWN", "UNKNOWN")).toBe("step.DOWN.UNKNOWN");
    expect(stepWordKey("SPOUSE", "MALE")).toBe("step.SPOUSE.MALE");
    expect(stepWordKey("SPOUSE", "FEMALE")).toBe("step.SPOUSE.FEMALE");
    expect(stepWordKey("SPOUSE", "UNKNOWN")).toBe("step.SPOUSE.UNKNOWN");
  });

  it("resolves to localized words in both locales", async () => {
    const ru = await instance("ru");
    expect(ru.t(stepWordKey("UP", "MALE"))).toBe("отец");
    expect(ru.t(stepWordKey("DOWN", "FEMALE"))).toBe("дочь");
    expect(ru.t(stepWordKey("SPOUSE", "UNKNOWN"))).toBe("партнёр");

    const en = await instance("en");
    expect(en.t(stepWordKey("UP", "FEMALE"))).toBe("mother");
    expect(en.t(stepWordKey("DOWN", "MALE"))).toBe("son");
    expect(en.t(stepWordKey("SPOUSE", "FEMALE"))).toBe("wife");
  });
});

const path: PathStep[] = [
  { personId: "a", edgeToNext: "SPOUSE" },
  { personId: "b", edgeToNext: "UP" },
  { personId: "c", edgeToNext: null },
];

const genderOf = (personId: string): Gender =>
  personId === "b" ? "FEMALE" : "MALE";

describe("path edges", () => {
  it("maps every direction to a kinship edge kind", () => {
    expect(edgesFromPath(path, genderOf)).toEqual([
      {
        from: "a",
        to: "b",
        kind: "SPOUSE",
        fromGender: "MALE",
        toGender: "FEMALE",
        adoptive: false,
      },
      {
        from: "b",
        to: "c",
        kind: "PARENT",
        fromGender: "FEMALE",
        toGender: "MALE",
        adoptive: false,
      },
    ]);
  });

  it("keeps the direction and the target person for the readable chain", () => {
    expect(pathChainLinks(path, genderOf)).toEqual([
      { direction: "SPOUSE", personId: "b", gender: "FEMALE" },
      { direction: "UP", personId: "c", gender: "MALE" },
    ]);
  });
});
