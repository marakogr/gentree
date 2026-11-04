//! App-local auxiliary chat history.
//!
//! Chat history is deliberately **not** part of the project format. It lives
//! under the Tauri application data root, outside the project folder, its
//! backups, checksums, exports and merge, in a `chat/<projectId>/` directory.
//! One conversation is one JSONL file: a header line followed by one entry per
//! line. A save rewrites the whole file through [`crate::write_bytes_atomic`],
//! so an interrupted write leaves the previous file readable.
//!
//! The module owns file naming, UUID validation, limits, strict loading,
//! resilient listing and project cleanup. It adds no dependency: the crate
//! already depends on `serde_json`, `uuid` and `atomicwrites`.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use gentree_core::error::codes;
use gentree_core::{now_rfc3339, rfc3339_from_system_time, AppError, AppResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::write_bytes_atomic;

/// On-disk format of a conversation file. A newer file is rejected instead of
/// being silently downgraded on the next save.
pub const CHAT_HISTORY_SCHEMA_VERSION: u32 = 1;
pub const CHAT_HISTORY_KIND: &str = "chat";

/// Hard caps. They are enforcement points, not UI suggestions, and never prune
/// history automatically.
pub const MAX_CHAT_ENTRIES: usize = 400;
pub const MAX_CHAT_CONVERSATION_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_CHAT_CONVERSATIONS: usize = 200;
pub const MAX_CHAT_PROJECT_BYTES: u64 = 64 * 1024 * 1024;
/// Characters kept from the first user message before an ellipsis.
pub const CHAT_TITLE_MAX_CHARS: usize = 80;

/// Caps a store enforces. Tests construct a store with smaller values so a
/// limit can be exercised without multi-megabyte fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryLimits {
    pub max_entries: usize,
    pub max_conversation_bytes: u64,
    pub max_conversations: usize,
    pub max_project_bytes: u64,
    pub title_max_chars: usize,
}

impl ChatHistoryLimits {
    #[must_use]
    pub const fn defaults() -> Self {
        Self {
            max_entries: MAX_CHAT_ENTRIES,
            max_conversation_bytes: MAX_CHAT_CONVERSATION_BYTES,
            max_conversations: MAX_CHAT_CONVERSATIONS,
            max_project_bytes: MAX_CHAT_PROJECT_BYTES,
            title_max_chars: CHAT_TITLE_MAX_CHARS,
        }
    }
}

impl Default for ChatHistoryLimits {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Persisted role. The system prompt and backend-only tool messages are never
/// written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatHistoryRole {
    User,
    Assistant,
}

/// Persisted entry status. `pending` and `streaming` are accepted for forward
/// compatibility but normalized to `cancelled` when saved or loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatHistoryStatus {
    Pending,
    Streaming,
    Done,
    Error,
    Cancelled,
}

impl ChatHistoryStatus {
    fn normalized(self) -> Self {
        match self {
            Self::Pending | Self::Streaming => Self::Cancelled,
            other => other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatHistoryToolStatus {
    Running,
    Ok,
    Error,
}

/// One tool call as the UI already truncated it to 4,000 characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryTool {
    pub name: String,
    pub status: ChatHistoryToolStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

/// One persisted transcript entry. `id` is a renderer id (for example
/// `user-<request>`), not a UUID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryEntry {
    pub id: String,
    pub role: ChatHistoryRole,
    pub content: String,
    pub status: ChatHistoryStatus,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub tools: Vec<ChatHistoryTool>,
}

/// First line of a conversation file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryHeader {
    pub schema: u32,
    pub kind: String,
    pub id: Uuid,
    pub project_id: Uuid,
    #[serde(default)]
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A fully loaded conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryConversation {
    pub schema: u32,
    pub kind: String,
    pub id: Uuid,
    pub project_id: Uuid,
    #[serde(default)]
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub entries: Vec<ChatHistoryEntry>,
}

/// One row of the conversation list. A damaged header still appears, with a
/// null title and the id taken from the file name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySummary {
    pub id: Uuid,
    pub title: Option<String>,
    pub updated_at: String,
    pub damaged: bool,
}

/// File-backed chat history rooted at the app-data `chat/` directory.
#[derive(Debug, Clone)]
pub struct ChatHistoryStore {
    root: PathBuf,
    limits: ChatHistoryLimits,
}

impl ChatHistoryStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            limits: ChatHistoryLimits::defaults(),
        }
    }

    /// Same store with explicit caps; used by tests and by a future settings
    /// surface without a spec change.
    #[must_use]
    pub fn with_limits(root: impl Into<PathBuf>, limits: ChatHistoryLimits) -> Self {
        Self {
            root: root.into(),
            limits,
        }
    }

    #[must_use]
    pub fn limits(&self) -> ChatHistoryLimits {
        self.limits
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn project_dir(&self, project_id: Uuid) -> PathBuf {
        self.root.join(project_id.to_string())
    }

    fn conversation_path(&self, project_id: Uuid, conversation_id: Uuid) -> PathBuf {
        self.project_dir(project_id)
            .join(format!("{conversation_id}.jsonl"))
    }

    /// Header-only scan of `<uuid>.jsonl` files, newest first. Non-UUID names
    /// and temp files are ignored. A bad header becomes a damaged row instead
    /// of hiding the rest of the history.
    pub fn list(&self, project_id: Uuid) -> AppResult<Vec<ChatHistorySummary>> {
        let dir = self.project_dir(project_id);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(io_error("list")),
        };

        let mut summaries = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => return Err(io_error("list")),
            };
            let file_type = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => return Err(io_error("list")),
            };
            if !file_type.is_file() {
                continue;
            }
            let Some(id) = conversation_id_from_name(&entry.file_name()) else {
                continue;
            };
            let path = entry.path();
            let modified = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .map(rfc3339_from_system_time)
                .unwrap_or_default();
            match read_header(&path) {
                Some(header)
                    if header.id == id
                        && header.project_id == project_id
                        && header.kind == CHAT_HISTORY_KIND =>
                {
                    summaries.push(ChatHistorySummary {
                        id,
                        title: header.title,
                        updated_at: header.updated_at,
                        damaged: false,
                    });
                }
                _ => summaries.push(ChatHistorySummary {
                    id,
                    title: None,
                    updated_at: modified,
                    damaged: true,
                }),
            }
        }

        summaries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(summaries)
    }

    /// Strict load: the header, every entry and both ids are verified. There is
    /// no partial transcript on failure.
    pub fn load(
        &self,
        project_id: Uuid,
        conversation_id: Uuid,
    ) -> AppResult<ChatHistoryConversation> {
        let path = self.conversation_path(project_id, conversation_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::new(codes::NOT_FOUND, "Conversation not found")
                    .with_param("id", conversation_id.to_string()));
            }
            Err(_) => return Err(io_error("load")),
        };
        let text = String::from_utf8(bytes).map_err(|_| corrupted(1, "invalidEncoding"))?;
        let mut lines = text.lines();
        let header_line = lines.next().ok_or_else(|| corrupted(1, "emptyHeader"))?;
        let header: ChatHistoryHeader =
            serde_json::from_str(header_line).map_err(|_| corrupted(1, "invalidHeader"))?;
        validate_header(&header, project_id, conversation_id)?;

        let mut entries = Vec::new();
        for (index, line) in lines.enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let line_number = index + 2;
            let entry: ChatHistoryEntry =
                serde_json::from_str(line).map_err(|_| corrupted(line_number, "invalidEntry"))?;
            entries.push(normalized_entry(entry));
        }

        Ok(ChatHistoryConversation {
            schema: header.schema,
            kind: header.kind,
            id: header.id,
            project_id: header.project_id,
            title: header.title,
            created_at: header.created_at,
            updated_at: header.updated_at,
            entries,
        })
    }

    /// Whole-conversation atomic rewrite. Limits are checked before a temp file
    /// is created, so a rejected save leaves the previous file byte-for-byte
    /// unchanged.
    pub fn save(
        &self,
        project_id: Uuid,
        conversation_id: Uuid,
        entries: &[ChatHistoryEntry],
    ) -> AppResult<ChatHistorySummary> {
        if entries.len() > self.limits.max_entries {
            return Err(limit_error("conversation"));
        }

        let path = self.conversation_path(project_id, conversation_id);
        let existing_header = read_header(&path).filter(|header| {
            header.id == conversation_id
                && header.project_id == project_id
                && header.kind == CHAT_HISTORY_KIND
        });
        let created_at = existing_header
            .as_ref()
            .map(|header| header.created_at.clone())
            .unwrap_or_else(now_rfc3339);
        let title = derive_title_with_limit(entries, self.limits.title_max_chars).or_else(|| {
            existing_header
                .as_ref()
                .and_then(|header| header.title.clone())
        });
        let updated_at = now_rfc3339();
        let header = ChatHistoryHeader {
            schema: CHAT_HISTORY_SCHEMA_VERSION,
            kind: CHAT_HISTORY_KIND.to_owned(),
            id: conversation_id,
            project_id,
            title: title.clone(),
            created_at,
            updated_at: updated_at.clone(),
        };
        let entries: Vec<ChatHistoryEntry> =
            entries.iter().cloned().map(normalized_entry).collect();
        let bytes = serialize(&header, &entries)?;

        if bytes.len() as u64 > self.limits.max_conversation_bytes {
            return Err(limit_error("conversation"));
        }
        let existing_size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let project_bytes = project_size(&self.project_dir(project_id))?
            .saturating_sub(existing_size)
            .saturating_add(bytes.len() as u64);
        if project_bytes > self.limits.max_project_bytes {
            return Err(limit_error("project"));
        }
        if !path.exists() {
            let count = count_conversations(&self.project_dir(project_id))?;
            if count >= self.limits.max_conversations {
                return Err(limit_error("project"));
            }
        }

        let dir = self.project_dir(project_id);
        fs::create_dir_all(&dir).map_err(|_| io_error("save"))?;
        write_bytes_atomic(&path, &bytes)?;
        Ok(ChatHistorySummary {
            id: conversation_id,
            title,
            updated_at,
            damaged: false,
        })
    }

    /// Removes exactly one conversation. A missing file is not an error, so a
    /// repeated delete stays idempotent.
    pub fn delete(&self, project_id: Uuid, conversation_id: Uuid) -> AppResult<bool> {
        match fs::remove_file(self.conversation_path(project_id, conversation_id)) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(io_error("delete")),
        }
    }

    /// Removes every conversation of one project and reports how many files
    /// were removed. Other projects are untouched.
    pub fn clear(&self, project_id: Uuid) -> AppResult<usize> {
        let dir = self.project_dir(project_id);
        if !dir.exists() {
            return Ok(0);
        }
        let count = count_conversations(&dir)?;
        fs::remove_dir_all(&dir).map_err(|_| io_error("clear"))?;
        Ok(count)
    }

    /// Removes the project's history directory as part of project deletion.
    pub fn delete_project(&self, project_id: Uuid) -> AppResult<bool> {
        let dir = self.project_dir(project_id);
        if !dir.exists() {
            return Ok(false);
        }
        fs::remove_dir_all(&dir).map_err(|_| io_error("deleteProject"))?;
        Ok(true)
    }
}

/// The id when the name is exactly `<uuid>.jsonl`.
fn conversation_id_from_name(name: &std::ffi::OsStr) -> Option<Uuid> {
    let name = name.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    Uuid::parse_str(stem).ok()
}

fn conversation_files(dir: &Path) -> AppResult<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(io_error("scan")),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| io_error("scan"))?;
        let is_file = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if is_file && conversation_id_from_name(&entry.file_name()).is_some() {
            files.push(entry.path());
        }
    }
    Ok(files)
}

fn count_conversations(dir: &Path) -> AppResult<usize> {
    Ok(conversation_files(dir)?.len())
}

fn project_size(dir: &Path) -> AppResult<u64> {
    let mut total = 0u64;
    for file in conversation_files(dir)? {
        total = total.saturating_add(fs::metadata(file).map(|meta| meta.len()).unwrap_or(0));
    }
    Ok(total)
}

/// Reads and parses only the first line, accepting the current or an older
/// schema. A newer schema or a wrong kind is treated as an unreadable header.
fn read_header(path: &Path) -> Option<ChatHistoryHeader> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let header: ChatHistoryHeader = serde_json::from_str(&line).ok()?;
    if header.kind != CHAT_HISTORY_KIND || header.schema > CHAT_HISTORY_SCHEMA_VERSION {
        return None;
    }
    Some(header)
}

fn validate_header(
    header: &ChatHistoryHeader,
    project_id: Uuid,
    conversation_id: Uuid,
) -> AppResult<()> {
    if header.kind != CHAT_HISTORY_KIND {
        return Err(corrupted(1, "invalidKind"));
    }
    if header.schema > CHAT_HISTORY_SCHEMA_VERSION {
        return Err(corrupted(1, "unsupportedSchema"));
    }
    if header.id != conversation_id {
        return Err(corrupted(1, "idMismatch"));
    }
    if header.project_id != project_id {
        return Err(corrupted(1, "projectMismatch"));
    }
    Ok(())
}

fn normalized_entry(mut entry: ChatHistoryEntry) -> ChatHistoryEntry {
    entry.status = entry.status.normalized();
    entry
}

/// Whitespace-collapsed, truncated to [`CHAT_TITLE_MAX_CHARS`] characters plus
/// an ellipsis when cut. Derived locally; no provider request is involved.
#[must_use]
pub fn derive_title(entries: &[ChatHistoryEntry]) -> Option<String> {
    derive_title_with_limit(entries, CHAT_TITLE_MAX_CHARS)
}

/// Same rule with an explicit cap, so a store can use its own limits.
#[must_use]
pub fn derive_title_with_limit(entries: &[ChatHistoryEntry], limit: usize) -> Option<String> {
    let content = entries
        .iter()
        .find(|entry| entry.role == ChatHistoryRole::User && !entry.content.trim().is_empty())
        .map(|entry| entry.content.as_str())?;
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    truncate_title(&collapsed, limit)
}

fn truncate_title(title: &str, limit: usize) -> Option<String> {
    if limit == 0 {
        return None;
    }
    let characters: Vec<char> = title.chars().collect();
    if characters.is_empty() {
        return None;
    }
    if characters.len() <= limit {
        return Some(characters.into_iter().collect());
    }
    let mut truncated: String = characters.into_iter().take(limit).collect();
    truncated.push('…');
    Some(truncated)
}

fn serialize(header: &ChatHistoryHeader, entries: &[ChatHistoryEntry]) -> AppResult<Vec<u8>> {
    let mut out = String::new();
    let line = serde_json::to_string(header)
        .map_err(|_| AppError::new(codes::IO_ERROR, "Chat history serialization failed"))?;
    out.push_str(&line);
    out.push('\n');
    for entry in entries {
        let line = serde_json::to_string(entry)
            .map_err(|_| AppError::new(codes::IO_ERROR, "Chat history serialization failed"))?;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out.into_bytes())
}

fn corrupted(line: usize, reason: &str) -> AppError {
    AppError::new(
        codes::CHAT_HISTORY_CORRUPTED,
        "Chat history file is corrupted",
    )
    .with_param("line", line.to_string())
    .with_param("reason", reason)
}

fn limit_error(scope: &str) -> AppError {
    AppError::new(codes::CHAT_HISTORY_LIMIT, "Chat history limit reached")
        .with_param("scope", scope)
}

/// Static, path-free IO failure. The underlying `io::Error` may contain an
/// absolute path, so it is deliberately dropped.
fn io_error(context: &str) -> AppError {
    AppError::new(codes::IO_ERROR, "Chat history storage operation failed")
        .with_param("context", context)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn project() -> Uuid {
        Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888)
    }

    fn other_project() -> Uuid {
        Uuid::from_u128(0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000)
    }

    fn user(content: &str) -> ChatHistoryEntry {
        ChatHistoryEntry {
            id: format!("user-{}", content.len()),
            role: ChatHistoryRole::User,
            content: content.to_owned(),
            status: ChatHistoryStatus::Done,
            skills: Vec::new(),
            tools: Vec::new(),
        }
    }

    fn assistant(content: &str, status: ChatHistoryStatus) -> ChatHistoryEntry {
        ChatHistoryEntry {
            id: format!("assistant-{content}"),
            role: ChatHistoryRole::Assistant,
            content: content.to_owned(),
            status,
            skills: vec!["core".to_owned()],
            tools: vec![ChatHistoryTool {
                name: "search".to_owned(),
                status: ChatHistoryToolStatus::Ok,
                duration_ms: Some(12),
                arguments: Some("{\"query\":\"x\"}".to_owned()),
                result: Some("[]".to_owned()),
            }],
        }
    }

    #[test]
    fn header_and_entry_use_camel_case_field_names() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let entries = vec![user("hello"), assistant("answer", ChatHistoryStatus::Done)];
        store.save(project(), Uuid::now_v7(), &entries).unwrap();

        let file = conversation_files(&temp.path().join(project().to_string()))
            .unwrap()
            .remove(0);
        let text = fs::read_to_string(file).unwrap();
        let first = text.lines().next().unwrap();
        assert!(first.contains("\"projectId\""), "{first}");
        assert!(first.contains("\"createdAt\""), "{first}");
        assert!(first.contains("\"updatedAt\""), "{first}");
        assert!(!first.contains("project_id"));
        assert!(text.contains("\"durationMs\""), "{text}");
        assert!(text.contains("\"skills\""), "{text}");
    }

    #[test]
    fn list_is_newest_first_and_marks_a_damaged_header() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let dir = temp.path().join(project().to_string());
        fs::create_dir_all(&dir).unwrap();

        let older = Uuid::now_v7();
        let newer = Uuid::now_v7();
        for (id, date, title) in [
            (older, "2026-01-01T00:00:00Z", "older"),
            (newer, "2026-02-01T00:00:00Z", "newer"),
        ] {
            let header = ChatHistoryHeader {
                schema: CHAT_HISTORY_SCHEMA_VERSION,
                kind: CHAT_HISTORY_KIND.to_owned(),
                id,
                project_id: project(),
                title: Some(title.to_owned()),
                created_at: date.to_owned(),
                updated_at: date.to_owned(),
            };
            let bytes = serialize(&header, &[]).unwrap();
            fs::write(dir.join(format!("{id}.jsonl")), bytes).unwrap();
        }
        let damaged = Uuid::now_v7();
        fs::write(dir.join(format!("{damaged}.jsonl")), b"not json\n").unwrap();
        fs::write(dir.join("not-a-uuid.jsonl"), b"ignored\n").unwrap();
        fs::write(dir.join(format!("{}.jsonl.tmp", Uuid::now_v7())), b"temp").unwrap();

        let list = store.list(project()).unwrap();
        assert_eq!(list.len(), 3);
        let position = |id: Uuid| list.iter().position(|row| row.id == id).unwrap();
        assert!(position(newer) < position(older));
        let newer_row = &list[position(newer)];
        assert_eq!(newer_row.title.as_deref(), Some("newer"));
        assert!(!newer_row.damaged);
        let damaged_row = &list[position(damaged)];
        assert!(damaged_row.damaged);
        assert!(damaged_row.title.is_none());
    }

    #[test]
    fn load_round_trips_and_normalizes_pending_status() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let id = Uuid::now_v7();
        let entries = vec![
            user("question"),
            assistant("partial", ChatHistoryStatus::Streaming),
        ];
        store.save(project(), id, &entries).unwrap();

        let loaded = store.load(project(), id).unwrap();
        assert_eq!(loaded.id, id);
        assert_eq!(loaded.project_id, project());
        assert_eq!(loaded.title.as_deref(), Some("question"));
        assert_eq!(loaded.entries.len(), 2);
        assert_eq!(loaded.entries[0], entries[0]);
        assert_eq!(loaded.entries[1].status, ChatHistoryStatus::Cancelled);
        assert_eq!(loaded.entries[1].tools.len(), 1);
        assert_eq!(
            loaded.entries[1].tools[0].arguments.as_deref(),
            Some("{\"query\":\"x\"}")
        );
    }

    #[test]
    fn load_rejects_bad_header_and_bad_entry() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let id = Uuid::now_v7();
        let dir = temp.path().join(project().to_string());
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join(format!("{id}.jsonl")), b"{\"kind\":\"chat\"}\n").unwrap();
        let error = store.load(project(), id).unwrap_err();
        assert_eq!(error.code, codes::CHAT_HISTORY_CORRUPTED);
        assert_eq!(error.params.get("line").map(String::as_str), Some("1"));

        let header = ChatHistoryHeader {
            schema: CHAT_HISTORY_SCHEMA_VERSION,
            kind: CHAT_HISTORY_KIND.to_owned(),
            id,
            project_id: project(),
            title: None,
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        let mut text = serde_json::to_string(&header).unwrap();
        text.push('\n');
        text.push_str(&serde_json::to_string(&user("ok")).unwrap());
        text.push('\n');
        text.push_str("{not an entry}\n");
        fs::write(dir.join(format!("{id}.jsonl")), text).unwrap();

        let error = store.load(project(), id).unwrap_err();
        assert_eq!(error.code, codes::CHAT_HISTORY_CORRUPTED);
        assert_eq!(error.params.get("line").map(String::as_str), Some("3"));
    }

    #[test]
    fn save_preserves_created_at_title_rules_and_old_file_on_rejection() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let id = Uuid::now_v7();
        store.save(project(), id, &[user("first title")]).unwrap();
        let first = store.load(project(), id).unwrap();

        let long = "word ".repeat(40);
        let entry = user(long.trim());
        store
            .save(project(), id, std::slice::from_ref(&entry))
            .unwrap();
        let second = store.load(project(), id).unwrap();
        assert_eq!(second.created_at, first.created_at);
        let title = second.title.unwrap();
        assert_eq!(title.chars().count(), CHAT_TITLE_MAX_CHARS + 1);
        assert!(title.ends_with('…'));

        let limits = ChatHistoryLimits {
            max_entries: 2,
            ..ChatHistoryLimits::defaults()
        };
        let store = ChatHistoryStore::with_limits(temp.path(), limits);
        let path = temp
            .path()
            .join(project().to_string())
            .join(format!("{id}.jsonl"));
        let before = fs::read(&path).unwrap();
        let error = store
            .save(project(), id, &[user("a"), user("b"), user("c")])
            .unwrap_err();
        assert_eq!(error.code, codes::CHAT_HISTORY_LIMIT);
        assert_eq!(
            error.params.get("scope").map(String::as_str),
            Some("conversation")
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn delete_clear_and_delete_project_are_scoped_and_idempotent() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let first = Uuid::now_v7();
        let second = Uuid::now_v7();
        let foreign = Uuid::now_v7();
        store.save(project(), first, &[user("one")]).unwrap();
        store.save(project(), second, &[user("two")]).unwrap();
        store
            .save(other_project(), foreign, &[user("three")])
            .unwrap();

        assert!(store.delete(project(), first).unwrap());
        assert!(!store.delete(project(), first).unwrap());
        assert_eq!(store.list(project()).unwrap().len(), 1);

        assert_eq!(store.clear(project()).unwrap(), 1);
        assert_eq!(store.clear(project()).unwrap(), 0);
        assert_eq!(store.list(other_project()).unwrap().len(), 1);

        assert!(store.delete_project(other_project()).unwrap());
        assert!(!store.delete_project(other_project()).unwrap());
        assert!(store.list(other_project()).unwrap().is_empty());
    }

    #[test]
    fn every_limit_has_a_stable_scope() {
        let temp = temp_root();
        let limits = ChatHistoryLimits {
            max_entries: 1,
            max_conversation_bytes: 400,
            max_conversations: 1,
            max_project_bytes: 800,
            title_max_chars: 80,
        };
        let store = ChatHistoryStore::with_limits(temp.path(), limits);

        let entry_error = store
            .save(project(), Uuid::now_v7(), &[user("a"), user("b")])
            .unwrap_err();
        assert_eq!(entry_error.code, codes::CHAT_HISTORY_LIMIT);
        assert_eq!(
            entry_error.params.get("scope").map(String::as_str),
            Some("conversation")
        );

        let byte_error = store
            .save(project(), Uuid::now_v7(), &[user(&"x".repeat(600))])
            .unwrap_err();
        assert_eq!(byte_error.code, codes::CHAT_HISTORY_LIMIT);
        assert_eq!(
            byte_error.params.get("scope").map(String::as_str),
            Some("conversation")
        );

        store
            .save(project(), Uuid::now_v7(), &[user("ok")])
            .unwrap();
        let count_error = store
            .save(project(), Uuid::now_v7(), &[user("second")])
            .unwrap_err();
        assert_eq!(count_error.code, codes::CHAT_HISTORY_LIMIT);
        assert_eq!(
            count_error.params.get("scope").map(String::as_str),
            Some("project")
        );

        let temp = temp_root();
        let limits = ChatHistoryLimits {
            max_entries: 10,
            max_conversation_bytes: 10_000,
            max_conversations: 10,
            max_project_bytes: 900,
            title_max_chars: 80,
        };
        let store = ChatHistoryStore::with_limits(temp.path(), limits);
        store
            .save(project(), Uuid::now_v7(), &[user(&"a".repeat(500))])
            .unwrap();
        let project_error = store
            .save(project(), Uuid::now_v7(), &[user(&"b".repeat(500))])
            .unwrap_err();
        assert_eq!(project_error.code, codes::CHAT_HISTORY_LIMIT);
        assert_eq!(
            project_error.params.get("scope").map(String::as_str),
            Some("project")
        );
    }

    #[test]
    fn unsupported_newer_schema_is_corrupted_and_listed_as_damaged() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let id = Uuid::now_v7();
        let dir = temp.path().join(project().to_string());
        fs::create_dir_all(&dir).unwrap();
        let header = ChatHistoryHeader {
            schema: CHAT_HISTORY_SCHEMA_VERSION + 1,
            kind: CHAT_HISTORY_KIND.to_owned(),
            id,
            project_id: project(),
            title: Some("future".to_owned()),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        fs::write(
            dir.join(format!("{id}.jsonl")),
            serde_json::to_string(&header).unwrap(),
        )
        .unwrap();

        let error = store.load(project(), id).unwrap_err();
        assert_eq!(error.code, codes::CHAT_HISTORY_CORRUPTED);
        let list = store.list(project()).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].damaged);
    }

    #[test]
    fn conversation_paths_stay_under_the_project_directory() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let id = Uuid::now_v7();
        store.save(project(), id, &[user("safe")]).unwrap();
        let path = store.conversation_path(project(), id);
        assert_eq!(
            path.parent(),
            Some(temp.path().join(project().to_string()).as_path())
        );

        let dir = temp.path().join(project().to_string());
        fs::write(dir.join("../escape.jsonl"), b"x").unwrap();
        fs::write(dir.join("..jsonl"), b"x").unwrap();
        let list = store.list(project()).unwrap();
        assert!(list.iter().all(|row| row.id == id));
    }

    #[test]
    fn corruption_errors_carry_no_path_or_content() {
        let temp = temp_root();
        let store = ChatHistoryStore::new(temp.path());
        let id = Uuid::now_v7();
        let dir = temp.path().join(project().to_string());
        fs::create_dir_all(&dir).unwrap();
        let secret = "SECRET_TITLE_AND_MESSAGE";
        fs::write(
            dir.join(format!("{id}.jsonl")),
            format!("{secret}\n{secret}\n"),
        )
        .unwrap();

        let error = store.load(project(), id).unwrap_err();
        let serialized = format!("{:?}", error.params) + &error.message;
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains(&temp.path().display().to_string()));
        assert_eq!(error.code, codes::CHAT_HISTORY_CORRUPTED);
    }
}
