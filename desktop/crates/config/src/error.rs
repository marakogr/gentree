//! Configuration errors. Contract: design.md §10, ADR-0012, ADR-0014.
//!
//! A config error never panics and never stops the application: the caller
//! keeps the defaults and reports the error in the settings screen. Codes are
//! `CONFIG_INVALID` for contract violations and `IO_ERROR` for file-system
//! failures; `message` is English and only for logs and technical output.

use std::fmt;
use std::path::Path;

use gentree_core::error::codes;
use gentree_core::AppError;

/// Why a config layer could not be loaded or validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// A known key carries a value that violates the contract.
    Invalid { key: String, reason: String },
    /// A layer exists but cannot be parsed.
    Parse { origin: String, reason: String },
    /// A layer cannot be read or written.
    Io { path: String, reason: String },
}

impl ConfigError {
    pub fn invalid(key: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Invalid {
            key: key.into(),
            reason: reason.into(),
        }
    }

    pub fn parse(origin: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Parse {
            origin: origin.into(),
            reason: reason.into(),
        }
    }

    pub fn io(path: &Path, error: &std::io::Error) -> Self {
        Self::Io {
            path: path.display().to_string(),
            reason: error.to_string(),
        }
    }

    /// Stable error code from ADR-0014.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io { .. } => codes::IO_ERROR,
            Self::Invalid { .. } | Self::Parse { .. } => codes::CONFIG_INVALID,
        }
    }

    /// Settings key the error belongs to, when one is known.
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::Invalid { key, .. } => Some(key),
            Self::Parse { .. } | Self::Io { .. } => None,
        }
    }

    /// Converts to the shared Tauri error envelope. The UI renders
    /// `errors.<code>`, never `message`.
    pub fn to_app_error(&self) -> AppError {
        let error = AppError::new(self.code(), self.to_string());
        match self {
            Self::Invalid { key, .. } => error.with_param("key", key.clone()),
            Self::Parse { origin, .. } => error.with_param("origin", origin.clone()),
            Self::Io { path, .. } => error.with_param("path", path.clone()),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { key, reason } => write!(f, "invalid config value for {key}: {reason}"),
            Self::Parse { origin, reason } => {
                write!(f, "cannot parse config layer {origin}: {reason}")
            }
            Self::Io { path, reason } => write!(f, "cannot access config file {path}: {reason}"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_maps_to_config_invalid_code() {
        let error = ConfigError::invalid("storage.projects_dir", "path must be absolute");
        assert_eq!(error.code(), codes::CONFIG_INVALID);
        let envelope = error.to_app_error();
        assert_eq!(envelope.code, codes::CONFIG_INVALID);
        assert_eq!(
            envelope.params.get("key").map(String::as_str),
            Some("storage.projects_dir")
        );
    }

    #[test]
    fn io_maps_to_io_error_code() {
        let error = ConfigError::Io {
            path: "config.yaml".to_owned(),
            reason: "denied".to_owned(),
        };
        assert_eq!(error.code(), codes::IO_ERROR);
        assert_eq!(error.to_app_error().code, codes::IO_ERROR);
    }
}
