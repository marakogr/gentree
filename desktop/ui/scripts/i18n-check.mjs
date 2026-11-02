#!/usr/bin/env node
// i18n gate: key parity, no empty values, no Cyrillic outside dictionaries.
// Contract: locale parity and no hardcoded Cyrillic outside locale files.
//
// Every supported locale is compared against a single reference dictionary in
// both directions, and no locale may carry an empty translation.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const localesDir = path.join(root, "src", "i18n", "locales");
const RELATIVE_LOCALES_DIR = path.join("src", "i18n", "locales");

/** Reference dictionary every other locale is checked against. */
const REFERENCE = "en";
const LOCALES = ["ru", "en", "uk", "be", "de", "es"];
const problems = [];

function flatten(value, prefix = "", out = new Map()) {
  for (const [key, item] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      flatten(item, full, out);
    } else {
      out.set(full, item);
    }
  }
  return out;
}

function namespaceFiles(locale) {
  const dir = path.join(localesDir, locale);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** `null` means the directory is missing; the reason is already reported. */
function readNamespaces(locale) {
  const files = namespaceFiles(locale);
  if (files === null) {
    problems.push(`missing locale directory: ${path.join(RELATIVE_LOCALES_DIR, locale)}`);
    return null;
  }
  const keys = new Map();
  for (const file of files) {
    const relative = path.join(RELATIVE_LOCALES_DIR, locale, file);
    const namespace = path.basename(file, ".json");
    let content;
    try {
      content = JSON.parse(fs.readFileSync(path.join(localesDir, locale, file), "utf8"));
    } catch (error) {
      problems.push(`invalid JSON: ${relative} (${error.message})`);
      continue;
    }
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      problems.push(`namespace root must be an object: ${relative}`);
      continue;
    }
    for (const [key, value] of flatten(content)) {
      keys.set(`${namespace}:${key}`, value);
    }
  }
  return { files, keys };
}

const dictionaries = new Map();
for (const locale of LOCALES) {
  dictionaries.set(locale, readNamespaces(locale));
}

const reference = dictionaries.get(REFERENCE);
if (reference === null) {
  console.error(`i18n:check failed (reference locale "${REFERENCE}" is missing)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

for (const locale of LOCALES) {
  const dictionary = dictionaries.get(locale);
  if (dictionary === null) continue;

  for (const file of dictionary.files) {
    if (!reference.files.includes(file)) {
      problems.push(
        `${locale} has namespace file unknown to ${REFERENCE}: ${file}`,
      );
    }
  }
  if (locale === REFERENCE) continue;

  for (const file of reference.files) {
    if (!dictionary.files.includes(file)) {
      problems.push(`${locale} is missing namespace file: ${file}`);
    }
  }
  for (const key of reference.keys.keys()) {
    if (!dictionary.keys.has(key)) {
      problems.push(`${locale} is missing key: ${key}`);
    }
  }
  for (const key of dictionary.keys.keys()) {
    if (!reference.keys.has(key)) {
      problems.push(`${locale} has an extra key not in ${REFERENCE}: ${key}`);
    }
  }
}

for (const locale of LOCALES) {
  const dictionary = dictionaries.get(locale);
  if (dictionary === null) continue;
  for (const [key, value] of dictionary.keys) {
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`empty translation: ${locale}:${key}`);
    }
  }
}

const cyrillic = /[\u0400-\u04FF]/;
const allowed = [path.join("src", "i18n", "locales")];

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (allowed.some((prefix) => full.startsWith(path.join(root, prefix)))) continue;
      scan(full);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (cyrillic.test(text)) {
      problems.push(`Cyrillic outside dictionaries: ${path.relative(root, full)}`);
    }
  }
}

scan(path.join(root, "src"));

if (problems.length > 0) {
  console.error(`i18n:check failed (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const sizes = LOCALES.map((locale) => `${locale}=${dictionaries.get(locale).keys.size}`);
console.log(`i18n:check ok: ${sizes.join(", ")} keys (reference: ${REFERENCE})`);
