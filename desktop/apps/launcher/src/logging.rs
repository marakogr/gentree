//! Minimal local diagnostics log for the launcher.
//!
//! Only technical metadata is written: event names, versions, artifact sizes,
//! durations and stable error codes. Feed URLs, install paths, hashes and any
//! token-like value never reach this file.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Creates `<app data>/logs` and remembers `launcher.log`.
pub fn init(directory: &Path) {
    if std::fs::create_dir_all(directory).is_ok() {
        let _ = LOG_PATH.set(directory.join("launcher.log"));
    }
}

pub fn info(target: &str, message: impl AsRef<str>) {
    append("INFO", target, message.as_ref());
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
