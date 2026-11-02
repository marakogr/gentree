//! Settings state and Tauri commands. Contract: design.md §7, §10; ADR-0012.
//!
//! The config never stops the application: an invalid file or layer is kept as
//! `error` in the snapshot, the defaults stay active and the UI shows
//! `errors.CONFIG_INVALID`.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use gentree_config::{default_paths, update_global, AppConfig, ConfigError, ConfigLayer, Language};
use gentree_core::error::codes;
use gentree_core::AppError;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

pub struct ConfigState {
    config: AppConfig,
    warnings: Vec<String>,
    error: Option<ConfigError>,
    global_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub config: AppConfig,
    pub warnings: Vec<String>,
    pub error: Option<AppError>,
    pub config_path: String,
    pub chat_api_key_present: bool,
    /// Only the fact that the DaData key env var is set; the key never leaves
    /// the process (ADR-0016).
    pub geocoder_api_key_present: bool,
}

impl ConfigState {
    /// Current effective config. Other modules only read the sections they own.
    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    pub fn initial() -> Self {
        let global_path = default_paths()
            .map(|paths| paths.global_config_path)
            .unwrap_or_else(|_| gentree_config::DefaultPaths::fallback().global_config_path);
        let mut state = Self {
            config: AppConfig::default(),
            warnings: Vec::new(),
            error: None,
            global_path,
        };
        state.reload();
        state
    }

    fn reload(&mut self) {
        let layer = ConfigLayer::file("global", self.global_path.clone());
        match gentree_config::load(&[layer]) {
            Ok((config, warnings)) => {
                self.config = config;
                self.warnings = warnings;
                self.error = None;
            }
            Err(error) => {
                self.config = AppConfig::default();
                self.warnings = Vec::new();
                self.error = Some(error);
            }
        }
        self.ensure_directories();
    }

    fn ensure_directories(&mut self) {
        for (key, path) in self.config.directories() {
            if let Err(error) = std::fs::create_dir_all(path) {
                self.warnings.push(format!("cannot create {key}: {error}"));
            }
        }
    }

    fn update(&mut self, patch: &Value) -> Result<(), ConfigError> {
        update_global(&self.global_path, patch)?;
        self.reload();
        Ok(())
    }

    fn snapshot(&self) -> SettingsSnapshot {
        SettingsSnapshot {
            config: self.config.clone(),
            warnings: self.warnings.clone(),
            error: self.error.as_ref().map(ConfigError::to_app_error),
            config_path: self.global_path.display().to_string(),
            chat_api_key_present: env_present(&self.config.chat.api_key_env),
            geocoder_api_key_present: env_present(&self.config.geocoder.api_key_env),
        }
    }
}

/// The key itself is never returned to the UI, only the fact that it is set.
fn env_present(name: &str) -> bool {
    crate::envvars::value(name).is_some()
}

fn lock<'a>(
    state: &'a State<'_, Mutex<ConfigState>>,
) -> Result<MutexGuard<'a, ConfigState>, AppError> {
    state
        .lock()
        .map_err(|_| AppError::new(codes::UNKNOWN, "settings state poisoned"))
}

#[tauri::command]
pub fn settings_get(state: State<'_, Mutex<ConfigState>>) -> Result<SettingsSnapshot, AppError> {
    Ok(lock(&state)?.snapshot())
}

#[tauri::command]
pub fn settings_update(
    state: State<'_, Mutex<ConfigState>>,
    patch: Value,
) -> Result<SettingsSnapshot, AppError> {
    let mut guard = lock(&state)?;
    guard.update(&patch).map_err(|error| error.to_app_error())?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub fn settings_reload(state: State<'_, Mutex<ConfigState>>) -> Result<SettingsSnapshot, AppError> {
    let mut guard = lock(&state)?;
    guard.reload();
    Ok(guard.snapshot())
}

#[tauri::command]
pub fn settings_locale(
    state: State<'_, Mutex<ConfigState>>,
    locale: String,
) -> Result<SettingsSnapshot, AppError> {
    let language = Language::parse(&locale).ok_or_else(|| {
        ConfigError::invalid(
            "app.language",
            "locale must be system, ru, en, uk, be, de or es",
        )
        .to_app_error()
    })?;
    let mut guard = lock(&state)?;
    guard
        .update(&json!({ "app": { "language": language.as_str() } }))
        .map_err(|error| error.to_app_error())?;
    Ok(guard.snapshot())
}

/// Reveal one of the configured locations in the OS file manager.
///
/// The renderer names a location (`kind`), never a path: all paths come from
/// `ConfigState`, so a compromised renderer cannot ask the backend to open an
/// arbitrary file. Unknown kinds are a validation error, missing paths are
/// `NOT_FOUND`.
#[tauri::command]
pub fn settings_open_path(
    state: State<'_, Mutex<ConfigState>>,
    kind: String,
) -> Result<bool, AppError> {
    let (path, select) = {
        let guard = lock(&state)?;
        match kind.as_str() {
            "projects" => (guard.config.storage.projects_dir.clone(), false),
            "backups" => (guard.config.storage.backups_dir.clone(), false),
            "index" => (guard.config.search.index_dir.clone(), false),
            "config" => (guard.global_path.clone(), true),
            _ => return Err(AppError::validation("kind", "unknown")),
        }
    };
    if !path.exists() {
        return Err(AppError::new(codes::NOT_FOUND, "Configured path not found"));
    }
    crate::open_in_file_manager(&path, select)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state whose only interesting property is the geocoder key env var; the
    /// global path is never read by `snapshot`.
    fn state_with_key_env(name: &str) -> ConfigState {
        let mut config = AppConfig::default();
        config.geocoder.api_key_env = name.to_owned();
        ConfigState {
            config,
            warnings: Vec::new(),
            error: None,
            global_path: PathBuf::from("config.yaml"),
        }
    }

    #[test]
    fn snapshot_reports_geocoder_key_presence_without_the_key() {
        // Unique per process so a developer's real environment cannot leak in.
        let name = format!("GENTREE_TEST_DADATA_KEY_{}", std::process::id());
        let state = state_with_key_env(&name);

        std::env::remove_var(&name);
        let absent = state.snapshot();
        assert!(!absent.geocoder_api_key_present);
        let json = serde_json::to_string(&absent).expect("serialize");
        assert!(json.contains("\"geocoderApiKeyPresent\":false"));

        std::env::set_var(&name, "test-key-not-a-real-secret");
        let present = state.snapshot();
        std::env::remove_var(&name);

        assert!(present.geocoder_api_key_present);
        let json = serde_json::to_string(&present).expect("serialize");
        assert!(json.contains("\"geocoderApiKeyPresent\":true"));
        assert!(
            !json.contains("test-key-not-a-real-secret"),
            "the key value must never reach the snapshot"
        );
    }
}
