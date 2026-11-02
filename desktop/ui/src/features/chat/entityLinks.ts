// Pure person-mention detection for chat answers.
//
// The assistant writes plain Markdown, so mentions are found in text, not in
// HTML. Only full-name forms are linked: "Surname Given Patronymic",
// "Given Surname", "Surname Given" and "Given Patronymic Surname". Matching is
// case-insensitive, word-bounded and Cyrillic-aware. Short tokens (< 3 letters)
// and single-word names are skipped on purpose: a bare two-letter given name
// would link the wrong person far more often than the right one. When two
// persons share an exact full name the mention stays plain, because a wrong
// card is worse than no card.
//
// No DOM, no IPC: covered by entityLinks.test.ts.

import type { PersonName } from "../../api/types";

export type EntityPerson = {
  id: string;
  names: readonly PersonName[];
};

export type EntitySegment = {
  text: string;
  /** Present when the segment is a mention of this person. */
  personId?: string;
};

export type EntityIndex = {
  linkify: (text: string) => EntitySegment[];
};

/** Letters, marks, digits and underscores; inner apostrophes/hyphens stay. */
const WORD_SOURCE = "[\\p{L}\\p{M}\\p{N}_]+(?:['\\u2019-][\\p{L}\\p{M}\\p{N}_]+)*";
const MIN_TOKEN_LENGTH = 3;
const MIN_NAME_TOKENS = 2;

type Token = {
  start: number;
  end: number;
  /** Lowercased, with the two Cyrillic yo/e letters folded for lookups. */
  key: string;
};

function tokenize(text: string): Token[] {
  const pattern = new RegExp(WORD_SOURCE, "gu");
  const tokens: Token[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    tokens.push({
      start,
      end: start + match[0].length,
      key: normalizeToken(match[0]),
    });
  }
  return tokens;
}

function normalizeToken(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\u0451/g, "\u0435");
}

function tokenKeys(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  return tokenize(value).map((token) => token.key);
}

/** Full-name variants of the primary name, in normalized token form. */
function variantKeys(names: readonly PersonName[]): string[] {
  const primary = names.find((name) => name.isPrimary) ?? names[0];
  if (primary === undefined) return [];

  const surname = tokenKeys(primary.surname);
  const given = tokenKeys(primary.given);
  const patronymic = tokenKeys(primary.patronymic);

  const candidates: string[][] = [
    [...surname, ...given, ...patronymic],
    [...given, ...patronymic, ...surname],
    [...given, ...surname],
    [...surname, ...given],
  ];

  const seen = new Set<string>();
  const variants: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < MIN_NAME_TOKENS) continue;
    // A variant with a two-letter token would match far too much.
    if (candidate.some((token) => Array.from(token).length < MIN_TOKEN_LENGTH)) {
      continue;
    }
    const key = candidate.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(key);
  }
  return variants;
}

type Dictionary = {
  /** `null` marks a name shared by several persons: no safe target. */
  entries: Map<string, string | null>;
  maxTokens: number;
};

function buildDictionary(persons: readonly EntityPerson[]): Dictionary {
  const entries = new Map<string, string | null>();
  let maxTokens = 0;
  for (const person of persons) {
    if (person.id === "") continue;
    for (const variant of variantKeys(person.names)) {
      maxTokens = Math.max(maxTokens, variant.split(" ").length);
      const existing = entries.get(variant);
      if (existing === undefined) entries.set(variant, person.id);
      else if (existing !== person.id) entries.set(variant, null);
    }
  }
  return { entries, maxTokens };
}

function longestMatch(
  text: string,
  tokens: Token[],
  start: number,
  dictionary: Dictionary,
): { personId: string; lastToken: number } | null {
  const limit = Math.min(dictionary.maxTokens, tokens.length - start);
  for (let count = limit; count >= MIN_NAME_TOKENS; count -= 1) {
    let key = tokens[start].key;
    let contiguous = true;
    for (let offset = 1; offset < count; offset += 1) {
      const gap = text.slice(
        tokens[start + offset - 1].end,
        tokens[start + offset].start,
      );
      if (!/^\s+$/.test(gap)) {
        contiguous = false;
        break;
      }
      key += ` ${tokens[start + offset].key}`;
    }
    if (!contiguous) continue;
    const personId = dictionary.entries.get(key);
    if (personId === undefined || personId === null) continue;
    return { personId, lastToken: start + count - 1 };
  }
  return null;
}

/**
 * Builds the name dictionary once per person list; `linkify` can then run for
 * every inline Markdown fragment without rebuilding it.
 */
export function createEntityIndex(persons: readonly EntityPerson[]): EntityIndex {
  const dictionary = buildDictionary(persons);

  const linkify = (text: string): EntitySegment[] => {
    if (text === "") return [];
    if (dictionary.entries.size === 0) return [{ text }];

    const tokens = tokenize(text);
    if (tokens.length < MIN_NAME_TOKENS) return [{ text }];

    const segments: EntitySegment[] = [];
    let cursor = 0;

    const pushPlain = (from: number, to: number) => {
      if (to <= from) return;
      const slice = text.slice(from, to);
      const last = segments[segments.length - 1];
      if (last !== undefined && last.personId === undefined) {
        last.text += slice;
      } else {
        segments.push({ text: slice });
      }
    };

    for (let index = 0; index < tokens.length; index += 1) {
      const match = longestMatch(text, tokens, index, dictionary);
      if (match === null) continue;
      pushPlain(cursor, tokens[index].start);
      segments.push({
        text: text.slice(tokens[index].start, tokens[match.lastToken].end),
        personId: match.personId,
      });
      cursor = tokens[match.lastToken].end;
      index = match.lastToken;
    }

    pushPlain(cursor, text.length);
    return segments.length > 0 ? segments : [{ text }];
  };

  return { linkify };
}

/** Convenience for one-off calls; prefer `createEntityIndex` in render paths. */
export function linkifyEntities(
  text: string,
  persons: readonly EntityPerson[],
): EntitySegment[] {
  return createEntityIndex(persons).linkify(text);
}
