#!/usr/bin/env node
// Checks the two native pieces the harness needs on Windows:
//   - tauri-driver (the WebDriver bridge for Tauri 2)
//   - msedgedriver that matches the installed WebView2 runtime
//
// tauri-driver is installed once by hand: cargo install tauri-driver --locked.
// msedgedriver is version-locked to WebView2, so it is cached and refreshed
// whenever the runtime is updated.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const E2E_DIR = path.resolve(import.meta.dirname, "..");
const CACHE_DIR = path.join(E2E_DIR, ".cache");
const DRIVER_DIR = path.join(CACHE_DIR, "msedgedriver");
const VERSION_FILE = path.join(DRIVER_DIR, "VERSION");
const IS_WINDOWS = process.platform === "win32";

// Evergreen WebView2 runtime, machine-wide install.
const WEBVIEW2_CLIENT_KEY =
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function fail(message) {
  console.error(`ux:setup: ${message}`);
  process.exit(1);
}

function ensureTauriDriver() {
  const probe = run(IS_WINDOWS ? "where" : "which", ["tauri-driver"]);
  if (probe.status === 0) return;

  const fallback = path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    ".cargo",
    "bin",
    IS_WINDOWS ? "tauri-driver.exe" : "tauri-driver",
  );
  if (fs.existsSync(fallback)) return;

  fail("tauri-driver is missing. Install it with: cargo install tauri-driver --locked");
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function webView2Version() {
  const registry = run("reg", ["query", WEBVIEW2_CLIENT_KEY, "/v", "pv"]);
  if (registry.status === 0) {
    const match = registry.stdout.match(/pv\s+REG_SZ\s+(\S+)/);
    if (match) return match[1];
  }

  const root = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft",
    "EdgeWebView",
    "Application",
  );
  if (fs.existsSync(root)) {
    const versions = fs
      .readdirSync(root)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort(compareVersions);
    if (versions.length > 0) return versions[versions.length - 1];
  }

  fail("the WebView2 runtime was not found; install it from Microsoft first");
}

function installedDriverVersion() {
  if (!fs.existsSync(VERSION_FILE)) return null;
  return fs.readFileSync(VERSION_FILE, "utf8").trim();
}

function downloadDriver(version) {
  fs.mkdirSync(DRIVER_DIR, { recursive: true });
  const archive = path.join(CACHE_DIR, "edgedriver_win64.zip");
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const script = [
    "$ErrorActionPreference='Stop'",
    `Invoke-WebRequest -Uri '${url}' -OutFile '${archive}' -UseBasicParsing`,
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${DRIVER_DIR}' -Force`,
  ].join("; ");

  const result = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (result.status !== 0) {
    fail(
      `could not download msedgedriver ${version}. Run the same command manually or set UX_EDGEDRIVER to an existing binary.\n${result.stderr}`,
    );
  }

  const binary = path.join(DRIVER_DIR, "msedgedriver.exe");
  if (!fs.existsSync(binary)) fail(`msedgedriver.exe is missing after unpacking ${archive}`);

  fs.writeFileSync(VERSION_FILE, `${version}\n`, "utf8");
}

function main() {
  if (!IS_WINDOWS) {
    fail("the review harness currently supports Windows only (WebView2 + msedgedriver)");
  }

  ensureTauriDriver();

  const version = webView2Version();
  if (installedDriverVersion() !== version) {
    console.log(`ux:setup: fetching msedgedriver ${version}`);
    downloadDriver(version);
  } else {
    console.log(`ux:setup: msedgedriver ${version} is cached`);
  }

  console.log("ux:setup: ready");
}

main();
