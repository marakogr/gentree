//! Project export to an AT5 or GEDCOM exchange archive.
//!
//! Both formats produce one `.zip` with the data file and a sibling media
//! folder:
//!
//! ```text
//! family.zip
//!   family.at5
//!   family.files/...   (when the project has media)
//! ```
//! or
//! ```text
//! family.zip
//!   family.ged
//!   family.files/...
//! ```
//!
//! The `.files` folder name is what both importers already look for next to the
//! data file. Media names are kept, and a numeric suffix is added only when two
//! different files share one name. Missing files are reported by count and
//! skipped; no absolute path or file name is repeated in a warning.
//!
//! AT5 is a Gentree exchange subset (see [`crate::at5_export`]), not a full
//! Древо Жизни 5 database. GEDCOM is 5.5.1 or 7.0 UTF-8 and includes events,
//! media and the same person/relationship model; 7.0 also writes sources and
//! citations (ADR-0019).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use gentree_core::error::AppError;
use gentree_core::record::Media;
use gentree_storage::ProjectStore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::at5_export;
use crate::exchange::{create_parent, replace_file};
use crate::gedcom::{self, ExportMedia, ExportReport, GedcomVersion};

/// Exchange format of [`export_archive`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportFormat {
    /// `.<name>.at5` plus `<name>.files/` (Gentree-readable AT5 EAV subset).
    #[default]
    At5,
    /// GEDCOM 5.5.1 plus `<name>.files/` (compatibility default).
    Gedcom,
    /// GEDCOM 7.0 plus `<name>.files/`.
    Gedcom7,
}

impl ExportFormat {
    /// Data file extension inside the archive.
    pub fn extension(self) -> &'static str {
        match self {
            Self::At5 => "at5",
            Self::Gedcom | Self::Gedcom7 => "ged",
        }
    }

    /// GEDCOM specification version, or `None` for AT5.
    pub fn gedcom_version(self) -> Option<GedcomVersion> {
        match self {
            Self::At5 => None,
            Self::Gedcom => Some(GedcomVersion::V5_5_1),
            Self::Gedcom7 => Some(GedcomVersion::V7_0),
        }
    }
}

/// Write one exchange archive for a project folder.
///
/// The project is opened read-only. The archive is built in a staging folder
/// next to `target` and moved into place only after the ZIP is complete, so a
/// failed export never leaves a partial target.
pub fn export_archive(
    project_dir: &Path,
    format: ExportFormat,
    target: &Path,
) -> Result<ExportReport, String> {
    let store = ProjectStore::open(project_dir, false).map_err(app_error)?;
    let persons = store.persons().map_err(app_error)?;
    let relationships = store.relationships().map_err(app_error)?;
    let events = store.events().map_err(app_error)?;
    let sources = store.sources().map_err(app_error)?;
    let citations = store.citations().map_err(app_error)?;
    let media = store.media().map_err(app_error)?;

    let stem = archive_stem(target, &store.manifest().name);
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staging = parent.join(format!(".gentree-export-{}", Uuid::now_v7()));
    fs::create_dir_all(&staging).map_err(|_| "cannot create export staging folder".to_owned())?;

    let result = (|| -> Result<ExportReport, String> {
        let mut report = ExportReport::default();
        let media_names = copy_media(&store, &media, &staging, &stem, &mut report)?;
        let data_path = staging.join(format!("{stem}.{}", format.extension()));

        match format {
            ExportFormat::At5 => at5_export::write_at5(
                &data_path,
                &persons,
                &relationships,
                &events,
                &media,
                &media_names,
                &mut report,
            )?,
            ExportFormat::Gedcom | ExportFormat::Gedcom7 => {
                let export_media = media
                    .iter()
                    .zip(media_names.iter())
                    .filter_map(|(item, name)| {
                        name.as_deref().map(|file_name| ExportMedia {
                            media: item,
                            file_name,
                        })
                    })
                    .collect::<Vec<_>>();
                // Sources and citations are written only into 7.0; the 5.5.1
                // output keeps its historical shape and the warning below.
                let is_v7 = format == ExportFormat::Gedcom7;
                let gedcom_report = gedcom::export_versioned(
                    &persons,
                    &relationships,
                    &events,
                    &export_media,
                    if is_v7 { &sources } else { &[] },
                    if is_v7 { &citations } else { &[] },
                    format
                        .gedcom_version()
                        .expect("GEDCOM formats have a version"),
                    &data_path,
                )?;
                for warning in gedcom_report.warnings {
                    report.warn(warning);
                }
            }
        }

        if format != ExportFormat::Gedcom7 && (!sources.is_empty() || !citations.is_empty()) {
            report.warn("sources and citations are not included in this export");
        }

        write_zip(&staging, target)?;
        Ok(report)
    })();

    let _ = fs::remove_dir_all(&staging);
    result
}

/// Copy available media into `<stem>.files` and return export names parallel to
/// `media`. `None` means the bytes are missing, so the data file must not
/// reference that row.
fn copy_media(
    store: &ProjectStore,
    media: &[Media],
    staging: &Path,
    stem: &str,
    report: &mut ExportReport,
) -> Result<Vec<Option<String>>, String> {
    let files_dir = staging.join(format!("{stem}.files"));
    let mut names: Vec<Option<String>> = vec![None; media.len()];
    let mut used: HashMap<String, String> = HashMap::new();
    let mut missing = 0usize;
    let mut copy_failed = 0usize;
    let mut checksum_mismatch = 0usize;
    let mut renamed = 0usize;

    for (index, item) in media.iter().enumerate() {
        let source = match store.resolve_media_path(item) {
            Ok(path) if path.is_file() => path,
            _ => {
                missing += 1;
                continue;
            }
        };
        let base =
            export_file_name(&item.file_name).unwrap_or_else(|| format!("media-{}.bin", index + 1));

        let mut candidate = base.clone();
        let mut suffix = 2usize;
        let mut changed = false;
        loop {
            let key = candidate.to_ascii_lowercase();
            match used.get(&key) {
                None => break,
                Some(checksum) if checksum == &item.checksum => {
                    // The same bytes already have this name; both rows may
                    // point at one archive entry.
                    names[index] = Some(candidate.clone());
                    break;
                }
                _ => {
                    candidate = with_suffix(&base, suffix);
                    suffix += 1;
                    changed = true;
                }
            }
        }
        if names[index].is_some() {
            continue;
        }
        if changed {
            renamed += 1;
        }

        if !files_dir.is_dir() {
            fs::create_dir_all(&files_dir)
                .map_err(|_| "cannot create export media folder".to_owned())?;
        }
        let destination = files_dir.join(&candidate);
        if fs::copy(&source, &destination).is_err() {
            copy_failed += 1;
            continue;
        }
        match crate::at5::sha256_file(&destination) {
            Ok(checksum) if checksum == item.checksum => {}
            Ok(_) => checksum_mismatch += 1,
            Err(_) => copy_failed += 1,
        }
        used.insert(candidate.to_ascii_lowercase(), item.checksum.clone());
        names[index] = Some(candidate);
    }

    if missing > 0 {
        report.warn(format!(
            "{missing} media file(s) are missing and were not exported"
        ));
    }
    if copy_failed > 0 {
        report.warn(format!(
            "{copy_failed} media file(s) could not be copied and were not exported"
        ));
    }
    if checksum_mismatch > 0 {
        report.warn(format!(
            "{checksum_mismatch} media file(s) do not match the stored checksum; the exported bytes are used"
        ));
    }
    if renamed > 0 {
        report.warn(format!(
            "{renamed} media file name(s) were changed to avoid a collision"
        ));
    }
    Ok(names)
}

/// Zip every staged file under its path relative to the staging root.
fn write_zip(staging: &Path, target: &Path) -> Result<(), String> {
    create_parent(target)?;
    let temp = target.with_file_name(format!(".gentree-export-{}.zip", Uuid::now_v7()));
    let file = File::create(&temp).map_err(|_| "cannot create export archive".to_owned())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let result = (|| -> Result<(), String> {
        for entry in walkdir::WalkDir::new(staging).sort_by_file_name() {
            let entry = entry.map_err(|_| "cannot read export staging folder".to_owned())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(staging)
                .map_err(|_| "cannot read export staging folder".to_owned())?;
            let name = relative.to_string_lossy().replace('\\', "/");
            let bytes = fs::read(entry.path()).map_err(|_| "cannot read export file".to_owned())?;
            zip.start_file(name, options)
                .map_err(|_| "cannot write export archive".to_owned())?;
            zip.write_all(&bytes)
                .map_err(|_| "cannot write export archive".to_owned())?;
        }
        zip.finish()
            .map_err(|_| "cannot finish export archive".to_owned())?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return result;
    }
    if let Err(message) = replace_file(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(message);
    }
    Ok(())
}

/// Safe file name inside the media folder. Storage already validates names;
/// this second pass keeps a corrupted project from escaping the folder.
fn export_file_name(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty()
        || normalized.contains("..")
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized.starts_with('/')
    {
        return None;
    }
    let name = normalized.rsplit('/').next()?.trim_end_matches([' ', '.']);
    if name.is_empty() || name == "." || name.starts_with('.') || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(name.to_owned())
}

fn with_suffix(name: &str, suffix: usize) -> String {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("media");
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if !extension.is_empty() => format!("{stem}-{suffix}.{extension}"),
        _ => format!("{stem}-{suffix}"),
    }
}

/// Name used for the data file inside the archive.
///
/// A target chosen as `family.at5.zip` becomes `family.at5` and `family.files`,
/// not `family.at5.at5`.
fn archive_stem(target: &Path, fallback: &str) -> String {
    let raw = target
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(fallback);
    let mut stem = raw;
    loop {
        let stripped = [".at5", ".ged", ".gedcom", ".zip"]
            .iter()
            .find_map(|suffix| stem.strip_suffix(suffix));
        match stripped {
            Some(value) if !value.is_empty() => stem = value,
            _ => break,
        }
    }
    sanitize_stem(stem)
        .or_else(|| sanitize_stem(fallback))
        .unwrap_or_else(|| "gentree".to_owned())
}

fn sanitize_stem(value: &str) -> Option<String> {
    let stem: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let trimmed = stem.trim_matches('_');
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn app_error(err: AppError) -> String {
    format!("{}: {}", err.code, err.message)
}
