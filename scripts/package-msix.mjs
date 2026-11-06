#!/usr/bin/env node
/*
 * Packages the Microsoft Store build as an MSIX file.
 *
 * The app is a full-trust desktop program, so the package needs no
 * `AppxManifest` wizardry: a layout directory with the executable, the tile
 * assets and `AppxManifest.xml` is packed with `makeappx.exe`. The Store
 * re-signs the upload after certification, which is why the file this script
 * produces for Partner Center must stay unsigned.
 *
 *   make store
 *   node scripts/package-msix.mjs --exe desktop/target/release/gentree-desktop.exe \
 *     --version 0.7.0 --out release-assets/store [--dev-sign] [--keep-layout]
 *
 * The executable must come from a `--features store` build (no in-app updater);
 * `make store` does both steps. `--dev-sign` adds a throw-away self-signed
 * certificate, installs it in the current user's TrustedPeople store and signs
 * the package, so the local Windows install accepts it. Never upload that file:
 * Partner Center rejects a package signed with a certificate it did not issue.
 *
 * Windows only: `makeappx.exe` and `signtool.exe` ship with the Windows SDK.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(REPO_ROOT, "desktop", "apps", "desktop");
const MANIFEST_PATH = path.join(APP_DIR, "msix", "AppxManifest.xml");
const ICONS_DIR = path.join(APP_DIR, "icons");
const EXE_NAME = "gentree-desktop.exe";
const SEMVER = /^\d+\.\d+\.\d+$/;
/** Logos that already exist at the right size in `icons/` (produced by the
 * Tauri icon pipeline); the two wide assets are generated from `icon.png`. */
const COPIED_ASSETS = [
  "StoreLogo.png",
  "Square150x150Logo.png",
  "Square44x44Logo.png",
];

const HELP = `Gentree MSIX packager

Usage:
  node scripts/package-msix.mjs --exe <path> --version <semver> --out <dir>
                                [--arch <x64>] [--dev-sign] [--keep-layout]

Options:
  --exe         Executable from "tauri build --no-bundle --features store".
  --version     App version from tauri.conf.json; stored as <version>.0.
  --out         Directory that receives the .msix (created if missing).
  --arch        Package architecture, "x64" by default.
  --dev-sign    Sign with a throw-away self-signed certificate for a local test
                install. Such a package cannot be uploaded to the Store.
  --keep-layout Keep the generated layout directory for inspection.
  --help        Show this text.

Windows only. Requires makeappx.exe from the Windows SDK.`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    exe: "",
    version: "",
    out: "",
    arch: "x64",
    devSign: false,
    keepLayout: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) fail(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--exe":
        options.exe = next();
        break;
      case "--version":
        options.version = next();
        break;
      case "--out":
        options.out = next();
        break;
      case "--arch":
        options.arch = next();
        break;
      case "--dev-sign":
        options.devSign = true;
        break;
      case "--keep-layout":
        options.keepLayout = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, what) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) fail(`${what} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${what} failed with exit code ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function findPowerShell() {
  for (const candidate of ["pwsh", "powershell"]) {
    if (
      commandWorks(candidate, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "exit 0",
      ])
    ) {
      return candidate;
    }
  }
  return "";
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** `makeappx.exe`/`signtool.exe`: explicit env var, then PATH, then the newest
 * Windows SDK installed under `Windows Kits\10\bin`. */
function findSdkTool(tool) {
  const override = process.env[tool.replace(/\.exe$/i, "").toUpperCase()];
  if (override) {
    if (!existsSync(override)) fail(`${tool} override does not exist: ${override}`);
    return override;
  }
  const onPath = capture("where.exe", [tool]).split(/\r?\n/)[0];
  if (onPath) return onPath;

  const kitsRoot = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const binRoot = path.join(kitsRoot, "Windows Kits", "10", "bin");
  if (existsSync(binRoot)) {
    const versions = readdirSync(binRoot)
      .filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry))
      .sort(compareVersions)
      .reverse();
    for (const version of versions) {
      for (const arch of ["x64", "x86", "arm64"]) {
        const candidate = path.join(binRoot, version, arch, tool);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  fail(
    `cannot find ${tool}. Install the Windows 10/11 SDK (it ships with the ` +
      `MSVC build tools) or set ${tool.replace(/\.exe$/i, "").toUpperCase()} ` +
      `to its full path.`,
  );
}

function readIdentity(manifest) {
  const identity = manifest.match(/<Identity[\s\S]*?\/>/u);
  if (!identity) fail("AppxManifest.xml has no <Identity> element");
  const attribute = (name, source) => {
    const match = source.match(new RegExp(`\\b${name}="([^"]*)"`, "u"));
    if (!match) fail(`AppxManifest.xml has no ${name}`);
    return match[1];
  };
  const displayName = manifest.match(
    /<PublisherDisplayName>([^<]+)<\/PublisherDisplayName>/u,
  );
  if (!displayName) fail("AppxManifest.xml has no <PublisherDisplayName>");
  return {
    name: attribute("Name", identity[0]),
    publisher: attribute("Publisher", identity[0]),
    displayName: displayName[1],
    // The tile background is repeated in the manifest; strip the ARGB alpha
    // because System.Drawing takes #RRGGBB here.
    backgroundColor: attribute("BackgroundColor", manifest).replace(/^#FF/i, "#"),
  };
}

/** MSIX needs a wide tile and a splash screen that Tauri does not generate. */
function generateTiles(shell, layoutAssets, backgroundColor) {
  const icon = path.join(ICONS_DIR, "icon.png");
  if (!existsSync(icon)) fail(`icon not found: ${icon}`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    `$source = [System.Drawing.Image]::FromFile(${quote(icon)})`,
    `$background = [System.Drawing.ColorTranslator]::FromHtml(${quote(backgroundColor)})`,
    "function New-Tile([int]$width, [int]$height, [int]$iconSize, [string]$destination) {",
    "  $bitmap = New-Object System.Drawing.Bitmap $width, $height",
    "  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "  try {",
    "    $graphics.Clear($background)",
    "    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
    "    $x = [int](($width - $iconSize) / 2)",
    "    $y = [int](($height - $iconSize) / 2)",
    "    $graphics.DrawImage($source, $x, $y, $iconSize, $iconSize)",
    "    $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)",
    "  } finally {",
    "    $graphics.Dispose()",
    "    $bitmap.Dispose()",
    "  }",
    "}",
    `New-Tile 310 150 118 ${quote(path.join(layoutAssets, "Wide310x150Logo.png"))}`,
    `New-Tile 620 300 220 ${quote(path.join(layoutAssets, "SplashScreen.png"))}`,
    "$source.Dispose()",
  ].join("\n");
  run(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    "tile generation",
  );
}

/** A local-only certificate: subject == the Store publisher, so the package
 * identity stays the same and a test install replaces the Store one cleanly. */
function devSign(shell, signtool, msixPath, publisher, workDir) {
  const pfx = path.join(workDir, "gentree-msix-dev.pfx");
  const password = "gentree-msix-dev";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$certificate = New-SelfSignedCertificate -Type Custom -Subject ${quote(publisher)} ` +
      "-KeyUsage DigitalSignature -FriendlyName 'Gentree MSIX (local test)' " +
      "-CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddYears(1) " +
      "-TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')",
    `$password = ConvertTo-SecureString -String ${quote(password)} -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $certificate -FilePath ${quote(pfx)} -Password $password | Out-Null`,
    "$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'CurrentUser')",
    "$store.Open('ReadWrite')",
    "$store.Add($certificate)",
    "$store.Close()",
    "Write-Output $certificate.Thumbprint",
  ].join("\n");
  const result = spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`creating the test certificate failed: ${result.stderr.trim()}`);
  }
  const thumbprint = (result.stdout ?? "").trim().split(/\r?\n/).pop();
  run(
    signtool,
    ["sign", "/fd", "SHA256", "/f", pfx, "/p", password, "/a", msixPath],
    "signtool",
  );
  console.log(`test certificate: ${thumbprint} (Cert:\\CurrentUser\\My)`);
  console.log(
    "remove it later: Get-ChildItem Cert:\\CurrentUser\\My | " +
      "Where-Object FriendlyName -like 'Gentree MSIX*' | Remove-Item",
  );
}

async function unpackCheck(makeappx, msixPath, workDir) {
  const target = path.join(workDir, "verify");
  run(makeappx, ["unpack", "/p", msixPath, "/d", target, "/o"], "makeappx unpack");
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).length;
  if (files < COPIED_ASSETS.length + 3) {
    fail(`the packaged layout has only ${files} files; packaging lost content`);
  }
  return files;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (process.platform !== "win32") {
    fail("the Microsoft Store package is Windows-only");
  }
  if (!options.exe) fail("--exe is required");
  if (!options.version) fail("--version is required");
  if (!SEMVER.test(options.version)) {
    fail(`--version must be a three-part version such as 0.7.0, got ${options.version}`);
  }
  if (!options.out) fail("--out is required");
  if (options.arch !== "x64") {
    fail(`only x64 is packaged today; Store submission for ${options.arch} is untested`);
  }

  const exePath = path.resolve(options.exe);
  const info = await stat(exePath).catch(() => null);
  if (!info?.isFile()) fail(`executable not found: ${options.exe}`);
  if (info.size < 1024 * 1024) {
    fail(
      `executable looks too small to be a production build: ${info.size} bytes`,
    );
  }

  const shell = findPowerShell();
  if (!shell) fail("PowerShell is required to render the tile assets");
  const makeappx = findSdkTool("makeappx.exe");
  const msixVersion = `${options.version}.0`;

  const template = await readFile(MANIFEST_PATH, "utf8");
  const identity = readIdentity(template);
  const manifest = template.replaceAll("{{VERSION}}", msixVersion);
  if (manifest.includes("{{")) fail("AppxManifest.xml has an unreplaced placeholder");

  await mkdir(options.out, { recursive: true });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "gentree-msix-"));
  const layout = path.join(workDir, "layout");
  const layoutAssets = path.join(layout, "Assets");
  const msixName = `${identity.name}_${msixVersion}_${options.arch}.msix`;
  const msixPath = path.resolve(options.out, msixName);

  try {
    await mkdir(layoutAssets, { recursive: true });
    await copyFile(exePath, path.join(layout, EXE_NAME));
    for (const asset of COPIED_ASSETS) {
      await copyFile(path.join(ICONS_DIR, asset), path.join(layoutAssets, asset));
    }
    generateTiles(shell, layoutAssets, identity.backgroundColor);
    await writeFile(path.join(layout, "AppxManifest.xml"), manifest, "utf8");

    run(makeappx, ["pack", "/d", layout, "/p", msixPath, "/o"], "makeappx pack");
    const files = await unpackCheck(makeappx, msixPath, workDir);

    if (options.devSign) {
      const signtool = findSdkTool("signtool.exe");
      devSign(shell, signtool, msixPath, identity.publisher, workDir);
    }

    const bytes = await readFile(msixPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // sha256sum-compatible, LF only: the same shape verify-release.mjs writes.
    const sumsPath = path.resolve(
      options.out,
      `SHA256SUMS-store-${options.arch}.txt`,
    );
    await writeFile(sumsPath, `${sha256}  ${msixName}\n`, "utf8");
    console.log("");
    console.log(`package:   ${msixPath}`);
    console.log(`identity:  ${identity.name} ${msixVersion} ${options.arch}`);
    console.log(`publisher: ${identity.publisher}`);
    console.log(`display:   ${identity.displayName}`);
    console.log(`files:     ${files}`);
    console.log(`bytes:     ${bytes.length}`);
    console.log(`sha256:    ${sha256}`);
    console.log(`sums:      ${sumsPath}`);
    console.log(`signed:    ${options.devSign ? "yes (local test only)" : "no (correct for Partner Center)"}`);
    if (options.devSign) {
      console.log("");
      console.log("local test install:");
      console.log(`  Add-AppxPackage -Path ${quote(msixPath)}`);
      console.log("local test removal:");
      console.log(`  Get-AppxPackage ${identity.name} | Remove-AppxPackage`);
    }
    if (options.keepLayout) {
      const kept = path.resolve(options.out, "layout");
      await rm(kept, { recursive: true, force: true });
      await cp(layout, kept, { recursive: true });
      console.log(`layout:    ${kept}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
