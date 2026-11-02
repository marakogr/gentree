//! Download, verify and install one release artifact.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::download;
use crate::error::{codes, LauncherError};
use crate::feed::{FileEntry, Kind};
use crate::progress::{Phase, ProgressEvent};
use crate::system;

/// Result of a completed install pipeline.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub version: String,
    /// macOS opens the DMG: the user drags Gentree into Applications.
    pub manual_step: bool,
}

/// Runs the whole pipeline: refuse while Gentree is open, download, verify,
/// verify again from disk, then start the installer.
pub fn install(
    version: &str,
    file: &FileEntry,
    downloads: &Path,
    progress: &mut dyn FnMut(ProgressEvent),
) -> Result<InstallOutcome, LauncherError> {
    if system::gentree_running()? {
        return Err(LauncherError::new(codes::APP_RUNNING));
    }

    let url = crate::feed::parse_artifact_url(&file.url)?;
    let name = download::safe_file_name(&url)
        .unwrap_or_else(|| download::fallback_file_name(version, file.os, file.arch, file.kind));
    let path = download::download(
        &file.url,
        &file.sha256,
        file.size,
        downloads,
        &name,
        progress,
    )?;

    let verified_size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    progress(ProgressEvent::new(
        Phase::Verify,
        verified_size,
        file.size.or(Some(verified_size)),
    ));
    if let Err(error) = download::verify_file(&path, &file.sha256) {
        // Re-verification from disk failed: never leave an unverified artifact.
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }

    // The archive was verified, but the app may have been started meanwhile.
    if system::gentree_running()? {
        return Err(LauncherError::new(codes::APP_RUNNING));
    }

    progress(ProgressEvent::new(Phase::Install, 0, None));
    run_installer(&path, file.kind)?;
    Ok(InstallOutcome {
        version: version.to_string(),
        manual_step: file.kind == Kind::Dmg,
    })
}

fn failed_install(detail: &str) -> LauncherError {
    LauncherError::with_detail(codes::INSTALL_FAILED, detail)
}

#[cfg(target_os = "windows")]
fn run_installer(path: &Path, kind: Kind) -> Result<(), LauncherError> {
    if kind != Kind::Nsis {
        return Err(LauncherError::new(codes::NO_FILE));
    }
    // `/S` is the NSIS silent switch. The Tauri installer is per-user by
    // default, so no elevation prompt is requested.
    let status = Command::new(path)
        .arg("/S")
        .status()
        .map_err(|_| failed_install("launch"))?;
    if !status.success() {
        return Err(failed_install("exit"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_installer(path: &Path, kind: Kind) -> Result<(), LauncherError> {
    if kind != Kind::Dmg {
        return Err(LauncherError::new(codes::NO_FILE));
    }
    // Mount the image and let the user drag Gentree into Applications; the
    // launcher never copies files or asks for elevated rights.
    Command::new("open")
        .arg(path)
        .status()
        .map_err(|_| failed_install("launch"))?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn run_installer(_path: &Path, _kind: Kind) -> Result<(), LauncherError> {
    Err(LauncherError::new(codes::UNSUPPORTED_PLATFORM))
}
