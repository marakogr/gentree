//! Launcher preferences persisted in the app config directory.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{codes, LauncherError};

/// Launcher preferences. The locale is stored by the webview in
/// `localStorage`; only behavior that must survive a reload without JS lives
/// here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Check the feed when the window opens. On by default: keeping Gentree
    /// current is the launcher's job. Nothing is installed without a click.
    pub auto_check: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto_check: true }
    }
}

/// Reads settings, falling back to defaults for a missing or corrupt file.
pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Writes settings atomically (temp file + rename).
pub fn save(path: &Path, settings: &Settings) -> Result<(), LauncherError> {
    let parent = path
        .parent()
        .ok_or_else(|| LauncherError::new(codes::SETTINGS_IO))?;
    fs::create_dir_all(parent).map_err(|_| LauncherError::new(codes::SETTINGS_IO))?;
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|_| LauncherError::new(codes::SETTINGS_IO))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|_| LauncherError::new(codes::SETTINGS_IO))?;
    fs::rename(&temporary, path).map_err(|_| LauncherError::new(codes::SETTINGS_IO))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_auto_check_enabled() {
        assert!(Settings::default().auto_check);
    }

    #[test]
    fn round_trips_through_the_config_file() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("settings.json");

        save(&path, &Settings { auto_check: false }).expect("save");
        let loaded = load(&path);

        assert_eq!(loaded, Settings { auto_check: false });
    }

    #[test]
    fn falls_back_to_defaults_for_a_missing_file() {
        let dir = tempfile::tempdir().expect("temp");

        assert_eq!(load(&dir.path().join("absent.json")), Settings::default());
    }

    #[test]
    fn falls_back_to_defaults_for_a_corrupt_file() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("settings.json");
        fs::write(&path, b"not json").expect("write");

        assert_eq!(load(&path), Settings::default());
    }
}
