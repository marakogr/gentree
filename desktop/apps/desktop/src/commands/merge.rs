//! `merge_preview` / `merge_apply` commands. Contract: ADR-0017.
//!
//! Both commands open the two source projects read-only through
//! [`ProjectStore`]; neither source is modified or deleted. `merge_preview` is a
//! pure dry run over [`ProjectSnapshot`]s. `merge_apply` writes a brand-new
//! project: the core [`gentree_core::merge::apply_merge`] produces the rows, the
//! desktop layer copies media bytes, drops rows whose file is missing, validates
//! and opens the result.
//!
//! Errors are stable codes. A media copy failure never leaks an absolute path:
//! [`MEDIA_MISSING`] and [`MEDIA_CHANGED`] warnings carry only the file name and
//! checksum.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use gentree_core::error::codes;
use gentree_core::merge::{
    self, MergeDecisions, MergeOutput, MergePreview, MergeReport, MergeWarning,
};
use gentree_core::person::Person;
use gentree_core::project::Manifest;
use gentree_core::record::{Citation, CitationTarget, Event, Media, Source};
use gentree_core::relationship::Relationship;
use gentree_core::validation::{ProjectSnapshot, Severity};
use gentree_core::{AppError, AppResult};
use gentree_storage::{store_media_file, ProjectStore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{project_info, projects_dir, AppState, ProjectInfo};

use super::{discard_project, parse_uuid, validate_store};

/// A merged media file is no longer on disk. Params: `fileName`, `checksum`.
/// Emitted by this layer; the core only documents the code.
pub const MEDIA_MISSING: &str = merge::codes::MEDIA_MISSING;

/// A merged media file changed on disk after it was recorded. The stored copy
/// is authoritative and the row carries the stored checksum. Params:
/// `fileName`, `checksum` (the stored checksum).
pub const MEDIA_CHANGED: &str = "MEDIA_CHANGED";

/// `merge_apply` payload: the new project and the core report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub project: ProjectInfo,
    pub report: MergeReport,
}

/// `merge_apply` request. Ids arrive as strings so a malformed one is a
/// `VALIDATION_ERROR` on its own field, like every other command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeApplyRequest {
    pub left_project_id: String,
    pub right_project_id: String,
    pub name: String,
    pub decisions: MergeDecisions,
}

/// Dry run: suggestions for merging `right` into `left`. Nothing is written.
#[tauri::command]
pub fn merge_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    left_project_id: String,
    right_project_id: String,
) -> AppResult<MergePreview> {
    let projects = projects_dir(&app, &state)?;
    let left_id = parse_uuid("leftProjectId", &left_project_id)?;
    let right_id = parse_uuid("rightProjectId", &right_project_id)?;
    ensure_distinct(left_id, right_id)?;

    let left_store = open_read_only(&projects, left_id)?;
    let right_store = open_read_only(&projects, right_id)?;
    let left = LoadedProject::load(&left_store)?;
    let right = LoadedProject::load(&right_store)?;

    Ok(merge::merge_preview(left.snapshot(), right.snapshot()))
}

/// Apply the decisions into a new project, copy media and open the result.
///
/// The sources stay untouched; a failure while writing moves the new folder to
/// `<projects_dir>/.trash`, so a half-written project never appears in the list.
#[tauri::command]
pub fn merge_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    request: MergeApplyRequest,
) -> AppResult<MergeResult> {
    let projects = projects_dir(&app, &state)?;
    let left_id = parse_uuid("leftProjectId", &request.left_project_id)?;
    let right_id = parse_uuid("rightProjectId", &request.right_project_id)?;
    let (manifest, report) = merge_apply_into(
        &projects,
        left_id,
        right_id,
        &request.name,
        &request.decisions,
    )?;
    finish_merge(&app, state, &projects, &manifest, report)
}

/// Open the freshly written project, make it current and return its info.
fn finish_merge(
    app: &AppHandle,
    state: State<'_, AppState>,
    projects: &Path,
    manifest: &Manifest,
    report: MergeReport,
) -> AppResult<MergeResult> {
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
    Ok(MergeResult { project, report })
}

/// Create the merged project under `projects_dir` and close it again.
///
/// No Tauri types are involved, so the whole write path is unit-testable. The
/// returned manifest belongs to the new project; the caller reopens it writable
/// to make it current. The sources are only ever opened read-only.
pub fn merge_apply_into(
    projects_dir: &Path,
    left_project_id: Uuid,
    right_project_id: Uuid,
    name: &str,
    decisions: &MergeDecisions,
) -> AppResult<(Manifest, MergeReport)> {
    ensure_distinct(left_project_id, right_project_id)?;

    let left_store = open_read_only(projects_dir, left_project_id)?;
    let right_store = open_read_only(projects_dir, right_project_id)?;
    let left = LoadedProject::load(&left_store)?;
    let right = LoadedProject::load(&right_store)?;
    let output = merge::apply_merge(left.snapshot(), right.snapshot(), decisions)?;

    let name = merged_project_name(name, left_store.manifest(), right_store.manifest());
    let mut store = ProjectStore::create(projects_dir, &name)?;
    let root = store.root().to_path_buf();

    let report = match write_merge(
        &mut store,
        &MergeSides {
            left_store: &left_store,
            right_store: &right_store,
            left: &left,
            right: &right,
        },
        output,
    ) {
        Ok(report) => report,
        Err(error) => {
            drop(store);
            discard_project(projects_dir, &root);
            return Err(error);
        }
    };

    let manifest = store.manifest().clone();
    // Dropping the store releases the exclusive lock before the caller reopens it.
    drop(store);
    Ok((manifest, report))
}

/// Left and right must name different projects; the same project merged with
/// itself is rejected before anything is opened.
fn ensure_distinct(left: Uuid, right: Uuid) -> AppResult<()> {
    if left == right {
        return Err(AppError::validation("rightProjectId", "distinctProjects"));
    }
    Ok(())
}

/// A blank override falls back to `"<left name> + <right name>"`.
fn merged_project_name(name: &str, left: &Manifest, right: &Manifest) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_owned();
    }
    format!("{} + {}", left.name.trim(), right.name.trim())
}

fn open_read_only(projects_dir: &Path, project_id: Uuid) -> AppResult<ProjectStore> {
    ProjectStore::open(&projects_dir.join(project_id.to_string()), false)
}

/// The six collections of one project, read in one pass.
struct LoadedProject {
    persons: Vec<Person>,
    events: Vec<Event>,
    relationships: Vec<Relationship>,
    sources: Vec<Source>,
    citations: Vec<Citation>,
    media: Vec<Media>,
}

impl LoadedProject {
    fn load(store: &ProjectStore) -> AppResult<Self> {
        Ok(Self {
            persons: store.persons()?,
            events: store.events()?,
            relationships: store.relationships()?,
            sources: store.sources()?,
            citations: store.citations()?,
            media: store.media()?,
        })
    }

    fn snapshot(&self) -> ProjectSnapshot<'_> {
        ProjectSnapshot {
            persons: &self.persons,
            events: &self.events,
            relationships: &self.relationships,
            sources: &self.sources,
            citations: &self.citations,
            media: &self.media,
        }
    }
}

/// Which source project an output media row came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaSide {
    Left,
    Right,
}

/// The two read-only source projects and their loaded collections.
struct MergeSides<'a> {
    left_store: &'a ProjectStore,
    right_store: &'a ProjectStore,
    left: &'a LoadedProject,
    right: &'a LoadedProject,
}

/// Write the merged collections into the new store and validate them.
///
/// Media bytes are copied before `save_media`, so a row never points at a file
/// that was not stored. Events are written before media so an event attachment
/// never points at an event that does not exist yet (ADR-0018); sources and
/// persons come first because both reference them.
fn write_merge(
    store: &mut ProjectStore,
    sides: &MergeSides<'_>,
    output: MergeOutput,
) -> AppResult<MergeReport> {
    let MergeOutput {
        persons,
        events,
        relationships,
        sources,
        citations,
        media,
        mut report,
        media_map,
        ..
    } = output;

    let (media, dropped_media) = copy_media(store.root(), sides, &media_map, media, &mut report)?;
    let citations: Vec<Citation> = citations
        .into_iter()
        .filter(|citation| {
            !(citation.target_type == CitationTarget::Media
                && dropped_media.contains(&citation.target_id))
        })
        .collect();

    store.save_persons(&persons)?;
    store.save_sources(&sources)?;
    store.save_events(&events)?;
    store.save_media(&media)?;
    store.save_relationships(&relationships)?;
    store.save_citations(&citations)?;

    let validation = validate_store(store)?;
    if validation.counts.error > 0 {
        let mut error = AppError::new(codes::MERGE_CONFLICT, "Merged project is invalid")
            .with_param("rule", "invalidOutput")
            .with_param("errors", validation.counts.error.to_string());
        if let Some(issue) = validation
            .issues
            .iter()
            .find(|issue| issue.severity == Severity::Error)
        {
            error = error.with_param("issue", issue.code.clone());
        }
        return Err(error);
    }

    Ok(report)
}

/// Copy every output media row from its source project into `new_root`.
///
/// Returns the rows that survive and the ids of rows dropped because their file
/// is gone. A changed file keeps its row with the stored checksum, because the
/// stored copy is authoritative. Nothing is ever dropped without a warning.
fn copy_media(
    new_root: &Path,
    sides: &MergeSides<'_>,
    media_map: &BTreeMap<Uuid, Uuid>,
    rows: Vec<Media>,
    report: &mut MergeReport,
) -> AppResult<(Vec<Media>, BTreeSet<Uuid>)> {
    let origins = media_origins(&sides.left.media, &sides.right.media, media_map);
    let mut kept = Vec::with_capacity(rows.len());
    let mut dropped = BTreeSet::new();

    for mut row in rows {
        let Some((side, source_row)) = origins.get(&row.id) else {
            // Defensive: an output row without an input origin cannot be
            // copied, so it is reported like a missing file instead of failing
            // the whole merge.
            drop_media(&mut dropped, report, &row);
            continue;
        };
        let source_store = match side {
            MediaSide::Left => sides.left_store,
            MediaSide::Right => sides.right_store,
        };
        let source_path = source_store
            .resolve_media_path(source_row)
            .ok()
            .filter(|path| path.is_file());
        let Some(source_path) = source_path else {
            drop_media(&mut dropped, report, &row);
            continue;
        };

        let checksum = match store_media_file(new_root, &source_path) {
            Ok((_relative, checksum)) => checksum,
            Err(error) if error.code == codes::NOT_FOUND => {
                drop_media(&mut dropped, report, &row);
                continue;
            }
            Err(error) => return Err(media_copy_error(&error, &row.file_name)),
        };

        if checksum != row.checksum {
            row.checksum = checksum.clone();
            report
                .warnings
                .push(media_warning(MEDIA_CHANGED, &row.file_name, &checksum));
        }
        kept.push(row);
    }

    Ok((kept, dropped))
}

/// Output media id to the input row it was built from.
///
/// Left rows keep their id; right rows map through `media_map`, which may point
/// at an existing left row when the core deduplicated identical metadata.
fn media_origins(
    left_media: &[Media],
    right_media: &[Media],
    media_map: &BTreeMap<Uuid, Uuid>,
) -> BTreeMap<Uuid, (MediaSide, Media)> {
    let mut origins = BTreeMap::new();
    for row in left_media {
        origins.insert(row.id, (MediaSide::Left, row.clone()));
    }
    for row in right_media {
        if let Some(output_id) = media_map.get(&row.id) {
            origins
                .entry(*output_id)
                .or_insert((MediaSide::Right, row.clone()));
        }
    }
    origins
}

fn drop_media(dropped: &mut BTreeSet<Uuid>, report: &mut MergeReport, row: &Media) {
    dropped.insert(row.id);
    report
        .warnings
        .push(media_warning(MEDIA_MISSING, &row.file_name, &row.checksum));
}

fn media_warning(code: &str, file_name: &str, checksum: &str) -> MergeWarning {
    MergeWarning {
        code: code.to_owned(),
        params: BTreeMap::from([
            ("fileName".to_owned(), file_name.to_owned()),
            ("checksum".to_owned(), checksum.to_owned()),
        ]),
    }
}

/// `store_media_file` puts the absolute source path in its `NOT_FOUND` params;
/// a merge error must never leak it.
fn media_copy_error(error: &AppError, file_name: &str) -> AppError {
    AppError::new(&error.code, "Failed to copy a media file").with_param("fileName", file_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use gentree_core::date::DateValue;
    use gentree_core::merge::{EventDecision, MergeAction, PersonDecision, Side};
    use gentree_core::person::{Gender, Name};
    use gentree_core::record::EventType;
    use gentree_core::relationship::RelationshipType;
    use gentree_storage::store_media_bytes;

    use crate::commands::validate_store;

    const LEFT_BYTES: &[u8] = b"left synthetic photo bytes";
    const RIGHT_BYTES: &[u8] = b"right synthetic photo bytes";

    /// Ids of the rows of one synthetic project.
    #[derive(Debug, Clone, Copy)]
    struct SideRows {
        project_id: Uuid,
        matched: Uuid,
        relative: Uuid,
        event: Uuid,
        media: Uuid,
    }

    fn projects_dir(root: &Path) -> PathBuf {
        let dir = root.join("projects");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn person(given: &str, surname: &str, gender: Gender, birth_year: i32) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some(given.to_owned()),
            surname: Some(surname.to_owned()),
            ..Name::default()
        }])
        .unwrap();
        person.gender = gender;
        person.birth = DateValue::exact_year(birth_year);
        person
    }

    /// One project with a matched person, a distinct relative, a birth event,
    /// a source, a person citation, a media row plus citation, and one edge.
    fn build_side(
        projects: &Path,
        name: &str,
        relative: (&str, &str, Gender),
        source_title: &str,
        media_name: &str,
        media_bytes: &[u8],
    ) -> SideRows {
        let mut store = ProjectStore::create(projects, name).unwrap();
        let project_id = store.manifest().project_id;

        let matched = person("Анна", "Петрова", Gender::Female, 1950);
        let relative = person(relative.0, relative.1, relative.2, 1920);

        let mut event = Event::new(matched.id, EventType::Birth);
        event.date = DateValue::exact_year(1950);
        event.place = Some("Москва".to_owned());

        let source = Source::new(source_title).unwrap();
        let person_citation = Citation::new(source.id, CitationTarget::Person, matched.id);

        let (_relative_path, checksum) =
            store_media_bytes(store.root(), media_name, media_bytes).unwrap();
        let media = Media {
            id: Uuid::now_v7(),
            file_name: media_name.to_owned(),
            mime_type: "image/jpeg".to_owned(),
            checksum,
            caption: None,
            source_id: None,
            person_id: Some(matched.id),
            event_id: None,
            primary: false,
        };
        let media_citation = Citation::new(source.id, CitationTarget::Media, media.id);

        let relationship =
            Relationship::new(RelationshipType::ParentChild, relative.id, matched.id).unwrap();

        store
            .save_persons(&[matched.clone(), relative.clone()])
            .unwrap();
        store.save_sources(std::slice::from_ref(&source)).unwrap();
        store.save_events(&[event.clone()]).unwrap();
        store.save_relationships(&[relationship]).unwrap();
        store.save_media(std::slice::from_ref(&media)).unwrap();
        store
            .save_citations(&[person_citation, media_citation])
            .unwrap();

        drop(store);
        SideRows {
            project_id,
            matched: matched.id,
            relative: relative.id,
            event: event.id,
            media: media.id,
        }
    }

    fn build_fixture(projects: &Path) -> (SideRows, SideRows) {
        let left = build_side(
            projects,
            "Left archive",
            ("Иван", "Петров", Gender::Male),
            "Metric book",
            "photo.jpg",
            LEFT_BYTES,
        );
        let right = build_side(
            projects,
            "Right archive",
            ("Мария", "Петрова", Gender::Female),
            "Family letter",
            "scan.jpg",
            RIGHT_BYTES,
        );
        (left, right)
    }

    fn merge_pair(left: &SideRows, right: &SideRows) -> MergeDecisions {
        MergeDecisions {
            persons: vec![PersonDecision {
                left_id: left.matched,
                right_id: right.matched,
                action: MergeAction::Merge,
                base: Side::Left,
                fields: BTreeMap::new(),
            }],
            events: vec![EventDecision {
                left_event_id: left.event,
                right_event_id: right.event,
                action: MergeAction::Merge,
                base: Side::Left,
                fields: BTreeMap::new(),
            }],
        }
    }

    fn keep_both(left: &SideRows, right: &SideRows) -> MergeDecisions {
        MergeDecisions {
            persons: vec![PersonDecision {
                left_id: left.matched,
                right_id: right.matched,
                action: MergeAction::KeepBoth,
                base: Side::Left,
                fields: BTreeMap::new(),
            }],
            events: Vec::new(),
        }
    }

    fn project_dirs(dir: &Path) -> Vec<String> {
        let mut names = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn open_project(projects: &Path, project_id: Uuid) -> ProjectStore {
        ProjectStore::open(&projects.join(project_id.to_string()), false).unwrap()
    }

    fn media_bytes(store: &ProjectStore) -> Vec<Vec<u8>> {
        let mut rows = store
            .media()
            .unwrap()
            .iter()
            .map(|row| fs::read(store.resolve_media_path(row).unwrap()).unwrap())
            .collect::<Vec<_>>();
        rows.sort();
        rows
    }

    fn has_warning(report: &MergeReport, code: &str) -> bool {
        report.warnings.iter().any(|row| row.code == code)
    }

    #[test]
    fn preview_matches_the_pair_without_writing_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);

        let left_store = open_project(&projects, left.project_id);
        let right_store = open_project(&projects, right.project_id);
        let left_loaded = LoadedProject::load(&left_store).unwrap();
        let right_loaded = LoadedProject::load(&right_store).unwrap();
        let preview = merge::merge_preview(left_loaded.snapshot(), right_loaded.snapshot());

        assert_eq!(preview.matches.len(), 1);
        let matched = &preview.matches[0];
        assert_eq!(matched.left.id, left.matched);
        assert_eq!(matched.right.id, right.matched);
        assert_eq!(matched.event_matches.len(), 1);
        assert_eq!(matched.event_matches[0].left.id, left.event);
        assert_eq!(matched.event_matches[0].right.id, right.event);
        assert_eq!(preview.counts.matched_people, 1);
        assert_eq!(preview.counts.matched_events, 1);
        // Only the two sources exist; the preview created no project.
        assert_eq!(project_dirs(&projects).len(), 2);
    }

    #[test]
    fn merge_apply_writes_a_valid_project_and_leaves_both_sources_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);

        let before_left = open_project(&projects, left.project_id);
        let before_right = open_project(&projects, right.project_id);
        let left_hash = before_left.manifest().content_hash.clone();
        let right_hash = before_right.manifest().content_hash.clone();
        let left_counts = before_left.manifest().counts.clone();
        let right_counts = before_right.manifest().counts.clone();
        let left_bytes = media_bytes(&before_left);
        let right_bytes = media_bytes(&before_right);
        drop(before_left);
        drop(before_right);

        let (manifest, report) = merge_apply_into(
            &projects,
            left.project_id,
            right.project_id,
            "  Merged tree  ",
            &merge_pair(&left, &right),
        )
        .unwrap();

        assert_eq!(manifest.name, "Merged tree");
        assert_eq!(report.merged_people, 1);
        assert_eq!(report.merged_events, 1);
        assert_eq!(report.unmatched_right_people, 1);
        assert!(manifest.project_id != left.project_id && manifest.project_id != right.project_id);

        let merged = open_project(&projects, manifest.project_id);
        assert_eq!(merged.persons().unwrap().len(), 3);
        assert_eq!(merged.events().unwrap().len(), 1);
        assert_eq!(merged.relationships().unwrap().len(), 2);
        assert_eq!(merged.sources().unwrap().len(), 2);
        assert_eq!(merged.citations().unwrap().len(), 4);
        assert_eq!(merged.media().unwrap().len(), 2);
        assert_eq!(merged.manifest().counts.persons, 3);
        assert_eq!(merged.manifest().counts.media, 2);

        let mut expected = vec![LEFT_BYTES.to_vec(), RIGHT_BYTES.to_vec()];
        expected.sort();
        assert_eq!(media_bytes(&merged), expected);
        assert_eq!(validate_store(&merged).unwrap().counts.error, 0);
        drop(merged);

        // Both sources are byte-identical and still complete.
        let after_left = open_project(&projects, left.project_id);
        let after_right = open_project(&projects, right.project_id);
        assert_eq!(after_left.manifest().content_hash, left_hash);
        assert_eq!(after_right.manifest().content_hash, right_hash);
        assert_eq!(after_left.manifest().counts, left_counts);
        assert_eq!(after_right.manifest().counts, right_counts);
        assert_eq!(media_bytes(&after_left), left_bytes);
        assert_eq!(media_bytes(&after_right), right_bytes);
    }

    #[test]
    fn merge_apply_keep_both_keeps_both_people_and_events() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);

        let (manifest, report) = merge_apply_into(
            &projects,
            left.project_id,
            right.project_id,
            "   ",
            &keep_both(&left, &right),
        )
        .unwrap();

        assert_eq!(manifest.name, "Left archive + Right archive");
        assert_eq!(report.kept_both_people, 1);
        assert_eq!(report.merged_people, 0);
        // The report counts right events only: one right event was copied.
        assert_eq!(report.kept_both_events, 1);

        let merged = open_project(&projects, manifest.project_id);
        let persons = merged.persons().unwrap();
        assert_eq!(persons.len(), 4);
        assert!(persons.iter().any(|row| row.id == left.matched));
        assert!(persons.iter().any(|row| row.id == right.matched));
        assert_eq!(merged.events().unwrap().len(), 2);
        let relationships = merged.relationships().unwrap();
        assert_eq!(relationships.len(), 2);
        assert!(relationships.iter().any(|row| {
            row.person_id == left.relative && row.related_person_id == left.matched
        }));
        assert!(relationships.iter().any(|row| {
            row.person_id == right.relative && row.related_person_id == right.matched
        }));
        assert_eq!(merged.media().unwrap().len(), 2);
        assert_eq!(validate_store(&merged).unwrap().counts.error, 0);
    }

    #[test]
    fn missing_media_drops_the_row_and_its_citations_with_a_warning() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);

        let left_store = open_project(&projects, left.project_id);
        let row = left_store
            .media()
            .unwrap()
            .into_iter()
            .find(|row| row.id == left.media)
            .unwrap();
        let path = left_store.resolve_media_path(&row).unwrap();
        drop(left_store);
        fs::remove_file(&path).unwrap();

        let (manifest, report) = merge_apply_into(
            &projects,
            left.project_id,
            right.project_id,
            "Merged tree",
            &merge_pair(&left, &right),
        )
        .unwrap();

        let warning = report
            .warnings
            .iter()
            .find(|warning| warning.code == MEDIA_MISSING)
            .expect("MEDIA_MISSING warning");
        assert_eq!(
            warning.params.get("fileName").map(String::as_str),
            Some("photo.jpg")
        );
        assert_eq!(
            warning.params.get("checksum").map(String::len),
            Some(64),
            "the warning carries the checksum, not a path"
        );
        assert!(
            warning
                .params
                .values()
                .all(|value| !value.contains(tmp.path().to_string_lossy().as_ref())),
            "a media warning must not leak an absolute path"
        );

        let merged = open_project(&projects, manifest.project_id);
        let media = merged.media().unwrap();
        assert_eq!(media.len(), 1);
        assert!(media.iter().all(|row| row.id != left.media));
        let citations = merged.citations().unwrap();
        assert_eq!(citations.len(), 3);
        assert!(citations
            .iter()
            .all(|citation| !(citation.target_type == CitationTarget::Media
                && citation.target_id == left.media)));
        assert_eq!(validate_store(&merged).unwrap().counts.error, 0);
    }

    #[test]
    fn changed_media_updates_the_checksum_and_keeps_the_stored_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);

        let left_store = open_project(&projects, left.project_id);
        let row = left_store
            .media()
            .unwrap()
            .into_iter()
            .find(|row| row.id == left.media)
            .unwrap();
        let path = left_store.resolve_media_path(&row).unwrap();
        drop(left_store);
        fs::write(&path, b"changed synthetic bytes").unwrap();

        let (manifest, report) = merge_apply_into(
            &projects,
            left.project_id,
            right.project_id,
            "Merged tree",
            &merge_pair(&left, &right),
        )
        .unwrap();

        assert!(has_warning(&report, MEDIA_CHANGED));
        let merged = open_project(&projects, manifest.project_id);
        let merged_row = merged
            .media()
            .unwrap()
            .into_iter()
            .find(|row| row.id == left.media)
            .unwrap();
        assert_ne!(merged_row.checksum, row.checksum);
        assert_eq!(
            fs::read(merged.resolve_media_path(&merged_row).unwrap()).unwrap(),
            b"changed synthetic bytes"
        );
        assert_eq!(validate_store(&merged).unwrap().counts.error, 0);
    }

    #[test]
    fn equal_or_missing_project_ids_create_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);
        let before = project_dirs(&projects);

        let error = merge_apply_into(
            &projects,
            left.project_id,
            left.project_id,
            "Merged tree",
            &keep_both(&left, &right),
        )
        .unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("rightProjectId")
        );

        let error = merge_apply_into(
            &projects,
            left.project_id,
            Uuid::from_u128(999),
            "Merged tree",
            &keep_both(&left, &right),
        )
        .unwrap_err();
        assert_eq!(error.code, codes::PROJECT_NOT_FOUND);

        assert_eq!(project_dirs(&projects), before);
    }

    #[test]
    fn an_unknown_decision_creates_no_project() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = projects_dir(tmp.path());
        let (left, right) = build_fixture(&projects);
        let before = project_dirs(&projects);

        let decisions = MergeDecisions {
            persons: vec![PersonDecision {
                left_id: Uuid::from_u128(777),
                right_id: right.matched,
                action: MergeAction::Merge,
                base: Side::Left,
                fields: BTreeMap::new(),
            }],
            events: Vec::new(),
        };

        let error = merge_apply_into(
            &projects,
            left.project_id,
            right.project_id,
            "Merged tree",
            &decisions,
        )
        .unwrap_err();
        assert_eq!(error.code, codes::MERGE_CONFLICT);
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("unknownPersonDecision")
        );
        assert_eq!(project_dirs(&projects), before);
    }
}
