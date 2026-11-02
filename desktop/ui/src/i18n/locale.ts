export const SUPPORTED_LOCALES = ["ru", "en", "uk", "be", "de", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * System language prefixes, most specific first. Anything unmatched falls back
 * to ru (ADR-0014).
 */
const SYSTEM_PREFIXES: ReadonlyArray<readonly [prefix: string, locale: Locale]> = [
  ["uk", "uk"],
  ["be", "be"],
  ["de", "de"],
  ["es", "es"],
  ["en", "en"],
];

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Configured locale wins when it is supported; `system`/unknown values follow
 * the system language (`uk*`→uk, `be*`→be, `de*`→de, `es*`→es, `en*`→en),
 * everything else to ru.
 */
export function resolveLocale(
  configured: string | null | undefined,
  systemLanguage: string | null | undefined,
): Locale {
  if (configured && isSupportedLocale(configured)) return configured;
  const system = (systemLanguage ?? "").toLowerCase();
  for (const [prefix, locale] of SYSTEM_PREFIXES) {
    if (system.startsWith(prefix)) return locale;
  }
  return "ru";
}

/** UI never renders error.message; it renders errors.<code>. */
export function errorMessageKey(code: string): string {
  return `errors.${code}`;
}
