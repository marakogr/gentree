// Pure helpers for the opt-in place autocomplete (ADR-0016). No DOM, no IPC:
// the component keeps the interaction and the spinner, these functions decide
// what is worth sending and what a confirmed suggestion becomes.

/** Shortest query the backend accepts; shorter input never opens a socket. */
export const PLACE_QUERY_MIN_CHARS = 3;

/**
 * Trimmed query that is worth a network call, or `null` below the threshold.
 * Mirrors `normalize_query` in the backend so the UI does not ask for a
 * request that can only return an empty list.
 */
export function placeQuery(raw: string): string | null {
  const trimmed = raw.trim();
  return Array.from(trimmed).length >= PLACE_QUERY_MIN_CHARS ? trimmed : null;
}

/**
 * Composed Unicode form of a suggestion label. Providers may return decomposed
 * accents; the stored free text should look exactly like the displayed label.
 */
export function normalizePlaceText(text: string): string {
  return text.normalize("NFC");
}

/** Confirmed text for one suggestion: the label, never a provider id. */
export function placeSuggestionText(label: string): string {
  return normalizePlaceText(label);
}
