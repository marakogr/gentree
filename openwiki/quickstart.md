---
type: guide
title: Gentree Desktop quickstart
description: What this repository builds, how the two halves fit together, which page to read for a given task, and the invariants that must not be broken.
tags: [quickstart, orientation, navigation]
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-405aaedc8bb3441099244155
    resource: repo://desktop/apps/desktop/src/commands/merge.rs
  - id: openwiki-source-652b594f0a99d5c5858f82f4
    resource: repo://desktop/crates/core/src/validation.rs
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "opencode", at: "2026-11-03T10:50:52.373Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-03T10:50:52.373Z
---

# Gentree Desktop quickstart

Gentree Desktop is a local family-archive application: one user, one project folder on disk, no server, accounts, telemetry or external database. It is built with Rust + Tauri 2 on the back end and React + Vite + Tailwind on the front end; Tantivy provides full-text search, `rusqlite` reads legacy AT5 files, and an OpenAI-compatible chat with in-process tools sits on top.

The project folder is the source of truth. Everything else — the search index, previews, chat answers — is derived and rebuildable.

## Orientation

```
desktop/
  Cargo.toml            Rust workspace
  apps/desktop/         Tauri shell, IPC commands, app state
  apps/launcher/        installer/updater app with its own version feed
  crates/
    core/               pure domain: persons, events, relations, dates, kinship
    storage/            project folder: manifest, JSONL, media, lock, backups
    search/             Tantivy index (derived, outside the project)
    import/             AT5, GEDCOM, JSON/ZIP, export archives
    config/             layered config and GENTREE_* env
    chat/               OpenAI-compatible transport, prompt, embedded skills
    mcp/                in-process tool catalogue and ProjectAccess seam
  ui/                   React UI (feature folders, i18n, Fluent UI)
Makefile                the only build/test entry point
```

## Read this for the task

| Task | Page |
| --- | --- |
| Understand the layers and why they depend the way they do | [Workspace layout and crate dependencies](architecture/workspace.md) |
| Change storage, manifest, checksums, locking or backups | [Project folder format and write discipline](architecture/project-format.md) |
| Merge two projects into a new one | [Project merge: preview, decisions and apply](architecture/project-merge.md) |
| Touch dates, filters or the timeline | [Date values, precision and qualifiers](domain/dates.md) |
| Change persons, events, participants or deletion | [People, events and validation](domain/persons-and-events.md) |
| Change place points, the Map tab, tiles or historical names | [Event places, coordinates and the map](domain/places-and-map.md) |
| Change relations, the tree, paths or kinship labels | [Relationships, graph invariants and kinship](domain/relationships-and-kinship.md) |
| Work on AT5 import or import reports | [AT5 import pipeline](import/at5.md) |
| Work on GEDCOM, JSON/ZIP exchange or export | [GEDCOM and AT5 export/interchange](import/interchange.md) |
| Change search behavior or indexing | [Search index and retrieval](search/engine.md) |
| Add or change a Tauri command | [Tauri shell, IPC commands and app state](desktop/ipc-and-state.md) |
| Change a screen, navigation or a translation | [React UI structure and localization](desktop/ui.md) |
| Change chat prompts, tools, streaming or the confirm card | [Chat assistant and in-process tools](chat/assistant.md) |
| Find the test that pins a behavior | [Contract test map](testing/contracts.md) |
| Build, run gates, ship installers or the portable archive | [Build, quality gates and release](operations/build-test-release.md) |

## Invariants to keep in mind

- **No fabricated data.** Unknown dates stay `UNKNOWN` with their original text; no fake timestamps, no guessed day.
- **Explicit relations only.** `PARENT_CHILD`, `ADOPTIVE_PARENT_CHILD`, `SPOUSE`, `PARTNER`; `person_id` is the parent. Siblings are derived, never stored. No self-links, duplicates or cycles.
- **One birth, one death.** Creating a second `BIRTH`/`DEATH` for a person is refused by the write commands (`LIFE_EVENT_ALREADY_EXISTS`); imports and merges may still carry legacy duplicates, which validation reports as a warning.
- **No destructive cascades.** Deleting a person keeps events that still have other participants; unlinking media never deletes the file.
- **Merge writes a new project.** Both sources are opened read-only, the result is validated, and the sources are never modified.
- **One writer.** The project folder has one writable `ProjectStore` at a time, guarded by an OS lock; writes are atomic and the manifest is written last.
- **Import is idempotent and honest.** Re-import never duplicates and never silently overwrites manual edits; everything unparsed is reported.
- **Tools run in process.** No network MCP server, no chat traffic before a provider is configured, no secrets or project data in logs.
- **All UI strings live in i18n dictionaries**, and no Cyrillic appears outside them.

`AGENTS.md` is the contract for how to work here: invariants first, then code and contract tests, then OpenSpec specs (when present), then current documentation under `docs/` and `desktop/docs/`, then README. If code and an invariant or contract test disagree, stop and ask instead of silently changing either side.

## First commands

```powershell
make setup      # Rust toolchain, UI deps, git hooks
make check      # fmt, clippy, Rust tests, UI typecheck/test/build/i18n
make dev        # Vite on 1420 + Tauri window
make run        # release exe and launch it
```

Details, Windows/macOS notes and the `cargo build` pitfall are in [Build, quality gates and release](operations/build-test-release.md).

## Related pages

- [Workspace layout and crate dependencies](architecture/workspace.md)
- [Project merge: preview, decisions and apply](architecture/project-merge.md)
- [React UI structure and localization](desktop/ui.md)
- [Build, quality gates and release](operations/build-test-release.md)
