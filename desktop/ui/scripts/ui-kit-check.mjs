#!/usr/bin/env node
// UI kit conformance gate.
//
// Zero dependencies: it reads the source tree, applies the rules from
// `ui-kit-rules.mjs`, compares the observed counts with
// `ui-kit.allowlist.json` and prints `rule file count` lines.
//
//   node scripts/ui-kit-check.mjs                      report mode
//   node scripts/ui-kit-check.mjs --block=boundaries   fail on that rule
//   node scripts/ui-kit-check.mjs --all-blocking       fail on every rule
//   node scripts/ui-kit-check.mjs --json               machine-readable report
//
// Report mode always exits zero unless the allowlist itself is invalid or a
// rule throws. Blocking rules exit non-zero on an unlisted file, a raised
// count, or a stale allowlist entry.
import fs from "node:fs";
import path from "node:path";
import {
  RULES,
  blockingViolations,
  boundaryViolations,
  compareAllowlist,
  duplicateCssBlocks,
  exportedNames,
  formatObserved,
  kitPurityViolations,
  parseAllowlist,
  rawPrimitiveCount,
  rawTableCount,
  styleViolations,
} from "./ui-kit-rules.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SRC = path.join(root, "src");
const ALLOWLIST = path.join(root, "ui-kit.allowlist.json");

const args = process.argv.slice(2);
const blocked = new Set();
let json = false;
for (const arg of args) {
  if (arg === "--json") json = true;
  else if (arg === "--all-blocking") blocked.add("*");
  else if (arg.startsWith("--block=")) {
    for (const rule of arg.slice("--block=".length).split(",")) {
      if (rule !== "") blocked.add(rule.trim());
    }
  } else {
    console.error(`ui-kit: unknown argument: ${arg}`);
    process.exit(2);
  }
}
for (const rule of blocked) {
  if (rule !== "*" && !RULES.includes(rule)) {
    console.error(`ui-kit: unknown rule: ${rule}`);
    process.exit(2);
  }
}

const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs)$/;
const STYLE_FILE = /\.css$/;

/** Every source/style file under `src`, repository-relative to the UI root. */
function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "locales") continue;
      listFiles(full, out);
      continue;
    }
    if (SOURCE_FILE.test(entry.name) || STYLE_FILE.test(entry.name)) {
      out.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  }
  return out.sort();
}

const files = listFiles(SRC);
const sourceFiles = files.filter((file) => SOURCE_FILE.test(file));
const styleFiles = files.filter((file) => STYLE_FILE.test(file));
const isTest = (file) => /\.(?:test|spec)\./.test(file);
const isKit = (file) =>
  file.startsWith("src/components/ui/") ||
  file.startsWith("src/components/patterns/") ||
  file.startsWith("src/components/");
const isFeature = (file) =>
  file.startsWith("src/features/") || file === "src/App.tsx";

const texts = new Map();
function read(relPath) {
  if (!texts.has(relPath)) {
    texts.set(relPath, fs.readFileSync(path.join(root, relPath), "utf8"));
  }
  return texts.get(relPath);
}

/** `rule file count` entries; zero counts are dropped from the report. */
function observed(rule, file, count) {
  return { rule, file, count };
}

const observations = [];

// 1. Boundaries: shared code must not import features/API, primitives must not
//    import patterns, pure helpers must not import components.
for (const file of sourceFiles) {
  if (isTest(file)) continue;
  const count = boundaryViolations(file, read(file));
  if (count > 0) observations.push(observed("boundaries", file, count));
}

// 2. Raw primitives: only feature code is checked; the kit owns the controls.
for (const file of sourceFiles) {
  if (isTest(file) || !isFeature(file)) continue;
  const count = rawPrimitiveCount(read(file));
  if (count > 0) observations.push(observed("raw-primitive", file, count));
}

// 2b. Raw tables: the shared data table owns list markup; renderers excepted.
for (const file of sourceFiles) {
  if (isTest(file)) continue;
  const count = rawTableCount(read(file));
  if (count > 0) observations.push(observed("raw-table", file, count));
}

// 3. Kit purity: shared components must not translate or import domain code.
for (const file of sourceFiles) {
  if (isTest(file) || !isKit(file)) continue;
  const count = kitPurityViolations(file, read(file));
  if (count > 0) observations.push(observed("kit-purity", file, count));
}

// 4. Styles: raw colours and Tailwind utilities in the shared kit.
for (const file of [...sourceFiles, ...styleFiles]) {
  if (isTest(file) || !isKit(file)) continue;
  const count = styleViolations(file, read(file));
  if (count > 0) observations.push(observed("style", file, count));
}

// 5. Dead exports: a shared export nobody outside its declaration uses.
const deadExports = [];
for (const file of sourceFiles) {
  if (isTest(file) || !isKit(file)) continue;
  const text = read(file);
  const dead = [];
  for (const name of exportedNames(text)) {
    const ownCount = (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
    const probe = new RegExp(`\\b${name}\\b`);
    let elsewhere = false;
    for (const other of sourceFiles) {
      if (other === file || isTest(other)) continue;
      if (probe.test(read(other))) {
        elsewhere = true;
        break;
      }
    }
    if (!elsewhere && ownCount <= 1) dead.push(name);
  }
  if (dead.length > 0) {
    observations.push(observed("dead-export", file, dead.length));
    deadExports.push({ file, names: dead });
  }
}

// 6. Duplicate CSS blocks across the source tree.
for (const entry of duplicateCssBlocks(
  styleFiles.map((file) => ({ file, text: read(file) })),
)) {
  observations.push(observed("duplicate-css", entry.file, entry.count));
}

// The allowlist uses UI-root-relative paths with forward slashes.
let entries = [];
const problems = [];
if (fs.existsSync(ALLOWLIST)) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8"));
  } catch (error) {
    console.error(`ui-kit: invalid allowlist: ${error.message}`);
    process.exit(2);
  }
  const parsed = parseAllowlist(raw);
  entries = parsed.entries;
  problems.push(...parsed.problems);
} else {
  problems.push("ui-kit.allowlist.json is missing");
}
if (problems.length > 0) {
  console.error(`ui-kit: invalid allowlist (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(2);
}

const result = compareAllowlist(observations, entries);
const blocking = blockingViolations(result, blocked);
const totals = Object.fromEntries(RULES.map((rule) => [rule, 0]));
for (const item of observations) totals[item.rule] += item.count;

if (json) {
  console.log(
    JSON.stringify(
      {
        mode: blocked.size > 0 ? "blocking" : "report",
        blocking: [...blocked],
        totals,
        violations: result.violations,
        stale: result.stale,
        wouldFail: result.violations.length,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `ui-kit check (${blocked.size > 0 ? `blocking: ${[...blocked].join(",")}` : "report"})`,
  );
  console.log(
    `  totals: ${RULES.map((rule) => `${rule}=${totals[rule]}`).join(" ")}`,
  );
  for (const line of formatObserved(observations)) console.log(`  ${line}`);
  for (const entry of deadExports) {
    for (const name of entry.names) {
      console.log(`  dead-export ${entry.file} ${name}`);
    }
  }
  for (const item of result.violations) {
    const marker = blocked.has(item.rule) || blocked.has("*") ? "violation" : "would-fail";
    console.log(
      `  ${marker} ${item.rule} ${item.file} count=${item.count} allowed=${item.allowed}`,
    );
  }
  for (const item of result.stale) {
    console.log(
      `  stale ${item.rule} ${item.file} recorded=${item.count} observed=${item.observed}`,
    );
  }
}

if (blocking.length > 0) {
  console.error(`ui-kit: failed (${blocking.length})`);
  process.exit(1);
}
console.log(
  `ui-kit: ok (${observations.length} allowlisted files, ${result.stale.length} stale)`,
);
