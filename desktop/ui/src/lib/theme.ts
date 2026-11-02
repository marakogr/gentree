// Theme preference handling shared by the shell and the settings screen.
// Pure resolvers live here so they can be tested without a DOM; the `apply*`
// helpers only touch `document`/`localStorage` when called in the browser.

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gentree.theme";

/** Minimal storage surface: tests pass a plain object, the browser passes `localStorage`. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Precedence: an explicit config value wins over the local cache, then the
 * cache, then `system`. The cache exists so the first paint does not wait for
 * `settings_get`; the config stays the persistent source of truth.
 */
export function resolveThemePreference(
  configTheme: unknown,
  storedTheme: unknown,
): ThemePreference {
  if (isThemePreference(configTheme)) return configTheme;
  if (isThemePreference(storedTheme)) return storedTheme;
  return "system";
}

/** `system` follows the media query; explicit choices ignore it. */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark ? "dark" : "light";
}

function browserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredThemePreference(
  storage: ThemeStorage | null = browserStorage(),
): ThemePreference | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked storage must not break theme switching for the session.
  }
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(
  theme: ResolvedTheme,
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): void {
  if (root === null) return;
  root.dataset.theme = theme;
}

/** Resolves and applies one preference; returns the concrete theme. */
export function applyThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
  root?: HTMLElement | null,
): ResolvedTheme {
  const theme = resolveTheme(preference, prefersDark);
  applyTheme(theme, root);
  return theme;
}

/** Applies the cached preference before React renders to avoid a flash. */
export function applyInitialTheme(storage?: ThemeStorage | null): ResolvedTheme {
  const preference = readStoredThemePreference(storage) ?? "system";
  return applyThemePreference(preference, systemPrefersDark());
}
