// Localizes a structural `KinshipDescriptor` into one word or phrase.
// Explicit full-phrase tables live in `locales/<locale>/kinship.json`; the
// function only selects a cell, so no term is assembled from generic parts
// (ADR-0011 §UI formatting). The two deliberate exceptions are:
//  - "pra-" depth: the great-grandparent/grandchild depth comes from
//    `generationDelta`, so the prefix is repeated instead of tabulated;
//  - `UNKNOWN` descriptors: the fallback is a phrase built from the resolved
//    edge chain (`describeChain`), e.g. "husband of a cousin sister".

import type {
  Gender,
  KinshipDescriptor,
  KinshipEdge,
} from "../api/types";
import enKinship from "./locales/en/kinship.json";
import ruKinship from "./locales/ru/kinship.json";
import ukKinship from "./locales/uk/kinship.json";
import beKinship from "./locales/be/kinship.json";
import deKinship from "./locales/de/kinship.json";
import esKinship from "./locales/es/kinship.json";
import type { Locale } from "./locale";

/** Explicit phrases for one gender of the target person. */
type GenderTable = Record<Gender, string>;
type CousinRelation = "peer" | "elder" | "younger" | "far";

export type KinshipTable = {
  /** Kinds whose term depends only on `kind` (string) or on gender (table). */
  kind: Record<string, string | GenderTable>;
  /** In-law kinds → via-spouse gender → target gender. */
  inLaw: Record<string, Record<string, GenderTable>>;
  /** Cousin degree (`1`-`3`, `other`) → relation → target gender. */
  cousin: Record<string, Record<CousinRelation, GenderTable>>;
  /** `PATERNAL`/`MATERNAL` postmodifier for uncle/aunt terms. */
  line: Record<string, string>;
  /** Base terms the generational prefix is attached to. */
  base: Record<string, GenderTable>;
  /** One-hop nouns used by `describeChain`. */
  chain: Record<string, GenderTable>;
  /** `genitive` (ru) heads the phrase with the last noun; `possessive` (en) chains `'s`. */
  chainStyle: string;
  generationalPrefix: string;
  /** Word-level genitive forms for the descriptive chain (empty when unused). */
  chainGenitive: {
    adjectives: Record<string, string>;
    nouns: Record<string, string>;
  };
  unknown: string;
  unknownWithPath: string;
};

const TABLES: Record<Locale, KinshipTable> = {
  ru: ruKinship,
  en: enKinship,
  uk: ukKinship,
  be: beKinship,
  de: deKinship,
  es: esKinship,
};

const PATH_SEPARATOR = " → ";

function tableFor(locale: Locale): KinshipTable {
  return TABLES[locale] ?? TABLES.ru;
}

function genderCell(table: GenderTable | undefined, gender: Gender): string {
  if (!table) return "";
  return table[gender] ?? table.UNKNOWN;
}

/** Term for a `kind` entry, string-valued kinds ignore the gender. */
function kindTerm(
  table: KinshipTable,
  kind: string,
  gender: Gender,
): string {
  const entry = table.kind[kind];
  if (typeof entry === "string") return entry;
  const term = genderCell(entry, gender);
  return term === "" ? table.unknown : term;
}

function inLawTerm(
  table: KinshipTable,
  kind: string,
  via: Gender | null | undefined,
  gender: Gender,
): string {
  const rows = table.inLaw[kind];
  const term = genderCell(rows?.[via ?? "UNKNOWN"], gender);
  return term === "" ? table.unknown : term;
}

/** `degree`/`removed`/`generationDelta` select one cousin cell. */
function cousinTerm(
  table: KinshipTable,
  degree: number,
  removed: number,
  generationDelta: number,
  gender: Gender,
): string {
  const degreeKey =
    degree <= 1 ? "1" : degree <= 3 ? String(degree) : "other";
  const relation: CousinRelation =
    removed === 0
      ? "peer"
      : removed > 1
        ? "far"
        : generationDelta < 0
          ? "elder"
          : "younger";
  const cells = table.cousin[degreeKey] ?? table.cousin.other;
  const term = genderCell(cells?.[relation], gender);
  return term === "" ? table.unknown : term;
}

/** Repeats the "pra-"/"great-" prefix for depth >= 3. */
function prefixedTerm(
  table: KinshipTable,
  baseKey: string,
  count: number,
  gender: Gender,
): string {
  const base = genderCell(table.base[baseKey], gender);
  if (base === "") return table.unknown;
  return table.generationalPrefix.repeat(Math.max(1, count)) + base;
}

function lineSuffix(table: KinshipTable, line: string | null): string {
  if (line === null) return "";
  return table.line[line] ?? "";
}

function parentLine(gender: Gender): string | null {
  if (gender === "MALE") return "PATERNAL";
  if (gender === "FEMALE") return "MATERNAL";
  return null;
}

function chainCell(
  table: KinshipTable,
  key: string,
  gender: Gender,
): string {
  const term = genderCell(table.chain[key], gender);
  return term === "" ? table.unknown : term;
}

/** Genitive of one word: dictionary first, then the generational prefix. */
function genitiveWord(table: KinshipTable, word: string): string {
  const direct =
    table.chainGenitive.adjectives[word] ??
    table.chainGenitive.nouns[word];
  if (direct) return direct;
  const prefix = table.generationalPrefix;
  if (prefix !== "" && word.startsWith(prefix) && word.length > prefix.length) {
    const rest = word.slice(prefix.length);
    const inner = genitiveWord(table, rest);
    if (inner !== rest) return prefix + inner;
  }
  return word;
}

function genitivePhrase(table: KinshipTable, phrase: string): string {
  return phrase
    .split(" ")
    .map((word) => genitiveWord(table, word))
    .join(" ");
}

/**
 * Russian heads the phrase with the final noun and puts every earlier link in
 * the genitive; English chains possessives ("wife's father").
 */
function joinChain(table: KinshipTable, parts: readonly string[]): string {
  if (parts.length === 0) return table.unknown;
  if (table.chainStyle === "possessive") {
    return parts.join("'s ");
  }
  const reversed = [...parts].reverse();
  const head = reversed[0];
  const modifiers = reversed.slice(1).map((part) => genitivePhrase(table, part));
  return [head, ...modifiers].join(" ");
}

function descendantChain(
  table: KinshipTable,
  levels: number,
  gender: Gender,
): string {
  if (levels <= 1) return chainCell(table, "child", gender);
  if (levels === 2) return chainCell(table, "grandchild", gender);
  return prefixedTerm(table, "greatGrandchild", levels - 2, gender);
}

function ancestorChain(
  table: KinshipTable,
  levels: number,
  gender: Gender,
): string {
  if (levels <= 1) return chainCell(table, "parent", gender);
  if (levels === 2) return chainCell(table, "grandparent", gender);
  return prefixedTerm(table, "greatGrandparent", levels - 2, gender);
}

/**
 * One monotone blood run (ups then downs, no spouse) as chain nouns.
 * A one-step-up run stays literal relative to the sibling anchor, so
 * `[U,D,D]` reads "brother's daughter" rather than repeating the niece table.
 */
function bloodRunParts(
  table: KinshipTable,
  run: readonly KinshipEdge[],
): string[] {
  let ups = 0;
  while (ups < run.length && run[ups].kind === "PARENT") ups += 1;
  const downs = run.length - ups;
  const target = run[run.length - 1].toGender;

  if (ups === 0) return [descendantChain(table, downs, target)];
  if (downs === 0) return [ancestorChain(table, ups, target)];

  if (ups === 1) {
    const sibling = run[1] ?? run[run.length - 1];
    const parts = [chainCell(table, "sibling", sibling.toGender)];
    if (downs > 1) parts.push(descendantChain(table, downs - 1, target));
    return parts;
  }

  if (downs === 1) {
    if (ups === 2) {
      const term = kindTerm(
        table,
        target === "FEMALE" ? "AUNT" : "UNCLE",
        target,
      );
      const suffix = lineSuffix(table, parentLine(run[0].toGender));
      return [suffix === "" ? term : `${term} ${suffix}`];
    }
    return [
      kindTerm(
        table,
        target === "FEMALE" ? "GREAT_AUNT" : "GREAT_UNCLE",
        target,
      ),
    ];
  }

  return [
    cousinTerm(
      table,
      Math.min(ups, downs) - 1,
      Math.abs(ups - downs),
      downs - ups,
      target,
    ),
  ];
}

function spouseChainTerm(table: KinshipTable, edge: KinshipEdge): string {
  if (edge.kind === "PARTNER") {
    return chainCell(table, "partner", edge.toGender);
  }
  return chainCell(table, "spouse", edge.toGender);
}

function chainParts(
  table: KinshipTable,
  edges: readonly KinshipEdge[],
): string[] {
  const parts: string[] = [];
  let run: KinshipEdge[] = [];
  const flush = () => {
    if (run.length === 0) return;
    parts.push(...bloodRunParts(table, run));
    run = [];
  };

  for (const edge of edges) {
    if (edge.kind === "SPOUSE" || edge.kind === "PARTNER") {
      flush();
      parts.push(spouseChainTerm(table, edge));
      continue;
    }
    // A parent step after a child step starts a new branch; the run must stay
    // monotone (ups then downs) for a single shape term.
    const last = run[run.length - 1];
    if (last && last.kind === "CHILD" && edge.kind === "PARENT") flush();
    run.push(edge);
  }
  flush();
  return parts;
}

/**
 * Human-readable phrase for an otherwise nameless chain, built from the
 * resolved edges in `locale`: "husband of a cousin sister", "wife's father",
 * "brother's daughter". Never returns an empty string.
 */
export function describeChain(
  edges: readonly KinshipEdge[],
  locale: Locale,
): string {
  const table = tableFor(locale);
  return joinChain(table, chainParts(table, edges));
}

/**
 * Renders the descriptor in `locale`. `nameOf` replaces person ids in the
 * id-only `UNKNOWN` fallback (no `edges`); with a chain the descriptive phrase
 * is used instead (ADR-0011).
 */
export function formatKinship(
  descriptor: KinshipDescriptor,
  locale: Locale,
  nameOf?: (personId: string) => string | undefined,
): string {
  const table = tableFor(locale);
  const gender = descriptor.gender ?? "UNKNOWN";
  const edges = descriptor.edges ?? [];

  switch (descriptor.kind) {
    case "UNKNOWN": {
      if (edges.length > 0) return describeChain(edges, locale);
      const path = descriptor.path.map((id) => nameOf?.(id) ?? id);
      if (path.length === 0) return table.unknown;
      return table.unknownWithPath.replace("{{path}}", path.join(PATH_SEPARATOR));
    }
    case "COUSIN":
      return cousinTerm(
        table,
        descriptor.degree,
        descriptor.removed,
        descriptor.generationDelta,
        gender,
      );
    case "GREAT_GRANDPARENT":
      return prefixedTerm(
        table,
        "greatGrandparent",
        descriptor.generationDelta - 2,
        gender,
      );
    case "GREAT_GRANDCHILD":
      return prefixedTerm(
        table,
        "greatGrandchild",
        Math.abs(descriptor.generationDelta) - 2,
        gender,
      );
    case "UNCLE":
    case "AUNT": {
      const term = kindTerm(
        table,
        gender === "FEMALE" ? "AUNT" : "UNCLE",
        gender,
      );
      const suffix = lineSuffix(table, descriptor.line);
      return suffix === "" ? term : `${term} ${suffix}`;
    }
    // Legacy kinds kept for compatibility with older descriptors.
    case "PARENT_OF_SPOUSE":
    case "PARENT_IN_LAW":
      return inLawTerm(table, "PARENT_IN_LAW", descriptor.viaSpouseGender, gender);
    case "SPOUSE_OF_CHILD":
    case "CHILD_IN_LAW":
      return inLawTerm(table, "CHILD_IN_LAW", descriptor.viaSpouseGender, gender);
    case "CHILD_OF_SPOUSE":
    case "STEP_CHILD":
      return kindTerm(table, "STEP_CHILD", gender);
    case "SIBLING_IN_LAW":
    case "SIBLING_OF_SPOUSE":
    case "SPOUSE_OF_SIBLING":
      return inLawTerm(table, descriptor.kind, descriptor.viaSpouseGender, gender);
    default:
      return kindTerm(table, descriptor.kind, gender);
  }
}
