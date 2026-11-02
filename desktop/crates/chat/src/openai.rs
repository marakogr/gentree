//! OpenAI-compatible transport: `POST {base_url}/chat/completions`, SSE stream.
//!
//! Text turns and agent tool turns share one cancellable SSE reader. A tool
//! turn accumulates streamed `tool_calls` fragments before returning them, so
//! the caller still sees every call before executing anything, while the
//! visible text is emitted incrementally through `on_delta`.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{BufRead, BufReader, ErrorKind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{
    CancelToken, ChatConfig, ChatError, ChatMessage, ChatProvider, ChatResponse, ChatUsage,
    ToolCall, ToolSpec, ToolTurn,
};

const COMPLETIONS_PATH: &str = "chat/completions";
const SSE_PREFIX: &str = "data:";
const SSE_DONE: &str = "[DONE]";

/// How often the cancellable reader wakes up to look at the token. A blocked
/// socket read cannot be interrupted, so the body is read by a helper thread
/// and this main loop only waits for the next line with this timeout; that
/// bounds `chat.cancel` latency to one poll interval (spec: ≤ 2 s).
const CANCEL_POLL: Duration = Duration::from_millis(50);

/// Prefix of every transport log line. Logs go to stderr because this crate is
/// transport-only and has no logger dependency; the desktop app owns its own
/// file log and adds the request id there.
const LOG_PREFIX: &str = "[chat]";

/// Placeholder for an endpoint that cannot be logged safely.
const INVALID_URL: &str = "<invalid-url>";

/// Sequence number pairing the `send` and `finished` lines of one HTTP
/// exchange, so concurrent chat requests stay distinguishable in the log.
static EXCHANGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Blocking OpenAI-compatible client (`reqwest` blocking + rustls).
pub struct OpenAiCompatibleProvider {
    client: reqwest::blocking::Client,
    config: ChatConfig,
}

impl OpenAiCompatibleProvider {
    /// Builds the HTTP client; the config is kept as-is (key included) so a
    /// settings reload means a new provider instance.
    pub fn new(config: ChatConfig) -> Result<Self, ChatError> {
        let mut builder = reqwest::blocking::Client::builder();
        if config.timeout_seconds > 0 {
            builder = builder.timeout(Duration::from_secs(config.timeout_seconds));
        }
        let client = builder.build().map_err(|_| ChatError::Unavailable)?;
        Ok(Self { client, config })
    }

    pub fn config(&self) -> &ChatConfig {
        &self.config
    }

    fn endpoint(&self) -> String {
        format!(
            "{}/{}",
            self.config.base_url.trim_end_matches('/'),
            COMPLETIONS_PATH
        )
    }

    fn request_body<'a>(&'a self, messages: &'a [ChatMessage]) -> RequestBody<'a> {
        RequestBody {
            model: &self.config.model,
            messages,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
            stream: self.config.stream,
            stream_options: self.config.stream.then_some(StreamOptions {
                include_usage: true,
            }),
        }
    }

    /// Sends the request and maps status codes onto [`ChatError`]. Response
    /// headers are never echoed: the request carries the key.
    fn post(&self, messages: &[ChatMessage]) -> Result<reqwest::blocking::Response, ChatError> {
        self.post_body(
            &self.request_body(messages),
            RequestLog {
                kind: "text",
                messages: messages.len(),
                tools: None,
                stream: self.config.stream,
            },
        )
    }

    /// Posts one JSON body. Shared by the streaming and the tool requests, so
    /// the auth, status mapping and log rules exist once.
    fn post_body<T>(
        &self,
        body: &T,
        meta: RequestLog<'_>,
    ) -> Result<reqwest::blocking::Response, ChatError>
    where
        T: Serialize + ?Sized,
    {
        let endpoint = self.endpoint();
        let exchange = next_exchange_id();
        log_request(exchange, &self.config, &endpoint, &meta);
        let started = Instant::now();
        let mut request = self.client.post(endpoint).json(body);
        if let Some(key) = self.config.api_key.as_deref() {
            request = request.bearer_auth(key);
        }
        match request.send() {
            Ok(response) if response.status().is_success() => {
                log_outcome(exchange, Some(response.status().as_u16()), started, None);
                Ok(response)
            }
            Ok(response) => {
                let status = response.status().as_u16();
                let error = map_status(status);
                log_outcome(exchange, Some(status), started, Some(&error));
                Err(error)
            }
            Err(err) => {
                let error = map_transport(&err);
                log_outcome(exchange, None, started, Some(&error));
                Err(error)
            }
        }
    }

    /// One text request, with or without cancellation. A token that is already
    /// set stops the call before the socket is opened, so a cancelled request
    /// never reaches the provider.
    fn dispatch(
        &self,
        messages: &[ChatMessage],
        token: Option<&CancelToken>,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<StreamAccumulator, ChatError> {
        if token.is_some_and(CancelToken::is_cancelled) {
            return Err(ChatError::Cancelled);
        }
        let response = self.post(messages)?;
        if self.config.stream {
            return match token {
                Some(token) => read_stream_cancellable(response, token, on_delta),
                None => read_stream(response, on_delta),
            };
        }
        // A non-streaming body has no deltas to poll between; the token is
        // checked before the call and once the body has arrived.
        let response = read_completion(response, on_delta)?;
        if token.is_some_and(CancelToken::is_cancelled) {
            return Err(ChatError::Cancelled);
        }
        Ok(StreamAccumulator::from_response(response))
    }

    /// Tool turn through the plain JSON endpoint. Used when streaming is off
    /// and as a fallback for a provider with a non-standard SSE tool shape.
    fn send_tools_once(
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

impl ChatProvider for OpenAiCompatibleProvider {
    fn send(
        &self,
        messages: &[ChatMessage],
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ChatResponse, ChatError> {
        self.dispatch(messages, None, on_delta)?.finish_response()
    }

    fn send_cancellable(
        &self,
        messages: &[ChatMessage],
        token: &CancelToken,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ChatResponse, ChatError> {
        self.dispatch(messages, Some(token), on_delta)?
            .finish_response()
    }

    fn send_tools(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<ToolTurn, ChatError> {
        if tools.is_empty() {
            return Err(ChatError::Unsupported);
        }
        let body = ToolRequestBody {
            model: &self.config.model,
            messages,
            tools,
            tool_choice: TOOL_CHOICE_AUTO,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
        };
        let response = self.post_body(
            &body,
            RequestLog {
                kind: "tools",
                messages: messages.len(),
                tools: Some(tools.len()),
                stream: false,
            },
        )?;
        let completion: ToolCompletion = response.json().map_err(|err| map_transport(&err))?;
        parse_tool_completion(completion)
    }

    fn send_tools_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        token: &CancelToken,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ToolTurn, ChatError> {
        if tools.is_empty() {
            return Err(ChatError::Unsupported);
        }
        if !self.config.stream {
            return self.send_tools_once(messages, tools, token, on_delta);
        }
        if token.is_cancelled() {
            return Err(ChatError::Cancelled);
        }
        let body = ToolStreamRequestBody {
            model: &self.config.model,
            messages,
            tools,
            tool_choice: TOOL_CHOICE_AUTO,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
            stream: true,
            stream_options: StreamOptions {
                include_usage: true,
            },
        };
        let response = match self.post_body(
            &body,
            RequestLog {
                kind: "tools-stream",
                messages: messages.len(),
                tools: Some(tools.len()),
                stream: true,
            },
        ) {
            Ok(response) => response,
            // A provider may reject `stream`/`stream_options` for tool
            // requests; retry in the widely supported plain JSON mode.
            Err(ChatError::Protocol(_)) => {
                return self.send_tools_once(messages, tools, token, on_delta);
            }
            Err(error) => return Err(error),
        };
        let accumulator = read_stream_cancellable(response, token, on_delta)?;
        match accumulator.finish_tool() {
            Ok(turn) => Ok(turn),
            // A provider that ignores `stream` or emits a non-standard SSE
            // shape would otherwise fail every agent turn. Retry once with the
            // plain JSON request, which is the most widely supported mode.
            Err(ChatError::Protocol(_)) => self.send_tools_once(messages, tools, token, on_delta),
            Err(error) => Err(error),
        }
    }
}

impl fmt::Debug for OpenAiCompatibleProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiCompatibleProvider")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize)]
struct RequestBody<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    temperature: f32,
    max_tokens: u32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// `tool_choice` for every agent turn: the model decides when to call a tool.
const TOOL_CHOICE_AUTO: &str = "auto";

/// Non-streaming body of one tool turn. Kept for providers that do not support
/// streamed tool calls; `send_tools_stream` uses [`ToolStreamRequestBody`].
#[derive(Serialize)]
struct ToolRequestBody<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    tools: &'a [ToolSpec],
    tool_choice: &'a str,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Serialize)]
struct ToolStreamRequestBody<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    tools: &'a [ToolSpec],
    tool_choice: &'a str,
    temperature: f32,
    max_tokens: u32,
    stream: bool,
    stream_options: StreamOptions,
}

#[derive(Deserialize)]
struct ToolCompletion {
    #[serde(default)]
    choices: Vec<ToolCompletionChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ToolCompletionChoice {
    #[serde(default)]
    message: Option<ToolCompletionMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ToolCompletionMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<crate::ToolCall>>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

/// Validates one tool completion: an empty message is a protocol error, and a
/// content-only message is a normal final turn.
fn parse_tool_completion(completion: ToolCompletion) -> Result<ToolTurn, ChatError> {
    let choice = completion
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| ChatError::Protocol("tool completion has no choices".to_owned()))?;
    let message = choice
        .message
        .ok_or_else(|| ChatError::Protocol("tool completion has no message".to_owned()))?;
    let content = message.content.filter(|text| !text.is_empty());
    let tool_calls = message.tool_calls.unwrap_or_default();
    if content.is_none() && tool_calls.is_empty() {
        return Err(empty_turn_error(choice.finish_reason.as_deref()));
    }
    Ok(ToolTurn {
        content,
        tool_calls,
        usage: completion.usage,
        reasoning: message.reasoning_content.filter(|text| !text.is_empty()),
    })
}

/// An empty turn means two different things: a thinking model that spent the
/// whole output budget on its chain of thought (`finish_reason=length`, no
/// retry can help) or a provider that broke the payload shape.
fn empty_turn_error(finish_reason: Option<&str>) -> ChatError {
    if finish_reason == Some("length") {
        return ChatError::Truncated;
    }
    ChatError::Protocol("tool completion has neither content nor tool calls".to_owned())
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Option<Delta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct Completion {
    #[serde(default)]
    choices: Vec<CompletionChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct CompletionChoice {
    #[serde(default)]
    message: Option<CompletionMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct CompletionMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Reads `data:` events until `data: [DONE]`; one `on_delta` call per
/// non-empty content chunk.
fn read_stream(
    response: reqwest::blocking::Response,
    on_delta: &mut dyn FnMut(&str),
) -> Result<StreamAccumulator, ChatError> {
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut accumulator = StreamAccumulator::default();

    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|err| map_io(&err))?;
        if read == 0 {
            break;
        }
        if !accumulator.push_line(&line, on_delta)? {
            break;
        }
    }

    Ok(accumulator)
}

/// Cancellable streaming read. The socket is owned by a helper thread (a
/// blocking `read_line` cannot be interrupted otherwise); this loop waits for
/// the next line with a short timeout and checks the token, so `chat.cancel`
/// takes effect within [`CANCEL_POLL`] even while the provider is silent.
fn read_stream_cancellable(
    response: reqwest::blocking::Response,
    token: &CancelToken,
    on_delta: &mut dyn FnMut(&str),
) -> Result<StreamAccumulator, ChatError> {
    let (lines, _reader) = spawn_line_reader(response);
    let mut accumulator = StreamAccumulator::default();

    loop {
        if token.is_cancelled() {
            // Dropping `lines` makes the helper's next send fail; it then
            // drops the response and the connection is closed.
            return Err(ChatError::Cancelled);
        }
        match lines.recv_timeout(CANCEL_POLL) {
            Ok(Ok(Some(line))) => {
                if !accumulator.push_line(&line, on_delta)? {
                    break;
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(err)) => return Err(err),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(accumulator)
}

/// Line messages from the reader thread: `Ok(None)` is EOF.
type LineMessage = Result<Option<String>, ChatError>;

/// Moves the response body into a thread that reads it line by line. The
/// handle is detached on purpose: a cancelled request must not wait for the
/// provider to close the socket.
fn spawn_line_reader(
    response: reqwest::blocking::Response,
) -> (mpsc::Receiver<LineMessage>, thread::JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut reader = BufReader::new(response);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = sender.send(Ok(None));
                    break;
                }
                Ok(_) => {
                    if sender.send(Ok(Some(line.clone()))).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = sender.send(Err(map_io(&err)));
                    break;
                }
            }
        }
    });
    (receiver, handle)
}

/// Incremental SSE state: collected text, streamed tool-call fragments and the
/// last reported usage. The same accumulator serves text and tool turns.
#[derive(Default)]
struct StreamAccumulator {
    content: String,
    /// Chain of thought of a thinking model; collected but never emitted as
    /// `on_delta`, because the transcript shows only the final answer.
    reasoning: String,
    /// Last non-empty `finish_reason`; `length` explains an empty turn.
    finish_reason: Option<String>,
    usage: Option<ChatUsage>,
    calls: BTreeMap<u32, PartialToolCall>,
}

#[derive(Default)]
struct PartialToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl StreamAccumulator {
    fn from_response(response: ChatResponse) -> Self {
        Self {
            content: response.content,
            usage: response.usage,
            ..Self::default()
        }
    }

    /// Handles one SSE line. Returns `false` after `data: [DONE]`; other
    /// non-data lines (blank, `event:`, comments) are ignored.
    fn push_line(&mut self, line: &str, on_delta: &mut dyn FnMut(&str)) -> Result<bool, ChatError> {
        let Some(payload) = sse_payload(line) else {
            return Ok(true);
        };
        if payload.is_empty() {
            return Ok(true);
        }
        if payload == SSE_DONE {
            return Ok(false);
        }
        let chunk: StreamChunk = serde_json::from_str(payload)
            .map_err(|_| ChatError::Protocol("malformed SSE chunk".to_owned()))?;
        if chunk.usage.is_some() {
            self.usage = chunk.usage;
        }
        if let Some(choice) = chunk.choices.into_iter().next() {
            if let Some(reason) = choice.finish_reason {
                if !reason.is_empty() {
                    self.finish_reason = Some(reason);
                }
            }
            if let Some(delta) = choice.delta {
                if let Some(text) = delta.content {
                    if !text.is_empty() {
                        self.content.push_str(&text);
                        on_delta(&text);
                    }
                }
                if let Some(reasoning) = delta.reasoning_content {
                    self.reasoning.push_str(&reasoning);
                }
                for call in delta.tool_calls {
                    let index = call.index.unwrap_or(0);
                    let slot = self.calls.entry(index).or_default();
                    if let Some(id) = call.id {
                        if !id.is_empty() {
                            slot.id = Some(id);
                        }
                    }
                    if let Some(function) = call.function {
                        if let Some(name) = function.name {
                            if !name.is_empty() {
                                slot.name = Some(name);
                            }
                        }
                        if let Some(arguments) = function.arguments {
                            slot.arguments.push_str(&arguments);
                        }
                    }
                }
            }
        }
        Ok(true)
    }

    fn finish_response(self) -> Result<ChatResponse, ChatError> {
        if self.content.is_empty() && self.finish_reason.as_deref() == Some("length") {
            return Err(ChatError::Truncated);
        }
        Ok(ChatResponse {
            content: self.content,
            usage: self.usage,
        })
    }

    fn finish_tool(self) -> Result<ToolTurn, ChatError> {
        let content = if self.content.is_empty() {
            None
        } else {
            Some(self.content)
        };
        let tool_calls = self
            .calls
            .into_values()
            .map(|partial| {
                let id = partial.id.unwrap_or_default();
                let name = partial.name.unwrap_or_default();
                if id.trim().is_empty() {
                    return Err(ChatError::Protocol(
                        "streamed tool call has no id".to_owned(),
                    ));
                }
                if name.trim().is_empty() {
                    return Err(ChatError::Protocol(
                        "streamed tool call has no name".to_owned(),
                    ));
                }
                Ok(ToolCall::new(id, name, partial.arguments))
            })
            .collect::<Result<Vec<_>, ChatError>>()?;
        if content.is_none() && tool_calls.is_empty() {
            return Err(empty_turn_error(self.finish_reason.as_deref()));
        }
        Ok(ToolTurn {
            content,
            tool_calls,
            usage: self.usage,
            reasoning: Some(self.reasoning).filter(|text| !text.is_empty()),
        })
    }
}

/// Non-streaming fallback: one JSON completion, one `on_delta` call.
fn read_completion(
    response: reqwest::blocking::Response,
    on_delta: &mut dyn FnMut(&str),
) -> Result<ChatResponse, ChatError> {
    let completion: Completion = response.json().map_err(|err| map_transport(&err))?;
    let choice = completion.choices.into_iter().next();
    let truncated = choice
        .as_ref()
        .is_some_and(|choice| choice.finish_reason.as_deref() == Some("length"));
    let content = choice
        .and_then(|choice| choice.message)
        .and_then(|message| message.content)
        .unwrap_or_default();
    if content.is_empty() && truncated {
        return Err(ChatError::Truncated);
    }
    if !content.is_empty() {
        on_delta(&content);
    }
    Ok(ChatResponse {
        content,
        usage: completion.usage,
    })
}

/// `data: {...}` → `{...}`; `None` for blank lines, comments and other
/// SSE fields (`event:`, `id:`, `retry:`).
fn sse_payload(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let payload = line.strip_prefix(SSE_PREFIX)?;
    Some(payload.trim_start())
}

/// Metadata of one outgoing request: the only thing that reaches the log.
///
/// Content is deliberately absent — no prompt, no answer, no key and no header
/// is ever formatted into a log line.
struct RequestLog<'a> {
    /// Call site: `text`, `tools` (plain JSON tool turn) or `tools-stream`.
    kind: &'a str,
    /// Number of messages in the transcript; never their content.
    messages: usize,
    /// Advertised tools, `None` when the request carries no catalogue.
    tools: Option<usize>,
    /// Actual transport mode of this request, not `ChatConfig::stream`.
    stream: bool,
}

fn next_exchange_id() -> u64 {
    EXCHANGE_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

/// Logs that a request is about to be sent: when, where and how big, never
/// what. The endpoint is masked with [`masked_url`].
fn log_request(exchange: u64, config: &ChatConfig, endpoint: &str, meta: &RequestLog<'_>) {
    let tools = meta
        .tools
        .map_or_else(|| "-".to_owned(), |count| count.to_string());
    eprintln!(
        "{LOG_PREFIX} send exchange={exchange} kind={} url={} model={} messages={} tools={tools} timeout_s={} stream={}",
        meta.kind,
        masked_url(endpoint),
        config.model,
        meta.messages,
        config.timeout_seconds,
        meta.stream
    );
}

/// Logs how one exchange ended: HTTP status, wall-clock duration and the
/// mapped error kind. Provider bodies are never logged.
fn log_outcome(exchange: u64, status: Option<u16>, started: Instant, error: Option<&ChatError>) {
    let status = status.map_or_else(|| "-".to_owned(), |code| code.to_string());
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match error {
        Some(error) => eprintln!(
            "{LOG_PREFIX} finished exchange={exchange} status={status} duration_ms={duration_ms} error={}",
            error_kind(error)
        ),
        None => eprintln!(
            "{LOG_PREFIX} finished exchange={exchange} status={status} duration_ms={duration_ms}"
        ),
    }
}

/// Stable, non-identifying label of a transport failure. `Protocol` details are
/// our own static strings, but only the kind is logged so nothing a provider
/// sent can ever reach the log through this path.
fn error_kind(error: &ChatError) -> &'static str {
    match error {
        ChatError::Timeout => "timeout",
        ChatError::Unauthorized => "unauthorized",
        ChatError::Unavailable => "unavailable",
        ChatError::Protocol(_) => "protocol",
        ChatError::Truncated => "truncated",
        ChatError::Unsupported => "unsupported",
        ChatError::Cancelled => "cancelled",
    }
}

/// Endpoint as it may be logged: scheme, host and path only.
///
/// A base URL can carry a token in its query (`?api-key=…`) or in userinfo
/// (`https://user:secret@host`), and neither belongs in a log. A value that is
/// not `scheme://authority/path` is replaced entirely: without a parsed
/// structure there is no way to tell which part might be a secret.
fn masked_url(url: &str) -> String {
    let bare = url.split(['?', '#']).next().unwrap_or_default();
    let Some((scheme, rest)) = bare.split_once("://") else {
        return INVALID_URL.to_owned();
    };
    let (authority, path) = rest
        .find('/')
        .map_or((rest, ""), |index| rest.split_at(index));
    let host = authority
        .rfind('@')
        .map_or(authority, |index| &authority[index + 1..]);
    format!("{scheme}://{host}{path}")
}

fn map_status(status: u16) -> ChatError {
    match status {
        401 | 403 => ChatError::Unauthorized,
        500..=599 => ChatError::Unavailable,
        other => ChatError::Protocol(format!("unexpected HTTP status {other}")),
    }
}

fn map_transport(err: &reqwest::Error) -> ChatError {
    if err.is_timeout() {
        ChatError::Timeout
    } else if err.is_decode() {
        ChatError::Protocol("malformed completion payload".to_owned())
    } else {
        ChatError::Unavailable
    }
}

/// Read failures inside the body are wrapped `reqwest` errors (deadline) or
/// plain I/O errors; both mean the provider is gone.
fn map_io(err: &std::io::Error) -> ChatError {
    if let Some(inner) = err
        .get_ref()
        .and_then(|e| e.downcast_ref::<reqwest::Error>())
    {
        return map_transport(inner);
    }
    match err.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => ChatError::Timeout,
        _ => ChatError::Unavailable,
    }
}

#[cfg(test)]
mod logging_tests {
    use super::{masked_url, INVALID_URL};

    #[test]
    fn masked_url_drops_query_fragment_and_userinfo() {
        assert_eq!(
            masked_url("https://api.example.com/v1/chat/completions?api-key=secret#frag"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            masked_url("https://user:secret@api.example.com/v1"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            masked_url("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            masked_url("https://api.example.com"),
            "https://api.example.com"
        );
    }

    #[test]
    fn masked_url_hides_a_value_that_is_not_a_url() {
        // Without a parsed structure there is no way to tell which part is the
        // secret, so nothing of the value may be logged.
        assert_eq!(masked_url("api-key=secret"), INVALID_URL);
        assert_eq!(masked_url(""), INVALID_URL);
    }
}
