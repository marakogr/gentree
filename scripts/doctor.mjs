#!/usr/bin/env node
// Development environment diagnostics: `make doctor` (Node.js 20+ is required).
// Prints one status line per check and exits 1 when something is missing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const UI = path.join(DESKTOP, "ui");
const IS_WIN = process.platform === "win32";

let okCount = 0;
let warnCount = 0;
let failCount = 0;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  return {
    code: res.status,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
  };
}

function report(status, label, detail) {
  if (status === "ok") okCount++;
  else if (status === "warn") warnCount++;
  else failCount++;
  console.log(`[doctor] ${status.padEnd(4)} ${label.padEnd(10)} ${detail}`);
}

function version(cmd, args = ["--version"], opts = {}) {
  const r = run(cmd, args, opts);
  return r.code === 0 || r.out ? r.out.split("\n")[0] : null;
}

// ---- Node.js (already running doctor, but check the major version) ----
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) {
  report("ok", "node", `v${process.versions.node}`);
} else {
  report("fail", "node", `v${process.versions.node}, Node.js 20+ is required`);
}

// ---- npm ----
// Windows: run npm through cmd explicitly; .cmd shims fail without a shell.
const npmCmd = IS_WIN ? "cmd" : "npm";
const npmArgs = IS_WIN ? ["/d", "/s", "/c", "npm --version"] : ["--version"];
const npmVer = version(npmCmd, npmArgs);
if (npmVer) {
  report("ok", "npm", npmVer);
} else {
  report("fail", "npm", "not found; install Node.js 20+ (npm is bundled)");
}

// ---- git ----
const gitVer = version("git");
if (gitVer) {
  report("ok", "git", gitVer);
} else {
  report("fail", "git", "not found; install git");
}

// ---- rustup (optional but recommended) ----
const rustupVer = version("rustup", ["show", "active-toolchain"]);
if (rustupVer) {
  report("ok", "rustup", rustupVer.split("\n")[0]);
} else {
  report(
    "warn",
    "rustup",
    "not found; recommended to manage the pinned toolchain (desktop/rust-toolchain.toml)",
  );
}

// ---- cargo ----
const cargoVer = version("cargo", ["--version"], { cwd: DESKTOP });
if (cargoVer) {
  report("ok", "cargo", cargoVer);
} else {
  report(
    "fail",
    "cargo",
    "not found; run `make setup`, or reinstall rustup and reopen the terminal",
  );
}

// ---- rustc + pinned toolchain check ----
const rustcVer = version("rustc", ["--version"], { cwd: DESKTOP });
if (rustcVer) {
  report("ok", "rustc", rustcVer);
  const toml = existsSync(path.join(DESKTOP, "rust-toolchain.toml"))
    ? readFileSync(path.join(DESKTOP, "rust-toolchain.toml"), "utf8")
    : "";
  const channel = /channel = "([^"]+)"/.exec(toml)?.[1];
  const have = /rustc (\d+\.\d+\.\d+)/.exec(rustcVer)?.[1];
  if (channel && have && channel !== have) {
    report(
      "warn",
      "pin",
      `pinned ${channel} but rustc reports ${have}; install rustup or the matching toolchain`,
    );
  }
} else {
  report("fail", "rustc", "not found; run `make setup`");
}

// ---- UI dependencies ----
const nodeModules = path.join(UI, "node_modules");
if (existsSync(nodeModules)) {
  report("ok", "ui-deps", "installed");
  const tauriBin = path.join(UI, "node_modules", ".bin", IS_WIN ? "tauri.cmd" : "tauri");
  if (existsSync(tauriBin)) {
    report("ok", "tauri-cli", "installed");
  } else {
    report("warn", "tauri-cli", `missing ${path.relative(ROOT, tauriBin)}; run: make install`);
  }
} else {
  report("fail", "ui-deps", "not installed; run: make install");
}

// ---- native linker host ----
if (IS_WIN) {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const r = run(vswhere, ["-all", "-prerelease", "-products", "*", "-property", "installationPath"]);
  const install = r.out.split("\n")[0]?.trim() ?? "";
  if (!install) {
    report(
      "warn",
      "msvc",
      "not detected; install Visual Studio Build Tools with the C++ workload to link the exe",
    );
  } else {
    const msvcDir = path.join(install, "VC", "Tools", "MSVC");
    const toolset = existsSync(msvcDir) ? readdirSync(msvcDir)[0] : null;
    if (toolset) {
      report("ok", "msvc", `Build Tools ${toolset} at ${install}`);
    } else {
      report(
        "warn",
        "msvc",
        `no MSVC C++ toolsets under ${install}; add the workload in the Visual Studio Installer`,
      );
    }
  }
} else if (process.platform === "darwin") {
  const xc = run("xcode-select", ["-p"]);
  if (xc.code === 0 && xc.out) {
    report("ok", "xcode", xc.out.split("\n")[0]);
  } else {
    report("warn", "xcode", "Command Line Tools missing; run: xcode-select --install");
  }
}

console.log(`[doctor] summary: ${okCount} ok, ${warnCount} warn, ${failCount} fail`);
process.exit(failCount > 0 ? 1 : 0);
