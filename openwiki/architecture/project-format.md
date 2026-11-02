---
type: architecture
title: Project folder format and write discipline
description: How a Gentree project is laid out on disk, how the manifest and content hash are maintained, which atomicity, locking and backup rules protect the folder, and how a merge writes a new project without touching its sources.
tags: [storage, project-format, atomic-writes, backups, media]
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
sources:
  - id: openwiki-source-405aaedc8bb3441099244155
    resource: repo://desktop/apps/desktop/src/commands/merge.rs
  - id: openwiki-source-c4a3d3efa573f4ccf9383021
    resource: repo://desktop/crates/core/src/geo.rs
  - id: openwiki-source-c635bd74bf6d9595e09a95db
    resource: repo://desktop/crates/core/src/project.rs
  - id: openwiki-source-2ceb2cf109727ad6a4699cb4
    resource: repo://desktop/crates/core/src/record.rs
  - id: openwiki-source-ba67a2844f3cdb93304b3fae
    resource: repo://desktop/crates/storage/src/lib.rs
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
---

# Project folder format and write discipline

A Gentree project is a plain folder owned by the user. There is no server and no database: the folder is the source of truth, and every read or write goes through `gentree_storage::ProjectStore`. The format is versioned, self-checksummed and written with the assumption that the process may die at any moment.

## Folder layout

Each project lives under `<app-data>/projects/<projectId>/`, where `projectId` is a UUID v7. The application data root is `%APPDATA%\Gentree` on Windows and `~/Library/Application Support/Gentree` on macOS, with `projects/`, `backups/`, `indexes/` and `config.yaml` below it (`desktop/crates/config/src/paths.rs`).

A project folder contains:

| Path | Purpose |
| --- | --- |
| `manifest.json` | identity, versions, counters, home person, content hash |
| `persons.jsonl` | people |
| `relationships.jsonl` | explicit relationship edges |
| `events.jsonl` | shared events |
| `sources.jsonl` | sources |
| `citations.jsonl` | citations linking sources to records |
| `media.jsonl` | media metadata rows |
| `media/<sha256[..2]>/<file>` | media bytes, content-addressed |
| `.lock` | OS lock taken by writable sessions |

The six JSONL names are constants in `desktop/crates/storage/src/lib.rs` (`PERSON_FILE` … `MEDIA_FILE`) and are the only collections accepted by the per-entity concurrency helpers. `checksums.sha256` is not a project file: it is generated inside backups only.

## Manifest and content hash

`Manifest` (`desktop/crates/core/src/project.rs`) stores `formatVersion`, `schemaVersion`, `projectId`, the display name, timestamps, the app version, an optional `homePersonId`, a `counts` snapshot and `contentHash`. The schema version stays at `1`; the format version has grown with optional row fields: `2` added type-specific event details, `3` the `eventId` link on media rows, `4` the confirmed place point on an event and `5` the Wikidata place source. All of those fields are optional, so the first successful mutation stamps the current version without rewriting every row. Opening a folder whose `formatVersion` is newer than the running app fails with `FORMAT_VERSION_UNSUPPORTED` instead of guessing.

`contentHash` is a sha256 over the schema version and, for each data file, the file name, its line count and the sha256 of its content; the result is prefixed with `sha256:` (`compute_content_hash`). It is a drift detector, not a per-row integrity guarantee. The `counts` block is a hint: `ProjectStore::open` and `counts()` recount the JSONL files on every open.

`validate_layout` never writes. It reports, in a deterministic order, a missing or unreadable manifest, an unsupported format version, missing or unreadable JSONL files, count mismatches and a stale `contentHash`. The resulting `RepairStatus` is computed on demand and is deliberately not persisted.

## The write path

All collection writes follow the same sequence in `save_collection`:

1. refuse to write unless the store holds the exclusive lock;
2. validate every entity (`Person`, `Event`, `Source`, `Citation`, relationship-set invariants for `relationships.jsonl`, file-name checks for media);
3. rebuild every JSONL line as a `Row` envelope, keeping the original `createdAt` and, when the entity payload is unchanged, the original `updatedAt`;
4. serialize the whole collection and write it through `write_bytes_atomic` — a temporary file, `sync_all`, then atomic rename.

Preserving `updatedAt` for unchanged rows matters because the same token is used for optimistic concurrency: `collection_versions` exposes `id -> updatedAt` per file, and `check_version` turns a mismatch into `STALE_WRITE`. Rewriting an untouched row with a new timestamp would produce false conflicts for other writers.

After the data file is durable, `finish_mutation` refreshes `updatedAt`, recounts all six collections, recomputes `contentHash` and writes `manifest.json` last. A crash between the two steps leaves data ahead of the manifest, which `validate_layout` reports as a count or hash mismatch on the next open — never as silently corrupt data.

## Single-writer locking

A writable `ProjectStore` opens `<project>/.lock` and takes a non-blocking exclusive OS lock through `fs2`. A second writable open fails with `PROJECT_LOCKED`; the application therefore keeps at most one project open for writing. Reads are different: `ProjectStore::open(path, false)` skips the lock, so project listing, side-by-side read-only access and chat/MCP reads work even while another process holds the write lock.

The lock is released when the `ProjectStore` (and the file handle it owns) is dropped. On Windows, `delete_project` releases the lock before retrying the folder rename, because the OS refuses to rename a directory with an open handle inside it.

## Media files

Media bytes are stored at `media/<first two hex chars of sha256>/<fileName>`. The checksum is mandatory: `Media::validate` requires 64 hex characters, and `store_media_file` / `store_media_bytes` compute it from the bytes they copy. Names are restricted to plain file names — empty, dot-prefixed, separator-containing, `..`-containing or control-character names are rejected with a `fileName/pathTraversal` validation error.

`resolve_media_path` re-validates the checksum and then verifies that the joined path still lives directly under the project's `media/` directory; a malformed record becomes `NOT_FOUND`, never a path outside the project. Copies are atomic (temp file then rename), so an interrupted import cannot leave a truncated image.

Removing a media link removes only the `media.jsonl` row. Storage has no code path that deletes a file under `media/`, which keeps the product invariant that unlinking media never destroys the user's file.

## Backups, restore and deletion

`ProjectStore::backup` writes `<backups>/<projectId>/<timestamp>.gentree.zip` containing the manifest, every present data file, every file under `media/` and a generated `checksums.sha256` listing `sha256  relative/path` for each entry. The archive is built under a `.zip.tmp` name and renamed only after `ZipWriter::finish`, so a visible backup is a complete one.

`ProjectStore::restore` extracts into a hidden staging folder `.restore-<newId>` and then:

- rejects entries whose path escapes the project, archives over 2 GiB and archives with no files;
- recomputes every checksum declared in `checksums.sha256` and fails with `BACKUP_CHECKSUM_MISMATCH` on any missing file or mismatch;
- rewrites the manifest with a fresh project id, `createdAt` and `updatedAt`;
- renames the staging folder into `projects/<newId>` and opens it.

Restore never overwrites an existing project, because the target id is always new. `delete_project` is equally conservative: it locks the folder, moves it to `<trash>/<projectId>-<timestamp>` and leaves the bytes for a human. `prune_backups` removes old archives by lexicographic timestamp but always keeps the newest one, even when asked to keep zero.

## Merge writes a new project

A project merge never edits either source. `merge_apply_into` opens both folders read-only, computes the merged rows in memory, and then calls `ProjectStore::create(projects_dir, name)` for a brand-new UUID v7 folder; an empty or blank name falls back to `"<left name> + <right name>"`. Because the target id is always new, a merge can run while the sources are simply listed by the UI, and the sources keep their manifest, files and media untouched.

The output store is filled in a fixed order: persons, sources, media rows, events, relationships, citations. Media bytes are copied from the owning source before `save_media`, so a row never points at a file that was not stored; a missing source file drops the row with a `MEDIA_MISSING` warning instead of failing the whole merge. Citations that would point at a dropped media row are filtered out before they are written.

After all six collections are written, the new project is validated with the same `validate_project` used elsewhere. Any error (not a warning) returns `MERGE_CONFLICT` and the half-written folder is moved to `.trash` by `discard_project`; a visible merged project is therefore a validated one. The exclusive lock is released by dropping the store before the caller reopens the new project for writing.

## Failure behavior

- A folder with a missing, corrupt or newer `manifest.json` is skipped by `list_projects`; one broken project never hides healthy ones.
- Invalid JSONL rows fail with a line number, so a hand-edited file can be repaired surgically.
- All storage errors are stable codes (`PROJECT_NOT_FOUND`, `PROJECT_LOCKED`, `FORMAT_VERSION_UNSUPPORTED`, `STALE_WRITE`, `BACKUP_CHECKSUM_MISMATCH`, `IO_ERROR`) that the UI localizes.

## Related pages

- [People, events and validation](../domain/persons-and-events.md) for the entities stored in these files.
- [Event places, coordinates and the map](../domain/places-and-map.md) for the point stored on an event.
- [Project merge: preview, decisions and apply](project-merge.md) for the merge pipeline that writes a new project.
- [Build, quality gates and release](../operations/build-test-release.md) for the checks that exercise the storage contracts.
