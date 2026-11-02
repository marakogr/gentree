// Pure matching for the built-in guide. No DOM and no i18n, so the rules stay
// testable: every word of the query must appear in the text, and matching
// ignores case, accents and the yo/ye spelling.

export type HelpSearchEntry = { id: string; text: string };

/** Lowercase, accent-free, single-spaced form used for both sides. */
export function normalizeHelpText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u0451/g, "\u0435")
    .replace(/\s+/g, " ")
    .trim();
}

/** Query words without punctuation; an empty list means "no query". */
function queryWords(query: string): string[] {
  return normalizeHelpText(query)
    .split(" ")
    .map((word) => word.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((word) => word !== "");
}

/** True when every query word occurs in the text; an empty query matches nothing. */
export function matchesHelpQuery(text: string, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return false;
  const haystack = normalizeHelpText(text);
  return words.every((word) => haystack.includes(word));
}

/** Ids of the matching entries, in their declared order. */
export function filterHelpEntries(
  entries: readonly HelpSearchEntry[],
  query: string,
): string[] {
  return entries
    .filter((entry) => matchesHelpQuery(entry.text, query))
    .map((entry) => entry.id);
}
