#!/usr/bin/env node
// Entry point for a review run: drivers -> isolated build -> WebdriverIO.
//
//   npm run ux:review                full pass (shell audit + project tour)
//   npm run ux:review -- --smoke     attach only
//   npm run ux:review -- --no-build  reuse the previous isolated build
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const E2E_DIR = path.resolve(import.meta.dirname, "..");
const UI_ROOT = path.resolve(E2E_DIR, "..");
const WDIO = path.join(UI_ROOT, "node_modules", "@wdio", "cli", "bin", "wdio.js");

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const smoke = args.includes("--smoke");
const extraSpecs = args
  .filter((argument) => argument.startsWith("--spec="))
  .map((argument) => argument.slice("--spec=".length));

if (!fs.existsSync(WDIO)) {
  console.error("ux:review: WebdriverIO is missing. Run: make install");
  process.exit(1);
}

function step(script) {
  return spawnSync(
    process.execPath,
    [path.join(E2E_DIR, "scripts", script)],
    { cwd: E2E_DIR, stdio: "inherit" },
  );
}

if (step("ensure-driver.mjs").status !== 0) process.exit(1);
if (!noBuild && step("build-app.mjs").status !== 0) process.exit(1);

const wdioArgs = ["run", "wdio.conf.js"];
if (smoke) wdioArgs.push("--spec", "./specs/01-smoke.js");
for (const spec of extraSpecs) wdioArgs.push("--spec", spec);

const result = spawnSync(process.execPath, [WDIO, ...wdioArgs], {
  cwd: E2E_DIR,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
