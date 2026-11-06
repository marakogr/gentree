// Validates every DateValue in the demo projects against the rules enforced by
// `DateValue::validate` in desktop/crates/core/src/date.rs (ADR-0010).
//
//   node scripts/check-demo-dates.mjs
//   node scripts/check-demo-dates.mjs demo/romanov demo/romanov-en
//
// Prints aggregates only (counts and error codes), never names or dates, so the
// output is safe for logs and issues. Exits non-zero when any date is invalid.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGETS = (process.argv.length > 2 ? process.argv.slice(2) : ["demo/romanov", "demo/romanov-en"]).map(
  (target) => path.resolve(ROOT, target),
);

const PRECISIONS = new Set(["DAY", "MONTH", "YEAR", "UNKNOWN"]);
const QUALIFIERS = new Set(["EXACT", "APPROXIMATE", "BEFORE", "AFTER", "RANGE", "UNKNOWN"]);
const BOTH_SIDED = new Set(["EXACT", "APPROXIMATE", "RANGE"]);

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(year, month) {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeap(year) ? 29 : 28;
    default:
      return 0;
  }
}

function parseIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

const compare = (left, right) =>
  left.year - right.year || left.month - right.month || left.day - right.day;

/** Same codes `DateValue::validate` returns, without the surrounding error type. */
function validateDate(value) {
  const codes = new Set();
  const { start, end, precision, qualifier } = value;

  if (!PRECISIONS.has(precision)) codes.add("unknownPrecision");
  if (!QUALIFIERS.has(qualifier)) codes.add("unknownQualifier");

  if (precision === "UNKNOWN") {
    if (start != null || end != null) codes.add("unknownHasBounds");
    return [...codes];
  }

  if (start == null && end == null) codes.add("missingBounds");
  if (qualifier === "BEFORE" && (start != null || end == null)) codes.add("beforeBounds");
  if (qualifier === "AFTER" && (end != null || start == null)) codes.add("afterBounds");
  if (BOTH_SIDED.has(qualifier) && (start == null || end == null)) codes.add("missingBounds");

  const startDate = start == null ? null : parseIso(start);
  const endDate = end == null ? null : parseIso(end);
  if (start != null && startDate === null) codes.add("invalidStart");
  if (end != null && endDate === null) codes.add("invalidEnd");
  if (startDate && endDate && compare(startDate, endDate) >= 0) codes.add("startNotBeforeEnd");

  // RANGE carries explicit user bounds; every other qualifier must align with
  // the declared precision (ADR-0010 rule 7).
  if (qualifier !== "RANGE") {
    for (const date of [startDate, endDate]) {
      if (!date) continue;
      if (precision === "YEAR" && (date.month !== 1 || date.day !== 1)) {
        codes.add("precisionBounds");
      }
      if (precision === "MONTH" && date.day !== 1) codes.add("precisionBounds");
    }
  }

  return [...codes];
}

function findProjectDir(target) {
  if (fs.existsSync(path.join(target, "manifest.json"))) return target;
  const nested = fs
    .readdirSync(target, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(target, entry.name, "manifest.json")),
    );
  if (nested.length !== 1) {
    throw new Error(`cannot find a single project inside ${target}`);
  }
  return path.join(target, nested[0].name);
}

/** Calls `visit` for every object shaped like a DateValue. */
function walkDateValues(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walkDateValues(item, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (
    Object.hasOwn(node, "start") &&
    Object.hasOwn(node, "end") &&
    Object.hasOwn(node, "precision") &&
    Object.hasOwn(node, "qualifier")
  ) {
    visit(node);
  }
  for (const item of Object.values(node)) walkDateValues(item, visit);
}

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const format = (map) =>
  [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");

const failures = [];

for (const target of TARGETS) {
  const dir = findProjectDir(target);
  const counts = { dates: 0 };

  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl"))) {
    const lines = fs
      .readFileSync(path.join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    for (const line of lines) {
      walkDateValues(JSON.parse(line), (value) => {
        counts.dates += 1;
        tally(counts.byPrecision ??= new Map(), String(value.precision));
        tally(counts.byQualifier ??= new Map(), String(value.qualifier));
        for (const code of validateDate(value)) {
          failures.push(code);
        }
      });
    }
  }

  console.log(
    `${path.relative(ROOT, target)}: ${counts.dates} dates ` +
      `(${format(counts.byPrecision ?? new Map())}); ` +
      `qualifiers (${format(counts.byQualifier ?? new Map())})`,
  );
}

const codes = new Map();
for (const code of failures) tally(codes, code);

if (failures.length === 0) {
  console.log("demo dates: 0 violations");
  process.exit(0);
}

console.log(`demo dates: ${failures.length} violations`);
for (const [code, count] of [...codes.entries()].sort()) {
  console.log(`  ${code}: ${count}`);
}
process.exit(1);
