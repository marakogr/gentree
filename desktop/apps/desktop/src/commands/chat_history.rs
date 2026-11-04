//! `chat_history.*` commands: project-scoped conversation history.
//!
//! History is auxiliary app data, not project data. The renderer sends the
//! project id it captured with the call; the backend verifies it equals the
//! open project, so a queued save cannot write project A's conversation into
//! project B. Logs record only operation, ids, counts and codes — never message
//! text, titles or tool payloads.

use std::path::Path;
use std::sync::Mutex;

use gentree_core::error::codes;
use gentree_core::{AppError, AppResult};
use gentree_storage::chat_history::{
    ChatHistoryConversation, ChatHistoryEntry, ChatHistoryLimits, ChatHistoryStore,
    ChatHistorySummary,
};
use gentree_storage::ProjectStore;
use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::parse_uuid;
use crate::logging;
use crate::AppState;

/// Result of `chat_history_list`: newest-first rows plus the active caps so the
/// UI can preempt a count limit without loading a conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryList {
    pub conversations: Vec<ChatHistorySummary>,
    pub limits: ChatHistoryLimits,
}

fn state_error() -> AppError {
    AppError::new(codes::UNKNOWN, "state poisoned")
}

fn no_project() -> AppError {
    AppError::new(codes::PROJECT_NOT_FOUND, "No project is open")
}

/// Path-free IO failure for the command surface. Creating the app-data `chat/`
/// folder can fail with a path-bearing OS message; that text never reaches the
/// renderer.
fn chat_root(app: &AppHandle, state: &AppState) -> AppResult<std::path::PathBuf> {
    crate::chat_dir(app, state).map_err(|_| {
        AppError::new(codes::IO_ERROR, "Chat history storage is unavailable")
            .with_param("context", "chatDir")
    })
}

/// Reads the id of the currently open project.
fn open_project_id(project: &Mutex<Option<ProjectStore>>) -> AppResult<Uuid> {
    let guard = project.lock().map_err(|_| state_error())?;
    guard
        .as_ref()
        .map(|store| store.manifest().project_id)
        .ok_or_else(no_project)
}

/// The renderer's id must be the open project. This is intentionally explicit:
/// the backend never derives the id silently, because a queued save can execute
/// after a project switch.
pub(crate) fn verified_project_id(
    project: &Mutex<Option<ProjectStore>>,
    raw: &str,
) -> AppResult<Uuid> {
    let requested = parse_uuid("projectId", raw)?;
    let open = open_project_id(project)?;
    if requested != open {
        return Err(AppError::new(
            codes::PROJECT_ISOLATION_VIOLATION,
            "Chat history belongs to another project",
        )
        .with_param("projectId", requested.to_string()));
    }
    Ok(requested)
}

fn log_history(
    operation: &str,
    project_id: Uuid,
    conversation_id: Option<Uuid>,
    entries: Option<usize>,
    code: &str,
) {
    logging::info(
        "chat.history",
        format!(
            "op={operation} project={project_id} conversation={} entries={} code={code}",
            conversation_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "-".to_owned()),
            entries.map_or_else(|| "-".to_owned(), |count| count.to_string())
        ),
    );
}

#[tauri::command]
pub fn chat_history_list(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ChatHistoryList, AppError> {
    let project_id = verified_project_id(&state.project, &project_id)?;
    let store = ChatHistoryStore::new(chat_root(&app, &state)?);
    match store.list(project_id) {
        Ok(conversations) => {
            log_history("list", project_id, None, Some(conversations.len()), "OK");
            Ok(ChatHistoryList {
                conversations,
                limits: store.limits(),
            })
        }
        Err(error) => {
            log_history("list", project_id, None, None, &error.code);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn chat_history_load(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    conversation_id: String,
) -> Result<ChatHistoryConversation, AppError> {
    let project_id = verified_project_id(&state.project, &project_id)?;
    let conversation_id = parse_uuid("conversationId", &conversation_id)?;
    let store = ChatHistoryStore::new(chat_root(&app, &state)?);
    match store.load(project_id, conversation_id) {
        Ok(conversation) => {
            log_history(
                "load",
                project_id,
                Some(conversation_id),
                Some(conversation.entries.len()),
                "OK",
            );
            Ok(conversation)
        }
        Err(error) => {
            log_history("load", project_id, Some(conversation_id), None, &error.code);
            Err(error)
        }
    }
}

/// Shared by the command and its test: the project check and the save happen
/// in one place, so a stale id cannot slip between them.
pub(crate) fn save_history(
    project: &Mutex<Option<ProjectStore>>,
    chat_root: &Path,
    raw_project_id: &str,
    raw_conversation_id: &str,
    entries: &[ChatHistoryEntry],
) -> AppResult<ChatHistorySummary> {
    let project_id = verified_project_id(project, raw_project_id)?;
    let conversation_id = parse_uuid("conversationId", raw_conversation_id)?;
    let store = ChatHistoryStore::new(chat_root);
    match store.save(project_id, conversation_id, entries) {
        Ok(summary) => {
            log_history(
                "save",
                project_id,
                Some(conversation_id),
                Some(entries.len()),
                "OK",
            );
            Ok(summary)
        }
        Err(error) => {
            log_history(
                "save",
                project_id,
                Some(conversation_id),
                Some(entries.len()),
                &error.code,
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub fn chat_history_save(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    conversation_id: String,
    entries: Vec<ChatHistoryEntry>,
) -> Result<ChatHistorySummary, AppError> {
    let root = chat_root(&app, &state)?;
    save_history(
        &state.project,
        &root,
        &project_id,
        &conversation_id,
        &entries,
    )
}

#[tauri::command]
pub fn chat_history_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    conversation_id: String,
) -> Result<bool, AppError> {
    let project_id = verified_project_id(&state.project, &project_id)?;
    let conversation_id = parse_uuid("conversationId", &conversation_id)?;
    let store = ChatHistoryStore::new(chat_root(&app, &state)?);
    match store.delete(project_id, conversation_id) {
        Ok(deleted) => {
            log_history("delete", project_id, Some(conversation_id), None, "OK");
            Ok(deleted)
        }
        Err(error) => {
            log_history(
                "delete",
                project_id,
                Some(conversation_id),
                None,
                &error.code,
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub fn chat_history_clear(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<usize, AppError> {
    let project_id = verified_project_id(&state.project, &project_id)?;
    let store = ChatHistoryStore::new(chat_root(&app, &state)?);
    match store.clear(project_id) {
        Ok(removed) => {
            log_history("clear", project_id, None, Some(removed), "OK");
            Ok(removed)
        }
        Err(error) => {
            log_history("clear", project_id, None, None, &error.code);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use gentree_storage::chat_history::{ChatHistoryRole, ChatHistoryStatus};

    use super::*;

    fn entry(content: &str) -> ChatHistoryEntry {
        ChatHistoryEntry {
            id: format!("user-{content}"),
            role: ChatHistoryRole::User,
            content: content.to_owned(),
            status: ChatHistoryStatus::Done,
            skills: Vec::new(),
            tools: Vec::new(),
        }
    }

    #[test]
    fn stale_save_is_rejected_and_the_new_project_stays_empty() {
        let temp = tempfile::tempdir().expect("temp dir");
        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let chat_root = temp.path().join("chat");

        let project_a = ProjectStore::create(&projects, "Project A").unwrap();
        let project_a_id = project_a.manifest().project_id;
        let project_b = ProjectStore::create(&projects, "Project B").unwrap();
        let project_b_id = project_b.manifest().project_id;

        let slot = Mutex::new(Some(project_a));
        let conversation_id = Uuid::now_v7().to_string();
        save_history(
            &slot,
            &chat_root,
            &project_a_id.to_string(),
            &conversation_id,
            &[entry("queued")],
        )
        .unwrap();

        *slot.lock().unwrap() = Some(project_b);
        let error = save_history(
            &slot,
            &chat_root,
            &project_a_id.to_string(),
            &conversation_id,
            &[entry("late")],
        )
        .unwrap_err();
        assert_eq!(error.code, codes::PROJECT_ISOLATION_VIOLATION);

        let store = ChatHistoryStore::new(&chat_root);
        assert_eq!(store.list(project_b_id).unwrap().len(), 0);
        assert_eq!(store.list(project_a_id).unwrap().len(), 1);
    }

    #[test]
    fn project_id_must_be_a_uuid_and_must_be_open() {
        let temp = tempfile::tempdir().expect("temp dir");
        let slot = Mutex::new(None);
        let error = verified_project_id(&slot, "not-a-uuid").unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);

        let error = verified_project_id(&slot, &Uuid::now_v7().to_string()).unwrap_err();
        assert_eq!(error.code, codes::PROJECT_NOT_FOUND);

        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let store = ProjectStore::create(&projects, "Project").unwrap();
        let project_id = store.manifest().project_id;
        *slot.lock().unwrap() = Some(store);
        let error = verified_project_id(&slot, &Uuid::now_v7().to_string()).unwrap_err();
        assert_eq!(error.code, codes::PROJECT_ISOLATION_VIOLATION);
        assert_eq!(
            verified_project_id(&slot, &project_id.to_string()).unwrap(),
            project_id
        );
    }

    #[test]
    fn helper_accepts_the_open_project() {
        let temp = tempfile::tempdir().expect("temp dir");
        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let store = ProjectStore::create(&projects, "Project").unwrap();
        let project_id = store.manifest().project_id;
        let slot = Arc::new(Mutex::new(Some(store)));
        let conversation_id = Uuid::now_v7().to_string();
        let summary = save_history(
            &slot,
            &temp.path().join("chat"),
            &project_id.to_string(),
            &conversation_id,
            &[entry("hello")],
        )
        .unwrap();
        assert_eq!(summary.title.as_deref(), Some("hello"));
    }
}
