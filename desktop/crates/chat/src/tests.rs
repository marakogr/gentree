//! Tests against a local `std::net::TcpListener` mock server: no external
//! network, no mock crates, one ephemeral port per test (bind to port 0).

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;
use uuid::Uuid;

use gentree_core::{DateValue, Event, EventType, Name, Person, Relationship, RelationshipType};

use crate::{
    route, system_prompt, system_prompt_with_skills, CancelToken, ChatConfig, ChatError,
    ChatMessage, ChatProvider, ChatResponse, ChatRole, DraftChange, DraftEvidence, DraftKind,
    OpenAiCompatibleProvider, ToolCall, ToolSpec,
};

const KEY: &str = "sk-chat-test-secret";

fn config(base_url: String) -> ChatConfig {
    ChatConfig {
        base_url,
        model: "test-model".to_owned(),
        api_key: None,
        temperature: 0.2,
        max_tokens: 64,
        timeout_seconds: 5,
        stream: true,
    }
}

fn user_message(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage::new(ChatRole::User, text)]
}

/// One-shot HTTP server on an ephemeral port. Returns the OpenAI base URL
/// (`http://127.0.0.1:<port>/v1`), the captured raw request and the handler
/// thread.
fn serve<F>(handler: F) -> (String, Receiver<String>, JoinHandle<()>)
where
    F: FnOnce(&mut TcpStream) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let addr = listener.local_addr().expect("mock server address");
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let request = read_request(&mut stream);
            let _ = tx.send(request);
            handler(&mut stream);
        }
    });
    (format!("http://{addr}/v1"), rx, handle)
}

/// Reads the request head and body so the server never answers before the
/// client finished writing.
fn read_request(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buf.extend_from_slice(&chunk[..read]);
                if let Some(head_end) = header_end(&buf) {
                    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                    if buf.len() >= head_end + content_length(&head) {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn content_length(head: &str) -> usize {
    for line in head.lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                return value.trim().parse().unwrap_or(0);
            }
        }
    }
    0
}

fn write_response(stream: &mut TcpStream, status_line: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status_line}\r\n\
         Content-Type: {content_type}\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\
         Content-Length: {}\r\n\
         \r\n\
         {body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn write_sse(stream: &mut TcpStream, events: &[&str]) {
    let mut body = String::new();
    for event in events {
        body.push_str("data: ");
        body.push_str(event);
        body.push_str("\n\n");
    }
    write_response(stream, "200 OK", "text/event-stream", &body);
}

fn write_status(stream: &mut TcpStream, status_line: &str, body: &str) {
    write_response(stream, status_line, "application/json", body);
}

fn request_text(rx: &Receiver<String>) -> String {
    rx.recv_timeout(Duration::from_secs(5))
        .expect("mock server must capture the request")
}

fn header(request: &str, name: &str) -> Option<String> {
    request.lines().find_map(|line| {
        let (header_name, value) = line.split_once(':')?;
        header_name
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}

fn body(request: &str) -> Value {
    let raw = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default();
    serde_json::from_str(raw).expect("request body must be JSON")
}

/// Server that only counts accepted connections. A client that connects gets a
/// minimal answer, so the test fails on the counter rather than on a hang.
fn serve_counting() -> (String, Arc<AtomicUsize>, JoinHandle<()>) {
    serve_counting_with(None)
}

/// [`serve_counting`] whose first connection is answered by `first`; a retry
/// would be the second connection and gets the minimal answer instead.
fn serve_counting_first<F>(first: F) -> (String, Arc<AtomicUsize>, JoinHandle<()>)
where
    F: FnOnce(&mut TcpStream) + Send + 'static,
{
    serve_counting_with(Some(Box::new(first)))
}

/// Handler for the first accepted connection in [`serve_counting_with`].
type FirstResponse = Box<dyn FnOnce(&mut TcpStream) + Send>;

fn serve_counting_with(first: Option<FirstResponse>) -> (String, Arc<AtomicUsize>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    listener
        .set_nonblocking(true)
        .expect("non-blocking listener");
    let addr = listener.local_addr().expect("mock server address");
    let connections = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::clone(&connections);
    let handle = thread::spawn(move || {
        let mut first = first;
        let deadline = Instant::now() + Duration::from_millis(600);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    // The request must be drained before answering: closing a
                    // stream with unread input resets the connection on Windows
                    // and the client sees a transport error instead of the body.
                    let _ = read_request(&mut stream);
                    match first.take() {
                        Some(handler) => handler(&mut stream),
                        None => {
                            let _ = stream.write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            );
                        }
                    }
                }
                Err(ref err) if err.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });
    (format!("http://{addr}/v1"), connections, handle)
}

/// Opens a close-delimited SSE response so chunks can be written gradually.
fn write_stream_head(stream: &mut TcpStream) {
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: text/event-stream\r\n\
          Cache-Control: no-cache\r\n\
          Connection: close\r\n\
          \r\n",
    );
    let _ = stream.flush();
}

fn write_sse_chunk(stream: &mut TcpStream, event: &str) {
    let _ = stream.write_all(format!("data: {event}\n\n").as_bytes());
    let _ = stream.flush();
}

fn person() -> Person {
    Person::new(vec![Name {
        given: Some("Иван".to_owned()),
        surname: Some("Петров".to_owned()),
        is_primary: true,
        ..Name::default()
    }])
    .expect("valid person")
}

fn draft(kind: DraftKind, payload: &impl serde::Serialize) -> DraftChange {
    DraftChange::new(kind, serde_json::to_value(payload).expect("payload JSON"))
}

/// Provider with no transport at all: exercises the default
/// `ChatProvider::send_cancellable`.
struct StubProvider {
    deltas: Vec<&'static str>,
}

impl ChatProvider for StubProvider {
    fn send(
        &self,
        _messages: &[ChatMessage],
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ChatResponse, ChatError> {
        let mut content = String::new();
        for delta in &self.deltas {
            on_delta(delta);
            content.push_str(delta);
        }
        Ok(ChatResponse {
            content,
            usage: None,
        })
    }
}

#[test]
fn streams_three_content_chunks_and_aggregates_usage() {
    let (base_url, requests, server) = serve(|stream| {
        write_sse(
            stream,
            &[
                r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
                r#"{"choices":[{"delta":{"content":"lo "}}]}"#,
                r#"{"choices":[{"delta":{"content":"world"}}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}"#,
                "[DONE]",
            ],
        );
    });

    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let mut deltas: Vec<String> = Vec::new();
    let response = provider
        .send(&user_message("hi"), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .expect("streamed response");
    server.join().expect("mock server");

    assert_eq!(deltas, ["Hel", "lo ", "world"]);
    assert_eq!(response.content, "Hello world");
    let usage = response.usage.expect("usage chunk");
    assert_eq!(
        (
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens
        ),
        (3, 4, 7)
    );

    let request = request_text(&requests);
    assert!(
        request.starts_with("POST /v1/chat/completions "),
        "{request}"
    );
    let sent = body(&request);
    assert_eq!(sent["model"], "test-model");
    assert_eq!(sent["messages"][0]["role"], "user");
    assert_eq!(sent["messages"][0]["content"], "hi");
    assert_eq!(sent["stream"].as_bool(), Some(true));
    assert_eq!(
        sent["stream_options"]["include_usage"].as_bool(),
        Some(true)
    );
}

#[test]
fn authorization_header_is_sent_only_when_key_is_set() {
    let (base_url, requests, server) = serve(|stream| write_sse(stream, &["[DONE]"]));
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    provider
        .send(&user_message("hi"), &mut |_| {})
        .expect("response without key");
    server.join().expect("mock server");
    assert_eq!(header(&request_text(&requests), "authorization"), None);

    let (base_url, requests, server) = serve(|stream| write_sse(stream, &["[DONE]"]));
    let mut with_key = config(base_url);
    with_key.api_key = Some(KEY.to_owned());
    let provider = OpenAiCompatibleProvider::new(with_key).expect("provider");
    provider
        .send(&user_message("hi"), &mut |_| {})
        .expect("response with key");
    server.join().expect("mock server");
    assert_eq!(
        header(&request_text(&requests), "authorization"),
        Some(format!("Bearer {KEY}"))
    );
}

#[test]
fn http_500_maps_to_unavailable() {
    let (base_url, _requests, server) = serve(|stream| {
        write_status(stream, "500 Internal Server Error", r#"{"error":"boom"}"#);
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let err = provider
        .send(&user_message("hi"), &mut |_| {})
        .expect_err("500 must fail");
    server.join().expect("mock server");
    assert_eq!(err, ChatError::Unavailable);
}

#[test]
fn slow_server_maps_to_timeout() {
    let (base_url, _requests, server) = serve(|stream| {
        thread::sleep(Duration::from_secs(3));
        write_sse(stream, &["[DONE]"]);
    });
    let mut timed = config(base_url);
    timed.timeout_seconds = 1;
    let provider = OpenAiCompatibleProvider::new(timed).expect("provider");

    let started = Instant::now();
    let err = provider
        .send(&user_message("hi"), &mut |_| {})
        .expect_err("slow server must time out");
    let elapsed = started.elapsed();
    drop(server); // the handler is still sleeping; the test must not wait for it.

    assert_eq!(err, ChatError::Timeout);
    assert!(
        elapsed < Duration::from_secs(3),
        "timeout must fire before the server answers, took {elapsed:?}"
    );
}

#[test]
fn malformed_sse_maps_to_protocol() {
    let (base_url, _requests, server) =
        serve(|stream| write_sse(stream, &[r#"{"choices": [not json"#]));
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let err = provider
        .send(&user_message("hi"), &mut |_| {})
        .expect_err("malformed SSE must fail");
    server.join().expect("mock server");
    assert!(
        matches!(err, ChatError::Protocol(ref message) if message.contains("SSE")),
        "unexpected error: {err:?}"
    );
}

#[test]
fn non_streaming_completion_is_aggregated_and_emitted_once() {
    let (base_url, _requests, server) = serve(|stream| {
        write_status(
            stream,
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":"Hello"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}"#,
        );
    });
    let mut plain = config(base_url);
    plain.stream = false;
    let provider = OpenAiCompatibleProvider::new(plain).expect("provider");

    let mut deltas: Vec<String> = Vec::new();
    let response = provider
        .send(&user_message("hi"), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .expect("completion");
    server.join().expect("mock server");

    assert_eq!(deltas, ["Hello"]);
    assert_eq!(response.content, "Hello");
    assert_eq!(response.usage.map(|usage| usage.total_tokens), Some(3));
}

#[test]
fn errors_never_expose_the_api_key() {
    let (base_url, _requests, server) =
        serve(|stream| write_status(stream, "401 Unauthorized", r#"{"error":"bad key"}"#));
    let mut with_key = config(base_url);
    with_key.api_key = Some(KEY.to_owned());
    let provider = OpenAiCompatibleProvider::new(with_key).expect("provider");

    let err = provider
        .send(&user_message("hi"), &mut |_| {})
        .expect_err("401 must fail");
    server.join().expect("mock server");

    assert_eq!(err, ChatError::Unauthorized);
    let rendered = [
        err.to_string(),
        format!("{err:?}"),
        format!("{provider:?}"),
        format!("{:?}", provider.config()),
    ];
    for text in rendered {
        assert!(!text.contains(KEY), "API key leaked: {text}");
    }
}

#[test]
fn cancel_before_send_returns_cancelled_without_any_request() {
    let (base_url, connections, server) = serve_counting();
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let token = CancelToken::new();
    token.cancel();

    let mut deltas: Vec<String> = Vec::new();
    let err = provider
        .send_cancellable(&user_message("hi"), &token, &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .expect_err("a cancelled token must stop before the request");
    server.join().expect("mock server");

    assert_eq!(err, ChatError::Cancelled);
    assert!(deltas.is_empty(), "no delta may be emitted: {deltas:?}");
    assert_eq!(
        connections.load(Ordering::SeqCst),
        0,
        "a cancelled request must not reach the provider"
    );
}

#[test]
fn cancel_mid_stream_stops_quickly_and_keeps_partial_deltas() {
    let (base_url, _requests, server) = serve(|stream| {
        write_stream_head(stream);
        write_sse_chunk(stream, r#"{"choices":[{"delta":{"content":"Hel"}}]}"#);
        write_sse_chunk(stream, r#"{"choices":[{"delta":{"content":"lo"}}]}"#);
        // The provider stays silent for longer than the cancellation budget.
        thread::sleep(Duration::from_millis(700));
        write_sse_chunk(stream, r#"{"choices":[{"delta":{"content":" world"}}]}"#);
        write_sse_chunk(stream, "[DONE]");
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let token = CancelToken::new();

    let mut deltas: Vec<String> = Vec::new();
    let started = Instant::now();
    let err = provider
        .send_cancellable(&user_message("hi"), &token, &mut |delta| {
            deltas.push(delta.to_owned());
            if deltas.len() == 2 {
                token.cancel();
            }
        })
        .expect_err("a cancelled stream must fail");
    let elapsed = started.elapsed();
    drop(server); // the handler is still sleeping; the test must not wait for it.

    assert_eq!(err, ChatError::Cancelled);
    assert_eq!(deltas, ["Hel", "lo"]);
    assert!(
        elapsed < Duration::from_secs(2),
        "cancel must fire within 2 s, took {elapsed:?}"
    );
}

#[test]
fn default_send_cancellable_checks_the_token_between_deltas() {
    let provider = StubProvider {
        deltas: vec!["a", "b", "c"],
    };

    let before = CancelToken::new();
    before.cancel();
    let mut seen: Vec<String> = Vec::new();
    let err = provider
        .send_cancellable(&user_message("hi"), &before, &mut |delta| {
            seen.push(delta.to_owned())
        })
        .expect_err("pre-cancelled token must fail");
    assert_eq!(err, ChatError::Cancelled);
    assert!(seen.is_empty(), "{seen:?}");

    let during = CancelToken::new();
    let mut seen: Vec<String> = Vec::new();
    let err = provider
        .send_cancellable(&user_message("hi"), &during, &mut |delta| {
            seen.push(delta.to_owned());
            during.cancel();
        })
        .expect_err("cancellation between deltas must fail");
    assert_eq!(err, ChatError::Cancelled);
    assert_eq!(seen, ["a"]);
}

#[test]
fn draft_accepts_valid_person_and_event() {
    let person = person();
    let create_person = draft(DraftKind::CreatePerson, &person);
    create_person.validate(&[], &[], &[]).expect("valid person");

    let mut event = Event::new(person.id, EventType::Birth);
    event.date = DateValue::exact_year(1950);
    let create_event = draft(DraftKind::CreateEvent, &event);
    create_event
        .validate(std::slice::from_ref(&person), &[], &[])
        .expect("valid event");

    let update_person = draft(DraftKind::UpdatePerson, &person);
    update_person
        .validate(std::slice::from_ref(&person), &[], &[])
        .expect("existing person can be updated");

    let child = self::person();
    let row = Relationship::new(RelationshipType::ParentChild, person.id, child.id)
        .expect("valid relationship");
    let create_relationship = draft(DraftKind::CreateRelationship, &row);
    create_relationship
        .validate(&[person.clone(), child], &[], &[])
        .expect("valid relationship");
}

#[test]
fn draft_rejects_death_before_birth() {
    let mut person = person();
    person.birth = DateValue::exact_year(1950);
    person.death = DateValue::exact_year(1940);

    let err = draft(DraftKind::CreatePerson, &person)
        .validate(&[], &[], &[])
        .unwrap_err();

    assert_eq!(err.code, gentree_core::codes::VALIDATION_ERROR);
    assert_eq!(err.params.get("field").map(String::as_str), Some("death"));
    assert_eq!(
        err.params.get("rule").map(String::as_str),
        Some("beforeBirth")
    );
}

#[test]
fn draft_rejects_dangling_relationship() {
    let person = person();
    let missing = Uuid::now_v7();
    let row = Relationship::new(RelationshipType::ParentChild, person.id, missing)
        .expect("relationship shape");

    let err = draft(DraftKind::CreateRelationship, &row)
        .validate(std::slice::from_ref(&person), &[], &[])
        .unwrap_err();

    assert_eq!(err.code, gentree_core::codes::VALIDATION_ERROR);
    assert_eq!(
        err.params.get("field").map(String::as_str),
        Some("relatedPersonId")
    );
    assert_eq!(err.params.get("rule").map(String::as_str), Some("notFound"));
}

#[test]
fn draft_rejects_payload_of_another_kind_and_unknown_kind() {
    let person = person();
    let err = draft(DraftKind::CreateRelationship, &person)
        .validate(std::slice::from_ref(&person), &[], &[])
        .unwrap_err();
    assert_eq!(err.code, gentree_core::codes::VALIDATION_ERROR);
    assert_eq!(err.params.get("field").map(String::as_str), Some("payload"));
    assert_eq!(err.params.get("rule").map(String::as_str), Some("invalid"));

    let unknown: Result<DraftKind, _> = serde_json::from_str(r#""DELETE_EVERYTHING""#);
    assert!(unknown.is_err(), "an unknown kind must not deserialize");

    let update_missing = draft(DraftKind::UpdatePerson, &person);
    let err = update_missing.validate(&[], &[], &[]).unwrap_err();
    assert_eq!(
        err.params.get("field").map(String::as_str),
        Some("personId")
    );
    assert_eq!(err.params.get("rule").map(String::as_str), Some("notFound"));
}

#[test]
fn draft_rejects_dangling_target_id() {
    let person = person();
    let mut create = draft(DraftKind::CreatePerson, &person);
    create.target_ids = vec![Uuid::now_v7()];

    let err = create.validate(&[], &[], &[]).unwrap_err();

    assert_eq!(err.code, gentree_core::codes::VALIDATION_ERROR);
    assert_eq!(
        err.params.get("field").map(String::as_str),
        Some("targetId")
    );
    assert_eq!(err.params.get("rule").map(String::as_str), Some("notFound"));
}

#[test]
fn draft_rejects_empty_evidence() {
    let person = person();
    let mut create = draft(DraftKind::CreatePerson, &person);
    create.evidence = vec![DraftEvidence {
        source: "metric book".to_owned(),
        quote_hash: String::new(),
    }];

    let err = create.validate(&[], &[], &[]).unwrap_err();
    assert_eq!(
        err.params.get("field").map(String::as_str),
        Some("evidence")
    );
    assert_eq!(err.params.get("rule").map(String::as_str), Some("required"));
}

fn tool_spec() -> ToolSpec {
    ToolSpec::new(
        "search",
        "Search persons, events and sources in one project.",
        serde_json::json!({
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }),
    )
}

fn tool_call_body() -> &'static str {
    r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"search","arguments":"{\"query\":\"Petrov\"}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}"#
}

#[test]
fn send_tools_posts_the_catalogue_and_parses_tool_calls() {
    let (base_url, requests, server) =
        serve(|stream| write_status(stream, "200 OK", tool_call_body()));
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");

    let turn = provider
        .send_tools(&user_message("who is Petrov?"), &[tool_spec()])
        .expect("tool turn");
    server.join().expect("mock server");

    assert_eq!(turn.content, None, "content is null for a pure tool turn");
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].id, "call_1");
    assert_eq!(turn.tool_calls[0].name, "search");
    assert_eq!(
        turn.tool_calls[0]
            .arguments_json()
            .expect("arguments JSON")
            .get("query")
            .and_then(serde_json::Value::as_str),
        Some("Petrov")
    );
    assert_eq!(turn.usage.map(|usage| usage.total_tokens), Some(7));

    let request = request_text(&requests);
    assert!(
        request.starts_with("POST /v1/chat/completions "),
        "{request}"
    );
    let sent = body(&request);
    assert_eq!(sent["model"], "test-model");
    assert_eq!(sent["messages"][0]["role"], "user");
    assert_eq!(sent["tool_choice"], "auto");
    assert!(
        sent.get("stream").is_none(),
        "tool turns must be non-streaming: {sent}"
    );
    assert_eq!(sent["tools"][0]["type"], "function");
    assert_eq!(sent["tools"][0]["function"]["name"], "search");
    assert_eq!(sent["tools"][0]["function"]["parameters"]["type"], "object");
    assert_eq!(header(&request, "authorization"), None);
}

#[test]
fn send_tools_stream_accumulates_calls_and_emits_content_deltas() {
    let (base_url, requests, server) = serve(|stream| {
        write_sse(
            stream,
            &[
                r#"{"choices":[{"delta":{"content":"Looking "}}]}"#,
                r#"{"choices":[{"delta":{"content":"up."}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\"query\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Petrov\"}"}}]}}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}"#,
                "[DONE]",
            ],
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");

    let mut deltas = Vec::new();
    let turn = provider
        .send_tools_stream(
            &user_message("who is Petrov?"),
            &[tool_spec()],
            &CancelToken::new(),
            &mut |delta| deltas.push(delta.to_owned()),
        )
        .expect("streamed tool turn");
    server.join().expect("mock server");

    assert_eq!(deltas, ["Looking ", "up."]);
    assert_eq!(turn.content.as_deref(), Some("Looking up."));
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].id, "call_1");
    assert_eq!(turn.tool_calls[0].name, "search");
    assert_eq!(
        turn.tool_calls[0]
            .arguments_json()
            .expect("assembled arguments JSON")["query"],
        "Petrov"
    );
    assert_eq!(turn.usage.map(|usage| usage.total_tokens), Some(7));

    let sent = body(&request_text(&requests));
    assert_eq!(sent["stream"], true);
    assert_eq!(sent["stream_options"]["include_usage"], true);
    assert_eq!(sent["tools"][0]["function"]["name"], "search");
    assert_eq!(sent["tool_choice"], "auto");
}

#[test]
fn streamed_reasoning_is_collected_and_only_replayed_when_present() {
    let (base_url, _requests, server) = serve(|stream| {
        write_sse(
            stream,
            &[
                r#"{"choices":[{"delta":{"reasoning_content":"Need the person. "}}]}"#,
                r#"{"choices":[{"delta":{"reasoning_content":"Searching. "}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\"query\":\"Petrov\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
                "[DONE]",
            ],
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");

    let turn = provider
        .send_tools_stream(
            &user_message("who is Petrov?"),
            &[tool_spec()],
            &CancelToken::new(),
            &mut |_| {},
        )
        .expect("streamed tool turn");
    server.join().expect("mock server");

    assert_eq!(
        turn.reasoning.as_deref(),
        Some("Need the person. Searching. "),
        "the chain of thought must survive the stream"
    );
    let replay = ChatMessage::assistant_tool_calls("", turn.tool_calls.clone())
        .with_reasoning(turn.reasoning.clone());
    let sent = serde_json::to_value(&replay).expect("assistant message");
    assert_eq!(sent["reasoning_content"], "Need the person. Searching. ");

    let plain = serde_json::to_value(
        ChatMessage::assistant_tool_calls("", turn.tool_calls).with_reasoning(Some(String::new())),
    )
    .expect("assistant message");
    assert!(
        plain.get("reasoning_content").is_none(),
        "an empty chain of thought must not add a wire field: {plain}"
    );
}

#[test]
fn streamed_turn_truncated_by_max_tokens_is_truncated_and_not_retried() {
    let (base_url, connections, server) = serve_counting_first(|stream| {
        write_sse(
            stream,
            &[
                r#"{"choices":[{"delta":{"reasoning_content":"Thinking hard..."}}]}"#,
                r#"{"choices":[{"delta":{"content":""},"finish_reason":"length"}]}"#,
                "[DONE]",
            ],
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");

    let err = provider
        .send_tools_stream(
            &user_message("a hard question"),
            &[tool_spec()],
            &CancelToken::new(),
            &mut |_| {},
        )
        .expect_err("an empty truncated turn must fail");
    server.join().expect("mock server");

    assert_eq!(err, ChatError::Truncated);
    assert_eq!(
        connections.load(Ordering::SeqCst),
        1,
        "a budget failure must not be retried as a non-streaming request"
    );
}

#[test]
fn non_stream_tool_turn_truncated_by_max_tokens_is_truncated() {
    let (base_url, _requests, server) = serve(|stream| {
        write_status(
            stream,
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":""},"finish_reason":"length"}]}"#,
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");

    let err = provider
        .send_tools(&user_message("a hard question"), &[tool_spec()])
        .expect_err("an empty truncated turn must fail");
    server.join().expect("mock server");

    assert_eq!(err, ChatError::Truncated);
}

#[test]
fn text_turn_truncated_by_max_tokens_is_truncated() {
    let (base_url, _requests, server) = serve(|stream| {
        write_sse(
            stream,
            &[
                r#"{"choices":[{"delta":{"reasoning_content":"Thinking hard..."}}]}"#,
                r#"{"choices":[{"delta":{"content":""},"finish_reason":"length"}]}"#,
                "[DONE]",
            ],
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");

    let err = provider
        .send(&user_message("a hard question"), &mut |_| {})
        .expect_err("an empty truncated answer must fail");
    server.join().expect("mock server");

    assert_eq!(err, ChatError::Truncated);
}

#[test]
fn tool_turn_then_content_is_sent_back_as_assistant_and_tool_messages() {
    let (base_url, first_request, server) =
        serve(|stream| write_status(stream, "200 OK", tool_call_body()));
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let first = provider
        .send_tools(&user_message("who is Petrov?"), &[tool_spec()])
        .expect("tool turn");
    server.join().expect("mock server");
    drop(first_request);

    let messages = vec![
        ChatMessage::new(ChatRole::User, "who is Petrov?"),
        ChatMessage::assistant_tool_calls("", first.tool_calls.clone()),
        ChatMessage::tool_result("call_1", r#"{"results":[{"title":"Petrov"}]}"#),
    ];

    let (base_url, second_request, server) = serve(|stream| {
        write_status(
            stream,
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":"Found one person."}}]}"#,
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let final_turn = provider
        .send_tools(&messages, &[tool_spec()])
        .expect("final turn");
    server.join().expect("mock server");

    assert_eq!(final_turn.content.as_deref(), Some("Found one person."));
    assert!(final_turn.tool_calls.is_empty());

    let sent = body(&request_text(&second_request));
    assert_eq!(sent["messages"][0]["role"], "user");
    assert_eq!(sent["messages"][1]["role"], "assistant");
    assert_eq!(sent["messages"][1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(
        sent["messages"][1]["tool_calls"][0]["function"]["name"],
        "search"
    );
    assert_eq!(sent["messages"][2]["role"], "tool");
    assert_eq!(sent["messages"][2]["tool_call_id"], "call_1");
}

#[test]
fn malformed_tool_calls_map_to_protocol() {
    let (base_url, _requests, server) = serve(|stream| {
        write_status(
            stream,
            "200 OK",
            r#"{"choices":[{"message":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":""}}]}}]}"#,
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let err = provider
        .send_tools(&user_message("hi"), &[tool_spec()])
        .expect_err("a nameless tool call must fail");
    server.join().expect("mock server");

    assert!(
        matches!(err, ChatError::Protocol(_)),
        "unexpected error: {err:?}"
    );
}

#[test]
fn tool_completion_without_content_or_calls_maps_to_protocol() {
    let (base_url, _requests, server) = serve(|stream| {
        write_status(
            stream,
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":""}}]}"#,
        );
    });
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let err = provider
        .send_tools(&user_message("hi"), &[tool_spec()])
        .expect_err("an empty completion must fail");
    server.join().expect("mock server");

    assert!(
        matches!(err, ChatError::Protocol(ref message) if message.contains("neither")),
        "unexpected error: {err:?}"
    );
}

#[test]
fn send_tools_without_a_catalogue_is_unsupported() {
    let (base_url, connections, server) = serve_counting();
    let provider = OpenAiCompatibleProvider::new(config(base_url)).expect("provider");
    let err = provider
        .send_tools(&user_message("hi"), &[])
        .expect_err("no tools means no tool request");
    let connections = connections.load(Ordering::SeqCst);
    drop(server);

    assert_eq!(err, ChatError::Unsupported);
    assert_eq!(
        connections, 0,
        "an empty catalogue must not call the provider"
    );
}

#[test]
fn default_send_tools_is_unsupported() {
    let provider = StubProvider { deltas: vec!["hi"] };
    let err = provider
        .send_tools(&user_message("hi"), &[tool_spec()])
        .expect_err("the stub has no tool transport");
    assert_eq!(err, ChatError::Unsupported);
}

#[test]
fn tool_call_messages_serialize_in_the_openai_shape_and_skip_empty_fields() {
    let call = ToolCall::new("call_1", "search", r#"{"query":"Petrov"}"#);
    let assistant = serde_json::to_value(ChatMessage::assistant_tool_calls("", vec![call]))
        .expect("assistant message");
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["tool_calls"][0]["id"], "call_1");
    assert_eq!(assistant["tool_calls"][0]["type"], "function");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        r#"{"query":"Petrov"}"#
    );

    let tool =
        serde_json::to_value(ChatMessage::tool_result("call_1", "{}")).expect("tool message");
    assert_eq!(tool["role"], "tool");
    assert_eq!(tool["tool_call_id"], "call_1");
    assert!(tool.get("tool_calls").is_none());

    let plain =
        serde_json::to_value(ChatMessage::new(ChatRole::User, "hi")).expect("plain message");
    assert!(plain.get("tool_calls").is_none());
    assert!(plain.get("tool_call_id").is_none());

    let restored: ChatMessage = serde_json::from_value(assistant).expect("assistant round-trip");
    assert_eq!(restored.tool_calls.len(), 1);
    assert_eq!(restored.tool_calls[0].name, "search");
}

#[test]
fn system_prompt_states_ui_locale_and_date_rule() {
    let prompt = system_prompt("ru", "Семья Петровых", Some("project-id"));

    assert!(prompt.contains("UI locale: ru"), "{prompt}");
    assert!(
        prompt.contains("\"ru\""),
        "locale must be explicit: {prompt}"
    );
    assert!(
        prompt.contains("never invent dates"),
        "date rule is missing: {prompt}"
    );
    assert!(
        prompt.contains("keep the date unknown"),
        "unknown dates must stay unknown: {prompt}"
    );
    assert!(
        prompt.contains("update_person"),
        "person-editing rule is missing: {prompt}"
    );
    assert!(
        prompt.contains("before/after card"),
        "confirmation-card rule is missing: {prompt}"
    );
    assert!(
        prompt.contains("do not translate"),
        "no-translation rule is missing: {prompt}"
    );
    assert!(
        prompt.contains("gentree://person/"),
        "person-link rule is missing: {prompt}"
    );
    assert!(
        prompt.contains("Семья Петровых"),
        "project name must be passed as-is: {prompt}"
    );
    assert!(
        prompt.contains("Current project id: project-id"),
        "project id must be explicit: {prompt}"
    );

    let english = system_prompt("en", "Petrov family", None);
    assert!(english.contains("UI locale: en"));
    assert!(!english.contains("UI locale: ru"));
    assert!(english.contains("Current project id: -"));
}

#[test]
fn system_prompt_appends_core_and_selected_skills() {
    let skills = route("Найди бабушку Марию");
    let prompt = system_prompt_with_skills("ru", "Семья Петровых", None, &skills);
    assert!(prompt.contains("## Skill: core"), "{prompt}");
    assert!(prompt.contains("## Skill: find-person"), "{prompt}");
    assert!(prompt.contains("Desktop tool contract"), "{prompt}");
    assert!(prompt.contains("get_tree_overview()"), "{prompt}");
    assert!(!prompt.contains("get_tree_overview(treeId)"), "{prompt}");
    assert!(!prompt.contains("## Skill: person-profile"), "{prompt}");
}
