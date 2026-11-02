import { describe, expect, it } from "vitest";
import {
  isThemePreference,
  persistThemePreference,
  readStoredThemePreference,
  resolveTheme,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  type ThemeStorage,
} from "./theme";

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe("isThemePreference", () => {
  it("accepts the three known values only", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("DARK")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

describe("resolveThemePreference", () => {
  it("lets the config win over the local cache", () => {
    expect(resolveThemePreference("light", "dark")).toBe("light");
    expect(resolveThemePreference("system", "dark")).toBe("system");
  });

  it("falls back to the cache when the config value is absent or invalid", () => {
    expect(resolveThemePreference(undefined, "dark")).toBe("dark");
    expect(resolveThemePreference(null, "light")).toBe("light");
    expect(resolveThemePreference("sepia", "light")).toBe("light");
  });

  it("defaults to system when neither source is valid", () => {
    expect(resolveThemePreference(undefined, undefined)).toBe("system");
    expect(resolveThemePreference("", "sepia")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("follows the media query only for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("keeps explicit choices regardless of the media query", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("stored preference", () => {
  it("reads a valid cached value and ignores garbage", () => {
    expect(readStoredThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe(
      "dark",
    );
    expect(readStoredThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBeNull();
    expect(readStoredThemePreference(fakeStorage())).toBeNull();
    expect(readStoredThemePreference(null)).toBeNull();
  });

  it("persists under the shared storage key", () => {
    const storage = fakeStorage();
    persistThemePreference("light", storage);
    expect(storage.values[THEME_STORAGE_KEY]).toBe("light");
  });
});
