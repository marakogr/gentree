//! Layered configuration (YAML/JSON). Contract: design.md §10, ADR-0012.
//!
//! Precedence: defaults → explicit layers (global, project) → `GENTREE_*`
//! environment variables → CLI (not implemented in WP-07a).
//!
//! - Unknown keys produce warnings, never errors.
//! - Invalid values produce [`ConfigError`] with code `CONFIG_INVALID`; the
//!   caller keeps the defaults and shows the error in the settings screen.
//! - Paths are `~`-expanded and must be absolute.
//! - `chat.api_key_env` holds an env var *name*; the key value is never read
//!   into the config.

mod error;
mod model;
mod paths;

pub use error::ConfigError;
pub use model::{
    AppConfig, AppSection, BackupSection, ChatSection, CustomEventField, EventFieldGroup,
    EventFieldsSection, EventTypesSection, GeocoderProvider, GeocoderSection, HistoricalSection,
    Language, MapBasemap, MapSection, SearchSection, StorageSection, Style, Theme, UpdatesSection,
    DEFAULT_AUTOSAVE_MS, DEFAULT_BACKUP_KEEP, DEFAULT_CHAT_API_KEY_ENV, DEFAULT_CHAT_PROVIDER,
    DEFAULT_DADATA_BASE_URL, DEFAULT_GEOCODER_API_KEY_ENV, DEFAULT_GEOCODER_TIMEOUT_SECONDS,
    DEFAULT_HISTORICAL_TIMEOUT_SECONDS, DEFAULT_MAP_TILE_URL, DEFAULT_PHOTON_BASE_URL,
    DEFAULT_WIKIDATA_API_URL, MAX_CUSTOM_EVENT_FIELDS, MAX_CUSTOM_EVENT_TYPES,
    MAX_EVENT_FIELD_GROUPS, MAX_EVENT_FIELD_LABEL, MAX_EVENT_TYPE_NAME, RESERVED_EVENT_DETAIL_KEYS,
};
pub use paths::{default_paths, expand_path, DefaultPaths, APP_DIR_NAME, CONFIG_FILE_NAME};

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// One source of configuration.
#[derive(Debug, Clone)]
pub struct ConfigLayer {
    /// Human-readable origin used in warnings: `global`, `project`, `patch`.
    pub origin: String,
    pub source: LayerSource,
}

#[derive(Debug, Clone)]
pub enum LayerSource {
    /// Optional file; a missing file is skipped. Format follows the extension:
    /// `.json` is JSON, everything else is YAML.
    File(PathBuf),
    /// Already-parsed mapping (tests, CLI, inline project settings).
    Value(Value),
}

impl ConfigLayer {
    pub fn file(origin: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            origin: origin.into(),
            source: LayerSource::File(path.into()),
        }
    }

    pub fn value(origin: impl Into<String>, value: Value) -> Self {
        Self {
            origin: origin.into(),
            source: LayerSource::Value(value),
        }
    }
}

/// Known keys per section; anything else is a warning.
const SECTIONS: &[(&str, &[&str])] = &[
    ("app", &["language", "theme", "style", "graph_whole_tree"]),
    ("event_types", &["custom"]),
    ("event_fields", &["custom"]),
    ("storage", &["projects_dir", "backups_dir", "autosave_ms"]),
    ("search", &["index_dir"]),
    (
        "chat",
        &[
            "enabled",
            "provider",
            "base_url",
            "model",
            "api_key_env",
            "temperature",
            "max_tokens",
            "timeout_seconds",
            "stream",
            "show_tools",
            "allow_person_edits",
        ],
    ),
    ("backup", &["enabled", "on_close", "daily", "keep"]),
    ("updates", &["auto_check"]),
    (
        "geocoder",
        &[
            "enabled",
            "provider",
            "photon_base_url",
            "dadata_base_url",
            "api_key_env",
            "timeout_seconds",
        ],
    ),
    ("map", &["basemap", "tile_url"]),
    (
        "historical_geocoder",
        &["enabled", "api_url", "timeout_seconds"],
    ),
];

/// Loads every layer over the defaults and returns the config plus warnings.
///
/// Environment variables (`GENTREE_*`) are applied after the explicit layers.
/// A layer with an unsupported shape is a parse error, not a panic.
pub fn load(layers: &[ConfigLayer]) -> Result<(AppConfig, Vec<String>), ConfigError> {
    let mut warnings = Vec::new();
    let mut merged = default_value()?;
    for layer in layers {
        let Some(value) = read_layer(layer)? else {
            continue;
        };
        let Value::Object(object) = &value else {
            return Err(ConfigError::parse(
                &layer.origin,
                "config layer must be a mapping",
            ));
        };
        check_unknown_keys(object, &layer.origin, &mut warnings);
        merge_value(&mut merged, value);
    }
    let config = finish(merged, true, &mut warnings)?;
    Ok((config, warnings))
}

/// Deep-merges a partial settings patch into `current` and validates the
/// result. `null` removes a key, so the default comes back. Environment
/// variables are deliberately not applied: a patch is what the user persists.
pub fn apply_patch(
    current: &AppConfig,
    patch: &Value,
) -> Result<(AppConfig, Vec<String>), ConfigError> {
    let mut warnings = Vec::new();
    let mut merged = to_value(current)?;
    merge_patch(&mut merged, patch, &mut warnings)?;
    let config = finish(merged, false, &mut warnings)?;
    Ok((config, warnings))
}

/// Applies a patch to the global file and writes it atomically.
///
/// If the existing file cannot be read or parsed, the warning is returned and
/// the write starts from the defaults, so a broken file is recoverable from the
/// settings screen.
pub fn update_global(path: &Path, patch: &Value) -> Result<(AppConfig, Vec<String>), ConfigError> {
    let mut warnings = Vec::new();
    let mut merged = default_value()?;
    match read_file(path, "global") {
        Ok(Some(Value::Object(object))) => {
            check_unknown_keys(&object, "global", &mut warnings);
            merge_value(&mut merged, Value::Object(object));
        }
        Ok(Some(_)) => {
            warnings.push("the global config is not a mapping; defaults were used".to_owned())
        }
        Ok(None) => {}
        Err(error) => warnings.push(format!("the existing config was ignored: {error}")),
    }
    merge_patch(&mut merged, patch, &mut warnings)?;
    let config = finish(merged, false, &mut warnings)?;
    write_file(path, &config)?;
    Ok((config, warnings))
}

fn default_value() -> Result<Value, ConfigError> {
    to_value(&AppConfig::default())
}

fn to_value(config: &AppConfig) -> Result<Value, ConfigError> {
    serde_json::to_value(config).map_err(|error| ConfigError::invalid("config", error.to_string()))
}

fn read_layer(layer: &ConfigLayer) -> Result<Option<Value>, ConfigError> {
    match &layer.source {
        LayerSource::File(path) => read_file(path, &layer.origin),
        LayerSource::Value(value) => Ok(Some(value.clone())),
    }
}

fn finish(
    merged: Value,
    with_env: bool,
    warnings: &mut Vec<String>,
) -> Result<AppConfig, ConfigError> {
    check_enum_value(&merged, "app", "language", &Language::VALUES)?;
    check_enum_value(&merged, "app", "theme", &Theme::VALUES)?;
    check_enum_value(&merged, "app", "style", &Style::VALUES)?;
    let mut config: AppConfig = serde_json::from_value(merged)
        .map_err(|error| ConfigError::invalid("config", error.to_string()))?;
    if with_env {
        apply_env(&mut config)?;
    }
    config.normalize_event_types();
    config.normalize_event_fields();
    // A key that became built in after the user saved a custom field with it is
    // ignored, not fatal: the rest of the config must stay usable.
    for collision in config.drop_builtin_event_field_collisions() {
        warnings.push(format!(
            "custom event field \"{collision}\" was ignored: the key is built in"
        ));
    }
    config.normalize_paths()?;
    config.validate()?;
    Ok(config)
}

fn check_enum_value(
    root: &Value,
    section: &str,
    key: &str,
    allowed: &[&str],
) -> Result<(), ConfigError> {
    let Some(value) = root.get(section).and_then(|value| value.get(key)) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let Some(text) = value.as_str() else {
        return Err(ConfigError::invalid(
            format!("{section}.{key}"),
            format!("must be one of: {}", allowed.join(", ")),
        ));
    };
    if allowed.contains(&text) {
        return Ok(());
    }
    Err(ConfigError::invalid(
        format!("{section}.{key}"),
        format!("`{text}` is not one of: {}", allowed.join(", ")),
    ))
}

fn check_unknown_keys(object: &Map<String, Value>, origin: &str, warnings: &mut Vec<String>) {
    for (section, value) in object {
        let Some((name, keys)) = SECTIONS.iter().find(|(name, _)| name == section) else {
            warnings.push(format!(
                "unknown config key \"{section}\" in {origin} layer"
            ));
            continue;
        };
        let Value::Object(inner) = value else {
            continue;
        };
        for key in inner.keys() {
            if !keys.contains(&key.as_str()) {
                warnings.push(format!(
                    "unknown config key \"{name}.{key}\" in {origin} layer"
                ));
            }
        }
    }
}

fn merge_patch(
    merged: &mut Value,
    patch: &Value,
    warnings: &mut Vec<String>,
) -> Result<(), ConfigError> {
    if patch.is_null() {
        return Ok(());
    }
    let Value::Object(object) = patch else {
        return Err(ConfigError::parse(
            "patch",
            "settings patch must be a mapping",
        ));
    };
    check_unknown_keys(object, "patch", warnings);
    merge_value(merged, patch.clone());
    Ok(())
}

/// JSON Merge Patch semantics: objects merge recursively, `null` deletes a key,
/// everything else replaces the previous value.
fn merge_value(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                if value.is_null() {
                    base_map.remove(&key);
                } else if let Some(existing) = base_map.get_mut(&key) {
                    merge_value(existing, value);
                } else {
                    base_map.insert(key, value);
                }
            }
        }
        (slot, value) => *slot = value,
    }
}

fn apply_env(config: &mut AppConfig) -> Result<(), ConfigError> {
    if let Some(value) = env_value("GENTREE_APP_LANGUAGE") {
        config.app.language = Language::parse(&value).ok_or_else(|| {
            ConfigError::invalid(
                "app.language",
                "GENTREE_APP_LANGUAGE must be system, ru, en, uk, be, de or es",
            )
        })?;
    }
    if let Some(value) = env_value("GENTREE_APP_THEME") {
        config.app.theme = match value.to_ascii_lowercase().as_str() {
            "system" => Theme::System,
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            _ => {
                return Err(ConfigError::invalid(
                    "app.theme",
                    "GENTREE_APP_THEME must be system, light or dark",
                ))
            }
        };
    }
    if let Some(value) = env_value("GENTREE_APP_STYLE") {
        config.app.style = match value.to_ascii_lowercase().as_str() {
            "classic" => Style::Classic,
            "swiss" => Style::Swiss,
            _ => {
                return Err(ConfigError::invalid(
                    "app.style",
                    "GENTREE_APP_STYLE must be classic or swiss",
                ))
            }
        };
    }
    if let Some(value) = env_value("GENTREE_STORAGE_PROJECTS_DIR") {
        config.storage.projects_dir = PathBuf::from(value);
    }
    if let Some(value) = env_value("GENTREE_STORAGE_BACKUPS_DIR") {
        config.storage.backups_dir = PathBuf::from(value);
    }
    if let Some(value) = env_number("GENTREE_STORAGE_AUTOSAVE_MS", "storage.autosave_ms")? {
        config.storage.autosave_ms = value;
    }
    if let Some(value) = env_value("GENTREE_SEARCH_INDEX_DIR") {
        config.search.index_dir = PathBuf::from(value);
    }

    if let Some(value) = env_bool("GENTREE_CHAT_ENABLED", "chat.enabled")? {
        config.chat.enabled = value;
    }
    if let Some(value) = env_value("GENTREE_CHAT_PROVIDER") {
        config.chat.provider = value;
    }
    if let Some(value) = env_value("GENTREE_CHAT_BASE_URL") {
        config.chat.base_url = value;
    }
    if let Some(value) = env_value("GENTREE_CHAT_MODEL") {
        config.chat.model = value;
    }
    if let Some(value) = env_value("GENTREE_CHAT_API_KEY_ENV") {
        config.chat.api_key_env = value;
    }
    if let Some(value) = env_number("GENTREE_CHAT_TEMPERATURE", "chat.temperature")? {
        config.chat.temperature = value;
    }
    if let Some(value) = env_number("GENTREE_CHAT_MAX_TOKENS", "chat.max_tokens")? {
        config.chat.max_tokens = value;
    }
    if let Some(value) = env_number("GENTREE_CHAT_TIMEOUT_SECONDS", "chat.timeout_seconds")? {
        config.chat.timeout_seconds = value;
    }
    if let Some(value) = env_bool("GENTREE_CHAT_STREAM", "chat.stream")? {
        config.chat.stream = value;
    }
    if let Some(value) = env_bool("GENTREE_CHAT_SHOW_TOOLS", "chat.show_tools")? {
        config.chat.show_tools = value;
    }
    if let Some(value) = env_bool("GENTREE_CHAT_ALLOW_PERSON_EDITS", "chat.allow_person_edits")? {
        config.chat.allow_person_edits = value;
    }

    if let Some(value) = env_bool("GENTREE_BACKUP_ENABLED", "backup.enabled")? {
        config.backup.enabled = value;
    }
    if let Some(value) = env_bool("GENTREE_BACKUP_ON_CLOSE", "backup.on_close")? {
        config.backup.on_close = value;
    }
    if let Some(value) = env_bool("GENTREE_BACKUP_DAILY", "backup.daily")? {
        config.backup.daily = value;
    }
    if let Some(value) = env_number("GENTREE_BACKUP_KEEP", "backup.keep")? {
        config.backup.keep = value;
    }
    if let Some(value) = env_bool("GENTREE_UPDATES_AUTO_CHECK", "updates.auto_check")? {
        config.updates.auto_check = value;
    }
    Ok(())
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_bool(name: &str, key: &str) -> Result<Option<bool>, ConfigError> {
    let Some(raw) = env_value(name) else {
        return Ok(None);
    };
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => Err(ConfigError::invalid(
            key,
            format!("{name} must be a boolean"),
        )),
    }
}

fn env_number<T>(name: &str, key: &str) -> Result<Option<T>, ConfigError>
where
    T: std::str::FromStr,
{
    let Some(raw) = env_value(name) else {
        return Ok(None);
    };
    raw.parse::<T>()
        .map(Some)
        .map_err(|_| ConfigError::invalid(key, format!("{name} must be a number")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigFormat {
    Yaml,
    Json,
}

fn format_for(path: &Path) -> ConfigFormat {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("json") => ConfigFormat::Json,
        _ => ConfigFormat::Yaml,
    }
}

/// Reads and parses a config file. `None` means the file does not exist.
pub fn read_file(path: &Path, origin: &str) -> Result<Option<Value>, ConfigError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ConfigError::io(path, &error)),
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let value: Value = match format_for(path) {
        ConfigFormat::Json => serde_json::from_str(text)
            .map_err(|error| ConfigError::parse(origin, format!("invalid JSON: {error}")))?,
        ConfigFormat::Yaml => serde_norway::from_str(text)
            .map_err(|error| ConfigError::parse(origin, format!("invalid YAML: {error}")))?,
    };
    Ok(Some(value))
}

fn serialize(config: &AppConfig, path: &Path) -> Result<String, ConfigError> {
    match format_for(path) {
        ConfigFormat::Json => serde_json::to_string_pretty(config)
            .map_err(|error| ConfigError::invalid("config", error.to_string())),
        ConfigFormat::Yaml => serde_norway::to_string(config)
            .map_err(|error| ConfigError::invalid("config", error.to_string())),
    }
}

/// Writes a config file atomically: temp file in the same directory, `fsync`,
/// then rename over the target.
pub fn write_file(path: &Path, config: &AppConfig) -> Result<(), ConfigError> {
    let text = serialize(config, path)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| ConfigError::io(parent, &error))?;
        }
    }
    let temp = temp_path(path);
    let result = (|| {
        let mut file =
            std::fs::File::create(&temp).map_err(|error| ConfigError::io(&temp, &error))?;
        file.write_all(text.as_bytes())
            .map_err(|error| ConfigError::io(&temp, &error))?;
        file.sync_all()
            .map_err(|error| ConfigError::io(&temp, &error))?;
        drop(file);
        std::fs::rename(&temp, path).map_err(|error| ConfigError::io(path, &error))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_owned());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.tmp-{}-{nanos}", std::process::id()))
}
