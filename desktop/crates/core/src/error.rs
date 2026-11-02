use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stable error codes. UI maps `code` to `errors.<code>`; `message` is English
/// and only for logs and technical output.
pub mod codes {
    pub const PROJECT_NOT_FOUND: &str = "PROJECT_NOT_FOUND";
    pub const PROJECT_LOCKED: &str = "PROJECT_LOCKED";
    pub const PROJECT_CORRUPTED: &str = "PROJECT_CORRUPTED";
    pub const FORMAT_VERSION_UNSUPPORTED: &str = "FORMAT_VERSION_UNSUPPORTED";
    pub const VALIDATION_ERROR: &str = "VALIDATION_ERROR";
    pub const RELATIONSHIP_CYCLE: &str = "RELATIONSHIP_CYCLE";
    pub const DUPLICATE_RELATIONSHIP: &str = "DUPLICATE_RELATIONSHIP";
    pub const PROJECT_ISOLATION_VIOLATION: &str = "PROJECT_ISOLATION_VIOLATION";
    pub const IMPORT_PARSE_ERROR: &str = "IMPORT_PARSE_ERROR";
    pub const BACKUP_CHECKSUM_MISMATCH: &str = "BACKUP_CHECKSUM_MISMATCH";
    pub const IO_ERROR: &str = "IO_ERROR";
    pub const CONFIG_INVALID: &str = "CONFIG_INVALID";
    pub const CHAT_UNAVAILABLE: &str = "CHAT_UNAVAILABLE";
    pub const CHAT_CANCELLED: &str = "CHAT_CANCELLED";
    /// Online address suggestions are enabled but no provider could answer.
    pub const GEOCODER_UNAVAILABLE: &str = "GEOCODER_UNAVAILABLE";
    /// The build has no update endpoint or public key, so no request was made.
    pub const UPDATE_NOT_CONFIGURED: &str = "UPDATE_NOT_CONFIGURED";
    /// The update endpoint could not be reached or returned no usable manifest.
    pub const UPDATE_CHECK_FAILED: &str = "UPDATE_CHECK_FAILED";
    /// A found update could not be downloaded, verified or installed.
    pub const UPDATE_INSTALL_FAILED: &str = "UPDATE_INSTALL_FAILED";
    pub const STALE_WRITE: &str = "STALE_WRITE";
    /// Two project snapshots cannot be merged with the requested decisions:
    /// a decision is inconsistent, a non-empty field conflicts without an
    /// explicit policy, or the result would not validate.
    pub const MERGE_CONFLICT: &str = "MERGE_CONFLICT";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const UNKNOWN: &str = "UNKNOWN";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<Value>,
    /// English, technical. Never rendered by the UI.
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            params: BTreeMap::new(),
            details: Vec::new(),
            message: message.into(),
        }
    }

    pub fn with_param(mut self, key: &str, value: impl Into<String>) -> Self {
        self.params.insert(key.to_owned(), value.into());
        self
    }

    pub fn validation(field: &str, rule: &str) -> Self {
        Self::new(codes::VALIDATION_ERROR, "Validation failed")
            .with_param("field", field)
            .with_param("rule", rule)
    }

    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::new(codes::IO_ERROR, source.to_string()).with_param("context", context)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;
