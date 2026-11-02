#!/usr/bin/env node
/*
 * Release gate for Gentree artifacts.
 *
 * Checks the code signature of every installer, writes a sha256sum-compatible
 * checksum file and optionally runs a Microsoft Defender scan. The signature
 * check is blocking only with --require-signature, so the gate can be wired
 * before a certificate exists: unsigned builds are reported, not fatal.
 * The Defender scan is always advisory.
 *
 *   node scripts/verify-release.mjs \
 *     --asset desktop/target/release/bundle/nsis/Gentree_0.2.0_x64-setup.exe \
 *     --sums release-assets/SHA256SUMS-windows-x64.txt --require-signature --defender
 *
 * Exit codes: 0 all checks passed, 1 a blocking check failed, 2 bad usage.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SIGNED_EXTENSIONS = new Set([".exe", ".msi", ".dll", ".sys"]);

const HELP = `Gentree release verification

Usage:
  node scripts/verify-release.mjs [--asset <file> ...] [--verify-only <file> ...]
                                  [--sums <file>] [--require-signature] [--defender]

Options:
  --asset         Release artifact: signature is checked and its SHA-256 is
                  written to the checksum file.
  --verify-only   File to check but not to list in the checksum file, such as
                  the executable that goes inside the portable archive.
  --sums          Write a sha256sum-compatible checksum file here.
  --require-signature
                  Fail when a signable artifact is not signed.
  --defender      Scan the files with Microsoft Defender (Windows, advisory).
  --help          Show this text.

Checksums are written as "<sha256>  <basename>", one line per artifact, sorted
by name. The executable bit is not part of the format.`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function note(status, message) {
  console.log(`${status.padEnd(6)} ${message}`);
}

function parseArgs(argv) {
  const options = {
    assets: [],
    verifyOnly: [],
    sums: "",
    requireSignature: false,
    defender: false,
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
      case "--asset":
        options.assets.push(next());
        break;
      case "--verify-only":
        options.verifyOnly.push(next());
        break;
      case "--sums":
        options.sums = next();
        break;
      case "--require-signature":
        options.requireSignature = true;
        break;
      case "--defender":
        options.defender = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!options.help && options.assets.length === 0) {
    fail("pass at least one --asset");
  }
  return options;
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

function runPowerShell(script) {
  const shell = findPowerShell();
  if (!shell) return { status: 127, stdout: "", stderr: "PowerShell not found" };
  const result = spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  );
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function windowsSignature(file) {
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath ${quote(file)}`,
    `Write-Output ("STATUS " + $signature.Status)`,
    `if ($signature.SignerCertificate) {`,
    `  Write-Output ("SUBJECT " + $signature.SignerCertificate.Subject)`,
    `}`,
  ].join("\n");
  const result = runPowerShell(script);
  if (result.status !== 0) {
    return { checked: false, signed: false, detail: result.stderr || "signature check failed" };
  }
  const status = /^STATUS (.+)$/m.exec(result.stdout)?.[1] ?? "Unknown";
  const subject = /^SUBJECT (.+)$/m.exec(result.stdout)?.[1] ?? "";
  return {
    checked: true,
    signed: status === "Valid",
    detail: status === "Valid" ? `signed (${subject})` : status,
  };
}

function macOSSignature(file, extension) {
  if (extension === ".app") {
    const verify = run("codesign", ["--verify", "--deep", "--strict", file]);
    return {
      checked: true,
      signed: verify.status === 0,
      detail: verify.status === 0 ? "signed app bundle" : verify.stderr || "codesign failed",
    };
  }
  if (extension === ".dmg") {
    const staple = run("xcrun", ["stapler", "validate", file]);
    const assess = run("spctl", ["--assess", "--type", "install", "--verbose=2", file]);
    const signed = staple.status === 0 && assess.status === 0;
    return {
      checked: true,
      signed,
      detail: signed
        ? "notarized and stapled"
        : [staple.stderr, assess.stderr].filter(Boolean).join("; ") || "not notarized",
    };
  }
  return { checked: false, signed: false, detail: "archive, verified after installation" };
}

function signature(file) {
  const extension = path.extname(file).toLowerCase();
  if (!SIGNED_EXTENSIONS.has(extension)) return { checked: false, signed: false, detail: "" };
  if (process.platform === "win32") return windowsSignature(file);
  if (process.platform === "darwin") return macOSSignature(file, extension);
  return { checked: false, signed: false, detail: "not checked on this platform" };
}

function defenderScan(file) {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `if (-not (Get-Command Start-MpScan -ErrorAction SilentlyContinue)) { exit 4 }`,
    `$start = (Get-Date).ToUniversalTime()`,
    `Start-MpScan -ScanType CustomScan -ScanPath ${quote(file)}`,
    `if (-not (Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue)) { exit 0 }`,
    `$hits = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -ge $start })`,
    `foreach ($hit in $hits) {`,
    `  Write-Output ("THREAT " + $hit.ThreatName)`,
    `}`,
    `if ($hits.Count -gt 0) { exit 3 }`,
    `exit 0`,
  ].join("\n");
  const result = runPowerShell(script);
  if (result.status === 4) {
    return { ok: true, advisory: true, detail: "Microsoft Defender is not available here" };
  }
  if (result.status === 3) {
    return { ok: false, advisory: true, detail: result.stdout || "threat detected" };
  }
  if (result.status !== 0) {
    return {
      ok: true,
      advisory: true,
      detail: `scan could not run: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    };
  }
  return { ok: true, advisory: false, detail: "no detections" };
}

async function checksum(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  const assets = [...new Set(options.assets.map((item) => path.resolve(item)))];
  const verifiedOnly = [...new Set(options.verifyOnly.map((item) => path.resolve(item)))];
  const failures = [];

  for (const file of [...assets, ...verifiedOnly]) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) fail(`artifact not found: ${file}`);
  }

  console.log(`platform: ${process.platform}`);
  for (const file of [...assets, ...verifiedOnly]) {
    const name = path.basename(file);
    const result = signature(file);
    if (!result.checked) {
      note("[info]", `${name}: signature ${result.detail || "not applicable"}`);
      continue;
    }
    if (result.signed) {
      note("[ok]", `${name}: ${result.detail}`);
      continue;
    }
    const message = `${name}: ${result.detail}`;
    if (options.requireSignature) {
      note("[fail]", message);
      failures.push(`${name}: not signed`);
    } else {
      note("[warn]", message);
    }
  }

  if (options.defender) {
    if (process.platform !== "win32") {
      note("[info]", "Defender scan skipped: Windows only");
    } else {
      for (const file of [...assets, ...verifiedOnly]) {
        const name = path.basename(file);
        const result = defenderScan(file);
        if (result.ok) {
          note(result.advisory ? "[warn]" : "[ok]", `${name}: ${result.detail}`);
        } else {
          note("[warn]", `${name}: ${result.detail}`);
        }
      }
    }
  }

  if (options.sums) {
    const sumsPath = path.resolve(options.sums);
    await mkdir(path.dirname(sumsPath), { recursive: true });
    const lines = [];
    for (const file of assets) {
      lines.push(`${await checksum(file)}  ${path.basename(file)}`);
    }
    lines.sort((left, right) => left.slice(66).localeCompare(right.slice(66)));
    await writeFile(sumsPath, `${lines.join("\n")}\n`, "utf8");
    note("[ok]", `checksums: ${sumsPath} (${lines.length} files)`);
  }

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`unsigned: ${failure}`);
    process.exit(1);
  }

  console.log("");
  console.log(`verified ${assets.length} release artifacts`);
}

await main();
