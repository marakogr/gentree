---
type: architecture
title: Tauri shell, IPC commands and app state
description: How the Tauri 2 app owns the open project, exposes typed commands to React, enforces concurrency and error contracts, and what it logs.
tags: [tauri, ipc, state, errors, logging]
sources:
  - id: openwiki-source-67a1e2ef1edca9d9bcf4a5fe
    resource: repo://desktop/apps/desktop/capabilities/default.json
  - id: openwiki-source-18f3f410cbe1638e61f978e4
    resource: repo://desktop/apps/desktop/src/commands/chat.rs
  - id: openwiki-source-b9357914b0833478bb89f27f
    resource: repo://desktop/apps/desktop/src/commands/event.rs
  - id: openwiki-source-7d68a90bb68afdbad43e2741
    resource: repo://desktop/apps/desktop/src/commands/mod.rs
  - id: openwiki-source-56a42ce8a8be0e685e7eea83
    resource: repo://desktop/apps/desktop/src/logging.rs
  - id: openwiki-source-a84e5d6f68ad36850840a35c
    resource: repo://desktop/apps/desktop/src/main.rs
  - id: openwiki-source-9b01955ee85f420462cdb219
    resource: repo://desktop/apps/desktop/tauri.conf.json
  - id: openwiki-source-652b594f0a99d5c5858f82f4
    resource: repo://desktop/crates/core/src/validation.rs
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# Tauri shell, IPC commands and app state

`desktop/apps/desktop` is the composition root and the only place where the domain, storage, search, import and chat layers meet. The React UI never calls HTTP APIs and never touches the filesystem: every data path is a `#[tauri::command]` invocation through `@tauri-apps/api/core`.

## Process and window

The app runs a single window labeled `main` (1200×800, minimum 960×600) with title `Gentree` and identifier `com.gentree.desktop`. CSP is disabled in the webview configuration, and the asset protocol is enabled with a static `$APPDATA/**` scope; at runtime `project_open` narrows that scope to the open project's `media/` directory so a project stored elsewhere still renders images without exposing the rest of the disk.

The capability set is minimal: `core:default` and `dialog:default` only. There is no shell, filesystem or HTTP plugin, so the renderer cannot bypass commands.

## Managed state

Four pieces of state are registered with Tauri:

| State | Contents | Shared with |
| --- | --- | --- |
| `AppState` | `Arc<Mutex<Option<ProjectStore>>>`, cached `projects` and `backups` directories | Tauri commands and the chat tool backend |
| `Mutex<ConfigState>` | layered `AppConfig`, resolved paths, load warnings | settings commands and `chat_send` |
| `ChatState` | in-flight cancel tokens and confirmation senders | `chat_send`, `chat_cancel`, `chat_confirm` |
| `UpdateState` | the last updater status and an in-flight check/install guard | `update_status`, `update_check`, `update_install` |

The `Arc` around the project store is the important part: the chat builds its `AppProjectAccess` over the same mutex, so a tool call sees exactly the project, backups and exports the commands see. There is one writable store per process; opening another project replaces it.

## One project at a time

- `project_open` opens the folder writable (taking the `.lock`), runs a one-time repair that backfills the second spouse into legacy marriage events, allows the media asset scope, and stores the new `ProjectStore`.
- `project_close` writes a backup, applies the `BACKUP_KEEP = 10` retention policy, and drops the store, releasing the lock.
- `project_delete` refuses while the project is open (`PROJECT_LOCKED` with `reason=open`) and moves the folder to `projects/.trash`.
- `project_backup` returns the absolute archive path so the UI can show it and hand it back to `project_backup_reveal`, which treats the renderer-supplied path as untrusted: it must be an absolute path, contain no `..`, end in `.gentree.zip`, and live directly in one project folder under the backups root.

## Command modules

`commands/mod.rs` re-exports one module per area: `chat`, `event`, `export`, `geocode`, `graph`, `import`, `media`, `merge`, `path`, `person`, `relationship`, `search`, `timeline`. The graph module exposes `graph_ancestors`, `graph_descendants` and `graph_kinship`; `merge` exposes the preview/apply pair. Project lifecycle, validation, settings, the opt-in updater and the legacy `person_add` live in `main.rs`. The invoke handler in `main` is the single registry; adding a command means adding it there as well.

Shared helpers in `commands/mod.rs` define the IPC contract used everywhere:

- `with_store` runs a closure on the open project or fails with `PROJECT_NOT_FOUND`;
- `Versioned<T>` pairs an entity with its optimistic-concurrency token;
- `Page<T>` carries `total` for the filtered set, not just the page;
- `require_version` turns a mismatched token into `STALE_WRITE`;
- `parse_uuid` and `parse_date_bound` report validation errors on the named field.

## Write guards

Two commands enforce rules that are not expressible as a single-row validation:

- `event_create` and `event_update` call `ensure_single_life_event`; a second `BIRTH` or `DEATH` for the same person fails with `LIFE_EVENT_ALREADY_EXISTS`, while editing an existing birth/death (same person and type) stays allowed even if old data already has duplicates. The same guard is applied by the chat tool backend's `create_event`/`update_event`.
- `merge_apply` validates the merged project and returns `MERGE_CONFLICT` when validation reports any error; the half-written folder is discarded.

## Error contract

Rust returns `AppError` values with stable codes (`PROJECT_NOT_FOUND`, `PROJECT_LOCKED`, `VALIDATION_ERROR`, `STALE_WRITE`, `NOT_FOUND`, `PROJECT_CORRUPTED`, `IO_ERROR`, `CHAT_UNAVAILABLE`, `LIFE_EVENT_ALREADY_EXISTS`, `MERGE_CONFLICT`, …) plus parameters such as `field`, `rule`, `id`, `reason` or `eventType`. Commands never return localized prose; the UI maps the code and parameters to a translated message. The same constructors are reused by the chat tool layer so IPC and tool errors stay consistent.

Serialization is camelCase (`#[serde(rename_all = "camelCase")]`), which is why the TypeScript types in `desktop/ui/src/api/types.ts` mirror Rust structs directly.

## Settings

`settings.rs` exposes get, update, reload, locale and open-path commands. Configuration is layered and reloadable at runtime; updates are validated before they are written. Path commands go through the same `~`-expansion and absolute-path rules as the config crate. The chat key is *not* part of the settings payload — settings only carry the environment variable name.

## Logging

There is no console in a release build, so `logging::init` creates `<app data>/logs/gentree.log` and appends timestamped `LEVEL target: message` lines. The log is deliberately metadata-only: request ids, error codes, tool names, durations and byte sizes. Prompts, answers, person data, tool arguments, tool results and the API key are never written.

## Related pages

- [Workspace layout and crate dependencies](../architecture/workspace.md)
- [Project merge: preview, decisions and apply](../architecture/project-merge.md)
- [React UI structure and localization](ui.md)
- [Chat assistant and in-process tools](../chat/assistant.md)
- [People, events and validation](../domain/persons-and-events.md)
