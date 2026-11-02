//! Minimal local diagnostics log.
//!
//! The desktop app has no console in a release build, so transport and tool
//! failures must leave a file behind. The log deliberately contains only
//! technical metadata: request ids, error codes, tool names, durations and
//! sizes. It never records prompts, answers, person data, tool arguments, tool
//! results or the API key.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Creates `<app data>/logs` and remembers `gentree.log`.
pub fn init(app: &AppHandle) {
    if let Ok(root) = app.path().app_data_dir() {
        let dir = root.join("logs");
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = LOG_PATH.set(dir.join("gentree.log"));
        }
    }
}

/// Absolute path of the current log file, when logging is initialized.
pub fn path() -> Option<&'static Path> {
    LOG_PATH.get().map(PathBuf::as_path)
}

pub fn info(target: &str, message: impl AsRef<str>) {
    append("INFO", target, message.as_ref());
}

pub fn warn(target: &str, message: impl AsRef<str>) {
    append("WARN", target, message.as_ref());
}

pub fn error(target: &str, message: impl AsRef<str>) {
    append("ERROR", target, message.as_ref());
}

fn append(level: &str, target: &str, message: &str) {
    let Some(path) = LOG_PATH.get() else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{timestamp} {level} {target}: {message}");
    }
}
