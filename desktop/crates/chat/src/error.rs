//! Chat transport errors.
//!
//! Contract: design.md §9, ADR-0012. `Display`/`Debug` intentionally never
//! carry the request headers or the API key: the key lives only in
//! `ChatConfig::api_key` and in the `Authorization` header of a live request.

use thiserror::Error;

/// Failure of one chat request.
///
/// The variants are the stable mapping used by the command layer
/// (`CHAT_UNAVAILABLE`, `CHAT_CANCELLED`); the UI renders its own localized
/// copy and never shows a Rust message.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ChatError {
    /// The provider did not answer within `ChatConfig::timeout_seconds`.
    #[error("chat provider timed out")]
    Timeout,

    /// HTTP 401/403: the endpoint rejected the credentials.
    #[error("chat provider rejected the credentials")]
    Unauthorized,

    /// Network failure or HTTP 5xx: retry later or check the settings.
    #[error("chat provider is unavailable")]
    Unavailable,

    /// The endpoint answered with something that is not a valid
    /// OpenAI-compatible payload (bad SSE event, unexpected status/body).
    #[error("chat provider protocol error: {0}")]
    Protocol(String),

    /// The turn ended before any final text existed because the output budget
    /// ran out: thinking models spend `max_tokens` on `reasoning_content`
    /// first, so `finish_reason=length` with empty `content` is a budget
    /// failure, not a malformed payload. Separate from [`ChatError::Protocol`]
    /// on purpose: retrying the same request cannot help.
    #[error("chat provider ran out of output tokens")]
    Truncated,

    /// The provider implementation (or the deployed model) cannot call tools.
    #[error("chat provider does not support tools")]
    Unsupported,

    /// The caller cancelled the request through [`CancelToken`](crate::CancelToken).
    /// The command layer maps it onto `CHAT_CANCELLED`; a partial answer is a
    /// draft message and is never written to the project.
    #[error("chat request cancelled")]
    Cancelled,
}
