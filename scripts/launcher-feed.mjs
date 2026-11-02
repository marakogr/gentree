#!/usr/bin/env node
/*
 * Local version-feed server for Gentree Launcher.
 *
 * Loopback only: binds 127.0.0.1 and is meant for testing the launcher
 * without touching GitHub/Gitea. It serves a directory that contains
 * `versions.json` plus the artifacts that file points at.
 *
 *   node scripts/launcher-feed.mjs --fixtures
 *   node scripts/launcher-feed.mjs
 *
 * The generated installers are synthetic bytes, not real installers. Use them
 * to exercise the feed, the download progress and the SHA-256 check; a real
 * install needs a real Gentree build.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_DIR = ".launcher-feed";
const FIXTURE_SIZE = 1024 * 1024;

const CONTENT_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".sha256": "text/plain; charset=utf-8",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".dmg": "application/x-apple-diskimage",
  ".bin": "application/octet-stream",
};

const HELP = `Gentree Launcher local feed server

Usage:
  node scripts/launcher-feed.mjs [--dir <path>] [--port <port>]
  node scripts/launcher-feed.mjs --fixtures [--dir <path>]

Options:
  --dir <path>   Directory to serve (default: ${DEFAULT_DIR}).
  --port <port>  Loopback port (default: ${DEFAULT_PORT}).
  --fixtures     Write synthetic artifacts and versions.json, then exit.
  -h, --help     Show this help.

The server always binds ${HOST}; remote clients cannot reach it.
`;

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIR, port: DEFAULT_PORT, fixtures: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--fixtures") {
      options.fixtures = true;
    } else if (arg === "--dir" || arg === "--port") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      if (arg === "--dir") {
        options.dir = value;
      } else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port: ${value}`);
        }
        options.port = port;
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function syntheticInstaller(version, os, arch) {
  const header = Buffer.from(
    `Gentree synthetic artifact\nversion=${version}\nos=${os}\narch=${arch}\n`,
    "utf8",
  );
  const padding = Buffer.alloc(Math.max(0, FIXTURE_SIZE - header.length), 0x20);
  return Buffer.concat([header, padding]);
}

function artifactName(version, os, arch) {
  const archTag = arch === "x86_64" ? "x64" : arch;
  return os === "windows"
    ? `Gentree_${version}_${archTag}-setup.exe`
    : `Gentree_${version}_${archTag}.dmg`;
}

async function writeFixtures(directory, port = DEFAULT_PORT) {
  await mkdir(directory, { recursive: true });

  const versions = [
    { version: "9.9.1", released: "2026-09-01T10:00:00Z", prerelease: false },
    { version: "9.9.2", released: "2026-10-01T10:00:00Z", prerelease: false },
    { version: "9.9.3-beta.1", released: "2026-10-20T10:00:00Z", prerelease: true },
  ];
  const feedVersions = [];

  for (const entry of versions) {
    const files = [];
    const targets = [
      { os: "windows", arch: "x86_64", kind: "nsis" },
      { os: "macos", arch: "aarch64", kind: "dmg" },
    ];
    for (const target of targets) {
      const name = artifactName(entry.version, target.os, target.arch);
      const bytes = syntheticInstaller(entry.version, target.os, target.arch);
      await writeFile(path.join(directory, name), bytes);
      files.push({
        os: target.os,
        arch: target.arch,
        kind: target.kind,
        url: `http://${HOST}:${port}/${name}`,
        sha256: sha256(bytes),
        size: bytes.length,
      });
    }
    feedVersions.push({
      version: entry.version,
      released: entry.released,
      notes: `Synthetic ${entry.version} fixture. Not a real Gentree release.`,
      prerelease: entry.prerelease,
      files,
    });
  }

  const feed = {
    schema: 1,
    app: "gentree",
    latest: "9.9.2",
    versions: feedVersions,
  };
  await writeFile(
    path.join(directory, "versions.json"),
    `${JSON.stringify(feed, null, 2)}\n`,
    "utf8",
  );
  return feed;
}

function contentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveInside(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const target = path.resolve(root, `.${decoded === "/" ? "/versions.json" : decoded}`);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return target;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`launcher-feed: ${error.message}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const root = path.resolve(options.dir);

  if (options.fixtures) {
    const feed = await writeFixtures(root, options.port);
    console.log(`Wrote synthetic feed with ${feed.versions.length} versions to ${root}`);
    console.log(`Next: node scripts/launcher-feed.mjs --dir ${options.dir}`);
    return;
  }

  if (!existsSync(path.join(root, "versions.json"))) {
    console.error(`launcher-feed: ${path.join(root, "versions.json")} is missing.`);
    console.error("Run with --fixtures first, or point --dir at your feed directory.");
    process.exitCode = 1;
    return;
  }

  const server = createServer(async (request, response) => {
    const method = request.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${HOST}`);
    const target = resolveInside(root, url.pathname);
    if (!target) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden\n");
      return;
    }

    const filePath = target;
    let info;
    try {
      info = await stat(filePath);
      if (!info.isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": String(info.size),
      "Cache-Control": "no-store",
    });
    if (method === "HEAD") {
      response.end();
    } else {
      createReadStream(filePath)
        .on("error", () => response.destroy())
        .pipe(response);
    }
    console.log(`${method} ${url.pathname} 200 ${info.size}`);
  });

  server.on("error", (error) => {
    console.error(`launcher-feed: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(options.port, HOST, () => {
    console.log(`Serving ${root}`);
    console.log(`Feed: http://${HOST}:${options.port}/versions.json`);
    console.log(
      `PowerShell: $env:GENTREE_LAUNCHER_FEED='http://${HOST}:${options.port}/versions.json'`,
    );
    console.log("Press Ctrl+C to stop.");
  });

  const stop = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(`launcher-feed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { writeFixtures, resolveInside, artifactName, syntheticInstaller, sha256 };
