#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Gentree Launcher — installs and updates Gentree from a version feed.
//!
//! The launcher is deliberately independent of any forge: the feed and its
//! artifacts may live on GitHub, Gitea or a plain static host. See
//! `docs/launcher.md` for the wire format and the local test server.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{codes, LauncherError};
use crate::feed::{Arch, Feed, Os};
use crate::progress::ProgressEvent;

mod download;
mod error;
mod feed;
mod install;
mod logging;
mod progress;
mod settings;
mod system;
mod version;

/// Placeholder feed used until the release pipeline publishes the real one.
/// TODO: replace OWNER with the final repository once the landing page and CI
/// publish `versions.json`.
pub const DEFAULT_FEED_URL: &str =
    "https://github.com/OWNER/gentree/releases/latest/download/versions.json";

/// Overrides the feed for local testing (`docs/launcher.md`).
pub const FEED_ENV: &str = "GENTREE_LAUNCHER_FEED";

/// Feed URL for this run: the environment override wins over the constant.
fn feed_url() -> String {
    std::env::var(FEED_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_FEED_URL.to_string())
}

/// Launcher-owned directories resolved once at startup.
struct Paths {
    data: PathBuf,
    config: PathBuf,
}

impl Paths {
    fn downloads(&self) -> PathBuf {
        self.data.join("downloads")
    }

    fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }
}

struct LauncherState {
    paths: Paths,
    settings: Mutex<settings::Settings>,
    /// Last successfully fetched feed; refreshed on demand, never persisted.
    feed: Mutex<Option<Feed>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: Option<&'static str>,
    arch: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    installed_version: Option<String>,
    /// `None` when the process check itself failed; the UI then offers install
    /// and surfaces the failure only when the user tries.
    installed_running: Option<bool>,
    platform: PlatformInfo,
    feed_url: String,
    auto_check: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionView {
    version: String,
    released: String,
    notes: String,
    prerelease: bool,
    latest: bool,
    installed: bool,
    update_available: bool,
    available: bool,
    kind: Option<String>,
    arch: Option<String>,
    size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedView {
    feed_url: String,
    installed_version: Option<String>,
    latest: Option<String>,
    update_state: version::UpdateState,
    platform_supported: bool,
    versions: Vec<VersionView>,
}

fn build_view(feed: &Feed, feed_url: &str, installed: Option<String>) -> FeedView {
    let latest = feed.select_latest().map(|entry| entry.version.clone());
    let os = feed::current_os();
    let arch = feed::current_arch();
    let installed_parsed = installed.as_deref().and_then(version::parse_installed);

    let versions = feed
        .sorted(true)
        .into_iter()
        .map(|entry| {
            let file = match (os, arch) {
                (Some(os), Some(arch)) => entry.file_for(os, arch),
                _ => None,
            };
            let parsed = semver::Version::parse(&entry.version).ok();
            VersionView {
                version: entry.version.clone(),
                released: entry.released.clone(),
                notes: entry.notes.clone(),
                prerelease: entry.is_prerelease(),
                latest: latest.as_deref() == Some(entry.version.as_str()),
                installed: installed_parsed.is_some()
                    && installed_parsed.as_ref() == parsed.as_ref(),
                update_available: version::is_newer(&entry.version, installed.as_deref()),
                available: file.is_some(),
                kind: file.map(|file| file.kind.as_str().to_string()),
                arch: file.map(|file| file.arch.as_str().to_string()),
                size: file.and_then(|file| file.size),
            }
        })
        .collect();

    FeedView {
        feed_url: feed_url.to_string(),
        installed_version: installed.clone(),
        update_state: version::update_state(installed.as_deref(), latest.as_deref()),
        platform_supported: os.is_some() && arch.is_some(),
        latest,
        versions,
    }
}

#[tauri::command]
fn launcher_info(state: State<'_, LauncherState>) -> Info {
    Info {
        installed_version: system::installed_version(),
        installed_running: system::gentree_running().ok(),
        platform: PlatformInfo {
            os: feed::current_os().map(Os::as_str),
            arch: feed::current_arch().map(Arch::as_str),
        },
        feed_url: feed_url(),
        auto_check: state
            .settings
            .lock()
            .map(|settings| settings.auto_check)
            .unwrap_or(true),
    }
}

/// Returns the cached feed or fetches it, keeping the cache in sync.
async fn ensure_feed(state: &LauncherState, refresh: bool) -> Result<Feed, LauncherError> {
    if !refresh {
        if let Ok(cached) = state.feed.lock() {
            if let Some(feed) = cached.as_ref() {
                return Ok(feed.clone());
            }
        }
    }

    let request_url = feed_url();
    if feed::is_placeholder_url(&request_url) {
        return Err(LauncherError::new(codes::FEED_NOT_CONFIGURED));
    }
    let fetched = tauri::async_runtime::spawn_blocking(move || download::fetch_feed(&request_url))
        .await
        .map_err(|_| LauncherError::new(codes::INTERNAL))?
        .inspect_err(|error| {
            logging::error("feed", error.to_string());
        })?;
    if let Ok(mut cached) = state.feed.lock() {
        *cached = Some(fetched.clone());
    }
    logging::info("feed", format!("versions {}", fetched.versions.len()));
    Ok(fetched)
}

#[tauri::command]
async fn feed_load(
    state: State<'_, LauncherState>,
    refresh: bool,
) -> Result<FeedView, LauncherError> {
    let feed = ensure_feed(&state, refresh).await?;
    Ok(build_view(&feed, &feed_url(), system::installed_version()))
}

#[tauri::command]
async fn install_version(
    app: AppHandle,
    state: State<'_, LauncherState>,
    version: String,
) -> Result<install::InstallOutcome, LauncherError> {
    let feed = ensure_feed(&state, false).await?;
    let entry = feed
        .find(&version)
        .cloned()
        .ok_or_else(|| LauncherError::with_detail(codes::FEED_VERSION, "unknown version"))?;
    let os = feed::current_os().ok_or_else(|| LauncherError::new(codes::UNSUPPORTED_PLATFORM))?;
    let arch =
        feed::current_arch().ok_or_else(|| LauncherError::new(codes::UNSUPPORTED_PLATFORM))?;
    let file = entry.file_for(os, arch).cloned().ok_or_else(|| {
        LauncherError::with_detail(codes::NO_FILE, format!("{} {}", os.as_str(), arch.as_str()))
    })?;

    let downloads = state.paths.downloads();
    let emit_app = app.clone();
    let mut progress = move |event: ProgressEvent| {
        let _ = emit_app.emit("launcher-progress", event);
    };
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        install::install(&entry.version, &file, &downloads, &mut progress)
    })
    .await
    .map_err(|_| LauncherError::new(codes::INTERNAL))?
    .inspect_err(|error| {
        logging::error("install", error.to_string());
    })?;

    logging::info("install", format!("installed {}", outcome.version));
    Ok(outcome)
}

#[tauri::command]
async fn open_app() -> Result<(), LauncherError> {
    tauri::async_runtime::spawn_blocking(system::open_installed)
        .await
        .map_err(|_| LauncherError::new(codes::INTERNAL))?
}

#[tauri::command]
fn settings_update(
    state: State<'_, LauncherState>,
    auto_check: bool,
) -> Result<settings::Settings, LauncherError> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| LauncherError::new(codes::INTERNAL))?;
    settings.auto_check = auto_check;
    settings::save(&state.paths.settings_file(), &settings)?;
    Ok(settings.clone())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&config_dir)?;

            let paths = Paths {
                data: data_dir,
                config: config_dir,
            };
            logging::init(&paths.data.join("logs"));
            let settings = settings::load(&paths.settings_file());
            logging::info(
                "launcher",
                format!("started, auto-check {}", settings.auto_check),
            );

            app.manage(LauncherState {
                paths,
                settings: Mutex::new(settings),
                feed: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launcher_info,
            feed_load,
            install_version,
            open_app,
            settings_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gentree Launcher");
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn sample_feed() -> Feed {
        Feed::parse(&format!(
            r#"{{
                "schema": 1,
                "app": "gentree",
                "latest": "0.2.1",
                "versions": [
                    {{
                        "version": "0.2.0",
                        "released": "2026-10-01T12:00:00Z",
                        "notes": "older",
                        "prerelease": false,
                        "files": [
                            {{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/old.exe","sha256":"{DIGEST}"}}
                        ]
                    }},
                    {{
                        "version": "0.2.1",
                        "released": "2026-11-01T12:00:00Z",
                        "notes": "newer",
                        "prerelease": false,
                        "files": [
                            {{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/new.exe","sha256":"{DIGEST}","size":7}}
                        ]
                    }}
                ]
            }}"#
        ))
        .expect("feed")
    }

    #[test]
    fn view_marks_the_latest_and_installed_versions() {
        let view = build_view(
            &sample_feed(),
            "https://feed.example/versions.json",
            Some("0.2.0".to_string()),
        );

        assert_eq!(view.latest.as_deref(), Some("0.2.1"));
        assert_eq!(view.update_state, version::UpdateState::UpdateAvailable);
        assert_eq!(view.versions.len(), 2);
        let latest = view
            .versions
            .iter()
            .find(|entry| entry.version == "0.2.1")
            .expect("latest row");
        assert!(latest.latest);
        assert!(latest.update_available);
        assert!(!latest.installed);
        let installed = view
            .versions
            .iter()
            .find(|entry| entry.version == "0.2.0")
            .expect("installed row");
        assert!(installed.installed);
    }
}
