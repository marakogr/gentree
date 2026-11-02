//! Cooperative cancellation of one chat request (design.md §9, ADR-0012).
//!
//! `chat.cancel(requestId)` flips the flag; the transport polls it while the
//! stream is open and stops with [`ChatError::Cancelled`](crate::ChatError).
//! The token is shared (`Arc`) and cheap to clone, so the command layer keeps
//! one handle per `requestId` and hands another to the transport.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Cancellation flag for a single request. Clones share the same flag.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests cancellation. Idempotent and callable from any thread.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// `true` once [`CancelToken::cancel`] has been called.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
