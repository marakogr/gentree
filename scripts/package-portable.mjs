#!/usr/bin/env node
/*
 * Packages the portable Windows build.
 *
 * The archive contains one production executable and a short readme. There is
 * no installer, no self-extracting stub and no registry access: a plain signed
 * executable inside a zip is the shape antivirus engines treat most
 * predictably.
 *
 *   node scripts/package-portable.mjs --exe desktop/target/release/gentree-desktop.exe \
 *     --version 0.2.0 --out release-assets [--arch x64] [--signed]
 *
 * Windows only: the archive is a .zip written by Compress-Archive.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PRODUCT = "Gentree";
const EXE_NAME = `${PRODUCT}.exe`;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const HELP = `Gentree portable packager

Usage:
  node scripts/package-portable.mjs --exe <path> --version <semver> --out <dir>
                                    [--arch <x64>] [--signed]

Options:
  --exe      Production executable produced by "tauri build --no-bundle".
  --version  Version written into the archive name and the readme.
  --out      Directory that receives the archive (created if missing).
  --arch     Architecture label, "x64" by default.
  --signed   The executable carries a code signature; the readme says so.
  --help     Show this text.

Windows only. The archive is named <Product>_<version>_<arch>_portable.zip.`;

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
    signed: false,
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
      case "--signed":
        options.signed = true;
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

function readme(version, arch, signed) {
  const signature = signed
    ? `The executable in this archive is code-signed. To check it, run:

    Get-AuthenticodeSignature Gentree.exe

and look for "Valid" in the Status column.`
    : `This archive was built without a code-signing certificate. Windows
SmartScreen warns about an unknown publisher on the first launch; that does not
mean the file is unsafe. Click "More info", then "Run anyway".

Check the SHA-256 published with the release before running the executable; the
release lists it in SHA256SUMS-windows-x64.txt.`;

  return `${PRODUCT} ${version} - portable build (Windows ${arch})

This archive contains a single executable. Nothing is installed and no
registry entries are created.

Requirements
------------
- Windows 10 version 1803 or newer, or Windows 11, with the Microsoft Edge
  WebView2 Runtime. It is part of Windows 11 and current Windows 10 updates;
  otherwise install it from
  https://developer.microsoft.com/microsoft-edge/webview2/
- Keep the whole folder together. Moving or renaming Gentree.exe is fine.

Where your data lives
---------------------
Settings, projects, backups and the search index are stored in
%APPDATA%\\Gentree, not next to the executable. Replacing this folder with a
newer archive never touches your data. Project and backup folders can be
changed in Settings.

Updates
-------
A portable build never downloads or installs an update by itself. To upgrade,
quit Gentree and replace the folder with a newer portable archive.

Integrity
---------
Every release publishes SHA-256 checksums. Verify the downloaded archive with:

    Get-FileHash Gentree_${version}_${arch}_portable.zip -Algorithm SHA256

${signature}
`;
}

function findPowerShell() {
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(
      candidate,
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
      { encoding: "utf8" },
    );
    if (probe.status === 0) return candidate;
  }
  return "";
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function compress(shell, sourceDir, archivePath) {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `Compress-Archive -Path ${quote(path.join(sourceDir, "*"))} ` +
      `-DestinationPath ${quote(archivePath)} -CompressionLevel Optimal -Force`,
  ].join("\n");
  const result = spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    fail(`Compress-Archive failed with exit code ${result.status}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (process.platform !== "win32") {
    fail("the portable archive is Windows-only; use the .dmg or .app on macOS");
  }
  if (!options.exe) fail("--exe is required");
  if (!options.version) fail("--version is required");
  if (!SEMVER.test(options.version)) {
    fail(`--version must be a semver string, got ${options.version}`);
  }
  if (!options.out) fail("--out is required");

  const exePath = path.resolve(options.exe);
  const info = await stat(exePath).catch(() => null);
  if (!info?.isFile()) fail(`executable not found: ${options.exe}`);
  if (info.size < 1024 * 1024) {
    fail(`executable looks too small to be a production build: ${info.size} bytes`);
  }

  const shell = findPowerShell();
  if (!shell) fail("PowerShell is required to create the archive");

  await mkdir(options.out, { recursive: true });
  const stage = await mkdtemp(path.join(os.tmpdir(), "gentree-portable-"));
  const archiveName = `${PRODUCT}_${options.version}_${options.arch}_portable.zip`;
  const archivePath = path.resolve(options.out, archiveName);

  try {
    const stagedExe = path.join(stage, EXE_NAME);
    await copyFile(exePath, stagedExe);
    await writeFile(
      path.join(stage, "README.txt"),
      readme(options.version, options.arch, options.signed),
      "utf8",
    );
    compress(shell, stage, archivePath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  const bytes = await readFile(archivePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`portable archive: ${archivePath}`);
  console.log(`bytes: ${bytes.length}`);
  console.log(`sha256: ${sha256}`);
  console.log(`executable: ${exePath}`);
  console.log(`signed: ${options.signed ? "yes" : "no"}`);
}

await main();
