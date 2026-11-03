---
type: architecture
title: Workspace layout and crate dependencies
description: The Cargo workspace behind Gentree Desktop, the responsibility of each crate, and why dependencies flow toward the pure domain layer.
tags: [architecture, cargo, layering, tauri]
sources:
  - id: openwiki-source-a84e5d6f68ad36850840a35c
    resource: repo://desktop/apps/desktop/src/main.rs
  - id: openwiki-source-7b3e5a1e29cfa85bbcf108de
    resource: repo://desktop/apps/desktop/src/project_access.rs
  - id: openwiki-source-92ee3a60a9826201e8ce6fa7
    resource: repo://desktop/Cargo.toml
  - id: openwiki-source-80679aaf0599ba71766b39e1
    resource: repo://desktop/crates/chat/src/lib.rs
  - id: openwiki-source-f94550accafd0b0e30661f1d
    resource: repo://desktop/crates/config/src/lib.rs
  - id: openwiki-source-732a801ee77fe42202c01a76
    resource: repo://desktop/crates/config/src/paths.rs
  - id: openwiki-source-9828fecd86edceab42891b1a
    resource: repo://desktop/crates/core/Cargo.toml
  - id: openwiki-source-92e08d93ca389e483dc97cd3
    resource: repo://desktop/crates/core/src/lib.rs
  - id: openwiki-source-72e9b1afd93e83913dec856a
    resource: repo://desktop/crates/core/src/merge.rs
  - id: openwiki-source-9dc3c3db583f6da6732efd92
    resource: repo://desktop/crates/import/Cargo.toml
  - id: openwiki-source-aacc0a305f4aff7538402ef8
    resource: repo://desktop/crates/import/src/lib.rs
  - id: openwiki-source-46b35f02f1fd5983e0147010
    resource: repo://desktop/crates/mcp/Cargo.toml
  - id: openwiki-source-81407da038de9b538fed6647
    resource: repo://desktop/crates/mcp/src/lib.rs
  - id: openwiki-source-1a34dda69247809be4a494e4
    resource: repo://desktop/crates/search/src/lib.rs
  - id: openwiki-source-e4274b099ca26e5b8d147625
    resource: repo://desktop/crates/storage/Cargo.toml
  - id: openwiki-source-ba67a2844f3cdb93304b3fae
    resource: repo://desktop/crates/storage/src/lib.rs
generated: { by: "opencode", at: "2026-11-03T10:50:52.373Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-03T10:50:52.373Z
---

# Workspace layout and crate dependencies

Gentree Desktop is a single Cargo workspace under `desktop/`, with the React front end in `desktop/ui`, the main Tauri 2 shell in `desktop/apps/desktop` and the installer/updater app in `desktop/apps/launcher`. The split is horizontal by responsibility rather than by feature: the domain model owns the rules, adapters own the world, and the apps own wiring.

## The dependency rule

Everything points at `gentree-core`, and `gentree-core` depends on no other workspace crate. This is what keeps the family rules testable without a filesystem, a webview or a network. `core` pulls only `serde`, `serde_json`, `uuid`, `time` and `thiserror`; it has no I/O, no Tauri, no HTTP and no localization.

The one deliberate exception is `gentree-import`, which depends on `gentree-storage` to emit and consume the documented backup/exchange layout. That edge is documented in its `Cargo.toml` and is why import tests can build real project bundles.

## Crates

| Crate | Owns | Key dependencies |
| --- | --- | --- |
| `gentree-core` | persons, names, events, sources, citations, media metadata, relationships, dates, ancestor/descendant graphs, kinship, merge, validation, project manifest | serde, uuid, time, thiserror |
| `gentree-storage` | project folder layout, JSONL envelopes, atomic writes, lock, checksums, media files, backup/restore | core, sha2, fs2, atomicwrites, zip, walkdir |
| `gentree-search` | derived Tantivy index, analyzer, prefix matching, grouped hits, snippets | core, tantivy, rust-stemmers |
| `gentree-import` | AT5 read-only import, GEDCOM 5.5.1 and 7.0 read/write, `.gentree.json`/`.gentree.zip` exchange, AT5/GEDCOM export archives, dedupe | core, storage, rusqlite, ged_io, zip |
| `gentree-config` | layered YAML/JSON configuration, defaults, `~` expansion, validation | core, serde_norway, directories |
| `gentree-chat` | OpenAI-compatible transport, SSE streaming, cancellation, prompt and skill assembly, tool-call types | core, reqwest |
| `gentree-mcp` | chat tool catalogue, DTOs, the `ProjectAccess` seam, in-memory test double | core, rmcp (types only), schemars, tokio |
| `gentree-desktop` | Tauri app: commands, state, settings, logging, project access implementation | every crate above, tauri 2 |

## Domain layer

`core` exports the vocabulary the rest of the workspace uses: `DateValue` and its precision/qualifier types, `Person`/`Name`/`ExternalId`, `Event` and `CitationTarget`, `Relationship` and `RelationshipSet`, `AncestorGraph`/`DescendantGraph`, `KinshipDescriptor`, `PathResult`, the merge types (`MergePreview`, `MergeOutput`, `PersonDecision`, `EventDecision`), `ensure_single_life_event`, `Manifest`, `AppError` and `ValidationReport`. Because these are plain data types with validation methods, they serialize identically into the project files and into the IPC boundary.

`now_rfc3339` is the single clock helper for manifest and JSONL envelopes; it always produces UTC.

## Storage layer

`ProjectStore` is the only component that touches a project folder. It owns the six JSONL collections, the manifest, the media tree, the OS lock and backups. Nothing above it writes files directly. See [Project folder format and write discipline](project-format.md).

## Derived data

`gentree-search` builds a Tantivy index from project content. The index is not part of the project folder: the caller passes an index directory (`<index_dir>/<projectId>`), and the index records the project's `schemaVersion` and `contentHash` in `index-meta.json`. A stale index is rebuilt before searching, so losing it costs time, not data.

## Import and export

`gentree-import` is the adapter family for foreign formats:

- `at5` opens the SQLite file read-only and recognizes either the EAV export tables (`ValuesStr`, `ValuesDates`, `EventDetails`) or a simplified person table;
- `gedcom` parses and writes GEDCOM 5.5.1 and 7.0 through `ged_io`;
- `exchange` handles `.gentree.json` (no media bytes) and `.gentree.zip` (full project in the backup layout);
- `export` writes AT5/GEDCOM archives with a sibling `.files` folder;
- `dedupe` holds idempotency helpers used by re-import;
- `report` defines the import report that lists everything not understood.

## Configuration

`gentree-config` merges defaults, a global file, a project file, `GENTREE_*` environment variables and (future) CLI arguments. Unknown keys become warnings; invalid values become `CONFIG_INVALID` while the caller keeps defaults. Paths are `~`-expanded and must be absolute. The chat section stores the *name* of the environment variable holding the API key (`chat.api_key_env`), never the key itself.

## Chat and tools

`gentree-chat` is transport-only: it knows how to call `POST {base_url}/chat/completions`, stream deltas and map failures to `ChatError`. It never executes a tool and never decides which tools exist. Logging is metadata-only — endpoint, model, counts, status, duration and error kind.

`gentree-mcp` is deliberately **not** an MCP server. It keeps the tool catalogue as `rmcp` route definitions, plus the `ProjectAccess` trait that the desktop implements over the same store the Tauri commands use. The crate has no filesystem, Tauri or storage dependency, so tool behavior can be exercised with `FakeProjectAccess` and synthetic data. The desktop implementation applies the same domain guard as the commands: `create_event` and `update_event` refuse a second birth or death through `ensure_single_life_event`, so a chat write cannot bypass the rule.

## Desktop shell

`gentree-desktop` is the composition root. It constructs the `ProjectStore`, keeps it in `Arc<Mutex<Option<ProjectStore>>>` so the Tauri commands and the chat tool backend share one open project, implements `ProjectAccess` on top, registers fifty-plus `#[tauri::command]` handlers (projects, persons, graph ancestors/descendants/kinship, path, events, geocode, media, timeline, relationships, import, merge, search, chat, settings), initializes logging and settings, and runs the webview.

The shell also carries platform glue: an asset-protocol scope narrowed to the open project's `media/` folder, a one-time marriage-participant repair for old projects, Windows-specific registry lookups behind `cfg(windows)`, and file-manager reveal helpers.

`gentree-launcher` is a separate Tauri app that owns no archive data. It reads a JSON version feed, downloads and verifies an installer, runs it and can launch the installed app; it shares the workspace lint and version settings but not the project store.

## Front end

`desktop/ui` is a separate npm package (React + Vite + Tailwind) built into the Tauri bundle. It talks to Rust only through the generated `invoke` wrappers in `src/api/client.ts`, so IPC types are the contract between the two halves. Feature folders under `src/features` mirror product areas (persons, events, timeline, graph, path, search, import, projects, settings, chat), and shared UI primitives live in `src/components/ui`.

## Build constraints

The workspace pins `rust-version = "1.88"`, uses edition 2021, sets `unsafe_code = "forbid"` for every crate and warns on all Clippy lints. The pinned toolchain lives in `desktop/rust-toolchain.toml`. Version `0.4.0` is shared by every crate through `[workspace.package]`.

## Related pages

- [Tauri shell, IPC commands and app state](../desktop/ipc-and-state.md)
- [Project merge: preview, decisions and apply](project-merge.md)
- [Relationships, graph invariants and kinship](../domain/relationships-and-kinship.md)
- [Gentree Desktop quickstart](../quickstart.md)
