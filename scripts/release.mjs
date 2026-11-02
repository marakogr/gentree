#!/usr/bin/env node
// Tags the version in tauri.conf.json and pushes the tag. The Release workflow
// then builds a draft release; publishing stays a manual review step.
//
// `make release` is the only supported entry point, so the guards below match
// the release checklist in docs/releases.md.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args, { inherit = false } = {}) {
  const options = inherit
    ? { stdio: "inherit" }
    : { encoding: "utf8" };
  const output = execFileSync("git", args, options);
  return inherit ? "" : output.trim();
}

const config = JSON.parse(
  readFileSync("desktop/apps/desktop/tauri.conf.json", "utf8"),
);
const version = config.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`tauri.conf.json has no semver version (${String(version)})`);
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## [${version}]`)) {
  fail(`CHANGELOG.md has no "## [${version}]" section for the user-facing notes`);
}

if (git(["status", "--porcelain"]) !== "") {
  fail("the working tree is not clean");
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") {
  fail(`release from main; the current branch is ${branch}`);
}

git(["fetch", "origin", "--tags", "--quiet"]);
const head = git(["rev-parse", "HEAD"]);
if (head !== git(["rev-parse", "origin/main"])) {
  fail("main is not in sync with origin/main; pull or push first");
}

const tag = `v${version}`;
if (git(["tag", "--list", tag]) !== "") {
  fail(`tag ${tag} already exists`);
}

console.log(`release: ${tag} at ${head.slice(0, 7)} (${version})`);
if (dryRun) {
  console.log("release: dry run, no tag created");
  process.exit(0);
}

git(["tag", "-a", tag, "-m", `Gentree ${version}`]);
git(["push", "origin", tag], { inherit: true });
console.log(
  `release: pushed ${tag}. Review the draft the Release workflow builds, then publish it.`,
);
