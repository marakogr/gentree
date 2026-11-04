// Pure logic for the UI kit conformance check.
//
// The module is dependency-free and has no I/O, so it can be unit tested
// directly (see `ui-kit-rules.test.ts`). `ui-kit-check.mjs` owns the file
// system and the process exit code.

/** Rules the checker knows about. Order is the report order. */
export const RULES = [
  "boundaries",
  "raw-primitive",
  "raw-table",
  "kit-purity",
  "style",
  "dead-export",
  "duplicate-css",
];

/** Rules that reject raw controls in feature code. */
const RAW_CONTROLS = /<(button|select|textarea|input)\b/g;
const DIALOG_ROLE = /\brole\s*=\s*["']dialog["']/g;
const RAW_TABLE = /<table\b/g;

/** Relative imports that leave a layer. */
const IMPORT_FROM = /\bfrom\s+["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /\bimport\s+["']([^"']+)["']/g;

/** Raw colour literals in kit code. */
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

/**
 * Tailwind-style utility tokens as a whole class name. The kit styles with
 * `makeStyles` and tokens, so a utility class is a violation.
 */
const UTILITY_CLASS =
  /^(?:flex|grid|inline-flex|block|inline-block|hidden|items-(?:start|center|end|stretch)|justify-(?:start|center|end|between)|gap-\d+|p[xy]?-\d+|m[xy]?-\d+|w-\d+|h-\d+|text-(?:xs|sm|base|lg|xl)|bg-\w+|rounded(?:-\w+)?|border(?:-\d+)?)$/;

const CLASS_STRING = /className\s*=\s*["']([^"']+)["']/g;

/** `export function foo`, `export const foo`, `export type Foo`, ... */
const EXPORT_DECL =
  /\bexport\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;

/** Classify a repository-relative path into a UI layer. */
export function classifyPath(relPath) {
  const file = String(relPath).replaceAll("\\", "/");
  if (/\.(?:test|spec)\.(?:ts|tsx|mjs|js|jsx)$/.test(file)) return "test";
  if (file.startsWith("src/components/ui/")) return "primitives";
  if (file.startsWith("src/components/patterns/")) return "patterns";
  if (file.startsWith("src/components/filters/")) return "patterns";
  if (file.startsWith("src/components/")) return "shared";
  if (file.startsWith("src/features/")) return "features";
  if (file.startsWith("src/api/")) return "api";
  if (file.startsWith("src/lib/")) return "lib";
  if (file.startsWith("src/app/")) return "foundations";
  if (file.startsWith("src/i18n/")) return "locales";
  if (file.endsWith(".css")) return "styles";
  return "other";
}

/** Count non-overlapping matches of a global regular expression. */
export function countOccurrences(text, pattern) {
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let count = 0;
  let match = regex.exec(text);
  while (match !== null) {
    count += 1;
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
    match = regex.exec(text);
  }
  return count;
}

/** Import specifiers of a source file. */
export function importSpecifiers(text) {
  const found = new Set();
  for (const pattern of [IMPORT_FROM, SIDE_EFFECT_IMPORT]) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(text);
    while (match !== null) {
      found.add(match[1]);
      match = regex.exec(text);
    }
  }
  return [...found];
}

/**
 * Resolve a relative import to a repository-relative path. Bare package names
 * stay untouched, because they never point into the source tree.
 */
export function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const parts = fromFile.replaceAll("\\", "/").split("/");
  parts.pop();
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** Count raw native controls and hand-written dialogs in one file. */
export function rawPrimitiveCount(text) {
  return countOccurrences(text, RAW_CONTROLS) + countOccurrences(text, DIALOG_ROLE);
}

/** Count raw `<table>` elements in one file. */
export function rawTableCount(text) {
  return countOccurrences(text, RAW_TABLE);
}

/** Count raw colour literals in one file. */
export function rawColorCount(text) {
  return countOccurrences(text, RAW_COLOR);
}

/** Count Tailwind utility class strings in one file. */
export function utilityClassCount(text) {
  let count = 0;
  const regex = new RegExp(CLASS_STRING.source, CLASS_STRING.flags);
  let match = regex.exec(text);
  while (match !== null) {
    if (match[1].split(/\s+/).some((token) => UTILITY_CLASS.test(token))) {
      count += 1;
    }
    match = regex.exec(text);
  }
  return count;
}

/**
 * Boundary violations in a file, as a count.
 *
 * - Shared components (`src/components/**`) must not import features or the API.
 * - Primitives must not import patterns or other shared compositions.
 * - Pure helpers (`src/lib/**` without React) must not import components.
 */
export function boundaryViolations(relPath, text) {
  const layer = classifyPath(relPath);
  if (layer !== "shared" && layer !== "primitives" && layer !== "patterns" && layer !== "lib") {
    return 0;
  }
  const specifiers = importSpecifiers(text);
  const resolved = specifiers
    .map((specifier) => resolveImport(relPath, specifier))
    .filter((value) => value !== null);
  const importsReact =
    specifiers.includes("react") ||
    specifiers.includes("react-i18next") ||
    specifiers.some((specifier) => specifier.startsWith("react/"));

  let count = 0;
  for (const target of resolved) {
    if (layer === "lib") {
      if (importsReact) continue;
      if (target.includes("components/") || target.startsWith("src/components/")) {
        count += 1;
        continue;
      }
      if (target.endsWith(".tsx")) count += 1;
      continue;
    }
    if (target.startsWith("src/features/") || target.startsWith("src/api/")) {
      count += 1;
      continue;
    }
    if (layer === "primitives" && target.startsWith("src/components/patterns/")) {
      count += 1;
    }
  }
  return count;
}

/** Kit-purity violations: translations, API/feature imports in shared code. */
export function kitPurityViolations(relPath, text) {
  const layer = classifyPath(relPath);
  if (layer !== "shared" && layer !== "primitives" && layer !== "patterns") return 0;
  let count = 0;
  count += countOccurrences(text, /\buseTranslation\s*\(/g);
  count += countOccurrences(text, /\bfrom\s+["']react-i18next["']/g);
  count += countOccurrences(text, /\bfrom\s+["']i18next["']/g);
  const specifiers = importSpecifiers(text);
  for (const specifier of specifiers) {
    if (specifier.startsWith(".")) {
      const target = resolveImport(relPath, specifier);
      if (
        target &&
        (target.startsWith("src/features/") ||
          target.startsWith("src/api/") ||
          target.startsWith("src/i18n/"))
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Style violations: raw colours and Tailwind utilities in kit files. */
export function styleViolations(relPath, text) {
  const layer = classifyPath(relPath);
  if (layer !== "shared" && layer !== "primitives" && layer !== "patterns" && layer !== "styles") {
    return 0;
  }
  // Page and feature stylesheets are not part of the kit.
  if (layer === "styles" && !relPath.replaceAll("\\", "/").startsWith("src/components/")) {
    return 0;
  }
  return rawColorCount(text) + utilityClassCount(text);
}

/** Exported symbol names declared in a source file. */
export function exportedNames(text) {
  const names = new Set();
  for (const pattern of [EXPORT_DECL]) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(text);
    while (match !== null) {
      names.add(match[1]);
      match = regex.exec(text);
    }
  }
  const lists = /\bexport\s*\{([^}]+)\}/g;
  let match = lists.exec(text);
  while (match !== null) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
    match = lists.exec(text);
  }
  return [...names];
}

/** Normalised declaration body of a CSS rule, or `null` when too small. */
function normalizeCssBody(body) {
  const normalized = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
  if (normalized.length < 40) return null;
  if ((normalized.match(/[a-z-]+\s*:/g) ?? []).length < 3) return null;
  return normalized;
}

/**
 * Duplicate CSS rules across files: the same normalised selector and body
 * appearing more than once.
 *
 * `files` is `[{ file, text }]`. Returns `[{ file, count, block }]`, where
 * `count` is the number of duplicate occurrences in that file (the first
 * occurrence of a rule is the original and is not counted).
 */
export function duplicateCssBlocks(files) {
  const seen = new Map();
  const duplicates = new Map();
  for (const { file, text } of files) {
    const rule = /([^{}@]+)\{([^{}]*)\}/g;
    let match = rule.exec(text);
    while (match !== null) {
      const body = normalizeCssBody(match[2]);
      const selector = match[1]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (body !== null && selector !== "") {
        const key = `${selector}\u0000${body}`;
        const previous = seen.get(key);
        if (previous === undefined) {
          seen.set(key, file);
        } else {
          const entry = duplicates.get(file) ?? { file, count: 0, block: body };
          entry.count += 1;
          duplicates.set(file, entry);
        }
      }
      match = rule.exec(text);
    }
  }
  return [...duplicates.values()].sort((left, right) =>
    left.file.localeCompare(right.file),
  );
}

/** Validate and normalise a parsed allowlist. Returns `{ entries, problems }`. */
export function parseAllowlist(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entries: [], problems: ["allowlist root must be an object"] };
  }
  if (raw.version !== 1) problems.push("allowlist version must be 1");
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  if (!Array.isArray(raw.entries)) problems.push("allowlist entries must be an array");
  const entries = [];
  for (const [index, item] of list.entries()) {
    const where = `entries[${index}]`;
    if (!item || typeof item !== "object") {
      problems.push(`${where} must be an object`);
      continue;
    }
    if (!RULES.includes(item.rule)) {
      problems.push(`${where}.rule is unknown: ${item.rule}`);
      continue;
    }
    if (typeof item.file !== "string" || item.file === "") {
      problems.push(`${where}.file must be a non-empty string`);
      continue;
    }
    if (!Number.isInteger(item.count) || item.count < 0) {
      problems.push(`${where}.count must be a non-negative integer`);
      continue;
    }
    if (typeof item.reason !== "string" || item.reason.trim() === "") {
      problems.push(`${where}.reason must be a non-empty string`);
      continue;
    }
    entries.push({
      rule: item.rule,
      file: item.file.replaceAll("\\", "/"),
      count: item.count,
      reason: item.reason,
    });
  }
  return { entries, problems };
}

/**
 * Compare observed counts with the allowlist.
 *
 * `observed` is `[{ rule, file, count }]`; `entries` are parsed allowlist
 * entries. Returns `{ violations, stale, ok }`, where a violation is a count
 * above the recorded one or a file that is not recorded at all, and `stale`
 * is a recorded file that lost violations or disappeared.
 */
export function compareAllowlist(observed, entries) {
  const recorded = new Map(
    entries.map((entry) => [`${entry.rule}\u0000${entry.file}`, entry]),
  );
  const violations = [];
  const stale = [];
  const seen = new Set();

  for (const item of observed) {
    const key = `${item.rule}\u0000${item.file}`;
    seen.add(key);
    const entry = recorded.get(key);
    if (entry === undefined) {
      if (item.count > 0) {
        violations.push({ ...item, allowed: 0 });
      }
      continue;
    }
    if (item.count > entry.count) {
      violations.push({ ...item, allowed: entry.count });
    } else if (item.count < entry.count) {
      stale.push({ ...entry, observed: item.count });
    }
  }

  for (const [key, entry] of recorded) {
    if (seen.has(key)) continue;
    stale.push({ ...entry, observed: 0 });
  }

  return {
    violations,
    stale,
    ok: violations.length === 0,
  };
}

/** Fail only the rules named in the blocking set. */
export function blockingViolations(result, blocked) {
  if (blocked.has("*")) return result.violations;
  return result.violations.filter((item) => blocked.has(item.rule));
}

/** Stable `rule file count` lines for the report. */
export function formatObserved(observed) {
  return [...observed]
    .filter((item) => item.count > 0)
    .sort(
      (left, right) =>
        RULES.indexOf(left.rule) - RULES.indexOf(right.rule) ||
        left.file.localeCompare(right.file),
    )
    .map((item) => `${item.rule} ${item.file} ${item.count}`);
}
