//! ChatProvider + OpenAI-compatible client. Contract: design.md §9, ADR-0012.
//!
//! The crate is transport-only: it knows how to call an OpenAI-compatible
//! `POST {base_url}/chat/completions`, streams content deltas to the caller and
//! maps failures onto [`ChatError`]. Model and endpoint always come from
//! [`ChatConfig`] and are never hardcoded.
//!
//! Tool calling is a separate request ([`ChatProvider::send_tools`], or
//! [`ChatProvider::send_tools_stream`] for SSE): the caller gets the whole
//! [`ToolTurn`], executes the calls itself and sends the results back. The
//! crate never executes a tool and never decides which tools exist.
//!
//! The API key is read from config, sent as a bearer token and never appears in
//! `Debug`, `Display`, errors or logs.
//!
//! Logging contract: every HTTP exchange leaves one `[chat]` line on stderr
//! with metadata only — endpoint without query/userinfo, model, message count,
//! tool count, timeout, stream flag, HTTP status, duration and the error kind.
//! Prompts, answers, tool payloads, the key and the `Authorization` header are
//! never logged.

mod cancel;
mod draft;
mod error;
mod openai;
mod prompt;
pub mod skills;
mod tool;

#[cfg(test)]
mod tests;

pub use cancel::CancelToken;
pub use draft::{DraftChange, DraftEvidence, DraftKind};
pub use error::ChatError;
pub use openai::OpenAiCompatibleProvider;
pub use prompt::{system_prompt, system_prompt_with_skills};
pub use skills::{route, route_names, Skill, SkillCatalog};
pub use tool::{ToolCall, ToolSpec, ToolTurn};

use std::fmt;

use serde::{Deserialize, Serialize};

/// Role of a message in the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One message sent to the provider.
///
/// `tool_calls` is set on an assistant message that requested function calls;
/// `tool_call_id` is set on a [`ChatRole::Tool`] message carrying one result.
/// `reasoning_content` echoes a thinking model's chain of thought back to the
/// provider. All three are skipped on the wire when absent, so plain turns
/// serialize exactly as before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// DeepSeek and other thinking models require the chain of thought of
    /// every previous turn to be passed back while `tools` are in the request.
    /// Only providers that emitted it ever see it again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl ChatMessage {
    pub fn new(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    /// Assistant message that requested `tool_calls`. `content` is the text the
    /// provider sent next to the calls (often empty).
    pub fn assistant_tool_calls(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
            tool_calls,
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    /// One tool result, tied to the request by `tool_call_id`.
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            reasoning_content: None,
        }
    }

    /// Replays the provider's chain of thought with this assistant message.
    /// An empty value stays `None` so non-thinking providers never receive
    /// an extra field.
    pub fn with_reasoning(mut self, reasoning: Option<String>) -> Self {
        self.reasoning_content = reasoning.filter(|text| !text.is_empty());
        self
    }
}

/// Token accounting reported by the provider, when it reports any.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatUsage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
}

/// Aggregated outcome of one request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatResponse {
    /// Concatenation of all content deltas.
    pub content: String,
    /// Present when the provider reports usage (streaming: last chunk).
    pub usage: Option<ChatUsage>,
}

/// Provider settings. Model, base URL and key come from config, not from code.
#[derive(Clone)]
pub struct ChatConfig {
    /// OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`.
    pub base_url: String,
    pub model: String,
    /// Bearer token; sent only when `Some`. Never logged.
    pub api_key: Option<String>,
    pub temperature: f32,
    pub max_tokens: u32,
    /// Total request timeout; `0` disables it.
    pub timeout_seconds: u64,
    /// `true` — SSE streaming; `false` — single JSON response.
    pub stream: bool,
}

const REDACTED: &str = "<redacted>";

impl fmt::Debug for ChatConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChatConfig")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| REDACTED))
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("timeout_seconds", &self.timeout_seconds)
            .field("stream", &self.stream)
            .finish()
    }
}

/// Provider-agnostic chat transport.
///
/// `on_delta` is called once per streamed content chunk, in order. The full
/// text is also returned in [`ChatResponse::content`] so a failed or cancelled
/// stream can keep a partial draft without touching project data.
pub trait ChatProvider {
    fn send(
        &self,
        messages: &[ChatMessage],
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ChatResponse, ChatError>;

    /// Cancellable variant of [`ChatProvider::send`].
    ///
    /// The default implementation checks `token` before the request and
    /// between deltas and returns [`ChatError::Cancelled`] once it is set. It
    /// cannot abort the HTTP exchange itself; providers that own the transport
    /// (e.g. [`OpenAiCompatibleProvider`]) override this to stop reading the
    /// stream and close the connection.
    fn send_cancellable(
        &self,
        messages: &[ChatMessage],
        token: &CancelToken,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ChatResponse, ChatError> {
        if token.is_cancelled() {
            return Err(ChatError::Cancelled);
        }
        let mut cancelled = false;
        let result = self.send(messages, &mut |delta: &str| {
            if token.is_cancelled() {
                cancelled = true;
                return;
            }
            on_delta(delta);
        });
        if cancelled || token.is_cancelled() {
            return Err(ChatError::Cancelled);
        }
        result
    }

    /// Sends one agent turn with a tool catalogue and returns the whole turn.
    ///
    /// Tool calling is deliberately non-streaming: the caller needs the
    /// complete `tool_calls` list before it may execute anything, so deltas
    /// cannot be interleaved safely. The default implementation supports no
    /// tools at all and returns [`ChatError::Unsupported`]; providers that do
    /// override it.
    fn send_tools(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> Result<ToolTurn, ChatError> {
        Err(ChatError::Unsupported)
    }

    /// Streaming variant of [`ChatProvider::send_tools`].
    ///
    /// Content deltas are passed to `on_delta` while the tool calls are still
    /// being collected; the complete calls are returned only after the stream
    /// ends. The default implementation falls back to the non-streaming
    /// [`ChatProvider::send_tools`] and emits its content once, so a provider
    /// without streamed tool calls keeps working.
    fn send_tools_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        token: &CancelToken,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ToolTurn, ChatError> {
        if token.is_cancelled() {
            return Err(ChatError::Cancelled);
        }
        let turn = self.send_tools(messages, tools)?;
        if let Some(content) = turn.content.as_deref() {
            if !content.is_empty() {
                on_delta(content);
            }
        }
        if token.is_cancelled() {
            return Err(ChatError::Cancelled);
        }
        Ok(turn)
    }
}
