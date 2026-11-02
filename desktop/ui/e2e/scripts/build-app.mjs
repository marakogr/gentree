#!/usr/bin/env node
// Builds the review variant of the app into desktop/target/ux.
//
// The only difference from a normal build is the bundle identifier from
// `tauri.ux.conf.json`. Windows keeps app data under %APPDATA%\<identifier>,
// so the review sees an empty home and can never open a real archive. A
// separate target directory keeps the normal release binary untouched.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { APP_EXE, DESKTOP_DIR, E2E_DIR } from "./driver.mjs";

const UI_ROOT = path.resolve(E2E_DIR, "..");
const TAURI_CLI = path.join(UI_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const CONFIG = path.join(E2E_DIR, "tauri.ux.conf.json");

if (!fs.existsSync(TAURI_CLI)) {
  console.error("ux:build: the Tauri CLI is missing. Run: make install");
  process.exit(1);
}

console.log("ux:build: compiling the isolated review app (first run is slow)");
const result = spawnSync(
  process.execPath,
  [TAURI_CLI, "build", "--no-bundle", "--config", CONFIG],
  {
    cwd: path.join(DESKTOP_DIR, "apps", "desktop"),
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.join(DESKTOP_DIR, "target", "ux"),
    },
  },
);

if (result.status !== 0) {
  console.error("ux:build: the build failed");
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(APP_EXE)) {
  console.error(`ux:build: expected the app at ${APP_EXE}`);
  process.exit(1);
}

console.log(`ux:build: ${APP_EXE}`);
