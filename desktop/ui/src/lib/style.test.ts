import { describe, expect, it } from "vitest";
import {
  applyInitialStyle,
  applyStyle,
  isStylePreference,
  persistStylePreference,
  readStoredStylePreference,
  resolveStylePreference,
  STYLE_STORAGE_KEY,
  type StyleStorage,
} from "./style";

function fakeStorage(initial: Record<string, string> = {}): StyleStorage & {
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

function fakeRoot(): HTMLElement {
  return { dataset: {} } as unknown as HTMLElement;
}

describe("isStylePreference", () => {
  it("accepts the two known values only", () => {
    expect(isStylePreference("classic")).toBe(true);
    expect(isStylePreference("swiss")).toBe(true);
    expect(isStylePreference("CLASSIC")).toBe(false);
    expect(isStylePreference("default")).toBe(false);
    expect(isStylePreference(null)).toBe(false);
    expect(isStylePreference(undefined)).toBe(false);
  });
});

describe("resolveStylePreference", () => {
  it("lets the config win over the local cache", () => {
    expect(resolveStylePreference("swiss", "classic")).toBe("swiss");
    expect(resolveStylePreference("classic", "swiss")).toBe("classic");
  });

  it("falls back to the cache, then to classic", () => {
    expect(resolveStylePreference(undefined, "swiss")).toBe("swiss");
    expect(resolveStylePreference("brutal", "swiss")).toBe("swiss");
    expect(resolveStylePreference(null, null)).toBe("classic");
    expect(resolveStylePreference("", "unknown")).toBe("classic");
  });
});

describe("stored preference", () => {
  it("reads only known values", () => {
    expect(
      readStoredStylePreference(fakeStorage({ [STYLE_STORAGE_KEY]: "swiss" })),
    ).toBe("swiss");
    expect(
      readStoredStylePreference(fakeStorage({ [STYLE_STORAGE_KEY]: "neon" })),
    ).toBeNull();
    expect(readStoredStylePreference(fakeStorage())).toBeNull();
  });

  it("persists the choice and survives a blocked storage", () => {
    const storage = fakeStorage();
    persistStylePreference("swiss", storage);
    expect(storage.values[STYLE_STORAGE_KEY]).toBe("swiss");

    const blocked: StyleStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => persistStylePreference("swiss", blocked)).not.toThrow();
    expect(readStoredStylePreference(blocked)).toBeNull();
  });
});

describe("applyStyle", () => {
  it("writes both values and never leaves the attribute empty", () => {
    const root = fakeRoot();
    applyStyle("swiss", root);
    expect(root.dataset.style).toBe("swiss");
    applyStyle("classic", root);
    expect(root.dataset.style).toBe("classic");
  });

  it("tolerates a missing document", () => {
    expect(() => applyStyle("swiss", null)).not.toThrow();
  });

  it("starts from the cache and defaults to classic", () => {
    const root = fakeRoot();
    const storage = fakeStorage({ [STYLE_STORAGE_KEY]: "swiss" });
    // applyInitialStyle writes to the real document; the return value is the
    // contract that matters for the first paint.
    expect(applyInitialStyle(storage)).toBe("swiss");
    expect(applyInitialStyle(fakeStorage())).toBe("classic");

    applyStyle(applyInitialStyle(storage), root);
    expect(root.dataset.style).toBe("swiss");
  });
});
