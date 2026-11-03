// Fetches public portraits for the Romanov demo from Wikipedia/Wikimedia and
// writes the media rows the app expects. Files already present are kept, so a
// second run is offline and byte-stable.
//
//   node scripts/fetch-romanov-portraits.mjs demo/romanov ru
//   node scripts/fetch-romanov-portraits.mjs demo/romanov-en en
//
// The portraits are 19th-century photographs in the public domain; the caption
// names the source.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const GIVEN = path.resolve(ROOT, process.argv[2] ?? "demo/romanov");
const OUT = fs.existsSync(path.join(GIVEN, "manifest.json"))
  ? GIVEN
  : (() => {
      const nested = fs
        .readdirSync(GIVEN, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(GIVEN, entry.name, "manifest.json")),
        );
      if (nested.length !== 1) {
        console.error(`portraits: cannot find the project inside ${GIVEN}`);
        process.exit(1);
      }
      return path.join(GIVEN, nested[0].name);
    })();
const LANG = process.argv[3] === "en" ? "en" : "ru";
const PROJECT_ID = path.basename(OUT);
const ROW_TIME = "2026-10-01T09:00:00Z";
const USER_AGENT =
  "Gentree-demo-portraits/1.0 (https://github.com/marakogr/gentree; synthetic demo assets)";

const TITLES = {
  1: "Александр II",
  2: "Мария Александровна (императрица)",
  3: "Александр III",
  4: "Мария Фёдоровна (императрица, жена Александра III)",
  5: "Николай II",
  6: "Александра Фёдоровна (императрица, жена Николая II)",
  7: "Ольга Николаевна (великая княжна)",
  8: "Татьяна Николаевна (великая княжна)",
  9: "Мария Николаевна (великая княжна)",
  10: "Анастасия Николаевна",
  11: "Алексей Николаевич",
  12: "Георгий Александрович (великий князь)",
  13: "Ксения Александровна",
  14: "Михаил Александрович (великий князь)",
  15: "Ольга Александровна",
  16: "Николай I",
  17: "Александра Фёдоровна (императрица, жена Николая I)",
};

const personId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const mediaId = (index) => `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageThumbnail(title) {
  const url =
    "https://ru.wikipedia.org/w/api.php?action=query&format=json&redirects=1" +
    "&prop=pageimages&piprop=thumbnail&pithumbsize=400&titles=" +
    encodeURIComponent(title);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`wikipedia ${response.status} for ${title}`);
  const payload = await response.json();
  const pages = Object.values(payload.query?.pages ?? {});
  return pages.find((item) => item.thumbnail) ?? null;
}

async function searchTitles(query) {
  const url =
    "https://ru.wikipedia.org/w/api.php?action=query&format=json&list=search" +
    "&srlimit=5&srsearch=" +
    encodeURIComponent(query);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`wikipedia search ${response.status} for ${query}`);
  const payload = await response.json();
  return (payload.query?.search ?? []).map((item) => item.title);
}

async function thumbnail(title) {
  const direct = await pageThumbnail(title);
  if (direct) return { source: direct.thumbnail.source, page: direct.title };
  // Some disambiguated titles differ from the article title; fall back to search.
  for (const candidate of await searchTitles(title)) {
    const page = await pageThumbnail(candidate);
    if (page) return { source: page.thumbnail.source, page: page.title };
  }
  throw new Error(`no thumbnail for ${title}`);
}

async function download(source, target) {
  const response = await fetch(source, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`image ${response.status} for ${source}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, bytes);
  return bytes;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function contentHash(root) {
  const hasher = crypto.createHash("sha256");
  const schema = Buffer.alloc(4);
  schema.writeUInt32LE(1);
  hasher.update(schema);
  for (const file of [
    "persons.jsonl",
    "relationships.jsonl",
    "events.jsonl",
    "sources.jsonl",
    "citations.jsonl",
    "media.jsonl",
  ]) {
    const full = path.join(root, file);
    const bytes = fs.existsSync(full) ? fs.readFileSync(full) : Buffer.alloc(0);
    const lines = bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
    const lineBytes = Buffer.alloc(8);
    lineBytes.writeBigUInt64LE(BigInt(lines));
    hasher.update(Buffer.from(file, "utf8"));
    hasher.update(lineBytes);
    hasher.update(crypto.createHash("sha256").update(bytes).digest());
  }
  return `sha256:${hasher.digest("hex")}`;
}

const mediaDir = path.join(OUT, "media");
fs.mkdirSync(mediaDir, { recursive: true });

const rows = [];
let index = 0;
for (const [person, title] of Object.entries(TITLES)) {
  index += 1;
  const fileName = `${personId(Number(person))}.jpg`;
  // The app resolves media under a checksum-sharded folder: media/<first two
  // hex characters>/<fileName>.
  let bytes = null;
  for (const shard of fs.readdirSync(mediaDir)) {
    const candidate = path.join(mediaDir, shard, fileName);
    if (shard.length === 2 && fs.existsSync(candidate)) bytes = fs.readFileSync(candidate);
  }
  if (bytes === null) {
    const image = await thumbnail(title);
    console.log(`fetch ${person} ${title} → ${image.page}`);
    const temporary = path.join(mediaDir, fileName);
    bytes = await download(image.source, temporary);
    await sleep(400);
  }
  const checksum = sha256(bytes);
  const shardDir = path.join(mediaDir, checksum.slice(0, 2));
  fs.mkdirSync(shardDir, { recursive: true });
  fs.writeFileSync(path.join(shardDir, fileName), bytes);
  fs.rmSync(path.join(mediaDir, fileName), { force: true });
  rows.push({
    schema: 1,
    id: mediaId(index),
    createdAt: ROW_TIME,
    updatedAt: ROW_TIME,
    data: {
      id: mediaId(index),
      fileName,
      mimeType: "image/jpeg",
      checksum,
      caption:
        LANG === "en"
          ? "Portrait from Wikimedia Commons (public domain)."
          : "Портрет из Wikimedia Commons (общественное достояние).",
      sourceId: null,
      personId: personId(Number(person)),
      primary: true,
    },
  });
}

const text = rows.map((row) => JSON.stringify(row)).join("\n");
fs.writeFileSync(path.join(OUT, "media.jsonl"), `${text}\n`, "utf8");

const manifestPath = path.join(OUT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.counts.media = rows.length;
manifest.contentHash = contentHash(OUT);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`portraits: ${rows.length} in ${OUT} (${PROJECT_ID})`);
