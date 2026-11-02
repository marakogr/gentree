//! `chat.*` commands. Contract: chat protocol and tool-call shape.
//!
//! `chat.send` returns as soon as the request is registered and streams the
//! answer through Tauri events (`chat-delta`, `chat-tool`, `chat-done`,
//! `chat-error`; the design's dotted names are not valid Tauri event names), so
//! a slow provider never blocks the command thread. `chat.cancel` flips the
//! stored [`CancelToken`]; the transport stops within its poll interval.
//!
//! The model may call the read-only tool catalogue, plus `update_person` when
//! the user enabled person editing. Tool turns are streamed (content deltas
//! are forwarded immediately), bounded by [`MAX_TOOL_TURNS`], and executed
//! through [`gentree_mcp::ProjectAccess`]: exactly the services the tools use.
//! A failed or unparsable tool call is returned to the model as `{code, params,
//! message}` content, not as a fatal request error. `update_person` never
//! writes directly: it re-reads the person, applies the patch to a copy,
//! pre-validates it with `dry_run` and emits a `chat-confirm` card; the project
//! is written only after the user approves through `chat.confirm`.
//!
//! The API key is read from the environment on every request, lives only in
//! [`ChatConfig`] and in the `Authorization` header, and is never logged,
//! returned or emitted. The system prompt (UI locale + project name) is always
//! the first message.
//!
//! Scope: read-only tools plus the single, confirmed `update_person` write.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use gentree_chat::{
    push_application_guide, route, system_prompt, system_prompt_with_skills, CancelToken,
    ChatConfig, ChatError, ChatMessage, ChatProvider, ChatRole, ChatUsage,
    OpenAiCompatibleProvider, Skill, ToolSpec,
};
use gentree_core::error::codes;
use gentree_core::person::Person;
use gentree_core::AppError;
use gentree_mcp::dto::{GetPersonRequest, SearchRequest, UpdatePersonRequest, WriteResult};
use gentree_mcp::{current_date, McpServer, ProjectAccess};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::logging;
use crate::project_access::AppProjectAccess;
use crate::settings::ConfigState;
use crate::AppState;

/// Fallback project name when no project is open.
const FALLBACK_PROJECT_NAME: &str = "Gentree";
/// Fallback locale when the client does not send a usable one.
const FALLBACK_LOCALE: &str = "ru";
/// Upper bound for the UI guide appended to the system prompt.
const MAX_GUIDE_CHARS: usize = 16_000;
// Tauri 2 event names allow only alphanumeric characters, `-`, `/`, `:` and
// `_`, so the design's `chat.delta` / `chat.tool` / `chat.done` / `chat.error`
// names are emitted as hyphenated wire names. The payload contract is unchanged.
const EVENT_SKILL: &str = "chat-skill";
const EVENT_DELTA: &str = "chat-delta";
const EVENT_TOOL: &str = "chat-tool";
const EVENT_DONE: &str = "chat-done";
const EVENT_ERROR: &str = "chat-error";
const EVENT_CONFIRM: &str = "chat-confirm";

/// Tool turns per request. The project context removes the need to discover
/// the project id, so this only bounds a genuinely looping model; on the limit
/// the loop asks once more for a plain answer without tools instead of failing
/// the whole request.
const MAX_TOOL_TURNS: usize = 12;

/// The only write tool ever offered to the chat, and only when
/// `chat.allow_person_edits` is enabled.
const PERSON_EDIT_TOOL: &str = "update_person";

/// How long the confirmation card waits for the user before failing the call.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(300);
/// Poll interval so a cancel during the wait is noticed promptly.
const CONFIRM_POLL: Duration = Duration::from_millis(200);

/// The read-only tool catalogue offered to the chat model, in display order.
/// Write tools are never exposed (design.md §9). `list_projects` is excluded
/// on purpose: the chat always runs inside the open project, and asking the
/// model to discover it only wastes turns and invites cross-project calls.
/// `get_current_date` reads no project data, so ages and "today" never derive
/// from the tree.
const READ_ONLY_TOOLS: [&str; 14] = [
    "get_project",
    "get_tree_overview",
    "search",
    "get_person",
    "get_event",
    "get_ancestors",
    "get_timeline",
    "find_path",
    "get_kinship",
    "validate_project",
    "list_sources",
    "get_source",
    "list_backups",
    "get_current_date",
];

/// How much of a tool argument/result is sent to the UI for the optional
/// expandable call details. The model still receives the complete result.
const TOOL_DETAIL_LIMIT: usize = 4000;

/// Cancellation handles of the requests currently in flight.
#[derive(Clone, Default)]
pub struct ChatState {
    requests: Arc<Mutex<HashMap<String, CancelToken>>>,
    confirmations: Arc<Mutex<HashMap<String, Sender<bool>>>>,
}

impl ChatState {
    fn insert(&self, request_id: &str, token: CancelToken) -> Result<(), AppError> {
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| AppError::new(codes::UNKNOWN, "chat state poisoned"))?;
        if requests.contains_key(request_id) {
            return Err(AppError::validation("requestId", "duplicate"));
        }
        requests.insert(request_id.to_owned(), token);
        Ok(())
    }

    fn token(&self, request_id: &str) -> Result<CancelToken, AppError> {
        self.requests
            .lock()
            .map_err(|_| AppError::new(codes::UNKNOWN, "chat state poisoned"))?
            .get(request_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    codes::CHAT_CANCELLED,
                    "Chat request is unknown or already finished",
                )
                .with_param("requestId", request_id)
            })
    }

    fn remove(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }

    /// Registers one pending confirmation and returns the receiver the waiter
    /// polls. Fail-closed: a duplicate id is a `VALIDATION_ERROR`, never an
    /// overwrite of the existing sender.
    fn register_confirmation(&self, id: &str) -> Result<Receiver<bool>, AppError> {
        let (sender, receiver) = mpsc::channel();
        let mut confirmations = self
            .confirmations
            .lock()
            .map_err(|_| AppError::new(codes::UNKNOWN, "chat state poisoned"))?;
        if confirmations.contains_key(id) {
            return Err(AppError::validation(
                "confirmationId",
                "duplicateConfirmation",
            ));
        }
        confirmations.insert(id.to_owned(), sender);
        Ok(receiver)
    }

    /// Resolves a pending confirmation by sending the decision and removing the
    /// sender. Unknown or already-handled ids are `VALIDATION_ERROR`.
    fn resolve_confirmation(&self, id: &str, approve: bool) -> Result<bool, AppError> {
        let sender = {
            let mut confirmations = self
                .confirmations
                .lock()
                .map_err(|_| AppError::new(codes::UNKNOWN, "chat state poisoned"))?;
            confirmations
                .remove(id)
                .ok_or_else(|| AppError::validation("confirmationId", "unknownConfirmation"))?
        };
        sender
            .send(approve)
            .map_err(|_| AppError::validation("confirmationId", "unknownConfirmation"))?;
        Ok(approve)
    }

    fn remove_confirmation(&self, id: &str) {
        if let Ok(mut confirmations) = self.confirmations.lock() {
            confirmations.remove(id);
        }
    }

    /// Drops every confirmation that belongs to `request_id`.
    fn clear_confirmations_for(&self, request_id: &str) {
        let prefix = format!("{request_id}:");
        if let Ok(mut confirmations) = self.confirmations.lock() {
            confirmations.retain(|id, _| !id.starts_with(&prefix));
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub key_present: bool,
    pub base_url: String,
    /// Read-only tool names the model may call, for the status line.
    pub tools: Vec<String>,
    /// Length of `tools`; kept explicit so the UI never counts itself.
    pub tools_count: usize,
    /// Feature flag: render tool calls (input and result) in the transcript.
    pub show_tools: bool,
    /// Absolute diagnostics log path, for support and local debugging.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    /// True when `chat.allow_person_edits` is on and `update_person` is offered.
    pub can_edit_persons: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSkillEvent {
    request_id: String,
    skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDeltaEvent {
    request_id: String,
    delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatToolEvent {
    request_id: String,
    name: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    /// Raw JSON arguments, truncated for display; `None` on completion events.
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<String>,
    /// Serialized tool result or error, truncated for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDoneEvent {
    request_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<ChatUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatErrorEvent {
    request_id: String,
    error: AppError,
}

/// Confirmation card for an `update_person` proposed by the model. `before` /
/// `after` are the full `Person` values in the UI's wire shape; `changedFields`
/// is computed by the backend by comparing the two, never from the model's
/// arguments. Field values are never logged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfirmEvent {
    pub request_id: String,
    pub confirmation_id: String,
    pub person_id: String,
    pub before: Person,
    pub after: Person,
    pub changed_fields: Vec<String>,
}

/// Lifecycle of one tool call as the UI shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolStatus {
    Running,
    Ok,
    Error,
}

impl ToolStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Ok => "ok",
            Self::Error => "error",
        }
    }
}

/// Event sink of one chat request. Extracted from the Tauri handle so the tool
/// loop can be tested without an application or an HTTP provider.
trait ChatEvents {
    fn delta(&self, delta: &str);
    fn done(&self, content: String, usage: Option<ChatUsage>);
    fn tool(
        &self,
        name: &str,
        status: ToolStatus,
        duration_ms: Option<u64>,
        arguments: Option<&str>,
        result: Option<&str>,
    );
    fn error(&self, error: AppError);
    /// Shows a confirmation card and blocks until the user decides. A
    /// cancellation error must stop the request loop, not become a tool result.
    fn confirm(&self, event: &ChatConfirmEvent) -> Result<bool, AppError>;
}

/// Emits every event on the Tauri wire names.
struct TauriEvents {
    app: AppHandle,
    request_id: String,
    confirmations: ChatState,
    token: CancelToken,
}

impl ChatEvents for TauriEvents {
    fn delta(&self, delta: &str) {
        let _ = self.app.emit(
            EVENT_DELTA,
            ChatDeltaEvent {
                request_id: self.request_id.clone(),
                delta: delta.to_owned(),
            },
        );
    }

    fn done(&self, content: String, usage: Option<ChatUsage>) {
        let _ = self.app.emit(
            EVENT_DONE,
            ChatDoneEvent {
                request_id: self.request_id.clone(),
                content,
                usage,
            },
        );
    }

    fn tool(
        &self,
        name: &str,
        status: ToolStatus,
        duration_ms: Option<u64>,
        arguments: Option<&str>,
        result: Option<&str>,
    ) {
        logging::info(
            "chat.tool",
            format!(
                "request={} name={name} status={} duration_ms={} result_chars={}",
                self.request_id,
                status.as_str(),
                duration_ms.unwrap_or(0),
                result.map_or(0, str::len)
            ),
        );
        let _ = self.app.emit(
            EVENT_TOOL,
            ChatToolEvent {
                request_id: self.request_id.clone(),
                name: name.to_owned(),
                status: status.as_str(),
                duration_ms,
                arguments: arguments.map(|value| truncate_detail(value, TOOL_DETAIL_LIMIT)),
                result: result.map(|value| truncate_detail(value, TOOL_DETAIL_LIMIT)),
            },
        );
    }

    fn error(&self, error: AppError) {
        logging::error(
            "chat.error",
            format!(
                "request={} code={} reason={} message={}",
                self.request_id,
                error.code,
                error
                    .params
                    .get("reason")
                    .map(String::as_str)
                    .unwrap_or("-"),
                error.message
            ),
        );
        let _ = self.app.emit(
            EVENT_ERROR,
            ChatErrorEvent {
                request_id: self.request_id.clone(),
                error,
            },
        );
    }

    fn confirm(&self, event: &ChatConfirmEvent) -> Result<bool, AppError> {
        let receiver = self
            .confirmations
            .register_confirmation(&event.confirmation_id)?;
        // Log only the fact of the confirmation and the ids, never field values.
        logging::info(
            "chat.confirm",
            format!(
                "request={} confirmation={} person={} fields={}",
                event.request_id,
                event.confirmation_id,
                event.person_id,
                event.changed_fields.join(",")
            ),
        );
        if self.app.emit(EVENT_CONFIRM, event).is_err() {
            self.confirmations
                .remove_confirmation(&event.confirmation_id);
            return Err(AppError::validation("updatePerson", "confirmationTimeout"));
        }
        let started = Instant::now();
        loop {
            if self.token.is_cancelled() {
                self.confirmations
                    .remove_confirmation(&event.confirmation_id);
                return Err(cancelled_error());
            }
            match receiver.recv_timeout(CONFIRM_POLL) {
                Ok(approved) => {
                    self.confirmations
                        .remove_confirmation(&event.confirmation_id);
                    return Ok(approved);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if started.elapsed() >= CONFIRM_TIMEOUT {
                        self.confirmations
                            .remove_confirmation(&event.confirmation_id);
                        return Err(AppError::validation("updatePerson", "confirmationTimeout"));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.confirmations
                        .remove_confirmation(&event.confirmation_id);
                    return Err(AppError::validation("updatePerson", "confirmationTimeout"));
                }
            }
        }
    }
}

/// One client message. The client sends completed user/assistant turns; tool
/// messages are created by the backend loop and never accepted from the UI.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessageInput {
    pub role: ChatRole,
    pub content: String,
}

/// `chat.status`: the UI shows enabled/model/key facts, never the key. The
/// tool list is the catalogue the model receives (read-only, plus
/// `update_person` when person editing is enabled).
#[tauri::command]
pub fn chat_status(state: State<'_, Mutex<ConfigState>>) -> Result<ChatStatus, AppError> {
    let config = state
        .lock()
        .map_err(|_| AppError::new(codes::UNKNOWN, "settings state poisoned"))?;
    let chat = &config.config().chat;
    let tools: Vec<String> = tool_specs(chat.allow_person_edits)
        .iter()
        .map(|spec| spec.name.clone())
        .collect();
    let tools_count = tools.len();
    Ok(ChatStatus {
        enabled: chat.enabled,
        provider: chat.provider.clone(),
        model: chat.model.clone(),
        key_present: crate::envvars::value(&chat.api_key_env).is_some(),
        base_url: chat.base_url.clone(),
        tools,
        tools_count,
        show_tools: chat.show_tools,
        log_path: logging::path().map(|path| path.display().to_string()),
        can_edit_persons: chat.allow_person_edits,
    })
}

/// Registers the request and streams the answer in a background thread.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn chat_send(
    app: AppHandle,
    project_state: State<'_, AppState>,
    settings: State<'_, Mutex<ConfigState>>,
    chat_state: State<'_, ChatState>,
    request_id: String,
    locale: String,
    messages: Vec<ChatMessageInput>,
    guide: Option<String>,
) -> Result<(), AppError> {
    let request_id = request_id.trim().to_owned();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(AppError::validation("requestId", "required"));
    }
    if messages.is_empty() {
        return Err(AppError::validation("messages", "required"));
    }
    if messages
        .iter()
        .any(|message| message.content.trim().is_empty())
    {
        return Err(AppError::validation("messages", "empty"));
    }
    // The shell sends its localized built-in guide; the cap keeps a runaway
    // payload from reaching the provider.
    let guide = guide
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(guide) = &guide {
        if guide.chars().count() > MAX_GUIDE_CHARS {
            return Err(AppError::validation("guide", "tooLong")
                .with_param("max", MAX_GUIDE_CHARS.to_string()));
        }
    }

    let (chat_config, allow_person_edits) = {
        let settings = settings
            .lock()
            .map_err(|_| AppError::new(codes::UNKNOWN, "settings state poisoned"))?;
        let section = &settings.config().chat;
        if !section.enabled {
            return Err(AppError::new(codes::CHAT_UNAVAILABLE, "Chat is disabled")
                .with_param("reason", "disabled"));
        }
        let key = crate::envvars::value(&section.api_key_env).ok_or_else(|| {
            AppError::new(codes::CHAT_UNAVAILABLE, "Chat API key is not set")
                .with_param("reason", "missingKey")
        })?;
        if section.model.trim().is_empty() {
            return Err(
                AppError::new(codes::CHAT_UNAVAILABLE, "Chat model is not configured")
                    .with_param("reason", "missingModel"),
            );
        }
        (
            ChatConfig {
                base_url: section.base_url.trim().to_owned(),
                model: section.model.trim().to_owned(),
                api_key: Some(key),
                temperature: section.temperature as f32,
                max_tokens: section.max_tokens,
                timeout_seconds: section.timeout_seconds,
                stream: section.stream,
            },
            section.allow_person_edits,
        )
    };

    let (project_name, project_id) = {
        let guard = project_state
            .project
            .lock()
            .map_err(|_| AppError::new(codes::UNKNOWN, "state poisoned"))?;
        match guard.as_ref() {
            Some(store) => (
                store.manifest().name.clone(),
                Some(store.manifest().project_id.to_string()),
            ),
            None => (FALLBACK_PROJECT_NAME.to_owned(), None),
        }
    };

    let last_user = messages
        .iter()
        .rev()
        .find(|message| message.role == ChatRole::User)
        .map(|message| message.content.as_str())
        .unwrap_or_default();
    // Skills exist to explain tool usage: without a tool catalogue the model
    // gets the base prompt only, and the UI is not told that skills are used.
    let tools_available = !tool_specs(allow_person_edits).is_empty();
    let skills = select_skills(last_user, tools_available);
    let skill_names: Vec<String> = skills.iter().map(|skill| skill.name.clone()).collect();
    let _ = app.emit(
        EVENT_SKILL,
        ChatSkillEvent {
            request_id: request_id.clone(),
            skills: skill_names.clone(),
        },
    );
    let transcript = build_transcript(
        &normalized_locale(&locale),
        &project_name,
        project_id.as_deref(),
        &messages,
        tools_available.then_some(skills.as_slice()),
        guide.as_deref(),
    );

    logging::info(
        "chat",
        format!(
            "start request={request_id} project_id={} model={} messages={} tools={} timeout_s={} stream={} skills={} guide_chars={}",
            project_id.as_deref().unwrap_or("-"),
            chat_config.model,
            messages.len(),
            tool_specs(allow_person_edits).len(),
            chat_config.timeout_seconds,
            chat_config.stream,
            skill_names.join(","),
            guide.as_deref().map_or(0, |text| text.chars().count())
        ),
    );

    // The same layout and the same access implementation the tools use, so a
    // tool call sees exactly the projects and backups the commands see.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new(codes::IO_ERROR, error.to_string()))?;
    let projects_dir = app_data.join("projects");
    let backups_dir = app_data.join("backups");
    for dir in [&projects_dir, &backups_dir] {
        std::fs::create_dir_all(dir)
            .map_err(|error| AppError::io("create chat tool directory", error))?;
    }
    let access = AppProjectAccess::new(
        Arc::clone(&project_state.project),
        projects_dir,
        backups_dir,
        &app_data,
    );

    let token = CancelToken::new();
    chat_state.insert(&request_id, token.clone())?;

    let app_handle = app.clone();
    let state = chat_state.inner().clone();
    let tools = tool_specs(allow_person_edits);
    std::thread::spawn(move || {
        let provider = match OpenAiCompatibleProvider::new(chat_config) {
            Ok(provider) => provider,
            Err(error) => {
                let mapped = map_error(error);
                logging::error(
                    "chat.provider",
                    format!("request={request_id} phase=init code={}", mapped.code),
                );
                emit_error(&app_handle, &request_id, mapped);
                state.remove(&request_id);
                return;
            }
        };
        let events = TauriEvents {
            app: app_handle,
            request_id: request_id.clone(),
            confirmations: state.clone(),
            token: token.clone(),
        };
        run_chat_loop(
            &provider,
            &access,
            transcript,
            tools,
            project_id.as_deref(),
            &token,
            &events,
            &request_id,
            allow_person_edits,
        );
        state.clear_confirmations_for(&request_id);
        state.remove(&request_id);
    });
    Ok(())
}

/// `chat.cancel`: unknown or finished requests are `CHAT_CANCELLED`.
#[tauri::command]
pub fn chat_cancel(chat_state: State<'_, ChatState>, request_id: String) -> Result<bool, AppError> {
    let token = chat_state.token(request_id.trim())?;
    token.cancel();
    Ok(true)
}

/// Resolves a pending `update_person` confirmation. Nothing is written here;
/// the write happens in `run_person_update` only after `approve: true`.
#[tauri::command]
pub fn chat_confirm(
    chat_state: State<'_, ChatState>,
    confirmation_id: String,
    approve: bool,
) -> Result<bool, AppError> {
    chat_state.resolve_confirmation(confirmation_id.trim(), approve)
}

/// The tool catalogue offered to the model.
///
/// Names, English descriptions and JSON Schemas are taken from the tool
/// router, so the catalogue and the implementation cannot drift apart; only the
/// read-only subset is exposed (design.md §9). `update_person` is appended as
/// the single write tool when `allow_person_edits` is enabled; every other
/// write tool stays hidden forever.
fn tool_specs(allow_person_edits: bool) -> &'static [ToolSpec] {
    static READ_ONLY: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    static WITH_EDIT: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    let specs = if allow_person_edits {
        WITH_EDIT.get_or_init(|| {
            let mut specs = read_only_specs();
            specs.push(tool_spec(PERSON_EDIT_TOOL));
            specs
        })
    } else {
        READ_ONLY.get_or_init(read_only_specs)
    };
    specs
}

fn read_only_specs() -> Vec<ToolSpec> {
    let router = McpServer::<dyn ProjectAccess>::tool_router();
    READ_ONLY_TOOLS
        .iter()
        .filter_map(|name| {
            let tool = router.get(name)?;
            let mut parameters = Value::Object(tool.input_schema.as_ref().clone());
            // OpenAI's `function.parameters` is a schema fragment, not a
            // document; the router meta-schema marker is not needed there.
            if let Some(object) = parameters.as_object_mut() {
                object.remove("$schema");
            }
            Some(ToolSpec::new(
                tool.name.as_ref(),
                tool.description.as_deref().unwrap_or_default(),
                parameters,
            ))
        })
        .collect()
}

/// One tool by name; used only for `update_person`, which the router defines.
fn tool_spec(name: &str) -> ToolSpec {
    let router = McpServer::<dyn ProjectAccess>::tool_router();
    let tool = router.get(name).expect("the router defines the write tool");
    let mut parameters = Value::Object(tool.input_schema.as_ref().clone());
    if let Some(object) = parameters.as_object_mut() {
        object.remove("$schema");
    }
    ToolSpec::new(
        tool.name.as_ref(),
        tool.description.as_deref().unwrap_or_default(),
        parameters,
    )
}

/// Runs tool turns until the model answers with content, the token is
/// cancelled, or [`MAX_TOOL_TURNS`] is exhausted. Every outcome ends with
/// exactly one `chat-done` or `chat-error`.
#[allow(clippy::too_many_arguments)]
fn run_chat_loop<P, A>(
    provider: &P,
    access: &A,
    mut messages: Vec<ChatMessage>,
    tools: &[ToolSpec],
    project_id: Option<&str>,
    token: &CancelToken,
    events: &dyn ChatEvents,
    request_id: &str,
    allow_person_edits: bool,
) where
    P: ChatProvider + ?Sized,
    A: ProjectAccess + ?Sized,
{
    let request_started = Instant::now();
    let mut seen_calls: HashSet<(String, String)> = HashSet::new();
    let mut turns = 0usize;
    for _ in 0..MAX_TOOL_TURNS {
        if token.is_cancelled() {
            events.error(cancelled_error());
            return;
        }
        let turn_started = Instant::now();
        let turn = match provider.send_tools_stream(&messages, tools, token, &mut |delta| {
            events.delta(delta);
        }) {
            Ok(turn) => turn,
            Err(ChatError::Cancelled) => {
                events.error(cancelled_error());
                return;
            }
            Err(error) => {
                let detail = protocol_detail(&error).to_owned();
                let mapped = map_error(error);
                logging::error(
                    "chat.provider",
                    format!(
                        "request={request_id} turn={} duration_ms={} code={} reason={} detail={detail}",
                        turns + 1,
                        elapsed_ms(turn_started),
                        mapped.code,
                        mapped
                            .params
                            .get("reason")
                            .map(String::as_str)
                            .unwrap_or("-")
                    ),
                );
                events.error(mapped);
                return;
            }
        };
        turns += 1;
        if token.is_cancelled() {
            events.error(cancelled_error());
            return;
        }
        if turn.tool_calls.is_empty() {
            let content = turn.content.unwrap_or_default();
            logging::info(
                "chat.provider",
                format!(
                    "request={request_id} turn={turns} status=done duration_ms={} total_ms={} content_bytes={}",
                    elapsed_ms(turn_started),
                    elapsed_ms(request_started),
                    content.len()
                ),
            );
            events.done(content, turn.usage);
            return;
        }
        logging::info(
            "chat.provider",
            format!(
                "request={request_id} turn={turns} status=tools duration_ms={} tool_calls={}",
                elapsed_ms(turn_started),
                turn.tool_calls.len()
            ),
        );
        messages.push(
            ChatMessage::assistant_tool_calls(
                turn.content.unwrap_or_default(),
                turn.tool_calls.clone(),
            )
            .with_reasoning(turn.reasoning.clone()),
        );
        let mut duplicate = false;
        for call in &turn.tool_calls {
            if token.is_cancelled() {
                events.error(cancelled_error());
                return;
            }
            let key = (call.name.clone(), call.arguments.trim().to_owned());
            if !seen_calls.insert(key) {
                let content = json!({
                    "code": codes::VALIDATION_ERROR,
                    "params": { "rule": "duplicate" },
                    "message": "This exact tool call already ran; use its result instead of repeating it."
                })
                .to_string();
                events.tool(
                    &call.name,
                    ToolStatus::Error,
                    Some(0),
                    Some(&call.arguments),
                    Some(&content),
                );
                messages.push(ChatMessage::tool_result(&call.id, content));
                logging::warn(
                    "chat.provider",
                    format!(
                        "request={request_id} reason=duplicateTool name={}",
                        call.name
                    ),
                );
                duplicate = true;
                break;
            }
            events.tool(
                &call.name,
                ToolStatus::Running,
                None,
                Some(&call.arguments),
                None,
            );
            let tool_started = Instant::now();
            let result = if call.name == PERSON_EDIT_TOOL && allow_person_edits {
                run_person_update(
                    request_id,
                    &call.id,
                    &call.arguments,
                    project_id,
                    access,
                    events,
                    token,
                )
            } else {
                run_tool(&call.name, &call.arguments, project_id, access)
            };
            let (content, status) = match result {
                Ok(value) => (value.to_string(), ToolStatus::Ok),
                Err(error) if error.code == codes::CHAT_CANCELLED => {
                    events.error(cancelled_error());
                    return;
                }
                Err(error) => {
                    logging::warn(
                        "chat.tool",
                        format!(
                            "request={request_id} name={} code={}",
                            call.name, error.code
                        ),
                    );
                    (tool_error_content(&error), ToolStatus::Error)
                }
            };
            let duration_ms = elapsed_ms(tool_started);
            events.tool(&call.name, status, Some(duration_ms), None, Some(&content));
            messages.push(ChatMessage::tool_result(&call.id, content));
        }
        if duplicate {
            break;
        }
    }

    // A model that keeps calling tools is not an unrecoverable failure: ask
    // once more for a plain answer without the catalogue. This keeps a long
    // research question useful instead of ending with a red banner.
    logging::warn(
        "chat.provider",
        format!(
            "request={request_id} turns={turns} reason=toolLimit fallback=no-tools total_ms={}",
            elapsed_ms(request_started)
        ),
    );
    if token.is_cancelled() {
        events.error(cancelled_error());
        return;
    }
    match provider.send_cancellable(&messages, token, &mut |delta| {
        events.delta(delta);
    }) {
        Ok(response) => {
            logging::info(
                "chat.provider",
                format!(
                    "request={request_id} turn={} status=done phase=fallback total_ms={} content_bytes={}",
                    turns + 1,
                    elapsed_ms(request_started),
                    response.content.len()
                ),
            );
            events.done(response.content, response.usage)
        }
        Err(ChatError::Cancelled) => events.error(cancelled_error()),
        Err(error) => {
            let detail = protocol_detail(&error).to_owned();
            let mapped = map_error(error);
            logging::error(
                "chat.provider",
                format!(
                    "request={request_id} phase=fallback total_ms={} code={} reason={} detail={detail}",
                    elapsed_ms(request_started),
                    mapped.code,
                    mapped
                        .params
                        .get("reason")
                        .map(String::as_str)
                        .unwrap_or("-")
                ),
            );
            events.error(mapped);
        }
    }
}

/// Executes one read-only tool against the same [`ProjectAccess`] the tool
/// catalogue describes. Arguments are the raw JSON string from the model; an
/// unparsable payload is a tool error, not a failed chat request.
fn run_tool<A>(
    name: &str,
    arguments: &str,
    project_id: Option<&str>,
    access: &A,
) -> Result<Value, AppError>
where
    A: ProjectAccess + ?Sized,
{
    match name {
        "get_project" => to_value(access.get_project(project_arguments(arguments, project_id)?)?),
        "get_tree_overview" => {
            to_value(access.get_tree_overview(project_arguments(arguments, project_id)?)?)
        }
        "search" => {
            let mut request: SearchRequest = project_arguments(arguments, project_id)?;
            // Mirror the tool layer: too short is a validation error, too
            // long is cut instead of failing the call.
            request.query = request.query.trim().to_owned();
            let length = request.query.chars().count();
            if length < 2 {
                return Err(AppError::validation("query", "tooShort"));
            }
            if length > 100 {
                request.query = request.query.chars().take(100).collect();
            }
            to_value(access.search(request)?)
        }
        "get_person" => to_value(access.get_person(project_arguments(arguments, project_id)?)?),
        "get_event" => to_value(access.get_event(project_arguments(arguments, project_id)?)?),
        "get_ancestors" => {
            to_value(access.get_ancestors(project_arguments(arguments, project_id)?)?)
        }
        "get_timeline" => to_value(access.get_timeline(project_arguments(arguments, project_id)?)?),
        "find_path" => to_value(access.find_path(project_arguments(arguments, project_id)?)?),
        "get_kinship" => to_value(access.get_kinship(project_arguments(arguments, project_id)?)?),
        "validate_project" => {
            to_value(access.validate_project(project_arguments(arguments, project_id)?)?)
        }
        "list_sources" => to_value(access.list_sources(project_arguments(arguments, project_id)?)?),
        "get_source" => to_value(access.get_source(project_arguments(arguments, project_id)?)?),
        "list_backups" => to_value(access.list_backups(project_arguments(arguments, project_id)?)?),
        // No project and no arguments: the same formatter as the catalogue, so
        // the chat cannot report a differently shaped date.
        "get_current_date" => Ok(current_date()),
        other => Err(AppError::validation("tool", "unknown").with_param("name", other)),
    }
}

/// Executes `update_person` with a mandatory UI confirmation card.
///
/// The write is split: first the person is re-read and the patch applied to a
/// copy (the same [`gentree_mcp::dto::PersonPatch::apply`] the access layer
/// uses), then the patch is pre-validated with `dry_run = true`, and only after
/// `events.confirm` returns `true` is the actual write issued with the version
/// captured when the card was shown. Nothing is written on rejection, timeout,
/// cancellation or a disabled flag.
#[allow(clippy::too_many_arguments)]
fn run_person_update<A: ProjectAccess + ?Sized>(
    request_id: &str,
    call_id: &str,
    arguments: &str,
    project_id: Option<&str>,
    access: &A,
    events: &dyn ChatEvents,
    token: &CancelToken,
) -> Result<Value, AppError> {
    let request: UpdatePersonRequest = project_arguments(arguments, project_id)?;

    // Provenance is not editable through the chat.
    if request.patch.external_ids.is_some() {
        return Err(AppError::validation("patch", "externalIdsNotEditable"));
    }

    let card = access.get_person(GetPersonRequest {
        project_id: request.project_id,
        person_id: request.person_id,
        limits: None,
    })?;
    // The model never supplies `expectedVersion`; the version is fixed here.
    let version = card.version.clone();
    let before = card.person.clone();
    let after = request.patch.apply(&before)?;

    let changed_fields = changed_fields(&before, &after);
    if changed_fields.is_empty() {
        // No-op: nothing to confirm and nothing to write.
        return to_value(WriteResult {
            dry_run: false,
            would_change: false,
            changed: false,
            entity_id: Some(request.person_id),
            version,
            issues: Vec::new(),
        });
    }

    // Pre-write: validate the patch (and catch a stale version) before showing
    // the card, so the user never confirms a change that cannot be applied.
    access.update_person(UpdatePersonRequest {
        project_id: request.project_id,
        person_id: request.person_id,
        patch: request.patch.clone(),
        dry_run: true,
        expected_version: version.clone(),
    })?;

    // A model-requested dry run reports without a confirmation card.
    if request.dry_run {
        return to_value(WriteResult {
            dry_run: true,
            would_change: true,
            changed: false,
            entity_id: Some(request.person_id),
            version,
            issues: Vec::new(),
        });
    }

    let confirmation_id = format!("{request_id}:{call_id}");
    let event = ChatConfirmEvent {
        request_id: request_id.to_owned(),
        confirmation_id: confirmation_id.clone(),
        person_id: request.person_id.to_string(),
        before: before.clone(),
        after: after.clone(),
        changed_fields: changed_fields.clone(),
    };
    let approved = events.confirm(&event)?;
    if !approved {
        return Err(AppError::validation("updatePerson", "userRejected"));
    }
    if token.is_cancelled() {
        return Err(cancelled_error());
    }

    let write_result = access.update_person(UpdatePersonRequest {
        project_id: request.project_id,
        person_id: request.person_id,
        patch: request.patch,
        dry_run: false,
        expected_version: version,
    })?;
    to_value(write_result)
}

/// Which of the editable fields differ between `before` and `after`, computed by
/// comparing the two `Person` values, never from the model's arguments.
fn changed_fields(before: &Person, after: &Person) -> Vec<String> {
    let mut fields = Vec::new();
    if before.names != after.names {
        fields.push("names".to_owned());
    }
    if before.gender != after.gender {
        fields.push("gender".to_owned());
    }
    if before.birth != after.birth {
        fields.push("birth".to_owned());
    }
    if before.death != after.death {
        fields.push("death".to_owned());
    }
    if before.notes != after.notes {
        fields.push("notes".to_owned());
    }
    fields
}

/// Parses the model's arguments and pins `projectId` to the open project.
///
/// The chat always runs in one project, so the model never has to discover the
/// id (and cannot accidentally target another project). A missing id is
/// supplied here; a malformed argument payload stays a tool error.
fn project_arguments<T: DeserializeOwned>(
    arguments: &str,
    project_id: Option<&str>,
) -> Result<T, AppError> {
    let trimmed = arguments.trim();
    let text = if trimmed.is_empty() { "{}" } else { trimmed };
    let mut value: Value =
        serde_json::from_str(text).map_err(|_| AppError::validation("arguments", "invalidJson"))?;
    if let Some(project_id) = project_id {
        let Value::Object(map) = &mut value else {
            return Err(AppError::validation("arguments", "invalidJson"));
        };
        map.insert("projectId".to_owned(), Value::String(project_id.to_owned()));
    }
    serde_json::from_value(value).map_err(|_| AppError::validation("arguments", "invalidJson"))
}

fn to_value<T: Serialize>(value: T) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|_| AppError::new(codes::UNKNOWN, "Failed to serialize the tool result"))
}

/// Caps a tool argument/result only for the UI event; the model receives the
/// full value. Counts characters, not bytes, so a Cyrillic payload is cut at a
/// readable boundary.
fn truncate_detail(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push_str("… (truncated)");
    truncated
}

/// Milliseconds since `started`, saturating instead of panicking on an
/// implausible clock.
fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Tool error content returned to the model: the stable `{code, params,
/// message}` shape, always with `params` present.
fn tool_error_content(error: &AppError) -> String {
    json!({
        "code": &error.code,
        "params": &error.params,
        "message": &error.message,
    })
    .to_string()
}

fn cancelled_error() -> AppError {
    AppError::new(codes::CHAT_CANCELLED, "Chat request was cancelled")
}

/// `Protocol` details are our own static strings (a bad SSE shape, an
/// unexpected HTTP status) and never carry provider payload or headers, so they
/// are safe to log and are the only way to tell the failure modes apart.
fn protocol_detail(error: &ChatError) -> &str {
    match error {
        ChatError::Protocol(detail) => detail,
        _ => "-",
    }
}

fn emit_error(app: &AppHandle, request_id: &str, error: AppError) {
    let _ = app.emit(
        EVENT_ERROR,
        ChatErrorEvent {
            request_id: request_id.to_owned(),
            error,
        },
    );
}

/// Skills are only useful when the model can call tools; an empty catalogue
/// means no skill text at all (not even `core`).
fn select_skills(message: &str, tools_available: bool) -> Vec<&'static Skill> {
    if tools_available {
        route(message)
    } else {
        Vec::new()
    }
}

/// Prepends the system prompt as the first message of the transcript.
///
/// `skills` is `None` when no tool catalogue is available: the prompt then
/// carries neither the tool contract nor skill blocks. `guide` is the
/// localized UI guide and may be `None` or blank.
fn build_transcript(
    locale: &str,
    project_name: &str,
    project_id: Option<&str>,
    messages: &[ChatMessageInput],
    skills: Option<&[&Skill]>,
    guide: Option<&str>,
) -> Vec<ChatMessage> {
    let mut transcript = Vec::with_capacity(messages.len() + 1);
    let mut system = match skills {
        Some(skills) => system_prompt_with_skills(locale, project_name, project_id, skills),
        None => system_prompt(locale, project_name, project_id),
    };
    push_application_guide(&mut system, guide);
    transcript.push(ChatMessage::new(ChatRole::System, system));
    transcript.extend(
        messages
            .iter()
            .map(|message| ChatMessage::new(message.role, message.content.trim().to_owned())),
    );
    transcript
}

/// Only supported UI locales reach the prompt; anything else falls back to
/// the app default.
fn normalized_locale(locale: &str) -> String {
    match locale.trim().to_ascii_lowercase().as_str() {
        "en" => "en".to_owned(),
        "ru" => "ru".to_owned(),
        "uk" => "uk".to_owned(),
        "be" => "be".to_owned(),
        "de" => "de".to_owned(),
        "es" => "es".to_owned(),
        _ => FALLBACK_LOCALE.to_owned(),
    }
}

/// Stable mapping of transport failures onto the documented error codes. The
/// provider message is deliberately dropped: it may echo request details.
fn map_error(error: ChatError) -> AppError {
    match error {
        ChatError::Cancelled => cancelled_error(),
        ChatError::Timeout => AppError::new(codes::CHAT_UNAVAILABLE, "Chat provider timed out")
            .with_param("reason", "timeout"),
        ChatError::Unauthorized => {
            AppError::new(codes::CHAT_UNAVAILABLE, "Chat provider rejected the key")
                .with_param("reason", "unauthorized")
        }
        ChatError::Unavailable => {
            AppError::new(codes::CHAT_UNAVAILABLE, "Chat provider is unavailable")
                .with_param("reason", "unavailable")
        }
        ChatError::Protocol(_) => {
            AppError::new(codes::CHAT_UNAVAILABLE, "Chat provider response is invalid")
                .with_param("reason", "protocol")
        }
        ChatError::Truncated => AppError::new(
            codes::CHAT_UNAVAILABLE,
            "Chat provider ran out of output tokens before answering",
        )
        .with_param("reason", "truncated"),
        ChatError::Unsupported => AppError::new(
            codes::CHAT_UNAVAILABLE,
            "Chat provider does not support tools",
        )
        .with_param("reason", "unsupported"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use gentree_chat::{ChatResponse, ToolCall, ToolTurn};
    use gentree_mcp::testing::{
        fake_event_id, fake_person, fake_person_id, fake_project_id, fake_source_id,
        FakeProjectAccess,
    };
    use uuid::Uuid;

    use super::*;

    /// Provider that replays scripted turns and records the messages it saw.
    struct ScriptedProvider {
        turns: Mutex<VecDeque<ToolTurn>>,
        sent: Mutex<Vec<Vec<ChatMessage>>>,
        cancel_on_first: Option<CancelToken>,
    }

    impl ScriptedProvider {
        fn new(turns: Vec<ToolTurn>) -> Self {
            Self {
                turns: Mutex::new(turns.into()),
                sent: Mutex::new(Vec::new()),
                cancel_on_first: None,
            }
        }

        fn cancelling(turns: Vec<ToolTurn>, token: CancelToken) -> Self {
            Self {
                cancel_on_first: Some(token),
                ..Self::new(turns)
            }
        }

        fn sent(&self) -> Vec<Vec<ChatMessage>> {
            self.sent
                .lock()
                .map(|sent| sent.clone())
                .unwrap_or_default()
        }
    }

    impl ChatProvider for ScriptedProvider {
        fn send(
            &self,
            _messages: &[ChatMessage],
            on_delta: &mut dyn FnMut(&str),
        ) -> Result<ChatResponse, ChatError> {
            let content = "Answer without tools.".to_owned();
            on_delta(&content);
            Ok(ChatResponse {
                content,
                usage: None,
            })
        }

        fn send_tools(
            &self,
            messages: &[ChatMessage],
            _tools: &[ToolSpec],
        ) -> Result<ToolTurn, ChatError> {
            let first = {
                let mut sent = self.sent.lock().map_err(|_| ChatError::Unavailable)?;
                sent.push(messages.to_vec());
                sent.len() == 1
            };
            if first {
                if let Some(token) = &self.cancel_on_first {
                    token.cancel();
                }
            }
            self.turns
                .lock()
                .map_err(|_| ChatError::Unavailable)?
                .pop_front()
                .ok_or(ChatError::Unavailable)
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    #[allow(clippy::large_enum_variant)]
    enum RecordedEvent {
        Delta(String),
        Done(String),
        Tool {
            name: String,
            status: &'static str,
            duration_ms: Option<u64>,
            arguments: Option<String>,
            result: Option<String>,
        },
        Error(AppError),
        Confirm {
            person_id: String,
            before: Person,
            after: Person,
            changed_fields: Vec<String>,
        },
    }

    struct Recorder {
        events: Mutex<Vec<RecordedEvent>>,
        confirm_decision: bool,
        confirm_error: Option<AppError>,
    }

    impl Default for Recorder {
        fn default() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
                confirm_decision: true,
                confirm_error: None,
            }
        }
    }

    impl Recorder {
        /// A recorder that answers every confirmation with `false`.
        fn rejecting() -> Self {
            Self {
                confirm_decision: false,
                ..Self::default()
            }
        }

        /// A recorder whose `confirm` fails as if the request were cancelled.
        fn cancelling() -> Self {
            Self {
                confirm_error: Some(cancelled_error()),
                ..Self::default()
            }
        }

        fn push(&self, event: RecordedEvent) {
            if let Ok(mut events) = self.events.lock() {
                events.push(event);
            }
        }

        fn events(&self) -> Vec<RecordedEvent> {
            let mut events = self.events.lock().expect("recorder lock");
            let copy = events.clone();
            events.clear();
            copy
        }
    }

    impl ChatEvents for Recorder {
        fn delta(&self, delta: &str) {
            self.push(RecordedEvent::Delta(delta.to_owned()));
        }

        fn done(&self, content: String, _usage: Option<ChatUsage>) {
            self.push(RecordedEvent::Done(content));
        }

        fn tool(
            &self,
            name: &str,
            status: ToolStatus,
            duration_ms: Option<u64>,
            arguments: Option<&str>,
            result: Option<&str>,
        ) {
            self.push(RecordedEvent::Tool {
                name: name.to_owned(),
                status: status.as_str(),
                duration_ms,
                arguments: arguments.map(str::to_owned),
                result: result.map(str::to_owned),
            });
        }

        fn error(&self, error: AppError) {
            self.push(RecordedEvent::Error(error));
        }

        fn confirm(&self, event: &ChatConfirmEvent) -> Result<bool, AppError> {
            self.push(RecordedEvent::Confirm {
                person_id: event.person_id.clone(),
                before: event.before.clone(),
                after: event.after.clone(),
                changed_fields: event.changed_fields.clone(),
            });
            if let Some(error) = &self.confirm_error {
                return Err(error.clone());
            }
            Ok(self.confirm_decision)
        }
    }

    fn message(role: ChatRole, content: &str) -> ChatMessageInput {
        ChatMessageInput {
            role,
            content: content.to_owned(),
        }
    }

    #[test]
    fn system_prompt_is_first_and_locale_is_normalized() {
        let skills = route("hello");
        let transcript = build_transcript(
            "en",
            "Synthetic project",
            Some("project-id"),
            &[message(ChatRole::User, " hello ")],
            Some(&skills),
            None,
        );
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0].role, ChatRole::System);
        assert!(transcript[0].content.contains("Synthetic project"));
        assert!(transcript[0]
            .content
            .contains("Current project id: project-id"));
        assert!(transcript[0].content.contains("UI locale: en"));
        assert!(transcript[0].content.contains("## Skill: core"));
        assert_eq!(transcript[1].role, ChatRole::User);
        assert_eq!(transcript[1].content, "hello");

        assert_eq!(normalized_locale(" EN "), "en");
        assert_eq!(normalized_locale("de"), "de");
        assert_eq!(normalized_locale("uk"), "uk");
        assert_eq!(normalized_locale("xx"), FALLBACK_LOCALE);
        assert_eq!(normalized_locale(""), FALLBACK_LOCALE);
    }

    #[test]
    fn skills_are_omitted_without_a_tool_catalogue() {
        let without = build_transcript(
            "en",
            "Synthetic project",
            None,
            &[message(ChatRole::User, "hello")],
            None,
            None,
        );
        assert_eq!(without.len(), 2);
        assert!(
            !without[0].content.contains("## Skill:"),
            "{}",
            without[0].content
        );
        assert!(
            !without[0].content.contains("Desktop tool contract"),
            "{}",
            without[0].content
        );

        assert!(select_skills("Расскажи о деде", false).is_empty());
        let selected = select_skills("Расскажи о деде", true);
        assert!(!selected.is_empty());
        let with = build_transcript(
            "en",
            "Synthetic project",
            None,
            &[message(ChatRole::User, "hello")],
            Some(selected.as_slice()),
            None,
        );
        assert!(
            with[0].content.contains("## Skill: core"),
            "{}",
            with[0].content
        );
        assert!(
            with[0].content.contains("## Skill: person-profile"),
            "{}",
            with[0].content
        );
    }

    #[test]
    fn guide_reaches_the_system_prompt_and_stays_reference() {
        let skills = route("hello");
        let transcript = build_transcript(
            "ru",
            "Synthetic project",
            None,
            &[message(ChatRole::User, "Как добавить событие?")],
            Some(&skills),
            Some("### События\nНажмите «Добавить»."),
        );
        let system = &transcript[0].content;
        assert!(system.ends_with("\n</application-guide>"), "{system}");
        assert!(system.contains("## Application guide (UI reference)"));
        assert!(system.contains("### События\nНажмите «Добавить»."));
        assert_eq!(transcript[1].content, "Как добавить событие?");

        let blank = build_transcript(
            "ru",
            "Synthetic project",
            None,
            &[message(ChatRole::User, "hello")],
            None,
            Some("  \n "),
        );
        assert!(!blank[0].content.contains("<application-guide>"));
    }

    #[test]
    fn transport_errors_map_to_documented_codes() {
        assert_eq!(map_error(ChatError::Cancelled).code, codes::CHAT_CANCELLED);
        for error in [
            ChatError::Timeout,
            ChatError::Unauthorized,
            ChatError::Unavailable,
            ChatError::Protocol("secret-ish detail".to_owned()),
            ChatError::Truncated,
            ChatError::Unsupported,
        ] {
            let mapped = map_error(error);
            assert_eq!(mapped.code, codes::CHAT_UNAVAILABLE);
            assert!(!mapped.message.contains("secret-ish"));
        }
        assert_eq!(
            map_error(ChatError::Unsupported)
                .params
                .get("reason")
                .map(String::as_str),
            Some("unsupported")
        );
        assert_eq!(
            map_error(ChatError::Truncated)
                .params
                .get("reason")
                .map(String::as_str),
            Some("truncated")
        );
        assert_eq!(
            protocol_detail(&ChatError::Protocol("bad SSE chunk".to_owned())),
            "bad SSE chunk"
        );
        assert_eq!(protocol_detail(&ChatError::Truncated), "-");
    }

    #[test]
    fn tool_specs_are_the_read_only_registry() {
        let names: Vec<&str> = tool_specs(false)
            .iter()
            .map(|spec| spec.name.as_str())
            .collect();
        assert_eq!(names, READ_ONLY_TOOLS.to_vec());
        assert_eq!(tool_specs(false).len(), 14);
        assert!(
            names.contains(&"get_current_date"),
            "the model must be able to ask for today's date: {names:?}"
        );
        for spec in tool_specs(false) {
            assert!(
                !spec.description.trim().is_empty(),
                "{} needs an English description",
                spec.name
            );
            assert_eq!(spec.parameters["type"], "object", "{}", spec.name);
            assert!(
                spec.parameters.get("properties").is_some(),
                "{} needs a JSON Schema object",
                spec.name
            );
            assert!(
                spec.parameters.get("$schema").is_none(),
                "{} must send a schema fragment, not a document",
                spec.name
            );
        }
        for write in [
            "create_person",
            "update_person",
            "delete_person",
            "create_event",
            "update_event",
            "create_relationship",
            "delete_relationship",
            "backup_project",
            "export_project",
            "import_project",
            "restore_backup",
        ] {
            assert!(
                !names.contains(&write),
                "write tool {write} must never be offered to the chat"
            );
        }
    }

    #[test]
    fn tool_specs_with_edits_adds_update_person_last() {
        let names: Vec<&str> = tool_specs(true)
            .iter()
            .map(|spec| spec.name.as_str())
            .collect();
        assert_eq!(
            names.len(),
            15,
            "read-only plus exactly one write tool: {names:?}"
        );
        assert_eq!(
            names[..14],
            READ_ONLY_TOOLS,
            "the read-only prefix is unchanged"
        );
        assert_eq!(names[14], PERSON_EDIT_TOOL, "update_person is last");
        // No other write tool is ever offered, even with edits enabled.
        for write in [
            "create_person",
            "delete_person",
            "create_event",
            "update_event",
            "create_relationship",
            "delete_relationship",
            "backup_project",
            "export_project",
            "import_project",
            "restore_backup",
        ] {
            assert!(
                !names.contains(&write),
                "write tool {write} must stay hidden"
            );
        }
    }

    #[test]
    fn run_tool_never_handles_update_person() {
        let access = FakeProjectAccess::new();
        let err = run_tool(
            "update_person",
            &json!({ "personId": fake_person_id(), "patch": {} }).to_string(),
            Some(&fake_project_id().to_string()),
            &access,
        )
        .expect_err("update_person is not a read-only tool");
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert_eq!(err.params.get("field").map(String::as_str), Some("tool"));
        assert!(
            access
                .calls()
                .iter()
                .all(|call| call.tool != "update_person"),
            "run_tool must never route to the write access layer"
        );
    }

    #[test]
    fn run_tool_dispatches_read_only_reads() {
        let access = FakeProjectAccess::new();
        let project_id = fake_project_id().to_string();
        let person_id = fake_person_id().to_string();

        let projects =
            run_tool("get_project", "", Some(&project_id), &access).expect("get_project");
        assert_eq!(projects["name"], "Synthetic project");

        let project = run_tool(
            "get_project",
            &json!({ "projectId": Uuid::now_v7() }).to_string(),
            Some(&project_id),
            &access,
        )
        .expect("the open project id is pinned");
        assert_eq!(project["name"], "Synthetic project");

        let overview = run_tool("get_tree_overview", "", Some(&project_id), &access)
            .expect("get_tree_overview");
        assert_eq!(overview["counts"]["persons"], 1);
        assert_eq!(overview["rootCount"], 1);

        let event = run_tool(
            "get_event",
            &json!({ "eventId": fake_event_id() }).to_string(),
            Some(&project_id),
            &access,
        )
        .expect("get_event");
        assert_eq!(event["event"]["id"], fake_event_id().to_string());
        assert_eq!(event["participants"][0]["id"], person_id);

        let sources =
            run_tool("list_sources", "", Some(&project_id), &access).expect("list_sources");
        assert_eq!(sources["total"], 1);
        let source = run_tool(
            "get_source",
            &json!({ "sourceId": fake_source_id() }).to_string(),
            Some(&project_id),
            &access,
        )
        .expect("get_source");
        assert_eq!(source["source"]["id"], fake_source_id().to_string());

        let card = run_tool(
            "get_person",
            &json!({ "personId": person_id }).to_string(),
            Some(&project_id),
            &access,
        )
        .expect("get_person");
        assert_eq!(card["person"]["id"], person_id);

        // The tool layer trims the query; the chat path must behave the same.
        let hits = run_tool(
            "search",
            &json!({ "query": "  Fi  " }).to_string(),
            Some(&project_id),
            &access,
        )
        .expect("search");
        assert_eq!(hits["results"][0]["snippet"], "match for Fi");

        // The clock tool needs neither the project nor arguments; its shape is
        // the one the catalogue returns.
        let today = run_tool("get_current_date", "", None, &access).expect("get_current_date");
        for key in ["date", "time", "timezone", "utc", "weekday", "unix"] {
            assert!(today.get(key).is_some(), "missing {key}: {today}");
        }
        assert_eq!(today["date"].as_str().map(str::len), Some(10), "YYYY-MM-DD");
        assert_eq!(today["time"].as_str().map(str::len), Some(8), "HH:MM:SS");
        assert!(today["utc"]
            .as_str()
            .is_some_and(|utc| utc.ends_with('Z') || utc.contains('+')));
        assert!(today["unix"].as_i64().is_some());
        assert!(today["weekday"]
            .as_str()
            .is_some_and(|weekday| weekday.chars().all(|c| c.is_ascii_alphabetic())));
    }

    #[test]
    fn loop_answers_a_date_question_without_touching_the_project() {
        let access = FakeProjectAccess::new();
        let provider = ScriptedProvider::new(vec![
            ToolTurn {
                content: None,
                tool_calls: vec![ToolCall::new("call_1", "get_current_date", "")],
                usage: None,
                reasoning: None,
            },
            ToolTurn {
                content: Some("Today is 2023-11-15.".to_owned()),
                tool_calls: Vec::new(),
                usage: None,
                reasoning: None,
            },
        ]);
        let recorder = Recorder::default();

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "how old is he?")],
            tool_specs(false),
            None,
            &CancelToken::new(),
            &recorder,
            "request-date",
            false,
        );

        assert!(
            access.calls().is_empty(),
            "the clock tool must not read project data"
        );
        let sent = provider.sent();
        let content: Value = serde_json::from_str(&sent[1][2].content).expect("tool content JSON");
        assert!(content["date"].is_string(), "{content}");
        assert_eq!(
            recorder.events().last(),
            Some(&RecordedEvent::Done("Today is 2023-11-15.".to_owned()))
        );
    }

    #[test]
    fn run_tool_reports_domain_and_argument_errors() {
        let access = FakeProjectAccess::new();

        let err = run_tool(
            "get_project",
            &json!({ "projectId": Uuid::now_v7() }).to_string(),
            None,
            &access,
        )
        .expect_err("an unknown project must fail");
        assert_eq!(err.code, codes::PROJECT_NOT_FOUND);

        let err = run_tool(
            "search",
            &json!({ "projectId": fake_project_id(), "query": "a" }).to_string(),
            None,
            &access,
        )
        .expect_err("a one-letter query must fail");
        assert_eq!(err.params.get("field").map(String::as_str), Some("query"));
        assert_eq!(err.params.get("rule").map(String::as_str), Some("tooShort"));

        let err = run_tool("get_project", "{not json", Some("project-id"), &access)
            .expect_err("bad JSON");
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert_eq!(
            err.params.get("field").map(String::as_str),
            Some("arguments")
        );

        let err =
            run_tool("create_person", "{}", Some("project-id"), &access).expect_err("write tool");
        assert_eq!(err.params.get("field").map(String::as_str), Some("tool"));
        assert!(
            access
                .calls()
                .iter()
                .all(|call| call.tool != "create_person"),
            "a write tool must never reach the access layer"
        );
    }

    #[test]
    fn tool_error_content_always_carries_params() {
        let error = AppError::new(codes::UNKNOWN, "boom");
        let value: Value =
            serde_json::from_str(&tool_error_content(&error)).expect("error content JSON");
        assert_eq!(value["code"], codes::UNKNOWN);
        assert_eq!(value["params"], json!({}));
        assert_eq!(value["message"], "boom");
    }

    #[test]
    fn loop_runs_a_tool_turn_and_finishes_with_content() {
        let access = FakeProjectAccess::new();
        let project_id = fake_project_id().to_string();
        let provider = ScriptedProvider::new(vec![
            ToolTurn {
                content: None,
                tool_calls: vec![ToolCall::new("call_1", "get_project", "")],
                usage: None,
                reasoning: Some("The user wants the open project.".to_owned()),
            },
            ToolTurn {
                content: Some("One project found.".to_owned()),
                tool_calls: Vec::new(),
                usage: None,
                reasoning: None,
            },
        ]);
        let recorder = Recorder::default();

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "open the project")],
            tool_specs(false),
            Some(&project_id),
            &CancelToken::new(),
            &recorder,
            "request-1",
            false,
        );

        let events = recorder.events();
        assert_eq!(events.len(), 4, "{events:?}");
        match &events[0] {
            RecordedEvent::Tool {
                name,
                status,
                duration_ms,
                arguments,
                result,
            } => {
                assert_eq!(name, "get_project");
                assert_eq!(*status, "running");
                assert!(duration_ms.is_none());
                assert_eq!(arguments.as_deref(), Some(""));
                assert!(result.is_none());
            }
            other => panic!("expected a running tool event, got {other:?}"),
        }
        match &events[1] {
            RecordedEvent::Tool {
                name,
                status,
                duration_ms,
                result,
                ..
            } => {
                assert_eq!(name, "get_project");
                assert_eq!(*status, "ok");
                assert!(
                    duration_ms.is_some(),
                    "the finished event carries a duration"
                );
                assert!(result
                    .as_deref()
                    .is_some_and(|text| text.contains("Synthetic")));
            }
            other => panic!("expected a finished tool event, got {other:?}"),
        }
        assert_eq!(
            events[2],
            RecordedEvent::Delta("One project found.".to_owned())
        );
        assert_eq!(
            events[3],
            RecordedEvent::Done("One project found.".to_owned())
        );

        let sent = provider.sent();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1].len(), 3);
        assert_eq!(sent[1][1].role, ChatRole::Assistant);
        assert_eq!(sent[1][1].tool_calls.len(), 1);
        assert_eq!(
            sent[1][1].reasoning_content.as_deref(),
            Some("The user wants the open project."),
            "a thinking model needs its chain of thought replayed with the tools"
        );
        assert_eq!(sent[1][2].role, ChatRole::Tool);
        assert_eq!(sent[1][2].tool_call_id.as_deref(), Some("call_1"));
        let content: Value = serde_json::from_str(&sent[1][2].content).expect("tool content JSON");
        assert_eq!(content["name"], "Synthetic project");
        assert!(access.calls().iter().any(|call| call.tool == "get_project"));
    }

    #[test]
    fn loop_returns_a_failed_tool_to_the_model_and_continues() {
        let access = FakeProjectAccess::new();
        let provider = ScriptedProvider::new(vec![
            ToolTurn {
                content: None,
                tool_calls: vec![ToolCall::new(
                    "call_1",
                    "get_project",
                    json!({ "projectId": Uuid::now_v7() }).to_string(),
                )],
                usage: None,
                reasoning: None,
            },
            ToolTurn {
                content: Some("I could not find that project.".to_owned()),
                tool_calls: Vec::new(),
                usage: None,
                reasoning: None,
            },
        ]);
        let recorder = Recorder::default();

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "open it")],
            tool_specs(false),
            None,
            &CancelToken::new(),
            &recorder,
            "request-2",
            false,
        );

        let events = recorder.events();
        match &events[1] {
            RecordedEvent::Tool { status, .. } => assert_eq!(*status, "error"),
            other => panic!("expected an error tool event, got {other:?}"),
        }
        assert!(matches!(events.last(), Some(RecordedEvent::Done(_))));

        let sent = provider.sent();
        let content: Value = serde_json::from_str(&sent[1][2].content).expect("tool error content");
        assert_eq!(content["code"], codes::PROJECT_NOT_FOUND);
        assert!(content.get("params").is_some());
    }

    #[test]
    fn loop_stops_repeated_calls_and_answers_without_tools() {
        let access = FakeProjectAccess::new();
        let project_id = fake_project_id().to_string();
        let turn = || ToolTurn {
            content: None,
            tool_calls: vec![ToolCall::new("call", "get_project", "{}")],
            usage: None,
            reasoning: None,
        };
        let provider = ScriptedProvider::new((0..MAX_TOOL_TURNS).map(|_| turn()).collect());
        let recorder = Recorder::default();

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "loop")],
            tool_specs(false),
            Some(&project_id),
            &CancelToken::new(),
            &recorder,
            "request-limit",
            false,
        );

        let sent = provider.sent();
        assert_eq!(sent.len(), 2, "the duplicate call must stop the tool loop");
        let events = recorder.events();
        let tool_events = events
            .iter()
            .filter(|event| matches!(event, RecordedEvent::Tool { .. }))
            .count();
        assert_eq!(tool_events, 3, "one completed call and one duplicate");
        assert!(matches!(events.last(), Some(RecordedEvent::Done(_))));
    }

    #[test]
    fn loop_stops_between_turns_when_cancelled() {
        let access = FakeProjectAccess::new();
        let token = CancelToken::new();
        let provider = ScriptedProvider::cancelling(
            vec![ToolTurn {
                content: None,
                tool_calls: vec![ToolCall::new("call_1", "get_project", "{}")],
                usage: None,
                reasoning: None,
            }],
            token.clone(),
        );
        let recorder = Recorder::default();

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "list")],
            tool_specs(false),
            None,
            &token,
            &recorder,
            "request-cancel",
            false,
        );

        assert_eq!(provider.sent().len(), 1);
        assert!(access.calls().is_empty(), "no tool may run after cancel");
        assert_eq!(
            recorder.events(),
            vec![RecordedEvent::Error(cancelled_error())]
        );
    }

    #[test]
    fn loop_with_a_pre_cancelled_token_never_calls_the_provider() {
        let access = FakeProjectAccess::new();
        let token = CancelToken::new();
        token.cancel();
        let provider = ScriptedProvider::new(vec![ToolTurn {
            content: Some("unused".to_owned()),
            tool_calls: Vec::new(),
            usage: None,
            reasoning: None,
        }]);
        let recorder = Recorder::default();

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "hi")],
            tool_specs(false),
            None,
            &token,
            &recorder,
            "request-pre-cancel",
            false,
        );

        assert!(provider.sent().is_empty());
        assert_eq!(
            recorder.events(),
            vec![RecordedEvent::Error(cancelled_error())]
        );
    }

    #[test]
    fn event_names_are_valid_tauri_event_names() {
        // Tauri rejects dots; this guards the wire names against a "spec-like"
        // rename back to `chat.delta`.
        for name in [
            EVENT_SKILL,
            EVENT_DELTA,
            EVENT_TOOL,
            EVENT_DONE,
            EVENT_ERROR,
            EVENT_CONFIRM,
        ] {
            assert!(
                name.chars().all(|character| character.is_alphanumeric()
                    || character == '-'
                    || character == '/'
                    || character == ':'
                    || character == '_'),
                "invalid Tauri event name: {name}"
            );
        }
    }

    #[test]
    fn cancel_token_is_shared_and_removed() {
        let state = ChatState::default();
        let token = CancelToken::new();
        state.insert("request-1", token.clone()).unwrap();
        assert!(state.insert("request-1", token.clone()).is_err());

        assert!(!token.is_cancelled());
        state.token("request-1").unwrap().cancel();
        assert!(token.is_cancelled());

        state.remove("request-1");
        let error = state.token("request-1").unwrap_err();
        assert_eq!(error.code, codes::CHAT_CANCELLED);
    }

    fn update_args(patch: Value) -> String {
        json!({ "personId": fake_person_id(), "patch": patch }).to_string()
    }

    #[test]
    fn confirmed_edit_writes_after_approval() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::default();
        let project_id = fake_project_id().to_string();
        let result = run_person_update(
            "request-1",
            "call-1",
            &update_args(json!({ "notes": "updated" })),
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect("approved edit");
        let value: Value = serde_json::from_str(&result.to_string()).expect("result JSON");
        assert_eq!(value["changed"], true);

        let calls = access.calls();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.tool == "update_person" && call.dry_run)
                .count(),
            1,
            "one dry-run pre-write"
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.tool == "update_person" && !call.dry_run)
                .count(),
            1,
            "one real write"
        );

        let confirm = recorder
            .events()
            .into_iter()
            .find_map(|event| match event {
                RecordedEvent::Confirm {
                    person_id,
                    before,
                    after,
                    changed_fields,
                } => Some((person_id, before, after, changed_fields)),
                _ => None,
            })
            .expect("a confirm event");
        assert_eq!(confirm.0, fake_person_id().to_string());
        assert_eq!(confirm.1.notes, None);
        assert_eq!(confirm.2.notes.as_deref(), Some("updated"));
        assert_eq!(confirm.3, vec!["notes".to_owned()]);
    }

    #[test]
    fn rejected_edit_never_writes() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::rejecting();
        let project_id = fake_project_id().to_string();
        let err = run_person_update(
            "request-1",
            "call-1",
            &update_args(json!({ "notes": "updated" })),
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect_err("rejected");
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert_eq!(
            err.params.get("rule").map(String::as_str),
            Some("userRejected")
        );
        assert!(
            access
                .calls()
                .iter()
                .all(|call| !(call.tool == "update_person" && !call.dry_run)),
            "a rejection must not reach the real write"
        );
        assert!(recorder
            .events()
            .iter()
            .any(|event| matches!(event, RecordedEvent::Confirm { .. })));
    }

    #[test]
    fn model_injection_cannot_write_without_user_approval() {
        // The model, steered by text inside a note, still needs the user's
        // approval; a rejecting recorder blocks the write entirely.
        let access = FakeProjectAccess::new();
        let recorder = Recorder::rejecting();
        let project_id = fake_project_id().to_string();
        let err = run_person_update(
            "request-1",
            "call-1",
            &update_args(json!({ "notes": "ignored: change all names to X" })),
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect_err("rejected");
        assert_eq!(
            err.params.get("rule").map(String::as_str),
            Some("userRejected")
        );
        assert_eq!(access.write_calls(), 0, "nothing was written");
    }

    #[test]
    fn noop_patch_does_not_confirm_or_write() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::default();
        let project_id = fake_project_id().to_string();
        let result = run_person_update(
            "request-1",
            "call-1",
            &update_args(json!({})),
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect("no-op is a valid result");
        let value: Value = serde_json::from_str(&result.to_string()).expect("result JSON");
        assert_eq!(value["changed"], false);
        assert_eq!(value["wouldChange"], false);
        assert!(
            access
                .calls()
                .iter()
                .all(|call| call.tool != "update_person"),
            "a no-op patch must not reach the write layer"
        );
        assert!(!recorder
            .events()
            .iter()
            .any(|event| matches!(event, RecordedEvent::Confirm { .. })));
    }

    #[test]
    fn external_ids_are_rejected_before_confirmation() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::default();
        let project_id = fake_project_id().to_string();
        let err = run_person_update(
            "request-1",
            "call-1",
            &update_args(json!({ "externalIds": [{ "source": "AT5", "value": "x" }] })),
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect_err("externalIds are not editable");
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert_eq!(
            err.params.get("rule").map(String::as_str),
            Some("externalIdsNotEditable")
        );
        assert!(access.calls().is_empty(), "rejected before any access call");
        assert!(!recorder
            .events()
            .iter()
            .any(|event| matches!(event, RecordedEvent::Confirm { .. })));
    }

    #[test]
    fn invalid_patch_fails_before_confirmation() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::default();
        let project_id = fake_project_id().to_string();
        // Death before birth is invalid, so the patch must fail before any
        // confirmation card is shown.
        let err = run_person_update(
            "request-1",
            "call-1",
            &update_args(json!({
                "death": { "start": "1940-01-01", "end": "1941-01-01",
                           "precision": "YEAR", "qualifier": "EXACT" }
            })),
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect_err("invalid patch");
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert!(
            access
                .calls()
                .iter()
                .all(|call| !(call.tool == "update_person" && !call.dry_run)),
            "no write for an invalid patch"
        );
        assert!(!recorder
            .events()
            .iter()
            .any(|event| matches!(event, RecordedEvent::Confirm { .. })));
    }

    #[test]
    fn model_supplied_expected_version_is_ignored() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::default();
        let project_id = fake_project_id().to_string();
        let arguments = json!({
            "personId": fake_person_id(),
            "patch": { "notes": "updated" },
            "expectedVersion": "attacker-controlled"
        })
        .to_string();
        run_person_update(
            "request-1",
            "call-1",
            &arguments,
            Some(&project_id),
            &access,
            &recorder,
            &CancelToken::new(),
        )
        .expect("the model's expectedVersion must be ignored");
        assert!(
            access
                .calls()
                .iter()
                .any(|call| call.tool == "update_person" && !call.dry_run),
            "the write uses the version fixed at card time, not the argument"
        );
    }

    #[test]
    fn cancelled_confirmation_stops_the_loop_and_writes_nothing() {
        let access = FakeProjectAccess::new();
        let recorder = Recorder::cancelling();
        let project_id = fake_project_id().to_string();
        let provider = ScriptedProvider::new(vec![ToolTurn {
            content: None,
            tool_calls: vec![ToolCall::new(
                "call_1",
                "update_person",
                update_args(json!({ "notes": "x" })),
            )],
            usage: None,
            reasoning: None,
        }]);

        run_chat_loop(
            &provider,
            &access,
            vec![ChatMessage::new(ChatRole::User, "fix the note")],
            tool_specs(true),
            Some(&project_id),
            &CancelToken::new(),
            &recorder,
            "request-cancel-confirm",
            true,
        );

        let events = recorder.events();
        assert!(
            matches!(events.last(), Some(RecordedEvent::Error(error)) if error.code == codes::CHAT_CANCELLED),
            "a cancelled confirmation stops the loop like any cancellation: {events:?}"
        );
        assert!(
            access
                .calls()
                .iter()
                .all(|call| !(call.tool == "update_person" && !call.dry_run)),
            "nothing is written when the confirmation is cancelled"
        );
    }

    #[test]
    fn confirmation_registry_is_fail_closed() {
        let state = ChatState::default();

        let receiver = state.register_confirmation("req:a").expect("register");
        let duplicate = state.register_confirmation("req:a").unwrap_err();
        assert_eq!(
            duplicate.params.get("rule").map(String::as_str),
            Some("duplicateConfirmation")
        );

        assert!(state.resolve_confirmation("req:a", true).unwrap());
        assert_eq!(receiver.recv(), Ok(true));
        let again = state.resolve_confirmation("req:a", true).unwrap_err();
        assert_eq!(
            again.params.get("rule").map(String::as_str),
            Some("unknownConfirmation")
        );

        let unknown = state.resolve_confirmation("missing", true).unwrap_err();
        assert_eq!(
            unknown.params.get("rule").map(String::as_str),
            Some("unknownConfirmation")
        );

        state.register_confirmation("req:b").unwrap();
        state.remove_confirmation("req:b");
        assert!(state.resolve_confirmation("req:b", true).is_err());

        // Keep the receivers alive, as the waiter would while blocking.
        let _receiver_a = state.register_confirmation("request-a:call-1").unwrap();
        let _receiver_b = state.register_confirmation("request-b:call-1").unwrap();
        state.clear_confirmations_for("request-a");
        assert!(state
            .resolve_confirmation("request-a:call-1", true)
            .is_err());
        assert!(state.resolve_confirmation("request-b:call-1", true).is_ok());
    }

    #[test]
    fn confirm_event_serializes_camel_case() {
        let event = ChatConfirmEvent {
            request_id: "r".to_owned(),
            confirmation_id: "r:c".to_owned(),
            person_id: fake_person_id().to_string(),
            before: fake_person(),
            after: fake_person(),
            changed_fields: vec!["notes".to_owned()],
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert!(value.get("requestId").is_some(), "{value}");
        assert!(value.get("confirmationId").is_some(), "{value}");
        assert!(value.get("personId").is_some(), "{value}");
        assert!(value.get("changedFields").is_some(), "{value}");
        assert!(value.get("before").is_some(), "{value}");
        assert!(value.get("after").is_some(), "{value}");
    }

    #[test]
    fn person_card_version_serializes_camel_case_and_skips_none() {
        let access = FakeProjectAccess::new();
        let mut card = access
            .get_person(GetPersonRequest {
                project_id: fake_project_id(),
                person_id: fake_person_id(),
                limits: None,
            })
            .expect("person card");
        assert_eq!(card.version.as_deref(), Some("2026-01-02T00:00:00Z"));

        let value = serde_json::to_value(&card).expect("serialize");
        assert_eq!(value["version"], "2026-01-02T00:00:00Z");

        card.version = None;
        let value = serde_json::to_value(&card).expect("serialize");
        assert!(value.get("version").is_none(), "{value}");
    }
}
