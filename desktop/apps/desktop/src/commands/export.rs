//! `project_export` command: AT5 or GEDCOM exchange archive.
//!
//! The renderer chooses an absolute target with the native save dialog. The
//! command never accepts a relative path and refuses a target inside the
//! project folder, so an export cannot overwrite project data.

use std::fs;
use std::path::{Path, PathBuf};

use gentree_core::error::codes;
use gentree_core::{AppError, AppResult};
use gentree_import::{export_archive, ExportFormat, GedcomVersion};
use gentree_storage::ProjectStore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{lock_or, projects_dir, AppState};

/// Output format requested by the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportFormatArg {
    At5,
    Gedcom,
}

impl From<ExportFormatArg> for ExportFormat {
    fn from(value: ExportFormatArg) -> Self {
        match value {
            ExportFormatArg::At5 => Self::At5,
            ExportFormatArg::Gedcom => Self::Gedcom,
        }
    }
}

/// `project_export` payload. `path` is the file the user chose; it is returned
/// only to the caller that supplied it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub warnings: Vec<String>,
}

/// Export one project, open or closed, to an absolute ZIP path.
///
/// `gedcom_version` applies only to `format = GEDCOM`: absent, blank or
/// `"5.5.1"` selects the compatibility default, `"7.0"` selects GEDCOM 7.0.
#[tauri::command]
pub fn project_export(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    format: ExportFormatArg,
    gedcom_version: Option<String>,
    destination: String,
) -> AppResult<ExportOutcome> {
    let id = crate::commands::parse_uuid("projectId", &project_id)?;
    let target = export_target(&destination)?;
    let format = export_format(format, gedcom_version.as_deref())?;

    let guard = lock_or(&state.project, "state poisoned")?;
    if let Some(store) = guard.as_ref() {
        if store.manifest().project_id == id {
            // The shared store stays locked for the whole read, so a chat tool
            // cannot write a half-exported snapshot.
            return run_export(store.root(), format, &target);
        }
    }
    drop(guard);

    let dir = projects_dir(&app, &state)?.join(id.to_string());
    let store = ProjectStore::open(&dir, false)?;
    let root = store.root().to_path_buf();
    drop(store);
    run_export(&root, format, &target)
}

/// Combine the format with the optional GEDCOM version.
fn export_format(format: ExportFormatArg, gedcom_version: Option<&str>) -> AppResult<ExportFormat> {
    match format {
        ExportFormatArg::At5 => {
            if gedcom_version.is_some_and(|version| !version.trim().is_empty()) {
                return Err(AppError::validation("gedcomVersion", "notApplicable"));
            }
            Ok(ExportFormat::At5)
        }
        ExportFormatArg::Gedcom => match parse_gedcom_version(gedcom_version)? {
            GedcomVersion::V5_5_1 => Ok(ExportFormat::Gedcom),
            GedcomVersion::V7_0 => Ok(ExportFormat::Gedcom7),
        },
    }
}

/// Accepted spellings of the version selector; absent means 5.5.1.
fn parse_gedcom_version(raw: Option<&str>) -> AppResult<GedcomVersion> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("5.5" | "5.5.1") => Ok(GedcomVersion::V5_5_1),
        Some("7" | "7.0" | "7.0.1") => Ok(GedcomVersion::V7_0),
        Some(_) => Err(AppError::validation("gedcomVersion", "unsupported")),
    }
}

fn run_export(root: &Path, format: ExportFormat, target: &Path) -> AppResult<ExportOutcome> {
    if target_is_inside(target, root) {
        return Err(AppError::validation("destination", "insideProject"));
    }
    let report = export_archive(root, format, target)
        .map_err(|_| AppError::new(codes::IO_ERROR, "Export failed"))?;
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export.zip".to_owned());
    let bytes = fs::metadata(target)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(ExportOutcome {
        path: target.to_string_lossy().into_owned(),
        file_name,
        bytes,
        warnings: report.warnings,
    })
}

/// Validate the renderer path and make sure it names a ZIP file.
fn export_target(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("destination", "required"));
    }
    let mut path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(AppError::validation("destination", "absolutePath"));
    }
    if path.file_name().is_none() || path.is_dir() {
        return Err(AppError::validation("destination", "notAFile"));
    }
    let is_zip = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
    if !is_zip {
        let mut name = path.into_os_string();
        name.push(".zip");
        path = PathBuf::from(name);
    }
    Ok(path)
}

/// True when `target` lives directly in `root` or below it.
fn target_is_inside(target: &Path, root: &Path) -> bool {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    let Ok(parent) = fs::canonicalize(parent) else {
        return false;
    };
    parent.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_format_names_deserialize() {
        assert_eq!(
            serde_json::from_str::<ExportFormatArg>("\"AT5\"").unwrap(),
            ExportFormatArg::At5
        );
        assert_eq!(
            serde_json::from_str::<ExportFormatArg>("\"GEDCOM\"").unwrap(),
            ExportFormatArg::Gedcom
        );
    }

    #[test]
    fn gedcom_version_defaults_to_551_and_accepts_70() {
        assert_eq!(
            export_format(ExportFormatArg::Gedcom, None).unwrap(),
            ExportFormat::Gedcom
        );
        assert_eq!(
            export_format(ExportFormatArg::Gedcom, Some("  ")).unwrap(),
            ExportFormat::Gedcom
        );
        assert_eq!(
            export_format(ExportFormatArg::Gedcom, Some("5.5.1")).unwrap(),
            ExportFormat::Gedcom
        );
        assert_eq!(
            export_format(ExportFormatArg::Gedcom, Some("7.0")).unwrap(),
            ExportFormat::Gedcom7
        );
    }

    #[test]
    fn unknown_gedcom_version_is_rejected() {
        let error = export_format(ExportFormatArg::Gedcom, Some("6.0")).unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("unsupported")
        );
    }

    #[test]
    fn at5_rejects_a_gedcom_version() {
        let error = export_format(ExportFormatArg::At5, Some("7.0")).unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
    }

    #[test]
    fn export_target_requires_an_absolute_file_and_adds_zip() {
        assert!(export_target("  ").is_err());
        assert!(export_target("family.zip").is_err());

        // An absolute path is platform-specific, so build one from the temp dir
        // instead of a Windows literal that is relative on macOS and Linux.
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("family");

        let path = export_target(&base.to_string_lossy()).unwrap();
        assert!(path.is_absolute());
        assert_eq!(path.file_name().unwrap(), "family.zip");

        let mut zipped = base.into_os_string();
        zipped.push(".ZIP");
        let path = export_target(&zipped.to_string_lossy()).unwrap();
        assert_eq!(path.file_name().unwrap(), "family.ZIP");
    }

    #[test]
    fn export_target_rejects_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let error = export_target(&dir.path().to_string_lossy()).unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("notAFile")
        );
    }

    #[test]
    fn target_inside_the_project_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let inside = project.join("family.zip");
        let outside = dir.path().join("family.zip");
        assert!(target_is_inside(&inside, &project));
        assert!(!target_is_inside(&outside, &project));
    }
}
