//! `.gentree.json` / `.gentree.zip` project exchange. Contract: design.md §12,
//! ADR-0013.
//!
//! JSON is the media-free exchange document: metadata for every collection,
//! but no media bytes. ZIP is the full project in the ADR-0009 backup layout
//! (`manifest.json`, the six JSONL files, `media/**`, `checksums.sha256`); the
//! writer is [`ProjectStore::backup`], so hashing and packing are not
//! duplicated here.
//!
//! Both importers create a **new** project under the given projects directory
//! (MVP never merges into an existing project) and return the parsed
//! collections plus an [`ImportReport`]. Nothing is written until the whole
//! document has been parsed and validated.
//!
//! Reports and errors never repeat field values or user file names: they carry
//! counts, stable codes and structural messages only.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use gentree_core::error::AppError;
use gentree_core::person::Person;
use gentree_core::project::FORMAT_VERSION;
use gentree_core::record::{Citation, Event, Media, Source};
use gentree_core::relationship::{Relationship, RelationshipSet};
use gentree_storage::{
    write_bytes_atomic, ProjectStore, CHECKSUMS_FILE, CITATION_FILE, EVENT_FILE, MANIFEST_FILE,
    MEDIA_FILE, PERSON_FILE, RELATIONSHIP_FILE, SOURCE_FILE,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::gedcom::ExportReport;
use crate::report::ImportReport;

/// Largest uncompressed ZIP payload accepted on import (2 GiB).
pub const MAX_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Largest allowed `uncompressed / archive size` ratio.
pub const MAX_COMPRESSION_RATIO: u64 = 100;

/// Largest number of ZIP entries accepted on import.
pub const MAX_ARCHIVE_ENTRIES: usize = 10_000;

/// Largest `checksums.sha256` accepted on import (it is read into memory).
const MAX_CHECKSUMS_BYTES: u64 = 2 * 1024 * 1024;

/// Borrowed view of one project for a JSON export.
///
/// `exported_at` is supplied by the caller instead of being read from the
/// clock, so the same snapshot always produces the same bytes. The import side
/// creates a new project, so the document intentionally carries no project id
/// or name.
#[derive(Debug, Clone, Copy)]
pub struct ProjectSnapshotData<'a> {
    /// Value written as `exportedAt` (RFC 3339).
    pub exported_at: &'a str,
    pub persons: &'a [Person],
    pub events: &'a [Event],
    pub relationships: &'a [Relationship],
    pub sources: &'a [Source],
    pub citations: &'a [Citation],
    pub media: &'a [Media],
}

/// Parsed exchange document plus the import outcome.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportBundle {
    pub persons: Vec<Person>,
    pub relationships: Vec<Relationship>,
    pub events: Vec<Event>,
    pub sources: Vec<Source>,
    pub citations: Vec<Citation>,
    pub media: Vec<Media>,
    pub report: ImportReport,
    /// Project created by the import (MVP always creates a new one).
    pub project_id: Option<Uuid>,
    pub project_dir: Option<PathBuf>,
}

impl ImportBundle {
    fn from_document(document: ExchangeDocument, report: ImportReport) -> Self {
        Self {
            persons: document.persons,
            relationships: document.relationships,
            events: document.events,
            sources: document.sources,
            citations: document.citations,
            media: document.media,
            report,
            project_id: None,
            project_dir: None,
        }
    }
}

/// On-disk JSON document. Field order is the serialization order and is part
/// of the contract; `camelCase` gives `formatVersion`/`exportedAt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeDocument {
    format_version: u32,
    exported_at: String,
    persons: Vec<Person>,
    relationships: Vec<Relationship>,
    events: Vec<Event>,
    sources: Vec<Source>,
    citations: Vec<Citation>,
    media: Vec<Media>,
}

/// Write a media-free `.gentree.json` exchange document.
///
/// Collections are sorted by id, so the same entities produce the same bytes
/// regardless of the order they were loaded in.
pub fn export_json(
    snapshot: ProjectSnapshotData<'_>,
    target: &Path,
) -> Result<ExportReport, String> {
    if snapshot.exported_at.trim().is_empty() {
        return Err("export timestamp is required".to_owned());
    }
    let document = ExchangeDocument {
        format_version: FORMAT_VERSION,
        exported_at: snapshot.exported_at.to_owned(),
        persons: sorted_by_id(snapshot.persons, |person| person.id),
        relationships: sorted_by_id(snapshot.relationships, |row| row.id),
        events: sorted_by_id(snapshot.events, |row| row.id),
        sources: sorted_by_id(snapshot.sources, |row| row.id),
        citations: sorted_by_id(snapshot.citations, |row| row.id),
        media: sorted_by_id(snapshot.media, |row| row.id),
    };
    validate_document(&document)?;
    let mut report = ExportReport::default();
    if !document.media.is_empty() {
        report.warnings.push(
            "media metadata is exported without file bytes; .gentree.json does not carry media"
                .to_owned(),
        );
    }
    let mut bytes = serde_json::to_vec_pretty(&document)
        .map_err(|_| "cannot serialize JSON export".to_owned())?;
    bytes.push(b'\n');
    create_parent(target)?;
    write_bytes_atomic(target, &bytes).map_err(app_error)?;
    Ok(report)
}

/// Write a full `.gentree.zip` project export.
///
/// The archive is produced by [`ProjectStore::backup`] (same layout as
/// ADR-0009: manifest, JSONL, `media/**`, checksums) and then moved to
/// `target`. The project folder is opened read-only; its `.lock` and any index
/// files are never included.
pub fn export_zip(project_dir: &Path, target: &Path) -> Result<ExportReport, String> {
    let store = ProjectStore::open(project_dir, false).map_err(app_error)?;
    let mut report = ExportReport::default();
    if store.validate_layout().map_err(app_error)?.needs_repair() {
        report
            .warnings
            .push("project layout has issues; the export may be incomplete".to_owned());
    }
    create_parent(target)?;

    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staging = parent.join(format!(".gentree-export-{}", Uuid::now_v7()));
    fs::create_dir_all(&staging).map_err(|_| "cannot create export staging folder".to_owned())?;

    let result = (|| -> Result<(), String> {
        let produced = store.backup(&staging).map_err(app_error)?;
        replace_file(&produced, target)
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    Ok(report)
}

/// Parse a `.gentree.json` document into a brand-new project under
/// `target_dir`.
///
/// Structural problems (invalid JSON, unsupported `formatVersion`, invalid
/// entities) are errors; domain notices go to [`ImportReport::warnings`].
pub fn import_json(source: &Path, target_dir: &Path) -> Result<ImportBundle, String> {
    let metadata = fs::metadata(source).map_err(|_| "cannot read JSON export".to_owned())?;
    if !metadata.is_file() {
        return Err("JSON export file not found".to_owned());
    }
    if metadata.len() > MAX_UNCOMPRESSED_BYTES {
        return Err("JSON export is too large".to_owned());
    }
    let bytes = fs::read(source).map_err(|_| "cannot read JSON export".to_owned())?;
    let document: ExchangeDocument = serde_json::from_slice(&bytes).map_err(|err| {
        format!(
            "invalid JSON export at line {} column {}",
            err.line(),
            err.column()
        )
    })?;
    validate_document(&document)?;

    let mut report = ImportReport {
        persons: document.persons.len(),
        ..Default::default()
    };
    if !document.media.is_empty() {
        report.warn("media metadata has no file bytes; .gentree.json does not carry media files");
    }

    let (project_id, project_dir) = materialize(target_dir, &project_name(source), &document)?;
    let mut bundle = ImportBundle::from_document(document, report);
    bundle.project_id = Some(project_id);
    bundle.project_dir = Some(project_dir);
    Ok(bundle)
}

/// Validate and restore a `.gentree.zip` project export under `target_dir`.
///
/// Archive safety (zip-slip, symlinks, size, compression ratio, entry count)
/// is checked before extraction; checksums, `formatVersion` and the new
/// project id are then handled by [`ProjectStore::restore`].
pub fn import_zip(source: &Path, target_dir: &Path) -> Result<ImportBundle, String> {
    inspect_archive(source)?;
    let store = ProjectStore::restore(source, target_dir).map_err(app_error)?;

    let persons = store.persons().map_err(app_error)?;
    let relationships = store.relationships().map_err(app_error)?;
    let events = store.events().map_err(app_error)?;
    let sources = store.sources().map_err(app_error)?;
    let citations = store.citations().map_err(app_error)?;
    let media = store.media().map_err(app_error)?;
    let report = ImportReport {
        persons: persons.len(),
        ..Default::default()
    };
    let project_id = store.manifest().project_id;
    let project_dir = store.root().to_path_buf();
    drop(store);

    Ok(ImportBundle {
        persons,
        relationships,
        events,
        sources,
        citations,
        media,
        report,
        project_id: Some(project_id),
        project_dir: Some(project_dir),
    })
}

fn validate_document(document: &ExchangeDocument) -> Result<(), String> {
    if !(1..=FORMAT_VERSION).contains(&document.format_version) {
        return Err(format!(
            "unsupported formatVersion {}; this app supports up to {FORMAT_VERSION}",
            document.format_version
        ));
    }
    validate_records("person", &document.persons, |person| person.validate())?;
    validate_records("event", &document.events, |event| event.validate())?;
    validate_records("source", &document.sources, |source| source.validate())?;
    validate_records("citation", &document.citations, |citation| {
        citation.validate()
    })?;
    validate_records("media", &document.media, |media| {
        media.validate()?;
        // Reuse storage's file-name rules (`media/<hash>/<name>`); no I/O.
        gentree_storage::resolve_media_path(Path::new("."), media).map(|_| ())
    })?;
    RelationshipSet::new(document.relationships.clone())
        .map_err(|err| format!("invalid relationship set: {}", err.code))?;
    Ok(())
}

/// Validates every record of one collection; the first failure is reported
/// with its 1-based record number.
fn validate_records<T>(
    kind: &str,
    records: &[T],
    validate: impl Fn(&T) -> Result<(), AppError>,
) -> Result<(), String> {
    for (index, record) in records.iter().enumerate() {
        validate(record).map_err(|err| invalid_record(kind, index, &err))?;
    }
    Ok(())
}

/// Message carries the record number and stable field/rule codes, never values.
fn invalid_record(kind: &str, index: usize, err: &AppError) -> String {
    let field = err.params.get("field").map(String::as_str).unwrap_or("-");
    let rule = err.params.get("rule").map(String::as_str).unwrap_or("-");
    format!("{kind} record {} is invalid: {field}/{rule}", index + 1)
}

/// Create the new project and write every collection. On failure the new
/// folder is removed, so a half-imported project is never left behind.
fn materialize(
    target_dir: &Path,
    name: &str,
    document: &ExchangeDocument,
) -> Result<(Uuid, PathBuf), String> {
    let mut store = ProjectStore::create(target_dir, name).map_err(app_error)?;
    let root = store.root().to_path_buf();
    let project_id = store.manifest().project_id;
    let saved = (|| -> Result<(), String> {
        store.save_persons(&document.persons).map_err(app_error)?;
        store.save_events(&document.events).map_err(app_error)?;
        store
            .save_relationships(&document.relationships)
            .map_err(app_error)?;
        store.save_sources(&document.sources).map_err(app_error)?;
        store
            .save_citations(&document.citations)
            .map_err(app_error)?;
        store.save_media(&document.media).map_err(app_error)?;
        Ok(())
    })();
    if let Err(message) = saved {
        // Release the lock before removing the folder on Windows.
        drop(store);
        let _ = fs::remove_dir_all(&root);
        return Err(message);
    }
    drop(store);
    Ok((project_id, root))
}

fn project_name(source: &Path) -> String {
    let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
        return "Import".to_owned();
    };
    let name = file_name
        .strip_suffix(".gentree.json")
        .or_else(|| file_name.strip_suffix(".json"))
        .unwrap_or(file_name);
    if name.trim().is_empty() {
        "Import".to_owned()
    } else {
        name.to_owned()
    }
}

fn inspect_archive(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|_| "cannot read ZIP export".to_owned())?;
    if !metadata.is_file() {
        return Err("ZIP export file not found".to_owned());
    }
    if metadata.len() > MAX_UNCOMPRESSED_BYTES {
        return Err("ZIP export is too large".to_owned());
    }

    let file = File::open(path).map_err(|_| "cannot read ZIP export".to_owned())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "invalid ZIP export".to_owned())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("ZIP export has too many entries".to_owned());
    }

    let mut total_uncompressed: u64 = 0;
    let mut files = 0usize;
    let mut has_manifest = false;
    let mut has_checksums = false;
    let mut declared: Vec<String> = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "invalid ZIP entry".to_owned())?;
        let name = entry.name().to_owned();
        if !is_safe_entry(&name) {
            return Err("ZIP entry escapes the project folder".to_owned());
        }
        if entry.unix_mode().is_some_and(is_symlink_mode) {
            return Err("ZIP symlink entries are not allowed".to_owned());
        }
        if name.ends_with('/') {
            continue;
        }
        files += 1;
        has_manifest |= name == MANIFEST_FILE;
        has_checksums |= name == CHECKSUMS_FILE;
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES {
            return Err("ZIP export expands beyond 2 GiB".to_owned());
        }
        if name == CHECKSUMS_FILE {
            if entry.size() > MAX_CHECKSUMS_BYTES {
                return Err("ZIP checksums file is too large".to_owned());
            }
            let mut text = String::new();
            entry
                .read_to_string(&mut text)
                .map_err(|_| "cannot read ZIP checksums".to_owned())?;
            for line in text.lines() {
                if let Some(relative) = line.split_whitespace().nth(1) {
                    if !is_safe_entry(relative) {
                        return Err("ZIP checksum entry escapes the project folder".to_owned());
                    }
                    declared.push(relative.to_owned());
                }
            }
        }
    }

    if total_uncompressed > metadata.len().max(1).saturating_mul(MAX_COMPRESSION_RATIO) {
        return Err("ZIP export compression ratio is too high".to_owned());
    }
    if files == 0 {
        return Err("empty ZIP export".to_owned());
    }
    if !has_manifest {
        return Err("ZIP export has no manifest.json".to_owned());
    }
    if !has_checksums {
        return Err("ZIP export has no checksums.sha256".to_owned());
    }
    for required in [
        MANIFEST_FILE,
        PERSON_FILE,
        RELATIONSHIP_FILE,
        EVENT_FILE,
        SOURCE_FILE,
        CITATION_FILE,
        MEDIA_FILE,
    ] {
        if !declared.iter().any(|name| name == required) {
            return Err(format!("ZIP checksums do not cover {required}"));
        }
    }
    Ok(())
}

fn is_safe_entry(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.starts_with('\\')
        && !name.contains(':')
        && !name.contains('\0')
        && !name.split(['/', '\\']).any(|part| part == "..")
}

fn is_symlink_mode(mode: u32) -> bool {
    mode & 0o170000 == 0o120000
}

fn sorted_by_id<T: Clone>(items: &[T], id: impl Fn(&T) -> Uuid) -> Vec<T> {
    let mut out = items.to_vec();
    out.sort_by_key(|item| id(item));
    out
}

pub(crate) fn create_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|_| "cannot create export folder".to_owned())?;
    }
    Ok(())
}

pub(crate) fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    // Same-volume fast path: no partial target is ever observable.
    if !target.exists() && fs::rename(source, target).is_ok() {
        return Ok(());
    }

    let staging = target.with_file_name(format!(".gentree-export-{}", Uuid::now_v7()));
    let result = (|| -> Result<(), String> {
        fs::copy(source, &staging).map_err(|_| "cannot write export file".to_owned())?;
        if target.exists() {
            fs::remove_file(target).map_err(|_| "cannot replace export target".to_owned())?;
        }
        fs::rename(&staging, target).map_err(|_| "cannot finalize export file".to_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn app_error(err: AppError) -> String {
    format!("{}: {}", err.code, err.message)
}
