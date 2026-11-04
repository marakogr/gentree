# Tasks

## 1. Storage and error codes

- [x] 1.1 Add `CHAT_HISTORY_CORRUPTED` and `CHAT_HISTORY_LIMIT` to `desktop/crates/core/src/error.rs`; verify `cargo check -p gentree-core` succeeds and the codes are exported.
- [x] 1.2 Create `desktop/crates/storage/src/chat_history.rs` with the header, entry, tool-call and summary types, the camelCase JSONL envelope, the title derivation and the limit constants; verify a unit test serializes a header and an entry with the expected camelCase field names.
- [x] 1.3 Implement `list` as a header-only scan of `<uuid>.jsonl` files: newest first, ignore temp/non-UUID files, include damaged items with the filename id and a null title; verify unit tests cover ordering, healthy items and a damaged header.
- [x] 1.4 Implement `load` strictly: parse the header and every entry, verify the project id, the id/filename match and the schema, and return `CHAT_HISTORY_CORRUPTED` with `line` and `reason` on failure; verify unit tests cover a valid round-trip, a bad header and a bad entry.
- [x] 1.5 Implement `save` as a whole-conversation atomic rewrite: preserve `createdAt`, normalize `pending`/`streaming` to `cancelled`, derive the title from the first user entry, and reject over-limit saves before writing; verify unit tests cover create/update, title truncation, status normalization and an unchanged old file after a rejected save.
- [x] 1.6 Implement `delete`, `clear` and `delete_project` with project-scoped paths and idempotent missing-file handling; verify unit tests cover delete-one, clear-all, another project unaffected and a missing directory.
- [x] 1.7 Add tests for the entry, conversation-byte, conversation-count and project-byte limits, an unsupported newer schema, UUID/path traversal rejection, and the absence of absolute paths or content in error payloads; verify the chat-history storage tests pass.
- [x] 1.8 Document the module as app-local auxiliary storage in its Rust doc comments; verify the crate still builds without a new dependency.

## 2. Commands, project deletion and docs

- [x] 2.1 Add `desktop/apps/desktop/src/commands/chat_history.rs` with `list`, `load`, `save`, `delete` and `clear`; resolve the open project, require the renderer's `projectId` to match it, return `PROJECT_ISOLATION_VIOLATION` on a mismatch, and map IO failures to static path-free messages; verify unit tests cover a valid id, a stale id and a missing project.
- [x] 2.2 Add a cached app-data `chat/` directory to `AppState`, register the five commands in `main.rs`, and verify `cargo check -p gentree-desktop` succeeds.
- [x] 2.3 Hook history cleanup into `project_delete` after the project folder moves successfully; treat a cleanup failure as metadata-only and keep the project deletion successful; verify the normal path removes the directory and a simulated failure does not fail the deletion.
- [x] 2.4 Update `docs/portable.md` to say conversations live under the live app-data root, not the project folder or its backups; verify the documented location matches `app.path().app_data_dir()`.
- [x] 2.5 Add a command-level test for a queued save captured for project A that executes after project B is open; verify it fails with `PROJECT_ISOLATION_VIOLATION` and B's history is unchanged.

## 3. UI data layer

- [x] 3.1 Add the history DTOs to `desktop/ui/src/api/types.ts` and the `chatApi` wrappers in `desktop/ui/src/api/client.ts`; verify `npm --prefix desktop/ui run typecheck` succeeds.
- [x] 3.2 Add `desktop/ui/src/features/chat/history.ts` with pure conversation sort, next-selection-after-delete, limit preemption and `ChatEntry` ↔ history mapping (status normalization, null `requestId`, running tool normalization); verify the vitest cases cover each rule.
- [x] 3.3 Add `desktop/ui/src/features/chat/historyQueue.ts` with serialized saves, a tombstone/epoch for deleted conversations and `idle`; verify vitest covers ordering and a save discarded after delete/clear.
- [x] 3.4 Add the `load` action to `desktop/ui/src/features/chat/stream.ts` that replaces messages, clears `activeRequestId` and `error`, and leaves stale-request entries unmatched; verify the reducer tests cover load, switch isolation and a late event for the previous request.
- [x] 3.5 Add a pure helper for the startup choice (most recent healthy, next on damaged, empty when none) and its tests; verify the chosen id matches the list order.

## 4. Chat rail, lifecycle, copy and UI kit

- [x] 4.1 Compose the conversation rail in `ChatPage.tsx` with `PageShell`, `CollectionShell`, `DataTable` and the shared `Splitter`: toolbar with the count and clear action, active row, per-row delete, title/date cell, empty/loading/error states and a persisted list width; verify typecheck and a manual wide/narrow check at 1200 and 1000 px.
- [x] 4.2 Add the detail header with the active title and date, the status strip, the not-saved/limit banner and the damaged row; implement delete and clear through one page-level kit `Dialog` with a busy state; verify the dialogs open, cancel and confirm manually.
- [x] 4.3 Wire the lifecycle: startup list/load, new chat, switch with confirm-stop, delete/clear with confirm-stop, save at send and terminal transitions, abort the send on a send-time limit, show the terminal-save notice, preempt count limits and keep chat ephemeral without a project; verify each path manually against the spec scenarios.
- [x] 4.4 Move the touched chat controls (header New/Settings, send/stop, suggestions) to kit `Button`/`IconButton` and keep the existing Fluent `Textarea` for the composer; verify `npm --prefix desktop/ui run ui:kit -- --all-blocking` reports no new allowlist entries.
- [x] 4.5 Add the chat and error copy to all six locale files (`ru`, `en`, `uk`, `be`, `de`, `es`), including the two new error codes; verify `npm --prefix desktop/ui run i18n:check` succeeds.
- [ ] 4.6 Add the rail/list/detail/banner styles to `desktop/ui/src/features/chat/chat.css` using tokens, with the `<= 1100px` row split and internal scrolling; verify the layout at 960, 1000, 1200 and maximized in classic/swiss × light/dark.
- [x] 4.7 Run `make ui-check`; verify it passes with zero new violations, zero stale allowlist entries and the full UI test suite.

## 5. Integration verification

- [x] 5.1 Run `make check` and verify fmt, clippy, all Rust tests, the UI typecheck, tests, build, i18n and the UI kit gate pass.
- [x] 5.2 Walk the end-to-end flow manually: restart, switch, new chat, delete one, clear all, delete the project and open a project with no history; verify against the spec.
- [x] 5.3 Walk the failure flow manually: damaged header, damaged entry, entry cap, project cap, terminal save failure and the "not saved" notice; verify no silent loss and no path/content leak.
- [x] 5.4 Run `openspec validate add-chat-history` and verify the change and its spec are valid.
- [ ] 5.5 Record the D6 decision, the new IPC surface and the test evidence in the PR description; verify the PR body carries the HITL note.
