//! Typed configuration contract (design.md §10, ADR-0012 §Config).
//!
//! Keys are snake_case in YAML and JSON. Unknown keys are warnings produced by
//! [`crate::load`]; invalid values are [`crate::ConfigError::Invalid`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use gentree_core::event_fields::{builtin_event_field_keys, is_valid_event_detail_key};
use gentree_core::record::EventType;

use crate::error::ConfigError;
use crate::paths::expand_path;

/// Default autosave interval; `0` means "autosave disabled".
pub const DEFAULT_AUTOSAVE_MS: u64 = 800;
/// Default provider kind. The model itself is never hardcoded.
pub const DEFAULT_CHAT_PROVIDER: &str = "openai-compatible";
/// Default env var holding the chat key (name, never the value).
pub const DEFAULT_CHAT_API_KEY_ENV: &str = "GENTREE_CHAT_API_KEY";
pub const DEFAULT_BACKUP_KEEP: u32 = 10;
/// Public Photon instance (OpenStreetMap). Fair use; self-hosting is allowed.
pub const DEFAULT_PHOTON_BASE_URL: &str = "https://photon.komoot.io/api/";
/// DaData address suggestions endpoint (Russian addresses).
pub const DEFAULT_DADATA_BASE_URL: &str =
    "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address";
/// Env var holding the DaData key (name, never the value).
pub const DEFAULT_GEOCODER_API_KEY_ENV: &str = "DADATA_API_KEY";
/// Default network timeout for one address suggestion request.
pub const DEFAULT_GEOCODER_TIMEOUT_SECONDS: u64 = 10;
/// Standard OpenStreetMap raster tiles. Attribution is required; the URL is
/// configurable so a self-hosted or other provider can be used (ADR-0020).
pub const DEFAULT_MAP_TILE_URL: &str = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
/// Wikidata API for historical place names (ADR-0021). No key is required.
pub const DEFAULT_WIKIDATA_API_URL: &str = "https://www.wikidata.org/w/api.php";
/// Default timeout for one historical suggestion request.
pub const DEFAULT_HISTORICAL_TIMEOUT_SECONDS: u64 = 10;
/// Longest accepted custom event type name, in characters.
pub const MAX_EVENT_TYPE_NAME: usize = 60;
/// Upper bound on user-defined event types in one config.
pub const MAX_CUSTOM_EVENT_TYPES: usize = 50;
/// Upper bound on `event_fields.custom` groups in one config.
pub const MAX_EVENT_FIELD_GROUPS: usize = 50;
/// Upper bound on custom fields of one event type.
pub const MAX_CUSTOM_EVENT_FIELDS: usize = 20;
/// Longest accepted custom field label, in characters.
pub const MAX_EVENT_FIELD_LABEL: usize = 80;
/// Detail keys that would collide with the event's own shape (ADR-0015).
pub const RESERVED_EVENT_DETAIL_KEYS: [&str; 6] =
    ["id", "type", "date", "place", "description", "details"];

/// Values used when a key is missing or explicitly `null`.
mod defaults {
    use std::path::PathBuf;

    use crate::paths::DefaultPaths;

    pub(super) fn projects_dir() -> PathBuf {
        DefaultPaths::resolve_or_fallback().projects_dir
    }

    pub(super) fn backups_dir() -> PathBuf {
        DefaultPaths::resolve_or_fallback().backups_dir
    }

    pub(super) fn index_dir() -> PathBuf {
        DefaultPaths::resolve_or_fallback().index_dir
    }

    pub(super) fn autosave_ms() -> u64 {
        super::DEFAULT_AUTOSAVE_MS
    }

    pub(super) fn chat_provider() -> String {
        super::DEFAULT_CHAT_PROVIDER.to_owned()
    }

    pub(super) fn chat_base_url() -> String {
        "http://127.0.0.1:11434/v1".to_owned()
    }

    pub(super) fn chat_model() -> String {
        String::new()
    }

    pub(super) fn chat_api_key_env() -> String {
        super::DEFAULT_CHAT_API_KEY_ENV.to_owned()
    }

    pub(super) fn chat_temperature() -> f64 {
        0.2
    }

    /// Thinking models spend `max_tokens` on the chain of thought before the
    /// answer, so a small cap produces an empty `finish_reason=length` turn.
    /// 8192 leaves room for reasoning plus a full answer.
    pub(super) fn chat_max_tokens() -> u32 {
        8192
    }

    pub(super) fn chat_timeout_seconds() -> u64 {
        60
    }

    pub(super) fn chat_stream() -> bool {
        true
    }

    pub(super) fn backup_keep() -> u32 {
        super::DEFAULT_BACKUP_KEEP
    }

    pub(super) fn geocoder_provider() -> super::GeocoderProvider {
        super::GeocoderProvider::Both
    }

    pub(super) fn geocoder_enabled() -> bool {
        true
    }

    pub(super) fn photon_base_url() -> String {
        super::DEFAULT_PHOTON_BASE_URL.to_owned()
    }

    pub(super) fn dadata_base_url() -> String {
        super::DEFAULT_DADATA_BASE_URL.to_owned()
    }

    pub(super) fn geocoder_api_key_env() -> String {
        super::DEFAULT_GEOCODER_API_KEY_ENV.to_owned()
    }

    pub(super) fn geocoder_timeout_seconds() -> u64 {
        super::DEFAULT_GEOCODER_TIMEOUT_SECONDS
    }

    pub(super) fn map_basemap() -> super::MapBasemap {
        super::MapBasemap::Osm
    }

    pub(super) fn map_tile_url() -> String {
        super::DEFAULT_MAP_TILE_URL.to_owned()
    }

    pub(super) fn historical_enabled() -> bool {
        true
    }

    pub(super) fn wikidata_api_url() -> String {
        super::DEFAULT_WIKIDATA_API_URL.to_owned()
    }

    pub(super) fn historical_timeout_seconds() -> u64 {
        super::DEFAULT_HISTORICAL_TIMEOUT_SECONDS
    }
}

/// `app.language`: `system|ru|en|uk|be|de|es`; `system` falls back to `ru`
/// (ADR-0014).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    Ru,
    En,
    Uk,
    Be,
    De,
    Es,
}

impl Language {
    pub const VALUES: [&'static str; 7] = ["system", "ru", "en", "uk", "be", "de", "es"];

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "system" => Some(Self::System),
            "ru" => Some(Self::Ru),
            "en" => Some(Self::En),
            "uk" => Some(Self::Uk),
            "be" => Some(Self::Be),
            "de" => Some(Self::De),
            "es" => Some(Self::Es),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Ru => "ru",
            Self::En => "en",
            Self::Uk => "uk",
            Self::Be => "be",
            Self::De => "de",
            Self::Es => "es",
        }
    }
}

/// `app.theme`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub const VALUES: [&'static str; 3] = ["system", "light", "dark"];
}

/// `app.style`: the visual language, independent of the light/dark scheme.
///
/// `classic` is the shipping look and the default, so an existing config keeps
/// its appearance; `swiss` is an opt-in redesign (design-system/gentree).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    #[default]
    Classic,
    Swiss,
}

impl Style {
    pub const VALUES: [&'static str; 2] = ["classic", "swiss"];
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AppSection {
    #[serde(default)]
    pub language: Language,
    #[serde(default)]
    pub theme: Theme,
    #[serde(default)]
    pub style: Style,
    /// Feature flag for the rootless "whole tree" graph mode. Off by default:
    /// a project-wide tree is unreadable once every generation is expanded.
    #[serde(default)]
    pub graph_whole_tree: bool,
}

/// `event_types`: the built-in types stay in the database enum. `custom` holds
/// extra display names; an event using one is stored as `OTHER` plus
/// `original_type`, so no schema change is needed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EventTypesSection {
    #[serde(default)]
    pub custom: Vec<String>,
}

/// `event_fields`: extra detail fields per event type (ADR-0015).
///
/// The section is global app config, not part of the project: labels live
/// here, values live in `events.jsonl`. `custom` works for built-in event type
/// codes and for labels from `event_types.custom`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EventFieldsSection {
    #[serde(default)]
    pub custom: Vec<EventFieldGroup>,
}

/// Fields added to one event type. `type` is a built-in code (`OCCUPATION`) or
/// a custom type label, matched case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventFieldGroup {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub fields: Vec<CustomEventField>,
}

/// One user-defined detail field. `key` is the stable id stored in event
/// `details`; `label` is display text only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomEventField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub multiline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageSection {
    #[serde(default = "defaults::projects_dir")]
    pub projects_dir: PathBuf,
    #[serde(default = "defaults::backups_dir")]
    pub backups_dir: PathBuf,
    /// `0` disables autosave.
    #[serde(default = "defaults::autosave_ms")]
    pub autosave_ms: u64,
}

impl Default for StorageSection {
    fn default() -> Self {
        Self {
            projects_dir: defaults::projects_dir(),
            backups_dir: defaults::backups_dir(),
            autosave_ms: DEFAULT_AUTOSAVE_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchSection {
    #[serde(default = "defaults::index_dir")]
    pub index_dir: PathBuf,
}

impl Default for SearchSection {
    fn default() -> Self {
        Self {
            index_dir: defaults::index_dir(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatSection {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "defaults::chat_provider")]
    pub provider: String,
    #[serde(default = "defaults::chat_base_url")]
    pub base_url: String,
    /// Empty means "not configured"; no model is hardcoded.
    #[serde(default = "defaults::chat_model")]
    pub model: String,
    /// Name of the env var, never the key value (ADR-0012).
    #[serde(default = "defaults::chat_api_key_env")]
    pub api_key_env: String,
    #[serde(default = "defaults::chat_temperature")]
    pub temperature: f64,
    #[serde(default = "defaults::chat_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "defaults::chat_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "defaults::chat_stream")]
    pub stream: bool,
    /// Feature flag for the chat screen: render tool calls with their input
    /// and result. Off by default so normal users see only the answer.
    #[serde(default)]
    pub show_tools: bool,
    /// Let the chat edit existing persons through `update_person`. Off by
    /// default; even when on, every write still requires an explicit
    /// confirmation card in the UI.
    #[serde(default)]
    pub allow_person_edits: bool,
}

impl Default for ChatSection {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: defaults::chat_provider(),
            base_url: defaults::chat_base_url(),
            model: defaults::chat_model(),
            api_key_env: defaults::chat_api_key_env(),
            temperature: defaults::chat_temperature(),
            max_tokens: defaults::chat_max_tokens(),
            timeout_seconds: defaults::chat_timeout_seconds(),
            stream: defaults::chat_stream(),
            show_tools: false,
            allow_person_edits: false,
        }
    }
}

/// `geocoder.provider`: which online address provider(s) may be queried.
///
/// `both` queries DaData for Cyrillic input and Photon otherwise; a missing
/// DaData key silently falls back to Photon only (ADR-0016).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeocoderProvider {
    Photon,
    Dadata,
    #[default]
    Both,
}

impl GeocoderProvider {
    pub const VALUES: [&'static str; 3] = ["photon", "dadata", "both"];
}

/// `geocoder`: online address suggestions (ADR-0016).
///
/// On by default: the first run may send a typed address to Photon/DaData. The
/// settings screen has an explicit switch, and while it is off no request
/// leaves the machine. `api_key_env` is the *name* of the env var holding the
/// DaData key; the key itself is never part of the config, the snapshot or the
/// log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeocoderSection {
    #[serde(default = "defaults::geocoder_enabled")]
    pub enabled: bool,
    #[serde(default = "defaults::geocoder_provider")]
    pub provider: GeocoderProvider,
    #[serde(default = "defaults::photon_base_url")]
    pub photon_base_url: String,
    #[serde(default = "defaults::dadata_base_url")]
    pub dadata_base_url: String,
    #[serde(default = "defaults::geocoder_api_key_env")]
    pub api_key_env: String,
    #[serde(default = "defaults::geocoder_timeout_seconds")]
    pub timeout_seconds: u64,
}

impl Default for GeocoderSection {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: defaults::geocoder_provider(),
            photon_base_url: defaults::photon_base_url(),
            dadata_base_url: defaults::dadata_base_url(),
            api_key_env: defaults::geocoder_api_key_env(),
            timeout_seconds: defaults::geocoder_timeout_seconds(),
        }
    }
}

/// `historical_geocoder`: resolve historical names through Wikidata (ADR-0021).
///
/// On by default, like the address suggestions, with an explicit switch. Only
/// the typed place name is sent; no key is needed. The API is configurable so a
/// self-hosted Wikibase can be used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoricalSection {
    #[serde(default = "defaults::historical_enabled")]
    pub enabled: bool,
    #[serde(default = "defaults::wikidata_api_url")]
    pub api_url: String,
    #[serde(default = "defaults::historical_timeout_seconds")]
    pub timeout_seconds: u64,
}

impl Default for HistoricalSection {
    fn default() -> Self {
        Self {
            enabled: defaults::historical_enabled(),
            api_url: defaults::wikidata_api_url(),
            timeout_seconds: defaults::historical_timeout_seconds(),
        }
    }
}

/// `map.basemap`: whether the map may request OpenStreetMap raster tiles.
///
/// `osm` requests tiles only when the Map tab is opened; `offline` never does
/// and shows the bundled outline (ADR-0020).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapBasemap {
    #[default]
    Osm,
    Offline,
}

impl MapBasemap {
    pub const VALUES: [&'static str; 2] = ["osm", "offline"];
}

/// `map`: the event map basemap (ADR-0020).
///
/// Coordinates stay in the project; only the tile URL is configuration. Nothing
/// is requested at application start or while another tab is open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MapSection {
    #[serde(default = "defaults::map_basemap")]
    pub basemap: MapBasemap,
    #[serde(default = "defaults::map_tile_url")]
    pub tile_url: String,
}

impl Default for MapSection {
    fn default() -> Self {
        Self {
            basemap: defaults::map_basemap(),
            tile_url: defaults::map_tile_url(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupSection {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub on_close: bool,
    /// At most one automatic backup per day.
    #[serde(default)]
    pub daily: bool,
    #[serde(default = "defaults::backup_keep")]
    pub keep: u32,
}

impl Default for BackupSection {
    fn default() -> Self {
        Self {
            enabled: true,
            on_close: true,
            daily: true,
            keep: DEFAULT_BACKUP_KEEP,
        }
    }
}

/// `updates`: in-app update checks (Tauri updater).
///
/// Off by default. While `auto_check` is off the only request is one the user
/// starts with "Check for updates"; the app never contacts the update server on
/// its own. The endpoint and the public key are release-build settings in
/// `tauri.conf.json`, not user config, so a project file or a stale settings
/// file can never redirect updates to another host.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct UpdatesSection {
    #[serde(default)]
    pub auto_check: bool,
}

/// Full configuration contract; every section has serde defaults.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub app: AppSection,
    #[serde(default)]
    pub event_types: EventTypesSection,
    #[serde(default)]
    pub event_fields: EventFieldsSection,
    #[serde(default)]
    pub storage: StorageSection,
    #[serde(default)]
    pub search: SearchSection,
    #[serde(default)]
    pub chat: ChatSection,
    #[serde(default)]
    pub geocoder: GeocoderSection,
    #[serde(default)]
    pub historical_geocoder: HistoricalSection,
    #[serde(default)]
    pub map: MapSection,
    #[serde(default)]
    pub backup: BackupSection,
    #[serde(default)]
    pub updates: UpdatesSection,
}

impl AppConfig {
    /// Expands `~` in every path and requires absolute results.
    pub fn normalize_paths(&mut self) -> Result<(), ConfigError> {
        self.storage.projects_dir =
            expand_path("storage.projects_dir", &self.storage.projects_dir)?;
        self.storage.backups_dir = expand_path("storage.backups_dir", &self.storage.backups_dir)?;
        self.search.index_dir = expand_path("search.index_dir", &self.search.index_dir)?;
        Ok(())
    }

    /// Trims custom event type names so a hand-edited file keeps no padding.
    /// Empty names survive this step and are rejected by [`Self::validate`].
    pub fn normalize_event_types(&mut self) {
        for name in &mut self.event_types.custom {
            *name = name.trim().to_owned();
        }
    }

    /// Trims group types and labels, and lowercases field keys so a hand-edited
    /// file stores the same stable key the UI writes. Labels stay user text.
    pub fn normalize_event_fields(&mut self) {
        for group in &mut self.event_fields.custom {
            group.event_type = group.event_type.trim().to_owned();
            for field in &mut group.fields {
                field.key = field.key.trim().to_ascii_lowercase();
                field.label = field.label.trim().to_owned();
            }
        }
    }

    /// Drops custom fields that reuse a built-in key of the same event type and
    /// returns their `type.key` paths.
    ///
    /// A config written before that key became built in must stay loadable: the
    /// duplicate field is ignored, while the rest of the group and every other
    /// custom field survive. [`Self::validate`] still rejects a collision on a
    /// config constructed in memory, so callers can surface it as an error.
    pub fn drop_builtin_event_field_collisions(&mut self) -> Vec<String> {
        let mut dropped = Vec::new();
        for group in &mut self.event_fields.custom {
            let event_type = group.event_type.trim().to_owned();
            let Some(builtin) = EventType::from_code(&event_type) else {
                continue;
            };
            let builtin_keys = builtin_event_field_keys(builtin);
            group.fields.retain(|field| {
                if builtin_keys.contains(&field.key.as_str()) {
                    dropped.push(format!("{event_type}.{}", field.key));
                    false
                } else {
                    true
                }
            });
        }
        dropped
    }

    /// Contract checks that do not touch the file system.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if !self.chat.temperature.is_finite() || !(0.0..=2.0).contains(&self.chat.temperature) {
            return Err(ConfigError::invalid(
                "chat.temperature",
                "must be between 0 and 2",
            ));
        }
        if self.chat.max_tokens == 0 {
            return Err(ConfigError::invalid(
                "chat.max_tokens",
                "must be greater than zero",
            ));
        }
        if self.chat.timeout_seconds == 0 {
            return Err(ConfigError::invalid(
                "chat.timeout_seconds",
                "must be greater than zero",
            ));
        }
        if self.chat.api_key_env.trim().is_empty() {
            return Err(ConfigError::invalid(
                "chat.api_key_env",
                "must name an environment variable",
            ));
        }
        if !self.chat.base_url.trim().is_empty() && !is_http_url(&self.chat.base_url) {
            return Err(ConfigError::invalid(
                "chat.base_url",
                "must start with http:// or https://",
            ));
        }
        if self.chat.enabled {
            if self.chat.base_url.trim().is_empty() {
                return Err(ConfigError::invalid(
                    "chat.base_url",
                    "required when chat is enabled",
                ));
            }
            if self.chat.provider.trim().is_empty() {
                return Err(ConfigError::invalid(
                    "chat.provider",
                    "required when chat is enabled",
                ));
            }
            if self.chat.model.trim().is_empty() {
                return Err(ConfigError::invalid(
                    "chat.model",
                    "required when chat is enabled",
                ));
            }
        }
        if self.backup.keep == 0 {
            return Err(ConfigError::invalid("backup.keep", "must be at least 1"));
        }
        self.validate_event_types()?;
        self.validate_event_fields()?;
        self.validate_geocoder()?;
        self.validate_historical()?;
        self.validate_map()?;
        Ok(())
    }

    /// Online address suggestions stay opt-in. Both endpoints must be HTTP(S),
    /// the key is referenced by a non-empty env var name and the timeout must be
    /// positive, so a broken config fails on load instead of at the first
    /// request. An unknown `provider` is rejected by serde.
    fn validate_geocoder(&self) -> Result<(), ConfigError> {
        if !is_http_url(&self.geocoder.photon_base_url) {
            return Err(ConfigError::invalid(
                "geocoder.photon_base_url",
                "must start with http:// or https://",
            ));
        }
        if !is_http_url(&self.geocoder.dadata_base_url) {
            return Err(ConfigError::invalid(
                "geocoder.dadata_base_url",
                "must start with http:// or https://",
            ));
        }
        if self.geocoder.api_key_env.trim().is_empty() {
            return Err(ConfigError::invalid(
                "geocoder.api_key_env",
                "must name an environment variable",
            ));
        }
        if self.geocoder.timeout_seconds == 0 {
            return Err(ConfigError::invalid(
                "geocoder.timeout_seconds",
                "must be greater than zero",
            ));
        }
        Ok(())
    }

    /// Wikidata must be HTTP(S) and the timeout positive; an unavailable
    /// service falls back to modern suggestions, so this cannot block the app.
    fn validate_historical(&self) -> Result<(), ConfigError> {
        if !is_http_url(&self.historical_geocoder.api_url) {
            return Err(ConfigError::invalid(
                "historical_geocoder.api_url",
                "must start with http:// or https://",
            ));
        }
        if self.historical_geocoder.timeout_seconds == 0 {
            return Err(ConfigError::invalid(
                "historical_geocoder.timeout_seconds",
                "must be greater than zero",
            ));
        }
        Ok(())
    }

    /// The map tile URL must be HTTP(S); an unknown `basemap` is rejected by
    /// serde. The URL is never fetched while the Map tab is closed.
    fn validate_map(&self) -> Result<(), ConfigError> {
        if !is_http_url(&self.map.tile_url) {
            return Err(ConfigError::invalid(
                "map.tile_url",
                "must start with http:// or https://",
            ));
        }
        Ok(())
    }

    /// Custom event type names are labels, not enum values: they must be
    /// non-empty, at most [`MAX_EVENT_TYPE_NAME`] characters, unique
    /// case-insensitively and limited to [`MAX_CUSTOM_EVENT_TYPES`] entries.
    fn validate_event_types(&self) -> Result<(), ConfigError> {
        let custom = &self.event_types.custom;
        if custom.len() > MAX_CUSTOM_EVENT_TYPES {
            return Err(ConfigError::invalid(
                "event_types.custom",
                format!("must contain at most {MAX_CUSTOM_EVENT_TYPES} names"),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for name in custom {
            if name.trim().is_empty() {
                return Err(ConfigError::invalid(
                    "event_types.custom",
                    "names must not be empty",
                ));
            }
            if name.chars().count() > MAX_EVENT_TYPE_NAME {
                return Err(ConfigError::invalid(
                    "event_types.custom",
                    format!("a name is longer than {MAX_EVENT_TYPE_NAME} characters"),
                ));
            }
            if !seen.insert(name.to_lowercase()) {
                return Err(ConfigError::invalid(
                    "event_types.custom",
                    "names must be unique, ignoring case",
                ));
            }
        }
        Ok(())
    }

    /// Custom event fields are global config (ADR-0015). The type is a built-in
    /// code or a custom label and need not be declared in `event_types.custom`:
    /// an unused group is allowed. Keys must be stable snake_case ids and may
    /// not collide with the event shape or with the built-in keys of that type.
    fn validate_event_fields(&self) -> Result<(), ConfigError> {
        let groups = &self.event_fields.custom;
        if groups.len() > MAX_EVENT_FIELD_GROUPS {
            return Err(ConfigError::invalid(
                "event_fields.custom",
                format!("must contain at most {MAX_EVENT_FIELD_GROUPS} groups"),
            ));
        }

        let mut seen_types = HashSet::new();
        for (group_index, group) in groups.iter().enumerate() {
            let group_path = format!("event_fields.custom[{group_index}]");
            let event_type = group.event_type.trim();
            if event_type.is_empty() {
                return Err(ConfigError::invalid(
                    format!("{group_path}.type"),
                    "must not be empty",
                ));
            }
            if event_type.chars().count() > MAX_EVENT_TYPE_NAME {
                return Err(ConfigError::invalid(
                    format!("{group_path}.type"),
                    format!("must be at most {MAX_EVENT_TYPE_NAME} characters"),
                ));
            }
            if !seen_types.insert(event_type.to_lowercase()) {
                return Err(ConfigError::invalid(
                    format!("{group_path}.type"),
                    "types must be unique, ignoring case",
                ));
            }
            if group.fields.len() > MAX_CUSTOM_EVENT_FIELDS {
                return Err(ConfigError::invalid(
                    format!("{group_path}.fields"),
                    format!("must contain at most {MAX_CUSTOM_EVENT_FIELDS} fields"),
                ));
            }

            let builtin = EventType::from_code(event_type);
            let mut seen_keys = HashSet::new();
            for (field_index, field) in group.fields.iter().enumerate() {
                let field_path = format!("{group_path}.fields[{field_index}]");
                let label = field.label.trim();
                if label.is_empty() {
                    return Err(ConfigError::invalid(
                        format!("{field_path}.label"),
                        "must not be empty",
                    ));
                }
                if label.chars().count() > MAX_EVENT_FIELD_LABEL {
                    return Err(ConfigError::invalid(
                        format!("{field_path}.label"),
                        format!("must be at most {MAX_EVENT_FIELD_LABEL} characters"),
                    ));
                }
                if !is_valid_event_detail_key(&field.key) {
                    return Err(ConfigError::invalid(
                        format!("{field_path}.key"),
                        "must be lowercase snake_case, 1 to 64 characters",
                    ));
                }
                if !seen_keys.insert(field.key.to_ascii_lowercase()) {
                    return Err(ConfigError::invalid(
                        format!("{field_path}.key"),
                        "keys must be unique within a group, ignoring case",
                    ));
                }
                if RESERVED_EVENT_DETAIL_KEYS.contains(&field.key.as_str()) {
                    return Err(ConfigError::invalid(
                        format!("{field_path}.key"),
                        "key is reserved for the event itself",
                    ));
                }
                if let Some(builtin) = builtin {
                    if builtin_event_field_keys(builtin).contains(&field.key.as_str()) {
                        return Err(ConfigError::invalid(
                            format!("{field_path}.key"),
                            format!("collides with a built-in field of {}", builtin.code()),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Directories created on first run, with the key used in warnings.
    pub fn directories(&self) -> [(&'static str, &Path); 3] {
        [
            ("storage.projects_dir", self.storage.projects_dir.as_path()),
            ("storage.backups_dir", self.storage.backups_dir.as_path()),
            ("search.index_dir", self.search.index_dir.as_path()),
        ]
    }
}

fn is_http_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_absolute_and_never_hardcode_a_model() {
        let config = AppConfig::default();
        assert!(config.storage.projects_dir.is_absolute());
        assert!(config.storage.backups_dir.is_absolute());
        assert!(config.search.index_dir.is_absolute());
        assert!(config.chat.model.is_empty());
        assert_eq!(config.backup.keep, DEFAULT_BACKUP_KEEP);
        config.validate().expect("defaults are valid");
    }

    #[test]
    fn language_round_trips_through_serde() {
        for value in Language::VALUES {
            let language = Language::parse(value).expect("known language");
            let text = serde_json::to_string(&language).expect("serialize");
            assert_eq!(text, format!("\"{value}\""));
            assert_eq!(language.as_str(), value);
        }
        assert_eq!(Language::parse("de"), Some(Language::De));
        assert_eq!(Language::parse("DE"), Some(Language::De));
        assert_eq!(Language::parse("xx"), None);
    }

    #[test]
    fn enabled_chat_requires_a_model() {
        let mut config = AppConfig::default();
        config.chat.enabled = true;
        let error = config.validate().expect_err("must fail");
        assert_eq!(error.key(), Some("chat.model"));
    }

    #[test]
    fn person_edits_are_disabled_by_default_and_absent_in_old_config() {
        assert!(!AppConfig::default().chat.allow_person_edits);

        // A config without the key deserializes to the off default.
        let config: AppConfig =
            serde_json::from_str(r#"{"chat":{"enabled":true,"model":"m"}}"#).expect("parse");
        assert!(!config.chat.allow_person_edits);
    }

    #[test]
    fn update_checks_are_off_by_default_and_absent_in_old_config() {
        assert!(!AppConfig::default().updates.auto_check);

        // A config written before the section existed deserializes to "off",
        // so upgrading never starts a background request on its own.
        let config: AppConfig =
            serde_json::from_str(r#"{"chat":{"enabled":true,"model":"m"}}"#).expect("parse");
        assert!(!config.updates.auto_check);
    }
}
