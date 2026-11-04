# Design

## Context

See `proposal.md` for motivation and `specs/chat-history/spec.md` for the behavior contract.

The chat screen owns the transcript in React (`desktop/ui/src/features/chat/stream.ts`). `chat_send` receives completed `{role, content}` turns, prepends the system prompt and streams the answer back. The backend tool loop keeps its own per-request messages but nothing is persisted. `ChatPage` is keyed by `projectId`, so switching projects intentionally discards the transcript.

`ProjectStore` is the only writer of the project folder. Search indexes, logs, exports and the actual projects directory live under the Tauri application data root, keyed by project id. `ProjectStore::restore` assigns a fresh project id, and `project_delete` moves the folder to `.trash` rather than erasing it.

The UI kit contract (`openspec/specs/ui-kit/spec.md`, `openspec/specs/ui-conformance/spec.md`, `docs/agents/ui-kit.md`) requires a list screen with a detail pane to compose `PageShell`, `CollectionShell`, `DataTable`, `Splitter` and the shared `Dialog`; screens must not re-implement splitters, pagers or sort headers. `make ui-check` is the executable gate.

D6 (#28) selected app data over the project folder. The UI shape was accepted after the interactive preview.

## Goals / Non-Goals

**Goals:**

- Durable, project-scoped history outside the project format, backups, checksums, export and merge.
- Atomic, isolated files; a damaged conversation never hides healthy ones.
- Restore the full screen state, including statuses, skills and truncated tool details.
- Keep one active request and one confirmation card; switching while streaming is explicit.
- Enforce caps with explicit errors and no silent loss.
- Keep the UI kit and privacy contracts: no content in logs, no paths in errors, only the active conversation sent.
- Put the interaction logic in pure, tested modules.

**Non-Goals:**

- Changing the project format, `ProjectStore` collections, backups, export, merge or the search index.
- Changing `chat_send` or moving transcript construction into Rust.
- Automatic pruning, time-based expiry, encryption at rest or a secure wipe.
- Transcript windowing or summarization for long conversations (a separate change).
- An app-wide "clear all projects" action and orphan-history cleanup outside the app (separate).
- Cleaning up the remaining Fluent controls in `ChatPage` beyond the controls this change touches (separate kit-debt change).

## Decisions

### D1. App data, explicit lifetime

History lives under the Tauri application data root, beside `projects/`, `indexes/`, `logs/` and `exports/`, in a `chat/` directory keyed by project id. It is removed only by an explicit delete/clear or by project deletion. There is no time-based expiry and no automatic pruning.

Alternatives: inside the project folder (would change the project format and force exclusions in backup, export, merge and checksums; project deletion would leave history in `.trash`); last conversation only (does not provide a history); a SQLite database (heavier than the issue asks for and unnecessary for this size).

The live root is `app.path().app_data_dir()`, which is `%APPDATA%\com.gentree.desktop` on Windows and `~/Library/Application Support/com.gentree.desktop` on macOS. The `%APPDATA%\Gentree` string in `docs/portable.md` and the config defaults is a pre-existing mismatch; this change follows the root the app actually uses for projects and indexes and records the docs mismatch separately.

### D2. One atomically rewritten JSONL file per conversation

```
<app-data>/chat/<projectId>/<conversationId>.jsonl

line 1  header: schema, kind, id, projectId, title, createdAt, updatedAt
line 2+ entry:  id, role, content, status, skills, tools[]
```

Saving serializes the whole conversation in memory and writes it through the existing `atomicwrites` helper (temp file, `sync_all`, rename). The list reads only the first line of each file. Delete removes one file; clear removes the project's directory.

Alternatives: one `<projectId>.jsonl` for all conversations (every save rewrites all history, the list reads everything, and corruption has a wider blast radius); one file plus an index (two sources of truth to repair); append-only lines (deletion and clear need compaction and crash recovery). Per-conversation files keep the failure domain and save cost small.

### D3. Full entry state, with normalized statuses

Each entry stores `id`, `role` (`user` or `assistant`), `content`, `status`, `skills` and `tools`. Tool entries keep the name, status, duration and the arguments/result that the event emitter already truncates to 4,000 characters. The file does not store the system prompt, request ids, provider reasoning, usage or backend-only tool messages.

`done`, `error` and `cancelled` are persisted. `pending` and `streaming` are normalized to `cancelled` when saved or loaded, so a crash mid-answer cannot produce a permanently typing entry. The loaded assistant entries have no `requestId`, so a late event from an earlier request cannot match them. This is what keeps `buildTranscript` behavior unchanged: cancelled and errored pairs are visible but never sent.

Alternatives: messages and statuses only (smaller, but loses the tool and skill UI after restart); messages only (a cancelled partial answer would load as done and be re-sent, which is incorrect).

### D4. The UI owns the snapshot save

The UI saves the whole conversation at two boundaries:

- immediately after a send, before `chat_send`, so the question and auto-title exist and the cap is enforced before the provider is called;
- on the terminal `done`, `error` or `cancel` transition, so the final answer or cancelled state is stored.

Saves are serialized through a per-page promise chain. The send-time save is awaited; if it fails with `CHAT_HISTORY_LIMIT`, the send is aborted and the composer text is kept. A terminal save failure leaves the answer visible with a persistent notice; the next successful snapshot save rewrites the whole conversation and heals the missing answer. No delta writes and no token-by-token disk writes.

Alternatives: backend auto-save (the backend would have to reconstruct UI-only statuses, skills and tools, or split the writer; `buildTranscript` would move into Rust); append on every delta (expensive, still needs compaction and cancellation semantics).

### D5. Storage module in `gentree-storage`

Add `desktop/crates/storage/src/chat_history.rs` with a `ChatHistoryStore` that takes the chat root as a path. It owns file naming, UUID validation, header/entry parsing, atomic writes, title derivation, limits, list resilience and project cleanup. The desktop command layer resolves the app-data `chat/` directory and supplies the open project id.

`gentree-storage` already depends on `atomicwrites`, `serde_json`, `uuid` and `fs2`; no new crate or dependency direction is introduced. A new `chat` crate would add an architecture decision for a small module; keeping it in the UI/app crate would make the store harder to test outside Tauri. The transport-only `gentree-chat` crate stays untouched.

### D6. Commands take a project id and verify it

```
chat_history_list(projectId)                  -> { conversations, limits }
chat_history_load(projectId, conversationId)  -> conversation
chat_history_save(projectId, conversationId, entries) -> summary
chat_history_delete(projectId, conversationId) -> boolean
chat_history_clear(projectId)                 -> number
```

The renderer passes the project id it captured with the call. The backend rejects a request whose id is not the currently open project with `PROJECT_ISOLATION_VIOLATION`. This is deliberately not "the backend derives the id silently": a queued save can execute after a project switch, and without the guard it would resolve the new open project and write project A's conversation into project B. The UI also guards stale responses with a sequence ref. Conversation ids and project ids are parsed as UUIDs before any path join.

### D7. Limits are enforcement points, not UI suggestions

Constants in the store (tunable without a spec change):

```
400 entries / 8 MiB per conversation
200 conversations / 64 MiB per project
80 characters per derived title
4,000 characters per tool argument/result (already enforced by the event emitter)
```

The save validates before it creates a temp file, so a rejected save leaves the old file byte-for-byte intact. `list` returns the count limits so the UI can preempt a conversation entry cap or a project conversation cap. Byte caps are server-side. A limit error is `CHAT_HISTORY_LIMIT` with `params.scope` (`conversation` or `project`). Deleting a conversation or clearing history frees capacity; the system never prunes automatically.

### D8. Strict reads, resilient list

`load` is strict: a bad header, a bad entry line, a project-id mismatch, an unsupported newer schema or an id/filename mismatch fails with `CHAT_HISTORY_CORRUPTED` carrying `params.line` and `params.reason`. There is no partial transcript.

`list` is resilient: it reads only the first line of every `<uuid>.jsonl`; a bad header becomes a damaged item with the id from the filename, a null title and a file-mtime date; the rest of the list still returns. A damaged item can be deleted, which removes the file. Temp files and non-UUID names are ignored. Corruption errors never carry the absolute path; storage's `invalid_jsonl_row` is not reused because it includes `path.display()`.

Alternative: lenient entry parsing (salvages readable lines, but a later save would silently drop the bad lines and would need a repair/read-only flow). Strict is honest and matches atomic writes.

### D9. UI composition follows the kit

```
PageShell (title "Chat", count, New chat, Settings)
  CollectionShell
    toolbar:  Conversations (N)              [Clear history]
    children: DataTable
                Conversation (title + date)  [delete]
    detail:   active title
              status strip
              not-saved / limit banner
              feed (scrolls)
              composer
```

- `CollectionShell` owns the master-detail grid, the shared `Splitter` and the stacked breakpoint. Chat sets the list bounds to `{ defaultWidth: 32, min: 26, max: 44 }`; the shell default of 58% is for table-heavy screens.
- The list is a `DataTable` with one data column and an actions column. The title cell contains a `Caption1` date. The active row uses `aria-selected` and a token background; the row delete is a kit `IconButton` that stops propagation. The list is newest first; sorting and paging are out of scope. If added later, use `HeaderCell`/`SortIcon`/`Pager`, not local markup.
- At `<= 1100px` the shell stacks. The page sets `grid-template-rows: minmax(0, 30%) minmax(0, 1fr)` for the collection layout; both panes have `min-height: 0`, the list and feed scroll internally, and the composer stays visible.
- Delete and clear use one page-level kit `Dialog` (no nested modals); the dialog is busy during the IPC and closes on success. Per-row delete, clear and the active conversation's title are the only new visible controls.
- The page header keeps `New chat` and `Settings` as kit `IconButton`s; the old header delete disappears. The active conversation title lives in the detail header; the list row highlight identifies it in the rail.
- The composer stays on the existing Fluent `Textarea` because the kit has no textarea primitive. The touched header controls and the send/stop/suggestion buttons move to kit `Button`/`IconButton` where the wrapper supports them; remaining Fluent controls in `ChatPage` are pre-existing debt, not new debt.
- The splitter width is persisted through a small local preference (or session state if persistence is deferred); the pure geometry lives in the kit's `collectionLayout.ts`. The chat has no section-filter store to reuse.

Alternative: a history dialog picker (fully conformant, no splitter or stacked layout, but no persistent list and a less visible active conversation). The accepted UI is the collection rail.

### D10. One active request and a confirm-stop lifecycle

The UI keeps the existing single `activeRequestId` and single `update_person` confirmation. Switching conversations, starting a new chat, deleting the active conversation or clearing history while streaming opens a kit `Dialog`; on confirmation it dispatches `cancel`, saves the cancelled snapshot, calls `chat.cancel` and performs the action. A non-active deletion leaves the stream running. Late events for a stopped request are ignored by the reducer because the loaded entries have no `requestId`.

Delete and clear must not be undone by a queued terminal save. The save queue carries a per-conversation tombstone (or a generation/epoch): deleting a conversation or clearing history discards queued saves for the removed ids, so a cancelled answer cannot recreate a file after the wipe. The queue is serialized; a save for an older snapshot cannot land after a newer one.

### D11. Startup and no-project behavior

On mount, the UI loads the list and opens the most recently updated healthy conversation. If it is damaged, the next healthy one is tried; if none is healthy, the detail shows the empty state with the list. A new chat is an unsaved conversation until the first send. Without an open project, history commands are not called and chat remains ephemeral; there is no global bucket.

### D12. Error codes, logging and localization

New codes:

- `CHAT_HISTORY_CORRUPTED` — with `params.line` and `params.reason`;
- `CHAT_HISTORY_LIMIT` — with `params.scope`.

Existing `NOT_FOUND`, `PROJECT_NOT_FOUND`, `PROJECT_ISOLATION_VIOLATION`, `IO_ERROR` and `VALIDATION_ERROR` are reused. History logging records the operation, project id, conversation id, entry count, byte count and code; it never records content, titles, tool payloads or keys. IO failures are mapped to a static message, not the underlying path-bearing display. UI copy lives in all six locale files, not in shared components.

### D13. Pure modules and tests

Feature-local pure modules with vitest:

- `history.ts`: conversation sort, next selection after delete, limit preemption, `ChatEntry` ↔ history DTO mapping (status normalization, `requestId` null, running tools);
- `historyQueue.ts`: serialized saves, tombstones/epochs, `idle`;
- `stream.ts`: a `load` action that replaces messages, clears the active request and error, and ignores stale events.

Storage unit tests cover round-trip, header-only list, atomic rejection, limits, strict corruption (header and entry), delete one, clear, project deletion, UUID/path validation and no secrets/absolute paths. Command tests cover project-id validation and stale writes. Manual checks cover restart, switch, delete, clear, limits, corruption and the four style/theme combinations; `make ui-check` must pass with no new allowlist entries.

## Risks / Trade-offs

- **Queued save after a project switch** → the command's `projectId` check rejects it; the UI ignores stale responses. Tested with a stale save.
- **Delete/clear recreated by a terminal save** → tombstones/epochs in the save queue, plus tests for delete during streaming and clear during streaming.
- **Narrow layout pushes the composer** → page row split 30/70, internal scroll for list and feed, manual review at 960, 1000, 1200 and maximized; the collection shell still owns the breakpoint.
- **List width has no existing view store** → pass a local persisted preference or session state through `storedWidth`/`onCommitWidth`; the shell owns the geometry.
- **Long conversations exceed the model context** → history makes this more likely, but transcript windowing is a separate change; this change does not silently truncate or summarize.
- **App quit or project close mid-answer** → the send-time snapshot preserves the question; the in-flight answer may be lost. A close-time flush is a follow-up.
- **Windows file locks during project deletion** → history cleanup is best-effort; the project deletion still completes and the failure is logged as metadata. The normal path removes the directory.
- **Orphan history if a project folder is deleted outside the app** → out of scope; auto-pruning is dangerous with removable drives. A future explicit cleanup can address it.
- **Path-root documentation mismatch** → use the live Tauri app-data root; record the `%APPDATA%\Gentree` mismatch as a separate documentation/config issue.
- **History contains personal data** → app data, explicit clear/delete, no logs/agent context, no key, no content in errors. Encryption at rest and a secure wipe are explicit non-goals.
- **UI-kit debt** → new controls and the history UI use the kit; the existing composer `Textarea` and any untouched Fluent controls remain pre-existing debt. `make ui-check` must pass without new allowlist entries.
- **HITL** → D6 is resolved; the new IPC surface is recorded in the change and PR. No project-format change, new crate, external dependency or network egress.

## Migration Plan

This is additive and has no data migration.

1. Add `gentree-storage::chat_history` and its unit tests.
2. Add `commands/chat_history.rs`, register the commands, add the app-data `chat/` directory, and hook project deletion.
3. Add the UI API types/wrappers and the pure history/queue modules with tests; add the `load` reducer action.
4. Compose the rail in `ChatPage` with `PageShell`, `CollectionShell`, `DataTable` and `Splitter`; wire save/switch/delete/clear and the confirm-stop lifecycle.
5. Add the kit `Dialog` confirmations, the not-saved/limit banner, the damaged row, six-locale copy and error keys.
6. Update `docs/portable.md` for the history location and run `make ui-check`.
7. Run targeted storage/UI tests, then `make check`.

Rollback: remove the commands and UI wiring. Existing history files in app data are inert and can be removed with "Clear history" or by deleting the app-data `chat/` directory; no project file is touched.

## Open Questions

None blocking. Transcript windowing, app-wide history cleanup, encryption at rest and the path-root documentation mismatch are separate changes, recorded under Non-Goals and Risks.
