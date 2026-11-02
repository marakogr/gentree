//! Stable error codes for the launcher UI.
//!
//! Every failure crosses the IPC boundary as `{ code, detail? }`. The code is a
//! stable ASCII identifier that the UI maps to a localized message; `detail`
//! carries non-sensitive technical context (an HTTP status, a field name, a
//! process exit code) and never an absolute path, URL or token.

use serde::Serialize;

/// Codes shared with `ui/app.js` (`error.<code>` locale keys).
pub mod codes {
    pub const FEED_PARSE: &str = "feed_parse";
    pub const FEED_SCHEMA: &str = "feed_schema";
    pub const FEED_APP: &str = "feed_app";
    pub const FEED_VERSION: &str = "feed_version";
    pub const FEED_RELEASED: &str = "feed_released";
    pub const FEED_SHA256: &str = "feed_sha256";
    pub const FEED_URL: &str = "feed_url";
    pub const FEED_LATEST: &str = "feed_latest";
    pub const FEED_FILES: &str = "feed_files";
    pub const FEED_TOO_LARGE: &str = "feed_too_large";
    pub const FEED_NOT_CONFIGURED: &str = "feed_not_configured";

    pub const HTTP_STATUS: &str = "http_status";
    pub const NETWORK: &str = "network";
    pub const DOWNLOAD_WRITE: &str = "download_write";
    pub const DOWNLOAD_READ: &str = "download_read";
    pub const CHECKSUM_MISMATCH: &str = "checksum_mismatch";
    pub const SIZE_MISMATCH: &str = "size_mismatch";

    pub const APP_RUNNING: &str = "app_running";
    pub const PROCESS_CHECK: &str = "process_check";
    pub const NO_FILE: &str = "no_file";
    pub const UNSUPPORTED_PLATFORM: &str = "unsupported_platform";
    pub const INSTALL_FAILED: &str = "install_failed";
    pub const OPEN_FAILED: &str = "open_failed";
    pub const NOT_INSTALLED: &str = "not_installed";

    pub const SETTINGS_IO: &str = "settings_io";
    pub const INTERNAL: &str = "internal";
}

/// One localized, stable launcher failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl LauncherError {
    pub fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

impl std::fmt::Display for LauncherError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Some(detail) => write!(formatter, "{} ({detail})", self.code),
            None => formatter.write_str(self.code),
        }
    }
}

impl std::error::Error for LauncherError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_with_a_stable_code() {
        let error = LauncherError::with_detail(codes::HTTP_STATUS, "404");
        let json = serde_json::to_string(&error).expect("serialize");

        assert_eq!(json, r#"{"code":"http_status","detail":"404"}"#);
    }

    #[test]
    fn errors_without_detail_omit_the_field() {
        let error = LauncherError::new(codes::CHECKSUM_MISMATCH);
        let json = serde_json::to_string(&error).expect("serialize");

        assert_eq!(json, r#"{"code":"checksum_mismatch"}"#);
    }
}
