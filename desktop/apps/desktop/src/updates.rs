//! In-app update checks on top of `tauri-plugin-updater`.
//!
//! Contract: an update request is opt-in. `update_status` is pure: it reports
//! the current version and whether the build is configured, and makes no
//! request. `update_check` / `update_install` are the only commands that touch
//! the network, and both refuse a build whose endpoint or public key is still a
//! placeholder. The startup check runs only when `updates.auto_check` is on.
//!
//! The endpoint and the public key live in `tauri.conf.json`
//! (`plugins.updater`), never in the user config: a settings file must not be
//! able to point updates at another host. Both values are public; the signing
//! private key stays in CI secrets (see `docs/releases.md`).

use std::sync::Mutex;

use gentree_core::error::codes;
use gentree_core::AppError;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::settings::ConfigState;

/// Plugin id in `tauri.conf.json`: `plugins.updater`.
const PLUGIN_NAME: &str = "updater";
/// Marker used by config placeholders and by a build that ships without keys.
const PLACEHOLDER: &str = "REPLACE_WITH";

/// Why the build cannot check for updates. Detailed reasons stay local; the UI
/// only shows the localized `UPDATE_NOT_CONFIGURED` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    MissingEndpoint,
    PlaceholderEndpoint,
    InsecureEndpoint,
    MissingPublicKey,
    PlaceholderPublicKey,
}

impl Readiness {
    fn is_ready(self) -> bool {
        self == Self::Ready
    }

    /// Stable machine-readable reason; never contains a URL or a key.
    fn reason(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::MissingEndpoint => "missingEndpoint",
            Self::PlaceholderEndpoint => "placeholderEndpoint",
            Self::InsecureEndpoint => "insecureEndpoint",
            Self::MissingPublicKey => "missingPublicKey",
            Self::PlaceholderPublicKey => "placeholderPublicKey",
        }
    }
}

/// The release-side part of the updater config, read from `tauri.conf.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdaterConfig {
    pub endpoints: Vec<String>,
    pub pubkey: String,
    /// `dangerousInsecureTransportProtocol` from the same plugin section. Only a
    /// deliberately built local test config sets it; then loopback HTTP is
    /// allowed, but nothing else.
    pub allow_insecure_loopback: bool,
}

impl UpdaterConfig {
    /// Reads `plugins.updater` without validating or touching the network.
    pub fn from_plugin_config(config: Option<&Value>) -> Self {
        let endpoints = config
            .and_then(|value| value.get("endpoints"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let pubkey = config
            .and_then(|value| value.get("pubkey"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let allow_insecure_loopback = config
            .and_then(|value| value.get("dangerousInsecureTransportProtocol"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            endpoints,
            pubkey,
            allow_insecure_loopback,
        }
    }

    /// Placeholders are refused before the plugin builds a client, so a build
    /// that ships without release keys never contacts a release host.
    pub fn readiness(&self) -> Readiness {
        let Some(endpoint) = self.endpoints.first() else {
            return Readiness::MissingEndpoint;
        };
        if self
            .endpoints
            .iter()
            .any(|value| value.contains(PLACEHOLDER))
        {
            return Readiness::PlaceholderEndpoint;
        }
        if !endpoint.starts_with("https://")
            && !(self.allow_insecure_loopback && is_loopback_http(endpoint))
        {
            return Readiness::InsecureEndpoint;
        }
        if self.pubkey.is_empty() {
            return Readiness::MissingPublicKey;
        }
        if self.pubkey.contains(PLACEHOLDER) {
            return Readiness::PlaceholderPublicKey;
        }
        Readiness::Ready
    }
}

/// `http://127.0.0.1`, `http://localhost` or `http://[::1]`, with an optional
/// port and path. Any other host must use https, whatever the flag says.
fn is_loopback_http(endpoint: &str) -> bool {
    let Some(rest) = endpoint.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// The guard every network command calls first. It returns before an updater
/// (and therefore an HTTP client) exists, so it cannot make a request.
pub fn ensure_ready(config: &UpdaterConfig) -> Result<(), AppError> {
    let readiness = config.readiness();
    if readiness.is_ready() {
        return Ok(());
    }
    Err(
        AppError::new(codes::UPDATE_NOT_CONFIGURED, "updates are not configured")
            .with_param("reason", readiness.reason()),
    )
}

/// One automatic check, kept for the settings screen. The manual check reports
/// its result directly and does not overwrite this.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCheckOutcome {
    pub checked_at: String,
    pub available_version: Option<String>,
    pub error_code: Option<String>,
}

/// Last automatic result; empty until a check ran.
#[derive(Default)]
pub struct UpdateState {
    last_auto_check: Mutex<Option<AutoCheckOutcome>>,
}

impl UpdateState {
    fn record(&self, outcome: AutoCheckOutcome) {
        if let Ok(mut slot) = self.last_auto_check.lock() {
            *slot = Some(outcome);
        }
    }

    fn last(&self) -> Option<AutoCheckOutcome> {
        self.last_auto_check
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// Drops the startup result after an install: it describes a version that
    /// is no longer the one on disk.
    fn clear(&self) {
        if let Ok(mut slot) = self.last_auto_check.lock() {
            *slot = None;
        }
    }
}

/// Facts shown by the settings screen. No request is made to build it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub configured: bool,
    pub auto_check: bool,
    /// Version announced by the check that produced this status, if any.
    pub available_version: Option<String>,
    pub notes: Option<String>,
    pub last_auto_check: Option<AutoCheckOutcome>,
}

fn base_status(
    app: &AppHandle,
    auto_check: bool,
    configured: bool,
    last_auto_check: Option<AutoCheckOutcome>,
) -> UpdateStatus {
    UpdateStatus {
        current_version: app.package_info().version.to_string(),
        configured,
        auto_check,
        available_version: None,
        notes: None,
        last_auto_check,
    }
}

fn updater_config(app: &AppHandle) -> UpdaterConfig {
    UpdaterConfig::from_plugin_config(app.config().plugins.0.get(PLUGIN_NAME))
}

fn read_auto_check(app: &AppHandle) -> bool {
    app.try_state::<Mutex<ConfigState>>()
        .and_then(|state| {
            state
                .lock()
                .ok()
                .map(|guard| guard.config().updates.auto_check)
        })
        .unwrap_or(false)
}

/// No secrets and no URLs are logged or returned: only this stable code.
fn check_failed() -> AppError {
    AppError::new(codes::UPDATE_CHECK_FAILED, "the update check failed")
}

fn install_failed() -> AppError {
    AppError::new(
        codes::UPDATE_INSTALL_FAILED,
        "the update could not be installed",
    )
}

fn now_display() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// `update_status`: current version and configuration facts, no network.
#[tauri::command]
pub fn update_status(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, AppError> {
    let config = updater_config(&app);
    Ok(base_status(
        &app,
        read_auto_check(&app),
        config.readiness().is_ready(),
        state.last(),
    ))
}

/// `update_check`: the only manual network command besides install.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, AppError> {
    let config = updater_config(&app);
    ensure_ready(&config)?;
    let auto_check = read_auto_check(&app);
    let updater = app.updater().map_err(|_| check_failed())?;
    let update = updater.check().await.map_err(|_| check_failed())?;
    let mut status = base_status(&app, auto_check, true, state.last());
    if let Some(update) = update {
        status.available_version = Some(update.version);
        status.notes = update.body;
    }
    Ok(status)
}

/// `update_install`: downloads the announced release, verifies its signature
/// and installs it. The plugin exits the app on Windows; other platforms need a
/// manual restart, so the UI says so.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, AppError> {
    let config = updater_config(&app);
    ensure_ready(&config)?;
    let auto_check = read_auto_check(&app);
    let updater = app.updater().map_err(|_| check_failed())?;
    let update = updater.check().await.map_err(|_| check_failed())?;
    let mut status = base_status(&app, auto_check, true, state.last());
    let Some(update) = update else {
        // The release disappeared or is no longer newer; report "up to date".
        return Ok(status);
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| install_failed())?;
    // The startup result described the previous version; it is stale now.
    state.clear();
    status.last_auto_check = None;
    status.available_version = Some(version);
    Ok(status)
}

/// Runs the startup check once, and only when the user opted in. Called from
/// `setup`; a build that is not configured returns before any task is spawned.
pub fn spawn_auto_check(app: AppHandle) {
    if !read_auto_check(&app) {
        return;
    }
    let config = updater_config(&app);
    if !config.readiness().is_ready() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let outcome = match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => AutoCheckOutcome {
                    checked_at: now_display(),
                    available_version: Some(update.version),
                    error_code: None,
                },
                Ok(None) => AutoCheckOutcome {
                    checked_at: now_display(),
                    available_version: None,
                    error_code: None,
                },
                Err(_) => AutoCheckOutcome {
                    checked_at: now_display(),
                    available_version: None,
                    error_code: Some(codes::UPDATE_CHECK_FAILED.to_owned()),
                },
            },
            Err(_) => AutoCheckOutcome {
                checked_at: now_display(),
                available_version: None,
                error_code: Some(codes::UPDATE_NOT_CONFIGURED.to_owned()),
            },
        };
        if let Some(state) = app.try_state::<UpdateState>() {
            state.record(outcome);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn configured_endpoint() -> &'static str {
        "https://updates.invalid/gentree/latest.json"
    }

    #[test]
    fn an_empty_plugin_config_is_refused_without_a_request() {
        let config = UpdaterConfig::from_plugin_config(None);

        assert_eq!(config.readiness(), Readiness::MissingEndpoint);
        let error = ensure_ready(&config).expect_err("must refuse");
        assert_eq!(error.code, codes::UPDATE_NOT_CONFIGURED);
        assert_eq!(
            error.params.get("reason").map(String::as_str),
            Some("missingEndpoint")
        );
    }

    #[test]
    fn placeholder_configs_are_refused_and_never_echoed() {
        let value = json!({
            "endpoints": [
                "https://updates.invalid/REPLACE_WITH_RELEASES_HOST/gentree/latest.json"
            ],
            "pubkey": "REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY"
        });
        let config = UpdaterConfig::from_plugin_config(Some(&value));

        assert_eq!(config.readiness(), Readiness::PlaceholderEndpoint);
        let error = ensure_ready(&config).expect_err("must refuse");
        let text = serde_json::to_string(&error).expect("serialize");
        assert!(!text.contains("updates.invalid"), "{text}");
        assert!(!text.contains(PLACEHOLDER), "{text}");
    }

    #[test]
    fn insecure_and_incomplete_configs_are_refused() {
        let insecure = UpdaterConfig {
            endpoints: vec!["http://updates.invalid/latest.json".to_owned()],
            pubkey: "a-public-key".to_owned(),
            allow_insecure_loopback: false,
        };
        assert_eq!(insecure.readiness(), Readiness::InsecureEndpoint);

        let no_key = UpdaterConfig {
            endpoints: vec![configured_endpoint().to_owned()],
            pubkey: String::new(),
            allow_insecure_loopback: false,
        };
        assert_eq!(no_key.readiness(), Readiness::MissingPublicKey);

        let placeholder_key = UpdaterConfig {
            endpoints: vec![configured_endpoint().to_owned()],
            pubkey: "REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY".to_owned(),
            allow_insecure_loopback: false,
        };
        assert_eq!(placeholder_key.readiness(), Readiness::PlaceholderPublicKey);
    }

    #[test]
    fn loopback_http_needs_the_explicit_local_flag() {
        let endpoint = "http://127.0.0.1:3001/gentree/releases/download/v0.2.1/latest.json";
        let strict = UpdaterConfig {
            endpoints: vec![endpoint.to_owned()],
            pubkey: "a-public-key".to_owned(),
            allow_insecure_loopback: false,
        };
        assert_eq!(strict.readiness(), Readiness::InsecureEndpoint);

        let local = UpdaterConfig {
            endpoints: vec![endpoint.to_owned()],
            pubkey: "a-public-key".to_owned(),
            allow_insecure_loopback: true,
        };
        assert_eq!(local.readiness(), Readiness::Ready);
        ensure_ready(&local).expect("a local test build may check");

        assert!(is_loopback_http("http://127.0.0.1/x"));
        assert!(is_loopback_http("http://localhost:3001/x"));
        assert!(is_loopback_http("http://[::1]:3001/x"));
        assert!(is_loopback_http("http://127.0.0.1:3001/x?y=1"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.example/x"));
        assert!(!is_loopback_http("http://192.168.0.10:3001/x"));
        assert!(!is_loopback_http("https://127.0.0.1/x"));
    }

    #[test]
    fn a_release_configured_https_endpoint_is_ready() {
        let config = UpdaterConfig {
            endpoints: vec![configured_endpoint().to_owned()],
            pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".to_owned(),
            allow_insecure_loopback: false,
        };

        assert_eq!(config.readiness(), Readiness::Ready);
        ensure_ready(&config).expect("configured build may check");
    }

    #[test]
    fn empty_entries_do_not_count_as_an_endpoint() {
        let config = UpdaterConfig::from_plugin_config(Some(&json!({
            "endpoints": ["", "   "],
            "pubkey": "a-public-key"
        })));

        assert!(config.endpoints.is_empty());
        assert_eq!(config.readiness(), Readiness::MissingEndpoint);
    }

    /// The shipped config is the only build users receive, so a regression to a
    /// placeholder must fail in CI rather than silently disable updates.
    #[test]
    fn the_shipped_config_enables_the_update_channel() {
        let value: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let plugin = value
            .get("plugins")
            .and_then(|plugins| plugins.get(PLUGIN_NAME));
        let config = UpdaterConfig::from_plugin_config(plugin);

        assert_eq!(config.readiness(), Readiness::Ready);
        assert!(
            config.endpoints.first().is_some_and(|endpoint| endpoint
                .ends_with("/marakogr/gentree/releases/latest/download/latest.json")),
            "{:?}",
            config.endpoints
        );
    }
}
