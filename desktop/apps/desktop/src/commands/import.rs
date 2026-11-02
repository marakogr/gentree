//! `import_preview_at5` / `import_at5` and `import_preview_gedcom` /
//! `import_gedcom` commands. Contract: import report and exchange format.
//!
//! Every preview is a dry run over a read-only reader. Every import creates a
//! brand-new project: an existing project is never opened for writing and the
//! source file is never modified. Both AT5 and GEDCOM copy resolved media
//! bytes into the project's `media/` folder.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use gentree_core::error::codes;
use gentree_core::project::Manifest;
use gentree_core::record::Media;
use gentree_core::{AppError, AppResult};
use gentree_import::gedcom::{self, GedcomBundle, GedcomMediaFile};
use gentree_import::{
    plan_at5_with_media_dirs, read_at5_bundle_with_media_dirs, At5Bundle, At5MediaFile,
    ImportReport,
};
use gentree_storage::{store_media_bytes, store_media_file, ProjectStore};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{project_info, projects_dir, AppState, ProjectInfo};

use super::discard_project;

/// Issue added when a media file changed between parsing and storing.
pub const MEDIA_CHANGED_ISSUE: &str =
    "media file changed between preview and import; the stored copy is authoritative";

/// `import_preview_at5` / `import_preview_gedcom` payload; wrapped so the
/// report can grow later.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub report: ImportReport,
}

/// `import_at5` / `import_gedcom` payload: the opened project plus the report
/// of what was written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub project: ProjectInfo,
    pub report: ImportReport,
}

/// `import_probe` payload: what a dropped path is and which reader can open it.
///
/// The import modal accepts both a data file and a media folder in the same
/// drop, so the path itself has to be classified before choosing a reader.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProbe {
    pub is_dir: bool,
    /// `at5` or `gedcom` for a supported file, `null` otherwise.
    pub format: Option<&'static str>,
}

/// Classify one dropped or picked path without opening the project.
#[tauri::command]
pub fn import_probe(path: String) -> AppResult<ImportProbe> {
    probe_import_path(Path::new(&path))
}

fn probe_import_path(path: &Path) -> AppResult<ImportProbe> {
    let metadata = fs::metadata(path).map_err(|err| AppError::io("read import source", err))?;
    if metadata.is_dir() {
        return Ok(ImportProbe {
            is_dir: true,
            format: None,
        });
    }
    Ok(ImportProbe {
        is_dir: false,
        format: sniff_import_format(path),
    })
}

/// Content first, extension second: a renamed `.at5`/`.ged` still opens with
/// the right reader, while folders are classified by `metadata`, not by name.
fn sniff_import_format(path: &Path) -> Option<&'static str> {
    let mut head = [0u8; 64];
    let read = fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .unwrap_or(0);
    let bytes = &head[..read];

    if bytes.starts_with(b"SQLite format 3\0") {
        return Some("at5");
    }
    let text = String::from_utf8_lossy(bytes);
    if text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("0 HEAD")
    {
        return Some("gedcom");
    }

    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("at5") => Some("at5"),
        Some("ged") | Some("gedcom") => Some("gedcom"),
        _ => None,
    }
}

/// Dry run: read the bundle and return its report without writing anything.
///
/// `media_dirs` are extra folders searched for media by file name after the
/// `.files` folder next to the database, exactly like GEDCOM.
#[tauri::command]
pub fn import_preview_at5(path: String, media_dirs: Vec<String>) -> AppResult<ImportPreview> {
    let report = plan_at5_with_media_dirs(Path::new(&path), &media_paths(&media_dirs))?;
    Ok(ImportPreview { report })
}

/// Import AT5 into a new project and make it the open project.
///
/// `name` overrides the project name; blank or absent falls back to the file
/// stem, so the UI can pass a user-chosen name without changing the default.
#[tauri::command]
pub fn import_at5(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    media_dirs: Vec<String>,
    name: Option<String>,
) -> AppResult<ImportResult> {
    let projects = projects_dir(&app, &state)?;
    let (manifest, report) = import_at5_into(
        &projects,
        Path::new(&path),
        &media_paths(&media_dirs),
        name.as_deref(),
    )?;
    finish_import(&app, state, &projects, &manifest, report)
}

/// Dry run over the GEDCOM reader; media folders are searched, nothing is
/// copied or written.
#[tauri::command]
pub fn import_preview_gedcom(path: String, media_dirs: Vec<String>) -> AppResult<ImportPreview> {
    Ok(ImportPreview {
        report: preview_gedcom(Path::new(&path), &media_paths(&media_dirs))?,
    })
}

/// Import GEDCOM into a new project, copy the media bytes and open the project.
///
/// `name` behaves as in [`import_at5`]: a non-empty override, else the stem.
#[tauri::command]
pub fn import_gedcom(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    media_dirs: Vec<String>,
    name: Option<String>,
) -> AppResult<ImportResult> {
    let projects = projects_dir(&app, &state)?;
    let (manifest, report) = import_gedcom_into(
        &projects,
        Path::new(&path),
        &media_paths(&media_dirs),
        name.as_deref(),
    )?;
    finish_import(&app, state, &projects, &manifest, report)
}

/// Open the freshly written project, make it current and return its info.
///
/// On any failure the new folder is moved to `.trash`, so a half-written
/// project never becomes reachable through the project list.
fn finish_import(
    app: &AppHandle,
    state: State<'_, AppState>,
    projects: &Path,
    manifest: &Manifest,
    report: ImportReport,
) -> AppResult<ImportResult> {
    let project_dir = projects.join(manifest.project_id.to_string());

    let store = match ProjectStore::open(&project_dir, true) {
        Ok(store) => store,
        Err(error) => {
            discard_project(projects, &project_dir);
            return Err(error);
        }
    };
    crate::allow_media_scope(app, store.root());
    let project = project_info(&store);

    let mut guard = match state.project.lock() {
        Ok(guard) => guard,
        Err(_) => {
            drop(store);
            discard_project(projects, &project_dir);
            return Err(AppError::new(codes::UNKNOWN, "state poisoned"));
        }
    };
    *guard = Some(store);
    Ok(ImportResult { project, report })
}

/// Create a new project from `path` under `projects_dir` and close it again.
///
/// `media_dirs` are extra folders searched for referenced media by file name
/// after the `.files` folder next to the database. No Tauri types are involved,
/// so the error path is unit-testable. The lock is released before returning;
/// the caller reopens the project to make it current. On any write error the
/// new folder is moved to `<projects_dir>/.trash`, so a half-written project is
/// never left behind.
pub fn import_at5_into(
    projects_dir: &Path,
    path: &Path,
    media_dirs: &[PathBuf],
    name: Option<&str>,
) -> AppResult<(Manifest, ImportReport)> {
    let bundle = read_at5_bundle_with_media_dirs(path, media_dirs)?;
    let mut report = bundle.report.clone();
    let mut store = ProjectStore::create(projects_dir, &project_name(path, name))?;
    let root = store.root().to_path_buf();

    if let Err(error) = write_bundle(&mut store, &bundle, &mut report) {
        drop(store);
        discard_project(projects_dir, &root);
        return Err(error);
    }

    let manifest = store.manifest().clone();
    // Dropping the store releases the exclusive lock before the caller reopens it.
    drop(store);
    Ok((manifest, report))
}

/// GEDCOM dry run: the same read path as [`import_gedcom_into`], no writes.
fn preview_gedcom(path: &Path, media_dirs: &[PathBuf]) -> AppResult<ImportReport> {
    let bundle = gedcom::parse_bundle(path, media_dirs)?;
    Ok(gedcom_report(&bundle))
}

/// Create a new project from `path`, copy resolved media bytes and close it.
///
/// Same error contract as [`import_at5_into`]: a write or copy failure moves
/// the new folder to `<projects_dir>/.trash` and leaves existing projects
/// untouched. Media sources are copied with [`store_media_file`], so the stored
/// checksum and the project-relative `media/<prefix>/<name>` layout are the
/// ones actually written to disk, not the preview values.
pub fn import_gedcom_into(
    projects_dir: &Path,
    path: &Path,
    media_dirs: &[PathBuf],
    name: Option<&str>,
) -> AppResult<(Manifest, ImportReport)> {
    let bundle = gedcom::parse_bundle(path, media_dirs)?;
    let mut store = ProjectStore::create(projects_dir, &project_name_or(path, "GEDCOM", name))?;
    let root = store.root().to_path_buf();
    let mut report = gedcom_report(&bundle);

    if let Err(error) = write_gedcom_bundle(&mut store, &bundle, &mut report) {
        drop(store);
        discard_project(projects_dir, &root);
        return Err(error);
    }

    let manifest = store.manifest().clone();
    drop(store);
    Ok((manifest, report))
}

fn write_bundle(
    store: &mut ProjectStore,
    bundle: &At5Bundle,
    report: &mut ImportReport,
) -> AppResult<()> {
    store.save_persons(&bundle.persons)?;
    store.save_relationships(&bundle.relationships)?;
    store.save_events(&bundle.events)?;
    // AT5 has no sources/citations table in the current reader; explicitly
    // write the empty collection so the new project is complete.
    store.save_citations(&[])?;
    let media = store_at5_media(store.root(), &bundle.media, &bundle.media_files, report)?;
    store.save_media(&media)
}

/// Copies every `.files` source into the project and returns the media rows
/// that point at the stored copy. Preview-only rows keep their metadata; a
/// changed source is reported but the stored copy stays authoritative.
fn store_at5_media(
    project_dir: &Path,
    media: &[Media],
    files: &[At5MediaFile],
    report: &mut ImportReport,
) -> AppResult<Vec<Media>> {
    let mut stored = media.to_vec();
    for (index, file) in files.iter().enumerate() {
        let (relative, checksum) = if let Some(source) = file.source.as_deref() {
            store_media_file(project_dir, source)?
        } else if let Some(bytes) = file.bytes.as_deref() {
            store_media_bytes(project_dir, &file.media.file_name, bytes)?
        } else {
            continue;
        };
        if checksum != file.media.checksum {
            report.issues.push(MEDIA_CHANGED_ISSUE.to_owned());
        }
        let file_name = relative
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::new(codes::IO_ERROR, "stored media path has no file name"))?;
        if let Some(item) = stored.get_mut(index) {
            item.checksum = checksum;
            item.file_name = file_name.to_owned();
        }
    }
    Ok(stored)
}

fn write_gedcom_bundle(
    store: &mut ProjectStore,
    bundle: &GedcomBundle,
    report: &mut ImportReport,
) -> AppResult<()> {
    store.save_persons(&bundle.persons)?;
    store.save_relationships(&bundle.relationships)?;
    store.save_events(&bundle.events)?;
    // GEDCOM citations are not mapped yet; an explicit empty collection keeps
    // the new project complete.
    store.save_citations(&[])?;

    let project_dir = store.root().to_path_buf();
    let media = store_gedcom_media(&project_dir, &bundle.media_files, report)?;
    store.save_media(&media)
}

/// Copy every resolved media file and return the records for `media.jsonl`.
///
/// A copy failure aborts the import (the caller moves the project to trash).
/// `store_media_file` recomputes sha256 and returns the stored relative path;
/// both are used here, so a file that changed since parsing cannot leave a
/// record pointing at a missing or mismatched copy.
fn store_gedcom_media(
    project_dir: &Path,
    media_files: &[GedcomMediaFile],
    report: &mut ImportReport,
) -> AppResult<Vec<Media>> {
    let mut stored = Vec::with_capacity(media_files.len());
    for entry in media_files {
        let (relative, checksum) = store_media_file(project_dir, &entry.source)?;
        if checksum != entry.media.checksum {
            report.issues.push(MEDIA_CHANGED_ISSUE.to_owned());
        }
        let file_name = relative
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::new(codes::IO_ERROR, "stored media path has no file name"))?;
        stored.push(Media {
            checksum,
            file_name: file_name.to_owned(),
            ..entry.media.clone()
        });
    }
    Ok(stored)
}

/// GEDCOM report translated to the report shape shared with AT5.
fn gedcom_report(bundle: &GedcomBundle) -> ImportReport {
    ImportReport {
        persons: bundle.report.persons,
        relationships: bundle.report.relationships,
        events: bundle.events.len(),
        media: bundle.media.len(),
        warnings: bundle.report.warnings.clone(),
        issues: bundle.report.issues.clone(),
        conflicts: Vec::new(),
    }
}

/// UI folders are strings; blank entries are ignored and the source order kept.
fn media_paths(dirs: &[String]) -> Vec<PathBuf> {
    dirs.iter()
        .map(|dir| PathBuf::from(dir.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .collect()
}

/// Name of the created project: the explicit `name` when it is not blank,
/// otherwise the source file stem, never an absolute path.
fn project_name(path: &Path, name: Option<&str>) -> String {
    project_name_or(path, "AT5", name)
}

fn project_name_or(path: &Path, fallback: &str, name: Option<&str>) -> String {
    name.map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::trim)
                .filter(|stem| !stem.is_empty())
                .unwrap_or(fallback)
                .to_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use gentree_storage::media_relative_path;

    /// Synthetic GEDCOM: two spouses, one child, one birth and two media files.
    const GEDCOM_FIXTURE: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ivan /Petrov/
1 SEX M
1 BIRT
2 DATE 15 MAY 1950
1 OBJE
2 FILE photos/scan.jpg
0 @I2@ INDI
1 NAME Maria /Ivanova/
1 SEX F
0 @I3@ INDI
1 NAME Sergey /Petrov/
1 SEX M
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @M1@ OBJE
1 FILE documents/doc.pdf
0 TRLR
";

    const GEDCOM_BAD_MEDIA: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ivan /Petrov/
1 OBJE
2 FILE photos/bad..jpg
0 TRLR
";

    fn projects_dir(root: &Path) -> PathBuf {
        let dir = root.join("projects");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assert_no_project(dir: &Path) {
        assert!(
            fs::read_dir(dir).unwrap().next().is_none(),
            "a failed import must not leave a project behind"
        );
    }

    fn write(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn gedcom_fixture(root: &Path) -> PathBuf {
        let path = root.join("family.ged");
        write(&path, GEDCOM_FIXTURE.as_bytes());
        write(
            &root.join("family.ged.files").join("photos/scan.jpg"),
            b"synthetic photo bytes",
        );
        path
    }

    fn project_dirs(dir: &Path) -> Vec<String> {
        let mut names = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn probe_detects_folder_and_supported_file_formats() {
        let tmp = tempfile::tempdir().unwrap();

        let media = tmp.path().join("media");
        fs::create_dir(&media).unwrap();
        let folder = probe_import_path(&media).unwrap();
        assert!(folder.is_dir);
        assert_eq!(folder.format, None);

        let sqlite = tmp.path().join("tree.bin");
        fs::write(&sqlite, b"SQLite format 3\0rest of the header").unwrap();
        let at5 = probe_import_path(&sqlite).unwrap();
        assert!(!at5.is_dir);
        assert_eq!(at5.format, Some("at5"));

        let gedcom = tmp.path().join("tree.data");
        fs::write(&gedcom, b"\xEF\xBB\xBF0 HEAD\n1 GEDC\n").unwrap();
        let ged = probe_import_path(&gedcom).unwrap();
        assert!(!ged.is_dir);
        assert_eq!(ged.format, Some("gedcom"));

        // An empty file cannot be sniffed; the extension is the fallback.
        let empty = tmp.path().join("empty.ged");
        fs::write(&empty, b"").unwrap();
        assert_eq!(probe_import_path(&empty).unwrap().format, Some("gedcom"));

        let unknown = tmp.path().join("notes.txt");
        fs::write(&unknown, b"hello").unwrap();
        assert_eq!(probe_import_path(&unknown).unwrap().format, None);
    }

    #[test]
    fn probe_missing_path_reports_io_error() {
        let tmp = tempfile::tempdir().unwrap();
        let error = probe_import_path(&tmp.path().join("missing.at5")).unwrap_err();
        assert_eq!(error.code, codes::IO_ERROR);
    }

    #[test]
    fn missing_file_reports_io_error_and_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());

        let error = import_at5_into(&dir, &tmp.path().join("missing.at5"), &[], None).unwrap_err();

        assert_eq!(error.code, codes::IO_ERROR);
        assert_no_project(&dir);
    }

    #[test]
    fn non_sqlite_file_reports_parse_error_and_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());
        let file = tmp.path().join("broken.at5");
        fs::write(&file, b"this is not a sqlite database").unwrap();

        let error = import_at5_into(&dir, &file, &[], None).unwrap_err();

        assert_eq!(error.code, codes::IMPORT_PARSE_ERROR);
        assert_no_project(&dir);
    }

    #[test]
    fn project_name_prefers_the_explicit_name_and_ignores_blank() {
        assert_eq!(
            project_name(Path::new("C:/data/family.at5"), None),
            "family"
        );
        assert_eq!(project_name(Path::new(""), None), "AT5");
        assert_eq!(
            project_name(Path::new("C:/data/family.at5"), Some("  My tree  ")),
            "My tree"
        );
        assert_eq!(
            project_name(Path::new("C:/data/family.at5"), Some("   ")),
            "family"
        );
        assert_eq!(
            project_name_or(Path::new("C:/data/family.ged"), "GEDCOM", None),
            "family"
        );
        assert_eq!(
            project_name_or(Path::new(""), "GEDCOM", Some("Tree from disk")),
            "Tree from disk"
        );
        assert_eq!(project_name_or(Path::new(""), "GEDCOM", None), "GEDCOM");
    }

    #[test]
    fn preview_gedcom_reports_counts_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());
        let path = gedcom_fixture(tmp.path());
        let documents = tmp.path().join("documents");
        write(&documents.join("doc.pdf"), b"%PDF-1.4 synthetic");

        let report = preview_gedcom(&path, std::slice::from_ref(&documents)).unwrap();

        assert_eq!(report.persons, 3);
        assert_eq!(report.relationships, 3);
        assert_eq!(report.events, 1);
        assert_eq!(report.media, 2);
        assert!(report.conflicts.is_empty());
        assert_no_project(&dir);
    }

    #[test]
    fn import_gedcom_copies_media_and_creates_a_complete_project() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());
        let path = gedcom_fixture(tmp.path());
        let documents = tmp.path().join("documents");
        write(&documents.join("doc.pdf"), b"%PDF-1.4 synthetic");

        let (manifest, report) =
            import_gedcom_into(&dir, &path, std::slice::from_ref(&documents), None).unwrap();

        assert_eq!(manifest.name, "family");
        assert_eq!(report.persons, 3);
        assert_eq!(report.relationships, 3);
        assert_eq!(report.events, 1);
        assert_eq!(report.media, 2);
        assert!(report.conflicts.is_empty());
        assert!(
            !report
                .issues
                .iter()
                .any(|issue| issue.contains("changed between preview")),
            "{:?}",
            report.issues
        );

        let project_dir = dir.join(manifest.project_id.to_string());
        let store = ProjectStore::open(&project_dir, true).unwrap();
        let persons = store.persons().unwrap();
        assert_eq!(persons.len(), 3);
        assert_eq!(store.relationships().unwrap().len(), 3);
        assert_eq!(store.events().unwrap().len(), 1);

        let media = store.media().unwrap();
        assert_eq!(media.len(), 2);
        assert!(media.iter().all(|entry| entry.checksum.len() == 64));
        assert!(media.iter().all(|entry| entry.source_id.is_none()));
        // The INDI photo is attributed to its person; the top-level document is not.
        let scan = media
            .iter()
            .find(|entry| entry.file_name == "scan.jpg")
            .unwrap();
        assert_eq!(scan.person_id, Some(persons[0].id));
        let document = media
            .iter()
            .find(|entry| entry.file_name == "doc.pdf")
            .unwrap();
        assert_eq!(document.person_id, None);
        for entry in &media {
            let relative = media_relative_path(&entry.checksum, &entry.file_name).unwrap();
            let stored = project_dir.join(relative);
            assert!(stored.is_file(), "missing stored media: {stored:?}");
            // The copy is byte-identical to the source.
            let expected: &[u8] = match entry.file_name.as_str() {
                "scan.jpg" => b"synthetic photo bytes",
                "doc.pdf" => b"%PDF-1.4 synthetic",
                other => panic!("unexpected media name: {other}"),
            };
            assert_eq!(fs::read(&stored).unwrap(), expected);
        }

        // The project is complete: the manifest, the six JSONL files and the
        // media folder agree with the counts.
        assert_eq!(store.manifest().counts.media, 2);
        assert!(
            store.validate_layout().unwrap().ok,
            "{:?}",
            store.validate_layout()
        );
    }

    #[test]
    fn import_gedcom_applies_the_project_name_override() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());
        let path = gedcom_fixture(tmp.path());
        let documents = tmp.path().join("documents");
        write(&documents.join("doc.pdf"), b"%PDF-1.4 synthetic");

        let (manifest, _) = import_gedcom_into(
            &dir,
            &path,
            std::slice::from_ref(&documents),
            Some("  Family archive  "),
        )
        .unwrap();

        assert_eq!(manifest.name, "Family archive");
    }

    #[test]
    fn import_gedcom_parse_error_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());
        let file = tmp.path().join("broken.ged");
        fs::write(&file, b"this is not a gedcom file").unwrap();

        let error = import_gedcom_into(&dir, &file, &[], None).unwrap_err();

        assert_eq!(error.code, codes::IMPORT_PARSE_ERROR);
        assert_no_project(&dir);
    }

    #[test]
    fn import_gedcom_write_error_moves_the_project_to_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = projects_dir(tmp.path());
        let path = tmp.path().join("family.ged");
        write(&path, GEDCOM_BAD_MEDIA.as_bytes());
        // The parser accepts the name, `store_media_file` refuses it: the
        // project is created and then has to be discarded.
        write(
            &tmp.path().join("family.ged.files").join("photos/bad..jpg"),
            b"synthetic photo bytes",
        );

        let error = import_gedcom_into(&dir, &path, &[], None).unwrap_err();

        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(project_dirs(&dir), vec![".trash".to_owned()]);
        assert_eq!(fs::read_dir(dir.join(".trash")).unwrap().count(), 1);
    }

    #[test]
    fn at5_media_bytes_are_copied_into_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("scan.jpg");
        write(&source, b"synthetic photo bytes");
        let staging = tmp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        let (_, checksum) = store_media_file(&staging, &source).unwrap();
        let media = Media {
            id: uuid::Uuid::now_v7(),
            file_name: "scan.jpg".to_owned(),
            mime_type: "image/jpeg".to_owned(),
            checksum,
            caption: None,
            source_id: None,
            person_id: None,
            event_id: None,
            primary: false,
        };
        let file = At5MediaFile {
            media: media.clone(),
            source: Some(source),
            bytes: None,
        };
        let mut report = ImportReport::default();

        let stored = store_at5_media(
            tmp.path(),
            std::slice::from_ref(&media),
            &[file],
            &mut report,
        )
        .unwrap();

        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].checksum, media.checksum);
        let path = gentree_storage::resolve_media_path(tmp.path(), &stored[0]).unwrap();
        assert!(path.is_file(), "{path:?}");
        assert_eq!(fs::read(&path).unwrap(), b"synthetic photo bytes");
    }

    #[test]
    fn media_paths_skips_blank_entries() {
        let dirs = vec![" C:/photos ".to_owned(), "  ".to_owned()];
        assert_eq!(media_paths(&dirs), vec![PathBuf::from("C:/photos")]);
        assert!(media_paths(&[]).is_empty());
    }
}
