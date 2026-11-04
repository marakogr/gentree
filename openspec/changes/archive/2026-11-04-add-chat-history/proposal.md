# Proposal

## Why

The chat currently lives only inside the open chat screen. Switching projects or restarting the app loses every conversation, so a user cannot return to an analysis, a set of sources or a proposed edit. The archive is local-only, and chat history is auxiliary data: it must not become part of the project format, backups or exports, and it must never leave the machine.

D6 (#28) chose app data over the project folder. The UI shape was accepted after checking the new UI kit contract.

## What Changes

- Add a project-scoped conversation store under the Tauri app data root, outside the project folder, backups, checksums, exports and merge. One JSONL file per conversation, rewritten atomically with a header line and one line per entry.
- Add `chat_history_list`, `chat_history_load`, `chat_history_save`, `chat_history_delete` and `chat_history_clear` IPC commands. The renderer passes the project id it captured; the backend verifies it equals the open project and rejects cross-project access.
- Persist the full entry state the screen owns: role, content, status, skills and tool calls with the already-truncated arguments and results. `chat_send` and `buildTranscript` stay unchanged; only the active conversation is sent to the provider.
- Add the conversation rail in the chat page: `PageShell` with `CollectionShell`, `DataTable` and the shared `Splitter`. The list shows the auto-title and updated date, highlights the active row, and offers per-row delete plus "Clear history" through kit `Dialog` confirmations.
- Derive the title from the first user message (whitespace-collapsed, 80 characters). Do not add a provider call or a rename surface in this change.
- Preserve the existing chat lifecycle: one active request, one confirmation card. Switching, starting a new chat, deleting the active conversation or clearing history while streaming asks for confirmation, stops the stream and saves the partial answer as cancelled.
- Enforce hard limits with explicit errors and no silent pruning: entries and bytes per conversation, conversations and bytes per project. A turn that would exceed a limit is blocked before the provider call; a terminal save that fails leaves the answer visible with a persistent "not saved" notice.
- Handle damaged files strictly: a bad header or entry makes loading fail with a stable code; the list still returns healthy conversations, marks the damaged item, and allows deleting it.
- Remove the project's history directory when the project is deleted. Do not change the project format, backups, checksums, export, merge or the search index.
- Add storage, command and UI tests, six-locale copy, and a documentation note about where history lives.

HITL: D6 is resolved (app data, explicit lifetime). The new IPC surface is part of this change. There is no project-format change, no new crate, no new external dependency and no new network egress. `ui-kit` and `ui-conformance` are followed, not modified.

## Capabilities

### New Capabilities

- `chat-history`: durable, project-scoped conversation history: storage layout, listing/loading/saving/deleting, auto-title, limits, corruption handling, privacy and project-deletion rules.

### Modified Capabilities

None.

## Impact

- `desktop/crates/storage`: new `chat_history` module; the crate already has `atomicwrites`, `serde_json`, `uuid` and `fs2`.
- `desktop/apps/desktop`: new `commands/chat_history.rs`, command registration, a `project_delete` cleanup hook and a cached app-data `chat/` directory.
- `desktop/ui`: API types and invoke wrappers; pure `features/chat/history.ts` and the serialized save queue; a `load` action in `stream.ts`; `ChatPage.tsx` and `chat.css` for the rail; six locales for chat copy and the new error codes.
- `docs/portable.md`: note that conversations live in app data, not in the project folder or its backups.
- Not affected: the project format, `ProjectStore` collections, backup/restore, `checksums.sha256`, export, merge, the search index, the `chat_send` contract and the `gentree-chat` transport crate.

New error codes: `CHAT_HISTORY_CORRUPTED` and `CHAT_HISTORY_LIMIT`. Existing `NOT_FOUND`, `PROJECT_NOT_FOUND`, `PROJECT_ISOLATION_VIOLATION`, `IO_ERROR` and `VALIDATION_ERROR` are reused.
