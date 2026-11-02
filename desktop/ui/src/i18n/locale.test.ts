import { describe, expect, it } from "vitest";
import { errorMessageKey, resolveLocale } from "./locale";

describe("resolveLocale", () => {
  it("keeps explicit locales", () => {
    expect(resolveLocale("en", "ru-RU")).toBe("en");
    expect(resolveLocale("ru", "en-US")).toBe("ru");
    expect(resolveLocale("de", "ru-RU")).toBe("de");
    expect(resolveLocale("es", "en-US")).toBe("es");
    expect(resolveLocale("uk", "ru-RU")).toBe("uk");
    expect(resolveLocale("be", "ru-RU")).toBe("be");
  });

  it("follows the system language for system/unknown", () => {
    expect(resolveLocale("system", "en-GB")).toBe("en");
    expect(resolveLocale("system", "de-DE")).toBe("de");
    expect(resolveLocale(null, "uk-UA")).toBe("uk");
    expect(resolveLocale(undefined, "be-BY")).toBe("be");
    expect(resolveLocale(null, "es-ES")).toBe("es");
    expect(resolveLocale(null, "ru-RU")).toBe("ru");
  });

  it("falls back to ru for unsupported systems", () => {
    expect(resolveLocale("xx", "fr-FR")).toBe("ru");
    expect(resolveLocale(undefined, null)).toBe("ru");
  });
});

describe("errorMessageKey", () => {
  it("maps codes to dictionary keys", () => {
    expect(errorMessageKey("PROJECT_LOCKED")).toBe("errors.PROJECT_LOCKED");
  });
});
