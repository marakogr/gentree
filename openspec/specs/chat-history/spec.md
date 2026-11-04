# chat-history Specification

## Purpose
Provides durable, project-scoped chat history so a user can return to earlier conversations without putting auxiliary data into the archive folder, its backups or its exports.

## Requirements

### Requirement: Project-scoped storage outside the project folder

The system SHALL store chat history under the application data directory, keyed by the open project's id, outside the project folder, project backups, checksums, export and merge. It SHALL use one JSONL file per conversation and SHALL rewrite that file atomically. It SHALL NOT add files or directories to the project format.

#### Scenario: Saving a conversation creates no project files

- **WHEN** a conversation is saved for an open project
- **THEN** the file lives under the application data chat directory for that project id
- **AND** the project folder, its manifest and its JSONL collections are unchanged

#### Scenario: Backups and exports exclude history

- **WHEN** a project backup or export is created
- **THEN** it contains no chat history
- **AND** the project still opens and validates without the history directory

#### Scenario: An interrupted save leaves the previous file intact

- **WHEN** writing a conversation fails or is interrupted
- **THEN** the previous file remains readable
- **AND** no partial row is visible on the next load

#### Scenario: Restoring a backup does not attach old history

- **WHEN** a project is restored from a backup
- **THEN** it receives a new project id
- **AND** the previous project's conversations are not attached to it

#### Scenario: Renaming a project keeps its history

- **WHEN** a project is renamed
- **THEN** its project id is unchanged
- **AND** its conversations remain available

### Requirement: Conversation list and active conversation

The system SHALL list conversations for the open project newest first, showing a title and updated time, and SHALL identify the active conversation. On startup it SHALL open the most recently updated healthy conversation, or an empty state when none exists. Without an open project, chat SHALL remain ephemeral and no history SHALL be listed or saved.

#### Scenario: Newest conversation comes first

- **WHEN** the history list is requested for a project with several conversations
- **THEN** the most recently updated conversation is first
- **AND** the active conversation is identified in the list

#### Scenario: Startup opens the most recent healthy conversation

- **WHEN** the application opens a project with history
- **THEN** the most recently updated healthy conversation is loaded
- **AND** if it is damaged, the next healthy conversation is tried
- **AND** if none is healthy, the empty state is shown with the list

#### Scenario: No project means no persistent history

- **WHEN** no project is open
- **THEN** the user can still chat in memory
- **AND** no conversation is listed or saved

### Requirement: Full conversation state survives restart

The system SHALL persist each entry's role, content, status, skills and tool-call details, including the already-truncated arguments and results. It SHALL preserve `done`, `error` and `cancelled` states; pending or streaming entries SHALL load as cancelled. Only user and assistant entries SHALL be stored; the system prompt, request identifiers and provider reasoning SHALL not be stored.

#### Scenario: Save and load round-trip

- **WHEN** a conversation with user and assistant entries is saved and loaded again
- **THEN** content, order, statuses, skills and tool-call details are preserved

#### Scenario: An interrupted answer loads as cancelled

- **WHEN** the application stops while an assistant entry is pending or streaming
- **THEN** the next load shows the question and a cancelled answer placeholder
- **AND** that incomplete pair is not sent to the provider on the next turn

#### Scenario: Cancelled and errored answers are not re-sent

- **WHEN** a conversation contains a cancelled or errored assistant entry
- **THEN** it remains visible in the transcript
- **AND** the next provider request contains only completed user/assistant pairs

#### Scenario: System and tool roles are not persisted

- **WHEN** a conversation is saved
- **THEN** the system prompt and backend-only tool messages are not stored

### Requirement: Auto-title from the first user message

The system SHALL derive a conversation title from the first user message by collapsing whitespace, truncating to 80 characters and adding an ellipsis when cut. The title SHALL be stable for the conversation and MUST NOT require a provider request. A conversation without a title SHALL display a localized untitled label.

#### Scenario: A long first message is truncated

- **WHEN** the first user message is longer than 80 characters
- **THEN** the stored title is at most 80 characters plus an ellipsis
- **AND** no provider request is made to create it

#### Scenario: A missing title falls back to localized copy

- **WHEN** a conversation has no stored title
- **THEN** the UI shows a localized "Untitled" label
- **AND** the stored content is not rewritten

### Requirement: Delete one conversation and clear history

The system SHALL delete exactly one conversation on request and SHALL clear all conversations for the open project on request. Both actions SHALL require explicit confirmation. Deleting or clearing SHALL NOT affect another project's history. After deleting the active conversation, the system SHALL select the next healthy conversation or an empty state.

#### Scenario: Deleting one conversation leaves the others

- **WHEN** the user deletes a conversation
- **THEN** only that conversation's file is removed
- **AND** the other conversations and their entries remain

#### Scenario: Clearing history is project-scoped

- **WHEN** the user clears the history of one project
- **THEN** all conversations for that project are removed
- **AND** another project's conversations remain

#### Scenario: Deleting the active conversation selects a neighbour

- **WHEN** the active conversation is deleted and healthy conversations remain
- **THEN** the next healthy conversation is selected
- **AND** if none remains, the empty state is shown

#### Scenario: Destructive actions ask first

- **WHEN** the user requests delete or clear
- **THEN** a confirmation is required before any file is removed

### Requirement: Switching and streaming lifecycle

The chat SHALL keep at most one active request. Switching conversations, starting a new chat, deleting the active conversation or clearing history while an answer streams SHALL first ask for confirmation; on confirmation it SHALL stop the request, save the partial answer as cancelled, then perform the action. Late events from the old request MUST NOT change the newly loaded conversation.

#### Scenario: Switching while streaming

- **WHEN** the user confirms switching conversations while an answer streams
- **THEN** the request is stopped and its partial answer is saved as cancelled
- **AND** the selected conversation loads
- **AND** late events for the stopped request do not modify it

#### Scenario: New chat while streaming

- **WHEN** the user confirms a new chat while an answer streams
- **THEN** the request is stopped and saved as cancelled
- **AND** an empty new conversation is shown
- **AND** the previous conversation remains in the list

#### Scenario: Deleting or clearing while streaming

- **WHEN** the user confirms deleting the active conversation or clearing history while an answer streams
- **THEN** the request is stopped first
- **AND** the deleted or cleared conversation is not recreated by a later save

#### Scenario: A non-active deletion does not stop the stream

- **WHEN** the user deletes a conversation that is not the one currently streaming
- **THEN** the stream continues
- **AND** only the selected conversation is removed

#### Scenario: The stop action saves a cancelled answer

- **WHEN** the user stops the current answer without switching
- **THEN** the partial answer is marked cancelled and saved
- **AND** the composer is enabled again

### Requirement: Project deletion removes history

Deleting a project SHALL remove its chat history directory. A cleanup failure MUST NOT prevent the project deletion and MUST be recorded as metadata without content. Restoring a project from a backup creates a new project id and MUST NOT attach the old history.

#### Scenario: Deleting a project removes its history

- **WHEN** a project is deleted
- **THEN** its history directory is removed
- **AND** another project's history is unchanged

#### Scenario: A cleanup failure does not block deletion

- **WHEN** the history directory cannot be removed
- **THEN** the project deletion still completes
- **AND** the failure is logged as metadata only

#### Scenario: Restored projects start without history

- **WHEN** a project is restored from a backup
- **THEN** it receives a new project id
- **AND** no old conversation is attached to it

### Requirement: Limits are enforced without silent loss

The system SHALL enforce caps on entries and bytes per conversation and on conversations and bytes per project. A save that exceeds a cap SHALL fail with `CHAT_HISTORY_LIMIT` and MUST leave the previous file unchanged. The system MUST NOT silently prune or truncate history. A turn blocked by a limit SHALL be stopped before the provider request; a terminal save failure SHALL keep the answer visible with a persistent notice.

#### Scenario: The entry cap blocks the turn

- **WHEN** a conversation is at its entry cap and another turn would exceed it
- **THEN** the turn is stopped before the provider request
- **AND** the UI explains that a new chat is needed

#### Scenario: The project conversation cap blocks a new conversation

- **WHEN** the project is at its conversation cap and a new conversation would be created
- **THEN** the save fails with `CHAT_HISTORY_LIMIT`
- **AND** no new file is created

#### Scenario: A byte cap leaves the old file intact

- **WHEN** a save would exceed a conversation or project byte cap
- **THEN** the save fails with `CHAT_HISTORY_LIMIT`
- **AND** the previous file is unchanged

#### Scenario: Deleting frees capacity

- **WHEN** the user deletes a conversation after a limit error
- **THEN** the next save can succeed
- **AND** no history was removed automatically

#### Scenario: A terminal save failure is visible

- **WHEN** the final answer cannot be saved
- **THEN** the answer remains visible in memory
- **AND** a persistent notice says it is not saved

### Requirement: Damaged files are isolated and deletable

A damaged conversation SHALL fail to load with `CHAT_HISTORY_CORRUPTED` carrying a line number and a reason, and MUST NOT produce a partial transcript. The list SHALL still return healthy conversations, mark the damaged item and allow deleting it. Errors MUST NOT contain absolute paths or message content.

#### Scenario: A damaged header is listed but not loaded

- **WHEN** a conversation header cannot be parsed
- **THEN** the list marks that item as damaged
- **AND** healthy conversations still list
- **AND** loading it returns `CHAT_HISTORY_CORRUPTED`

#### Scenario: A damaged entry fails the load

- **WHEN** an entry line cannot be parsed
- **THEN** loading returns `CHAT_HISTORY_CORRUPTED` with the line number
- **AND** no partial transcript is shown

#### Scenario: A damaged file can be deleted

- **WHEN** the user deletes a damaged conversation
- **THEN** its file is removed
- **AND** the rest of the history remains

#### Scenario: Corruption errors carry no path or content

- **WHEN** a corruption error is returned to the UI
- **THEN** it contains a stable code, a line number and a reason
- **AND** it contains no absolute path, title or message text

### Requirement: Project isolation for history commands

Every history command SHALL receive a project id and SHALL verify it equals the currently open project. A mismatch SHALL fail with `PROJECT_ISOLATION_VIOLATION`. A queued save that executes after a project switch MUST NOT write the old conversation into the new project.

#### Scenario: A stale save is rejected

- **WHEN** a save captured for project A executes after project B is open
- **THEN** it fails with `PROJECT_ISOLATION_VIOLATION`
- **AND** project B's history is unchanged

#### Scenario: Cross-project reads and deletes are rejected

- **WHEN** a list, load or delete names a project other than the open one
- **THEN** the command fails with `PROJECT_ISOLATION_VIOLATION`

### Requirement: Chat history privacy

The system MUST NOT write message content, titles, tool payloads or API keys to logs, errors or the project folder. It SHALL send only the active conversation's completed user/assistant turns to the provider. History files SHALL live outside the repository and project exports, and clear or delete SHALL remove the corresponding files. Errors SHALL use stable codes and contain no absolute paths.

#### Scenario: Logs stay metadata-only

- **WHEN** history is listed, loaded, saved or deleted
- **THEN** logs contain operation, project id, conversation id, counts and codes
- **AND** they contain no message text, title, tool payload or API key

#### Scenario: The provider sees only the active conversation

- **WHEN** a message is sent
- **THEN** the request contains the active conversation's completed turns and the new question
- **AND** it contains no other conversation

#### Scenario: History stays out of git and exports

- **WHEN** the repository and project exports are inspected
- **THEN** no conversation file is present

#### Scenario: Clear and delete remove files

- **WHEN** the user clears history or deletes a conversation
- **THEN** the corresponding files are removed
- **AND** no copy remains in the project folder
