// Style preference handling shared by the shell and the settings screen.
//
// The style is a second, independent axis next to the light/dark theme:
// `data-style` on <html> selects the visual language, `data-theme` selects the
// scheme. `classic` is the shipping look and the default; `swiss` is the
// opt-in design-system/gentree language. Pure resolvers live here so they can
// be tested without a DOM; the `apply*` helpers only touch `document` /
// `localStorage` when called in the browser.

export type StylePreference = "classic" | "swiss";

export const STYLE_STORAGE_KEY = "gentree.style";

/** Minimal storage surface: tests pass a plain object, the browser passes `localStorage`. */
export type StyleStorage = Pick<Storage, "getItem" | "setItem">;

export function isStylePreference(value: unknown): value is StylePreference {
  return value === "classic" || value === "swiss";
}

/**
 * Precedence: an explicit config value wins over the local cache, then the
 * cache, then `classic`. The cache exists so the first paint does not wait for
 * `settings_get`; the config stays the persistent source of truth.
 */
export function resolveStylePreference(
  configStyle: unknown,
  storedStyle: unknown,
): StylePreference {
  if (isStylePreference(configStyle)) return configStyle;
  if (isStylePreference(storedStyle)) return storedStyle;
  return "classic";
}

function browserStorage(): StyleStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredStylePreference(
  storage: StyleStorage | null = browserStorage(),
): StylePreference | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(STYLE_STORAGE_KEY);
    return isStylePreference(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistStylePreference(
  preference: StylePreference,
  storage: StyleStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(STYLE_STORAGE_KEY, preference);
  } catch {
    // A blocked storage must not break style switching for the session.
  }
}

/**
 * Writes the resolved style as an attribute. `classic` also sets the attribute
 * so the DOM states the choice explicitly; the stylesheet only reacts to
 * `swiss`, and a missing attribute therefore behaves like `classic`.
 */
export function applyStyle(
  style: StylePreference,
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): void {
  if (root === null) return;
  root.dataset.style = style;
}

/** Applies the cached preference before React renders to avoid a flash. */
export function applyInitialStyle(storage?: StyleStorage | null): StylePreference {
  const preference =
    readStoredStylePreference(storage) ?? resolveStylePreference(null, null);
  applyStyle(preference);
  return preference;
}
