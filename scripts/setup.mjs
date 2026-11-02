#!/usr/bin/env node
// One-time environment bootstrap: Rust toolchain, UI dependencies, git hooks.
// Run via `make setup` (Node.js 20+ must already be installed).
import { spawnSync } from "node:child_process";
import { createWriteStream, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(ROOT, "desktop", "ui");
const IS_WIN = process.platform === "win32";

function die(message) {
  console.error(`[setup] FAIL ${message}`);
  process.exit(1);
}

// ---- 1. Rust toolchain ----
const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargo.status === 0) {
  console.log(`[setup] cargo already installed: ${cargo.stdout.trim()}`);
} else {
  console.log("[setup] cargo not found, installing rustup (takes a few minutes)...");
  if (IS_WIN) {
    const exe = path.join(os.tmpdir(), "gentree-rustup-init.exe");
    const res = await fetch(
      "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
    );
    if (!res.ok || !res.body) die(`cannot download rustup-init: HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(exe));
    try {
      if (spawnSync(exe, ["-y"], { stdio: "inherit" }).status !== 0) {
        die("rustup-init exited with an error");
      }
    } finally {
      rmSync(exe, { force: true });
    }
    console.log(
      "[setup] NOTE reopen the terminal so %USERPROFILE%\\.cargo\\bin appears on PATH",
    );
  } else {
    const res = await fetch("https://sh.rustup.rs");
    if (!res.ok) die(`cannot download the rustup script: HTTP ${res.status}`);
    const script = await res.text();
    if (
      spawnSync("sh", ["-s", "--", "-y"], {
        input: script,
        stdio: ["pipe", "inherit", "inherit"],
      }).status !== 0
    ) {
      die("rustup installer exited with an error");
    }
    console.log("[setup] NOTE run `source ~/.cargo/env` or reopen the terminal");
  }
  console.log("[setup] the pinned toolchain (desktop/rust-toolchain.toml) is fetched on demand");
}

// ---- 2. UI dependencies ----
console.log("[setup] npm ci (desktop/ui)...");
// Windows: run npm through cmd explicitly; .cmd shims fail without a shell.
const npm = spawnSync(IS_WIN ? "cmd" : "npm", IS_WIN ? ["/d", "/s", "/c", "npm ci"] : ["ci"], {
  cwd: UI,
  stdio: "inherit",
});
if (npm.status !== 0) die("npm ci failed; run `make install` for details");

// ---- 3. git hooks ----
const hooks = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: ROOT });
if (hooks.status !== 0) die("cannot enable git hooks; check that git is installed");
console.log("[setup] git hooks enabled (.githooks)");

console.log("[setup] done. Next: make doctor, then make check");
