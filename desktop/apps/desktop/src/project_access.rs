//! [`gentree_mcp::ProjectAccess`] over the open project: the in-process tool
//! backend for the desktop chat.
//!
//! There is no MCP listener: the chat calls these methods directly and builds
//! the model's tool schemas from the same tool definitions, so the catalogue
//! and the implementation cannot drift apart.
//!
//! The desktop app is the only writer of a project, so writes go through the
//! already-open [`ProjectStore`]; reads may also open another project read-only
//! (that is why read tools keep working while a project is locked elsewhere).
//! A write on a read-only store is `PROJECT_LOCKED`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gentree_core::error::codes;
use gentree_core::person::{Gender, Person};
use gentree_core::record::{Citation, CitationTarget, Event, EventType, Source};
use gentree_core::relationship::{Relationship, RelationshipSet};
use gentree_core::validation::ValidationIssue;
use gentree_core::{AppError, AppResult, CivilDate, Counts, Manifest, SCHEMA_VERSION};
use gentree_mcp::dto::{
    require_confirm, BackupInfo, BackupProjectRequest, CreateEventRequest, CreatePersonRequest,
    CreateRelationshipRequest, DeletePersonRequest, DeleteRelationshipRequest, EventCard,
    ExportFormatArg, ExportProjectRequest, ExportResult, FindPathRequest, GetAncestorsRequest,
    GetEventRequest, GetKinshipRequest, GetPersonRequest, GetProjectRequest, GetSourceRequest,
    GetTimelineRequest, GetTreeOverviewRequest, ImportFormatArg, ImportProjectRequest,
    ImportReport, ListBackupsRequest, ListBackupsResponse, ListProjectsRequest,
    ListProjectsResponse, ListSourcesRequest, ListSourcesResponse, PersonCard,
    RestoreBackupRequest, RootPerson, SearchHit, SearchRequest, SearchResponse, SourceCard,
    TimelineResult, TreeDateRange, TreeOverview, TreeSummary, UpdateEventRequest,
    UpdatePersonRequest, ValidateProjectRequest, WriteResult,
};
use gentree_mcp::ProjectAccess;
use gentree_storage::{
    list_projects, prune_backups, ProjectStore, BACKUP_SUFFIX, EVENT_FILE, PERSON_FILE,
    RELATIONSHIP_FILE,
};
use uuid::Uuid;

use crate::commands::person::{apply_removal, plan_removal, sync_life_events};
use crate::commands::search::search_project;
use crate::commands::{
    citations_without, display_names, event_type_name, gender_map, parse_date_bound,
    parse_event_type, person_not_found, validate_store, version_from,
};
use crate::BACKUP_KEEP;

/// Ceilings for the person card sub-collections. Requests may only lower them.
const MAX_CARD_EVENTS: u32 = 200;
const MAX_CARD_RELATIONSHIPS: u32 = 200;
const MAX_CARD_MEDIA: u32 = 100;
const MAX_CARD_CITATIONS: u32 = 100;

// ---------------------------------------------------------------------------
// ProjectAccess over ProjectStore
// ---------------------------------------------------------------------------

/// [`ProjectAccess`] backed by the open store. Cheap to construct; one instance
/// is shared by every MCP session.
pub struct AppProjectAccess {
    project: Arc<Mutex<Option<ProjectStore>>>,
    projects_dir: PathBuf,
    backups_dir: PathBuf,
    index_dir_root: PathBuf,
    export_dir: PathBuf,
}

impl AppProjectAccess {
    /// `app_data_dir` is the Tauri application data directory; the same layout
    /// as the Tauri commands is used, so both paths see the same projects.
    #[must_use]
    pub fn new(
        project: Arc<Mutex<Option<ProjectStore>>>,
        projects_dir: PathBuf,
        backups_dir: PathBuf,
        app_data_dir: &Path,
    ) -> Self {
        Self {
            project,
            projects_dir,
            backups_dir,
            index_dir_root: app_data_dir.join("indexes"),
            export_dir: app_data_dir.join("exports"),
        }
    }

    fn state_error() -> AppError {
        AppError::new(codes::UNKNOWN, "project state poisoned")
    }

    fn project_not_found(project_id: Uuid) -> AppError {
        AppError::new(codes::PROJECT_NOT_FOUND, "Project is not open")
            .with_param("projectId", project_id.to_string())
    }

    fn locked() -> AppError {
        AppError::new(codes::PROJECT_LOCKED, "Project is open read-only")
    }

    /// Runs a read against the open project, or against another project opened
    /// read-only (no lock is taken, so this also works when it is locked).
    fn read<T>(
        &self,
        project_id: Uuid,
        action: impl FnOnce(&ProjectStore) -> AppResult<T>,
    ) -> AppResult<T> {
        let guard = self.project.lock().map_err(|_| Self::state_error())?;
        if let Some(store) = guard.as_ref() {
            if store.manifest().project_id == project_id {
                return action(store);
            }
        }
        drop(guard);
        let store = ProjectStore::open(&self.projects_dir.join(project_id.to_string()), false)?;
        action(&store)
    }

    /// Runs a write on the open project; anything else is `PROJECT_NOT_FOUND`
    /// or `PROJECT_LOCKED`.
    fn write<T>(
        &self,
        project_id: Uuid,
        action: impl FnOnce(&mut ProjectStore) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.project.lock().map_err(|_| Self::state_error())?;
        let store = guard
            .as_mut()
            .ok_or_else(|| Self::project_not_found(project_id))?;
        if store.manifest().project_id != project_id {
            return Err(Self::project_not_found(project_id));
        }
        if !store.is_writable() {
            return Err(Self::locked());
        }
        action(store)
    }

    fn backup_dir(&self, project_id: Uuid) -> PathBuf {
        self.backups_dir.join(project_id.to_string())
    }

    /// Recursive byte size used by the `dryRun` report of `backup_project`.
    fn directory_size(dir: &Path) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        let mut total = 0u64;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                total = total.saturating_add(Self::directory_size(&entry.path()));
            } else if file_type.is_file() {
                total = total.saturating_add(entry.metadata().map(|meta| meta.len()).unwrap_or(0));
            }
        }
        total
    }
}

/// Envelope token of one row, read back after a write.
fn version_of(store: &ProjectStore, file: &str, id: Uuid) -> AppResult<String> {
    version_from(&store.collection_versions(file)?, id)
}

fn not_found(kind: &str, id: Uuid) -> AppError {
    AppError::new(codes::NOT_FOUND, format!("{kind} not found")).with_param("id", id.to_string())
}

fn ensure_person(store: &ProjectStore, person_id: Uuid) -> AppResult<()> {
    if store.persons()?.iter().any(|person| person.id == person_id) {
        Ok(())
    } else {
        Err(AppError::validation("personId", "notFound"))
    }
}

fn ensure_persons(store: &ProjectStore, ids: [Uuid; 2]) -> AppResult<()> {
    let persons = store.persons()?;
    for id in ids {
        if !persons.iter().any(|person| person.id == id) {
            return Err(person_not_found(id));
        }
    }
    Ok(())
}

fn write_result(dry_run: bool, entity_id: Option<Uuid>, version: Option<String>) -> WriteResult {
    WriteResult {
        dry_run,
        would_change: true,
        changed: !dry_run,
        entity_id,
        version,
        issues: Vec::new(),
    }
}

fn card_limit(value: Option<u32>, ceiling: u32) -> usize {
    value.unwrap_or(ceiling).clamp(1, ceiling) as usize
}

/// Caps one card sub-collection and reports whether rows were dropped.
fn cap<T>(rows: Vec<T>, limit: usize) -> (Vec<T>, bool) {
    let truncated = rows.len() > limit;
    (rows.into_iter().take(limit).collect(), truncated)
}

/// Name fields used by `get_tree_overview`; the primary name wins, otherwise
/// the first stored name. Missing parts stay `None` instead of guessed.
fn root_person(person: &Person) -> RootPerson {
    let name = person
        .names
        .iter()
        .find(|name| name.is_primary)
        .or_else(|| person.names.first());
    RootPerson {
        id: person.id,
        first_name: name.and_then(|name| name.given.clone()),
        last_name: name.and_then(|name| name.surname.clone()),
    }
}

/// Parses the free-form `types` filter of `get_timeline`.
fn parse_event_types(types: &[String]) -> AppResult<Vec<EventType>> {
    types
        .iter()
        .map(|raw| parse_event_type(raw).ok_or_else(|| AppError::validation("types", "unknown")))
        .collect()
}

impl ProjectAccess for AppProjectAccess {
    fn list_projects(&self, request: ListProjectsRequest) -> AppResult<ListProjectsResponse> {
        let mut projects = list_projects(&self.projects_dir)?;
        let total = projects.len();
        let limit = request.limit.unwrap_or(50).clamp(1, 200) as usize;
        let offset = request.offset.unwrap_or(0) as usize;
        let projects = if offset >= projects.len() {
            Vec::new()
        } else {
            projects.drain(offset..).take(limit).collect()
        };
        Ok(ListProjectsResponse { projects, total })
    }

    fn get_project(&self, request: GetProjectRequest) -> AppResult<Manifest> {
        self.read(request.project_id, |store| Ok(store.manifest().clone()))
    }

    fn get_tree_overview(&self, request: GetTreeOverviewRequest) -> AppResult<TreeOverview> {
        self.read(request.project_id, |store| {
            let persons = store.persons()?;
            let relationships = store.relationships()?;
            let mut start: Option<CivilDate> = None;
            let mut end: Option<CivilDate> = None;
            for event in store.events()? {
                let Some(date) = event.date.start else {
                    continue;
                };
                start = Some(start.map_or(date, |current| current.min(date)));
                end = Some(end.map_or(date, |current| current.max(date)));
            }

            let children: BTreeSet<Uuid> = relationships
                .iter()
                .filter(|row| row.rel_type.is_parent())
                .map(|row| row.related_person_id)
                .collect();
            let mut roots: Vec<RootPerson> = persons
                .iter()
                .filter(|person| !children.contains(&person.id))
                .map(root_person)
                .collect();
            roots.sort_by(|left, right| {
                left.first_name
                    .is_none()
                    .cmp(&right.first_name.is_none())
                    .then_with(|| left.first_name.cmp(&right.first_name))
                    .then_with(|| left.last_name.cmp(&right.last_name))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let root_count = roots.len();
            roots.truncate(50);

            let manifest = store.manifest();
            Ok(TreeOverview {
                tree: TreeSummary {
                    id: manifest.project_id,
                    name: manifest.name.clone(),
                    home_person_id: manifest.home_person_id,
                },
                counts: store.counts()?,
                date_range: TreeDateRange { start, end },
                roots,
                root_count,
            })
        })
    }

    fn search(&self, request: SearchRequest) -> AppResult<SearchResponse> {
        let limit = request.limit.unwrap_or(20).clamp(1, 50) as usize;
        let dir = self.index_dir_root.join(request.project_id.to_string());
        fs::create_dir_all(&dir)
            .map_err(|error| AppError::io("create search index directory", error))?;
        self.read(request.project_id, |store| {
            let response = search_project(store, &dir, &request.query, limit)?;
            let titles = search_titles(store)?;
            let mut results = Vec::new();
            for group in response.groups {
                if let Some(types) = &request.types {
                    let wanted = types
                        .iter()
                        .any(|kind| kind.eq_ignore_ascii_case(&group.entity_type));
                    if !wanted {
                        continue;
                    }
                }
                for item in group.items {
                    let Ok(entity_id) = Uuid::parse_str(&item.entity_id) else {
                        continue;
                    };
                    let rank = results.len();
                    results.push(SearchHit {
                        entity_type: group.entity_type.to_ascii_uppercase(),
                        entity_id,
                        title: titles
                            .get(&entity_id)
                            .cloned()
                            .unwrap_or_else(|| item.snippet.clone()),
                        snippet: (!item.snippet.is_empty()).then_some(item.snippet),
                        // The grouped index API does not expose raw relevance;
                        // the order is by relevance, so a rank-based score keeps
                        // the ordering visible without inventing a number.
                        score: 1.0 / (rank as f32 + 1.0),
                    });
                }
            }
            Ok(SearchResponse {
                results,
                has_more: response.truncated,
                next_cursor: None,
            })
        })
    }

    fn get_person(&self, request: GetPersonRequest) -> AppResult<PersonCard> {
        self.read(request.project_id, |store| {
            let persons = store.persons()?;
            let person = persons
                .iter()
                .find(|candidate| candidate.id == request.person_id)
                .cloned()
                .ok_or_else(|| person_not_found(request.person_id))?;
            let limits = request.limits.unwrap_or_default();

            let (events, events_truncated) = cap(
                store
                    .events()?
                    .into_iter()
                    .filter(|event| event.person_id == request.person_id)
                    .collect(),
                card_limit(limits.events, MAX_CARD_EVENTS),
            );

            let relationship_limit = card_limit(limits.relationships, MAX_CARD_RELATIONSHIPS);
            let (relationships, relationships_truncated) = cap(
                store
                    .relationships()?
                    .into_iter()
                    .filter(|row| {
                        row.person_id == request.person_id
                            || row.related_person_id == request.person_id
                    })
                    .collect(),
                relationship_limit,
            );

            let related_ids: BTreeSet<Uuid> = relationships
                .iter()
                .flat_map(|row| [row.person_id, row.related_person_id])
                .filter(|id| *id != request.person_id)
                .collect();
            let (related_persons, related_truncated) = cap(
                persons
                    .into_iter()
                    .filter(|candidate| related_ids.contains(&candidate.id))
                    .collect(),
                relationship_limit,
            );

            // A person card shows the person's own files; event attachments
            // belong to the event and are returned by `get_event` (ADR-0018).
            let (media, media_truncated) = cap(
                store
                    .media()?
                    .into_iter()
                    .filter(|row| row.person_id == Some(request.person_id))
                    .collect(),
                card_limit(limits.media, MAX_CARD_MEDIA),
            );

            let (citations, citations_truncated) = cap(
                store
                    .citations()?
                    .into_iter()
                    .filter(|citation| {
                        citation.target_type == CitationTarget::Person
                            && citation.target_id == request.person_id
                    })
                    .collect(),
                card_limit(limits.citations, MAX_CARD_CITATIONS),
            );

            Ok(PersonCard {
                person,
                events,
                relationships,
                related_persons,
                media,
                citations,
                truncated: events_truncated
                    || relationships_truncated
                    || related_truncated
                    || media_truncated
                    || citations_truncated,
                version: Some(version_of(store, PERSON_FILE, request.person_id)?),
            })
        })
    }

    fn get_event(&self, request: GetEventRequest) -> AppResult<EventCard> {
        self.read(request.project_id, |store| {
            let event = store
                .events()?
                .into_iter()
                .find(|event| event.id == request.event_id)
                .ok_or_else(|| not_found("Event", request.event_id))?;
            let persons = store.persons()?;
            let mut participant_ids = Vec::with_capacity(1 + event.participant_ids.len());
            participant_ids.push(event.person_id);
            participant_ids.extend(event.participant_ids.iter().copied());
            let participants = participant_ids
                .into_iter()
                .filter_map(|id| persons.iter().find(|person| person.id == id).cloned())
                .collect();
            let citations = store
                .citations()?
                .into_iter()
                .filter(|citation| {
                    citation.target_type == CitationTarget::Event && citation.target_id == event.id
                })
                .collect();
            let media = store
                .media()?
                .into_iter()
                .filter(|row| row.event_id == Some(event.id))
                .collect();
            Ok(EventCard {
                event,
                participants,
                citations,
                media,
            })
        })
    }

    fn list_sources(&self, request: ListSourcesRequest) -> AppResult<ListSourcesResponse> {
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let offset = request.offset.unwrap_or(0).min(1_000_000);
        self.read(request.project_id, |store| {
            let mut sources = store.sources()?;
            sources.sort_by(|left, right| {
                left.title
                    .to_lowercase()
                    .cmp(&right.title.to_lowercase())
                    .then_with(|| left.id.cmp(&right.id))
            });
            let total = sources.len();
            let items = if offset as usize >= total {
                Vec::new()
            } else {
                sources
                    .into_iter()
                    .skip(offset as usize)
                    .take(limit as usize)
                    .collect()
            };
            Ok(ListSourcesResponse {
                items,
                total,
                limit,
                offset,
            })
        })
    }

    fn get_source(&self, request: GetSourceRequest) -> AppResult<SourceCard> {
        self.read(request.project_id, |store| {
            let source = store
                .sources()?
                .into_iter()
                .find(|source| source.id == request.source_id)
                .ok_or_else(|| not_found("Source", request.source_id))?;
            let citations = store
                .citations()?
                .into_iter()
                .filter(|citation| citation.source_id == source.id)
                .collect();
            Ok(SourceCard { source, citations })
        })
    }

    fn get_ancestors(
        &self,
        request: GetAncestorsRequest,
    ) -> AppResult<gentree_core::AncestorGraph> {
        self.read(request.project_id, |store| {
            let persons = store.persons()?;
            if !persons.iter().any(|person| person.id == request.person_id) {
                return Err(person_not_found(request.person_id));
            }
            let genders = gender_map(&persons);
            let generations = request
                .generations
                .unwrap_or(gentree_core::DEFAULT_GENERATIONS);
            Ok(store.relationship_set()?.ancestors_with_gender(
                request.person_id,
                generations,
                |id| genders.get(&id).copied().unwrap_or(Gender::Unknown),
            ))
        })
    }

    fn get_timeline(&self, request: GetTimelineRequest) -> AppResult<TimelineResult> {
        let from = parse_date_bound("from", request.from.as_deref())?;
        let to = parse_date_bound("to", request.to.as_deref())?;
        let types = request
            .types
            .as_deref()
            .map(parse_event_types)
            .transpose()?;
        let person_ids: Option<BTreeSet<Uuid>> = request
            .person_ids
            .as_ref()
            .map(|ids| ids.iter().copied().collect());
        let include_undated = request.include_undated.unwrap_or(true);
        let limit = request.limit.unwrap_or(100).clamp(1, 200) as usize;

        self.read(request.project_id, |store| {
            let mut dated = Vec::new();
            let mut undated = Vec::new();
            for event in store.events()? {
                if person_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&event.person_id))
                {
                    continue;
                }
                if types
                    .as_ref()
                    .is_some_and(|kinds| !kinds.contains(&event.event_type))
                {
                    continue;
                }
                let in_range = crate::commands::event::date_matches(&event.date, from, to);
                if event.date.start.is_some() {
                    if in_range {
                        dated.push(event);
                    }
                } else if include_undated {
                    undated.push(event);
                }
            }
            dated.sort_by(crate::commands::event::event_order);
            let truncated = dated.len() > limit;
            dated.truncate(limit);
            Ok(TimelineResult {
                events: dated,
                undated,
                truncated,
            })
        })
    }

    fn find_path(&self, request: FindPathRequest) -> AppResult<gentree_core::PathResult> {
        self.read(request.project_id, |store| {
            ensure_persons(store, [request.from_person_id, request.to_person_id])?;
            Ok(store
                .relationship_set()?
                .find_path(request.from_person_id, request.to_person_id))
        })
    }

    fn get_kinship(
        &self,
        request: GetKinshipRequest,
    ) -> AppResult<gentree_core::KinshipDescriptor> {
        self.read(request.project_id, |store| {
            ensure_persons(store, [request.from_person_id, request.to_person_id])?;
            let genders = gender_map(&store.persons()?);
            Ok(store.relationship_set()?.kinship(
                request.from_person_id,
                request.to_person_id,
                &|id| genders.get(&id).copied().unwrap_or(Gender::Unknown),
            ))
        })
    }

    fn validate_project(
        &self,
        request: ValidateProjectRequest,
    ) -> AppResult<gentree_core::ValidationReport> {
        self.read(request.project_id, validate_store)
    }

    fn list_backups(&self, request: ListBackupsRequest) -> AppResult<ListBackupsResponse> {
        Ok(ListBackupsResponse {
            backups: list_backup_infos(&self.backup_dir(request.project_id), request.project_id),
        })
    }

    fn create_person(&self, request: CreatePersonRequest) -> AppResult<WriteResult> {
        let options = request.options();
        self.write(request.project_id, |store| {
            let person = request.person.to_person()?;
            let mut persons = store.persons()?;
            if persons.iter().any(|existing| existing.id == person.id) {
                return Err(AppError::validation("id", "duplicate"));
            }
            if options.dry_run {
                return Ok(write_result(true, Some(person.id), None));
            }
            persons.push(person.clone());
            store.save_persons(&persons)?;
            let mut events = store.events()?;
            if sync_life_events(&mut events, &person, None) {
                store.save_events(&events)?;
            }
            let version = version_of(store, PERSON_FILE, person.id)?;
            Ok(write_result(false, Some(person.id), Some(version)))
        })
    }

    fn update_person(&self, request: UpdatePersonRequest) -> AppResult<WriteResult> {
        let options = request.options();
        self.write(request.project_id, |store| {
            let mut persons = store.persons()?;
            let index = persons
                .iter()
                .position(|person| person.id == request.person_id)
                .ok_or_else(|| person_not_found(request.person_id))?;
            let previous = persons[index].clone();
            let updated = request.patch.apply(&previous)?;
            if let Some(expected) = options.expected_version.as_deref() {
                store.check_version(PERSON_FILE, request.person_id, expected)?;
            }
            if options.dry_run {
                return Ok(write_result(true, Some(request.person_id), None));
            }
            persons[index] = updated.clone();
            store.save_persons(&persons)?;
            let mut events = store.events()?;
            if sync_life_events(&mut events, &updated, Some(&previous)) {
                store.save_events(&events)?;
            }
            let version = version_of(store, PERSON_FILE, request.person_id)?;
            Ok(write_result(false, Some(request.person_id), Some(version)))
        })
    }

    fn delete_person(&self, request: DeletePersonRequest) -> AppResult<WriteResult> {
        require_confirm(request.confirm)?;
        let options = request.options();
        self.write(request.project_id, |store| {
            let removal = plan_removal(store, request.person_id)?;
            if let Some(expected) = options.expected_version.as_deref() {
                store.check_version(PERSON_FILE, request.person_id, expected)?;
            }
            if options.dry_run {
                return Ok(write_result(true, Some(request.person_id), None));
            }
            apply_removal(store, removal)?;
            Ok(write_result(false, Some(request.person_id), None))
        })
    }

    fn create_event(&self, request: CreateEventRequest) -> AppResult<WriteResult> {
        let options = request.options();
        self.write(request.project_id, |store| {
            let event = request.event.to_event()?;
            ensure_person(store, event.person_id)?;
            let mut events = store.events()?;
            if events.iter().any(|existing| existing.id == event.id) {
                return Err(AppError::validation("id", "duplicate"));
            }
            gentree_core::ensure_single_life_event(&events, &event, None)?;
            if options.dry_run {
                return Ok(write_result(true, Some(event.id), None));
            }
            events.push(event.clone());
            store.save_events(&events)?;
            let version = version_of(store, EVENT_FILE, event.id)?;
            Ok(write_result(false, Some(event.id), Some(version)))
        })
    }

    fn update_event(&self, request: UpdateEventRequest) -> AppResult<WriteResult> {
        let options = request.options();
        self.write(request.project_id, |store| {
            let mut events = store.events()?;
            let index = events
                .iter()
                .position(|event| event.id == request.event_id)
                .ok_or_else(|| not_found("Event", request.event_id))?;
            let previous = &events[index];
            let updated = request.patch.apply(previous)?;
            ensure_person(store, updated.person_id)?;
            if previous.person_id != updated.person_id || previous.event_type != updated.event_type
            {
                gentree_core::ensure_single_life_event(&events, &updated, Some(request.event_id))?;
            }
            if let Some(expected) = options.expected_version.as_deref() {
                store.check_version(EVENT_FILE, request.event_id, expected)?;
            }
            if options.dry_run {
                return Ok(write_result(true, Some(request.event_id), None));
            }
            events[index] = updated;
            store.save_events(&events)?;
            let version = version_of(store, EVENT_FILE, request.event_id)?;
            Ok(write_result(false, Some(request.event_id), Some(version)))
        })
    }

    fn create_relationship(&self, request: CreateRelationshipRequest) -> AppResult<WriteResult> {
        let options = request.options();
        self.write(request.project_id, |store| {
            ensure_persons(store, [request.person_id, request.related_person_id])?;
            let row = Relationship::new(
                request.relationship_type.into(),
                request.person_id,
                request.related_person_id,
            )?;
            let mut set = RelationshipSet::new(store.relationships()?)?;
            set.push(row.clone())?;
            if options.dry_run {
                return Ok(write_result(true, Some(row.id), None));
            }
            store.save_relationships(set.rows())?;
            let version = version_of(store, RELATIONSHIP_FILE, row.id)?;
            Ok(write_result(false, Some(row.id), Some(version)))
        })
    }

    fn delete_relationship(&self, request: DeleteRelationshipRequest) -> AppResult<WriteResult> {
        require_confirm(request.confirm)?;
        let options = request.options();
        self.write(request.project_id, |store| {
            let rows = store.relationships()?;
            if !rows.iter().any(|row| row.id == request.relationship_id) {
                return Err(not_found("Relationship", request.relationship_id));
            }
            if let Some(expected) = options.expected_version.as_deref() {
                store.check_version(RELATIONSHIP_FILE, request.relationship_id, expected)?;
            }
            if options.dry_run {
                return Ok(write_result(true, Some(request.relationship_id), None));
            }
            let rows: Vec<Relationship> = rows
                .into_iter()
                .filter(|row| row.id != request.relationship_id)
                .collect();
            let citations =
                citations_without(store, CitationTarget::Relationship, request.relationship_id)?;
            store.save_citations(&citations)?;
            store.save_relationships(&rows)?;
            Ok(write_result(false, Some(request.relationship_id), None))
        })
    }

    fn backup_project(&self, request: BackupProjectRequest) -> AppResult<BackupInfo> {
        let options = request.options();
        self.read(request.project_id, |store| {
            if options.dry_run {
                return Ok(BackupInfo {
                    backup_id: format!("{}/dry-run{BACKUP_SUFFIX}", request.project_id),
                    created_at: gentree_core::now_rfc3339(),
                    size_bytes: Self::directory_size(store.root()),
                    schema_version: SCHEMA_VERSION,
                });
            }
            let path = store.backup(&self.backups_dir)?;
            prune_backups(&self.backups_dir, request.project_id, BACKUP_KEEP)?;
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("backup{BACKUP_SUFFIX}"));
            Ok(BackupInfo {
                backup_id: format!("{}/{}", request.project_id, file_name),
                created_at: gentree_core::now_rfc3339(),
                size_bytes: fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                schema_version: SCHEMA_VERSION,
            })
        })
    }

    fn export_project(&self, request: ExportProjectRequest) -> AppResult<ExportResult> {
        let options = request.options();
        self.read(request.project_id, |store| {
            let (extension, format) = match request.format {
                ExportFormatArg::GentreeZip => (".gentree.zip", "GENTREE_ZIP"),
                ExportFormatArg::GentreeJson => (".gentree.json", "GENTREE_JSON"),
            };
            let file_name = format!("{}{extension}", sanitize_file_stem(&store.manifest().name));
            let target = match request.destination.as_deref().map(str::trim) {
                Some(destination) if !destination.is_empty() => {
                    let path = PathBuf::from(destination);
                    if !path.is_absolute() {
                        return Err(AppError::validation("destination", "absolutePath"));
                    }
                    if path.is_dir() {
                        path.join(&file_name)
                    } else {
                        path
                    }
                }
                _ => self.export_dir.join(&file_name),
            };
            if options.dry_run {
                // Export to a staging folder, measure it and drop it: the
                // destination and the project stay untouched, but the report
                // carries the real size.
                let staging = self
                    .export_dir
                    .join(".dry-run")
                    .join(Uuid::now_v7().to_string());
                fs::create_dir_all(&staging)
                    .map_err(|error| AppError::io("create export staging", error))?;
                let staged = staging.join(&file_name);
                let result = write_export(store, request.format, &staged);
                let bytes = fs::metadata(&staged).map(|meta| meta.len()).unwrap_or(0);
                let _ = fs::remove_dir_all(&staging);
                result?;
                return Ok(ExportResult {
                    file_name,
                    bytes,
                    format: format.to_owned(),
                });
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| AppError::io("create export folder", error))?;
            }
            write_export(store, request.format, &target)?;
            let file_name = target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(file_name);
            Ok(ExportResult {
                file_name,
                bytes: fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0),
                format: format.to_owned(),
            })
        })
    }

    fn import_project(&self, request: ImportProjectRequest) -> AppResult<ImportReport> {
        let source = PathBuf::from(request.source_path.trim());
        if request.source_path.trim().is_empty() {
            return Err(AppError::validation("sourcePath", "required"));
        }
        if !source.is_file() {
            return Err(AppError::new(
                codes::IMPORT_PARSE_ERROR,
                "Import source file is missing",
            ));
        }
        let format = detect_import_format(request.format, &source)?;
        let dry_run = request.dry_run;
        let staging;
        let target_dir = if dry_run {
            staging = self
                .export_dir
                .join("import-dry-run")
                .join(Uuid::now_v7().to_string());
            fs::create_dir_all(&staging)
                .map_err(|error| AppError::io("create import staging", error))?;
            staging.clone()
        } else {
            self.projects_dir.clone()
        };

        let outcome = self.run_import(format, &source, &target_dir, &request);
        if dry_run {
            let _ = fs::remove_dir_all(&target_dir);
        }
        let imported = outcome?;
        Ok(ImportReport {
            dry_run,
            project_id: (!dry_run).then_some(imported.project_id),
            counts: imported.counts,
            issues: imported.issues,
        })
    }

    fn restore_backup(&self, request: RestoreBackupRequest) -> AppResult<WriteResult> {
        require_confirm(request.confirm)?;
        let (project_id, file_name) = parse_backup_id(&request.backup_id)?;
        let path = self.backup_dir(project_id).join(&file_name);
        if !path.is_file() {
            return Err(AppError::new(codes::NOT_FOUND, "Backup not found")
                .with_param("backupId", request.backup_id.clone()));
        }
        if request.dry_run {
            // Restore into a disposable folder: this verifies the archive and
            // its checksums without adding a project.
            let staging = self
                .export_dir
                .join(".restore-dry-run")
                .join(Uuid::now_v7().to_string());
            fs::create_dir_all(&staging)
                .map_err(|error| AppError::io("create restore staging", error))?;
            let outcome = ProjectStore::restore(&path, &staging);
            let restored = outcome
                .as_ref()
                .map(|store| store.manifest().project_id)
                .map_err(Clone::clone);
            drop(outcome);
            let _ = fs::remove_dir_all(&staging);
            return Ok(write_result(true, Some(restored?), None));
        }
        let store = ProjectStore::restore(&path, &self.projects_dir)?;
        let manifest = store.manifest().clone();
        drop(store);
        Ok(write_result(
            false,
            Some(manifest.project_id),
            Some(manifest.updated_at),
        ))
    }
}

/// Names of searchable entities, so a hit carries a readable title.
fn search_titles(store: &ProjectStore) -> AppResult<HashMap<Uuid, String>> {
    let persons = store.persons()?;
    let person_names = display_names(&persons);
    let mut titles: HashMap<Uuid, String> = person_names.clone();
    for event in store.events()? {
        let owner = person_names
            .get(&event.person_id)
            .cloned()
            .unwrap_or_default();
        titles.insert(
            event.id,
            format!("{}: {owner}", event_type_name(event.event_type)),
        );
    }
    for source in store.sources()? {
        titles.insert(source.id, source.title.clone());
    }
    Ok(titles)
}

/// One project's backup files, newest first. The backup id is opaque to the
/// renderer and accepted by `restore_backup`.
pub(crate) fn list_backup_infos(dir: &Path, project_id: Uuid) -> Vec<BackupInfo> {
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let is_file = entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false);
            if !is_file {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(BACKUP_SUFFIX) {
                    names.push(name.to_owned());
                }
            }
        }
    }
    names.sort_unstable_by(|left, right| right.cmp(left));
    names
        .into_iter()
        .map(|name| {
            let path = dir.join(&name);
            let metadata = fs::metadata(&path).ok();
            let size_bytes = metadata.as_ref().map_or(0, |meta| meta.len());
            let created_at = metadata
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .map(rfc3339)
                .unwrap_or_else(|| name.trim_end_matches(BACKUP_SUFFIX).to_owned());
            BackupInfo {
                backup_id: format!("{}/{}", project_id, name),
                created_at,
                size_bytes,
                schema_version: SCHEMA_VERSION,
            }
        })
        .collect()
}

pub(crate) fn rfc3339(value: std::time::SystemTime) -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::from(value)
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Replaces path-hostile characters; the result is only used as a file name.
fn sanitize_file_stem(name: &str) -> String {
    let stem: String = name
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
    if trimmed.is_empty() {
        "gentree".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn import_error(context: &str) -> AppError {
    // Importer errors may embed absolute paths; the MCP client gets a stable
    // code instead of a file-system path.
    AppError::new(codes::IMPORT_PARSE_ERROR, format!("{context} failed"))
}

/// Writes one export in the requested format. The caller owns the target path.
fn write_export(store: &ProjectStore, format: ExportFormatArg, target: &Path) -> AppResult<()> {
    match format {
        ExportFormatArg::GentreeZip => {
            gentree_import::export_zip(store.root(), target).map_err(|_| import_error("export"))?;
        }
        ExportFormatArg::GentreeJson => {
            let persons = store.persons()?;
            let events = store.events()?;
            let relationships = store.relationships()?;
            let sources = store.sources()?;
            let citations = store.citations()?;
            let media = store.media()?;
            let exported_at = gentree_core::now_rfc3339();
            gentree_import::export_json(
                gentree_import::ProjectSnapshotData {
                    exported_at: &exported_at,
                    persons: &persons,
                    events: &events,
                    relationships: &relationships,
                    sources: &sources,
                    citations: &citations,
                    media: &media,
                },
                target,
            )
            .map_err(|_| import_error("export"))?;
        }
    }
    Ok(())
}

pub(crate) fn parse_backup_id(backup_id: &str) -> AppResult<(Uuid, String)> {
    let (project, file_name) = backup_id
        .split_once('/')
        .ok_or_else(|| AppError::validation("backupId", "invalid"))?;
    let project_id =
        Uuid::parse_str(project).map_err(|_| AppError::validation("backupId", "invalid"))?;
    let unsafe_name = file_name.is_empty()
        || file_name.contains(['/', '\\'])
        || file_name.contains("..")
        || !file_name.ends_with(BACKUP_SUFFIX);
    if unsafe_name {
        return Err(AppError::validation("backupId", "invalid"));
    }
    Ok((project_id, file_name.to_owned()))
}

fn detect_import_format(format: ImportFormatArg, source: &Path) -> AppResult<ImportFormatArg> {
    if format != ImportFormatArg::Auto {
        return Ok(format);
    }
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with(".gentree.zip") || name.ends_with(".zip") {
        Ok(ImportFormatArg::GentreeZip)
    } else if name.ends_with(".gentree.json") || name.ends_with(".json") {
        Ok(ImportFormatArg::GentreeJson)
    } else if name.ends_with(".at5") {
        Ok(ImportFormatArg::At5)
    } else if name.ends_with(".ged") || name.ends_with(".gedcom") {
        Ok(ImportFormatArg::Gedcom)
    } else {
        Err(AppError::validation("format", "unknown"))
    }
}

struct ImportedProject {
    project_id: Uuid,
    counts: Counts,
    issues: Vec<ValidationIssue>,
}

impl AppProjectAccess {
    fn run_import(
        &self,
        format: ImportFormatArg,
        source: &Path,
        target_dir: &Path,
        request: &ImportProjectRequest,
    ) -> AppResult<ImportedProject> {
        let project_name = request
            .project_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                source
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "Imported project".to_owned());

        match format {
            ImportFormatArg::GentreeZip => {
                let bundle = gentree_import::import_zip(source, target_dir)
                    .map_err(|_| import_error("import"))?;
                Ok(ImportedProject {
                    project_id: bundle.project_id.ok_or_else(|| import_error("import"))?,
                    counts: Counts {
                        persons: bundle.persons.len(),
                        events: bundle.events.len(),
                        relationships: bundle.relationships.len(),
                        sources: bundle.sources.len(),
                        citations: bundle.citations.len(),
                        media: bundle.media.len(),
                    },
                    issues: Vec::new(),
                })
            }
            ImportFormatArg::GentreeJson => {
                let bundle = gentree_import::import_json(source, target_dir)
                    .map_err(|_| import_error("import"))?;
                Ok(ImportedProject {
                    project_id: bundle.project_id.ok_or_else(|| import_error("import"))?,
                    counts: Counts {
                        persons: bundle.persons.len(),
                        events: bundle.events.len(),
                        relationships: bundle.relationships.len(),
                        sources: bundle.sources.len(),
                        citations: bundle.citations.len(),
                        media: bundle.media.len(),
                    },
                    issues: Vec::new(),
                })
            }
            ImportFormatArg::At5 => {
                let bundle = gentree_import::read_at5_bundle(source)?;
                let mut issues = Vec::new();
                if !bundle.media.is_empty() {
                    issues.push(media_not_imported(bundle.media.len()));
                }
                let (project_id, counts) = materialize(
                    target_dir,
                    &project_name,
                    bundle.persons,
                    bundle.relationships,
                    bundle.events,
                    Vec::new(),
                    Vec::new(),
                )?;
                Ok(ImportedProject {
                    project_id,
                    counts,
                    issues,
                })
            }
            ImportFormatArg::Gedcom => {
                let (persons, relationships, report) =
                    gentree_import::parse_gedcom(source).map_err(|_| import_error("import"))?;
                let mut issues = Vec::new();
                if report.persons == 0 {
                    issues.push(empty_import_issue());
                }
                let (project_id, counts) = materialize(
                    target_dir,
                    &project_name,
                    persons,
                    relationships,
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                )?;
                Ok(ImportedProject {
                    project_id,
                    counts,
                    issues,
                })
            }
            ImportFormatArg::Auto => Err(AppError::validation("format", "unknown")),
        }
    }
}

fn materialize(
    target_dir: &Path,
    name: &str,
    persons: Vec<Person>,
    relationships: Vec<Relationship>,
    events: Vec<Event>,
    sources: Vec<Source>,
    citations: Vec<Citation>,
) -> AppResult<(Uuid, Counts)> {
    let mut store = ProjectStore::create(target_dir, name)?;
    store.save_persons(&persons)?;
    store.save_relationships(&relationships)?;
    store.save_events(&events)?;
    store.save_sources(&sources)?;
    store.save_citations(&citations)?;
    let project_id = store.manifest().project_id;
    let counts = store.counts()?;
    Ok((project_id, counts))
}

fn media_not_imported(count: usize) -> ValidationIssue {
    let mut params = BTreeMap::new();
    params.insert("count".to_owned(), count.to_string());
    ValidationIssue {
        code: "MEDIA_NOT_IMPORTED".to_owned(),
        severity: gentree_core::Severity::Warning,
        entity_ids: Vec::new(),
        params,
    }
}

fn empty_import_issue() -> ValidationIssue {
    ValidationIssue {
        code: "IMPORT_EMPTY".to_owned(),
        severity: gentree_core::Severity::Warning,
        entity_ids: Vec::new(),
        params: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_mcp::testing::fake_project_id;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gentree-{label}-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn import_format_is_detected_from_the_extension() {
        assert_eq!(
            detect_import_format(ImportFormatArg::Auto, Path::new("tree.gentree.zip")).unwrap(),
            ImportFormatArg::GentreeZip
        );
        assert_eq!(
            detect_import_format(ImportFormatArg::Auto, Path::new("tree.GED")).unwrap(),
            ImportFormatArg::Gedcom
        );
        assert_eq!(
            detect_import_format(ImportFormatArg::Auto, Path::new("tree.at5")).unwrap(),
            ImportFormatArg::At5
        );
        assert!(detect_import_format(ImportFormatArg::Auto, Path::new("tree.txt")).is_err());
        assert_eq!(
            detect_import_format(ImportFormatArg::GentreeJson, Path::new("tree.bin")).unwrap(),
            ImportFormatArg::GentreeJson
        );
    }

    #[test]
    fn backup_ids_cannot_escape_the_backups_folder() {
        assert!(parse_backup_id("../../etc/passwd").is_err());
        assert!(parse_backup_id(&format!("{}/../x{BACKUP_SUFFIX}", fake_project_id())).is_err());
        assert!(parse_backup_id(&format!("{}/ok.zip", fake_project_id())).is_err());
        let (project, name) =
            parse_backup_id(&format!("{}/2026.zip{BACKUP_SUFFIX}", fake_project_id())).unwrap();
        assert_eq!(project, fake_project_id());
        assert_eq!(name, format!("2026.zip{BACKUP_SUFFIX}"));
    }

    fn project_access(
        projects_dir: &Path,
    ) -> (Arc<Mutex<Option<ProjectStore>>>, Uuid, AppProjectAccess) {
        let store = ProjectStore::create(projects_dir, "Synthetic project").unwrap();
        let project_id = store.manifest().project_id;
        let slot = Arc::new(Mutex::new(Some(store)));
        let access = AppProjectAccess::new(
            Arc::clone(&slot),
            projects_dir.to_path_buf(),
            projects_dir.join("backups"),
            &projects_dir.join("appdata"),
        );
        (slot, project_id, access)
    }

    fn person_input(given: &str) -> gentree_mcp::dto::PersonInput {
        gentree_mcp::dto::PersonInput {
            names: vec![gentree_mcp::dto::NameInput {
                given: Some(given.to_owned()),
                is_primary: true,
                ..gentree_mcp::dto::NameInput::default()
            }],
            ..gentree_mcp::dto::PersonInput::default()
        }
    }

    #[test]
    fn project_access_reads_overview_events_and_sources() {
        let dir = temp_dir("mcp-reads");
        let (slot, project_id, access) = project_access(&dir);
        let person = person_input("Synthetic")
            .to_person()
            .expect("synthetic person");
        let mut event = Event::new(person.id, EventType::Birth);
        event.date = gentree_core::DateValue::exact_year(1950);
        event.place = Some("Synthetic place".to_owned());
        let source = Source::new("Synthetic source").expect("synthetic source");
        let citation = Citation::new(source.id, CitationTarget::Event, event.id);
        {
            let mut guard = slot.lock().unwrap();
            let store = guard.as_mut().expect("open store");
            store
                .save_persons(std::slice::from_ref(&person))
                .expect("save persons");
            store
                .save_events(std::slice::from_ref(&event))
                .expect("save events");
            store
                .save_sources(std::slice::from_ref(&source))
                .expect("save sources");
            store
                .save_citations(std::slice::from_ref(&citation))
                .expect("save citations");
        }

        let overview = access
            .get_tree_overview(GetTreeOverviewRequest { project_id })
            .expect("overview");
        assert_eq!(overview.counts.persons, 1);
        assert_eq!(overview.counts.events, 1);
        assert_eq!(overview.counts.sources, 1);
        assert_eq!(overview.date_range.start, event.date.start);
        assert_eq!(overview.root_count, 1);
        assert_eq!(overview.roots[0].id, person.id);
        assert_eq!(overview.roots[0].first_name.as_deref(), Some("Synthetic"));

        let event_card = access
            .get_event(GetEventRequest {
                project_id,
                event_id: event.id,
            })
            .expect("event");
        assert_eq!(event_card.event.id, event.id);
        assert_eq!(event_card.participants[0].id, person.id);
        assert_eq!(event_card.citations, vec![citation.clone()]);

        let sources = access
            .list_sources(ListSourcesRequest {
                project_id,
                limit: Some(10),
                offset: Some(0),
            })
            .expect("sources");
        assert_eq!(sources.total, 1);
        assert_eq!(sources.items, vec![source.clone()]);
        assert_eq!((sources.limit, sources.offset), (10, 0));

        let source_card = access
            .get_source(GetSourceRequest {
                project_id,
                source_id: source.id,
            })
            .expect("source");
        assert_eq!(source_card.source.id, source.id);
        assert_eq!(source_card.citations, vec![citation]);

        fs::remove_dir_all(&dir).unwrap();
    }

    fn year_date(year: i32) -> gentree_mcp::dto::DateInput {
        gentree_mcp::dto::DateInput {
            start: Some(format!("{year}-01-01")),
            end: Some(format!("{}-01-01", year + 1)),
            precision: gentree_mcp::dto::DatePrecisionArg::Year,
            qualifier: gentree_mcp::dto::DateQualifierArg::Exact,
            original: None,
        }
    }

    fn dated_person(given: &str, birth: i32, death: i32) -> gentree_mcp::dto::PersonInput {
        gentree_mcp::dto::PersonInput {
            birth: year_date(birth),
            death: year_date(death),
            ..person_input(given)
        }
    }

    fn own_events(
        slot: &Arc<Mutex<Option<ProjectStore>>>,
        person_id: Uuid,
        event_type: EventType,
    ) -> Vec<Event> {
        slot.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .events()
            .unwrap()
            .into_iter()
            .filter(|event| event.person_id == person_id && event.event_type == event_type)
            .collect()
    }

    #[test]
    fn project_access_keeps_life_events_in_step_with_person_dates() {
        let dir = temp_dir("mcp-access-life-events");
        let (slot, project_id, access) = project_access(&dir);

        let created = access
            .create_person(CreatePersonRequest {
                project_id,
                person: dated_person("Ada", 1950, 2000),
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        let person_id = created.entity_id.unwrap();

        // Creating through the chat backend creates the automatic life events,
        // exactly like the person form does.
        let death = own_events(&slot, person_id, EventType::Death);
        assert_eq!(death.len(), 1);
        assert_eq!(death[0].date, year_date(2000).to_core().unwrap());
        assert_eq!(own_events(&slot, person_id, EventType::Birth).len(), 1);
        let death_id = death[0].id;

        let version = access
            .get_person(GetPersonRequest {
                project_id,
                person_id,
                limits: None,
            })
            .unwrap()
            .version
            .unwrap();
        access
            .update_person(UpdatePersonRequest {
                project_id,
                person_id,
                patch: gentree_mcp::dto::PersonPatch {
                    death: Some(year_date(2001)),
                    ..gentree_mcp::dto::PersonPatch::default()
                },
                dry_run: false,
                expected_version: Some(version),
            })
            .unwrap();

        let death = own_events(&slot, person_id, EventType::Death);
        assert_eq!(death.len(), 1, "no duplicate death event");
        assert_eq!(death[0].id, death_id, "the same event follows the person");
        assert_eq!(death[0].date, year_date(2001).to_core().unwrap());

        // Clearing the person's death date removes the automatic event.
        let version = access
            .get_person(GetPersonRequest {
                project_id,
                person_id,
                limits: None,
            })
            .unwrap()
            .version
            .unwrap();
        access
            .update_person(UpdatePersonRequest {
                project_id,
                person_id,
                patch: gentree_mcp::dto::PersonPatch {
                    death: Some(gentree_mcp::dto::DateInput::default()),
                    ..gentree_mcp::dto::PersonPatch::default()
                },
                dry_run: false,
                expected_version: Some(version),
            })
            .unwrap();
        assert!(own_events(&slot, person_id, EventType::Death).is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn project_access_delete_removes_the_owned_event_not_the_co_participant() {
        // Issue #147: a child's BIRTH event has the father as a co-participant.
        // Deleting the child removes the event owned by the child; the father is
        // never promoted into it. The chat/MCP path shares `plan_removal` with
        // the IPC command, so this covers both.
        let dir = temp_dir("mcp-access-delete-owned-event");
        let (slot, project_id, access) = project_access(&dir);

        let child = person_input("Child").to_person().expect("synthetic child");
        let father = person_input("Father")
            .to_person()
            .expect("synthetic father");
        let mut birth = Event::new(child.id, EventType::Birth);
        birth.participant_ids = vec![father.id];
        {
            let mut guard = slot.lock().unwrap();
            let store = guard.as_mut().expect("open store");
            store
                .save_persons(&[child.clone(), father.clone()])
                .expect("save persons");
            store
                .save_events(std::slice::from_ref(&birth))
                .expect("save events");
        }

        // A dry run reports the plan and writes nothing.
        let dry = access
            .delete_person(DeletePersonRequest {
                project_id,
                person_id: child.id,
                confirm: true,
                dry_run: true,
                expected_version: None,
            })
            .unwrap();
        assert!(dry.dry_run);
        assert!(!dry.changed);
        assert_eq!(
            slot.lock().unwrap().as_ref().unwrap().events().unwrap(),
            vec![birth.clone()]
        );

        access
            .delete_person(DeletePersonRequest {
                project_id,
                person_id: child.id,
                confirm: true,
                dry_run: false,
                expected_version: None,
            })
            .unwrap();

        let guard = slot.lock().unwrap();
        let store = guard.as_ref().expect("open store");
        let events = store.events().unwrap();
        assert!(
            events.iter().all(|event| event.id != birth.id),
            "the event owned by the deleted child must be gone"
        );
        assert!(
            events.iter().all(|event| event.person_id != father.id),
            "the father must not become the owner of the child's event"
        );
        let persons = store.persons().unwrap();
        assert_eq!(persons.len(), 1);
        assert_eq!(persons[0].id, father.id);
        drop(guard);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn project_access_refuses_a_second_birth_or_death_event() {
        // Issue #129: the IPC/chat create path enforces the same uniqueness the
        // form shows. Person creation already owns the automatic life events,
        // so any extra BIRTH or DEATH must be a validation error.
        let dir = temp_dir("access-duplicate-life-events");
        let (_slot, project_id, access) = project_access(&dir);
        let created = access
            .create_person(CreatePersonRequest {
                project_id,
                person: dated_person("Ada", 1950, 2000),
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        let person_id = created.entity_id.unwrap();

        let life_event = |event_type, year| gentree_mcp::dto::EventInput {
            person_id,
            event_type,
            date: year_date(year),
            place: None,
            description: None,
            source_ids: Vec::new(),
            details: None,
        };

        for (event_type, year) in [
            (gentree_mcp::dto::EventTypeArg::Birth, 1951),
            (gentree_mcp::dto::EventTypeArg::Death, 2001),
        ] {
            let error = access
                .create_event(CreateEventRequest {
                    project_id,
                    event: life_event(event_type, year),
                    dry_run: false,
                    expected_version: None,
                })
                .unwrap_err();
            assert_eq!(
                error.code,
                gentree_core::validation::LIFE_EVENT_ALREADY_EXISTS
            );
        }

        // A repeatable type on the same person and a BIRTH for another person
        // are not blocked by this rule.
        access
            .create_event(CreateEventRequest {
                project_id,
                event: life_event(gentree_mcp::dto::EventTypeArg::Residence, 1970),
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        let other = access
            .create_person(CreatePersonRequest {
                project_id,
                person: person_input("Bob"),
                dry_run: false,
                expected_version: None,
            })
            .unwrap()
            .entity_id
            .unwrap();
        access
            .create_event(CreateEventRequest {
                project_id,
                event: gentree_mcp::dto::EventInput {
                    person_id: other,
                    event_type: gentree_mcp::dto::EventTypeArg::Birth,
                    date: year_date(1980),
                    place: None,
                    description: None,
                    source_ids: Vec::new(),
                    details: None,
                },
                dry_run: false,
                expected_version: None,
            })
            .unwrap();

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn project_access_writes_through_storage_with_versions_and_dry_run() {
        let dir = temp_dir("mcp-access");
        let (slot, project_id, access) = project_access(&dir);

        // A second project is visible through list_projects.
        let listed = access
            .list_projects(ListProjectsRequest::default())
            .unwrap();
        assert_eq!(listed.total, 1);
        assert_eq!(listed.projects[0].project_id, project_id);

        // Dry run validates and generates an id but writes nothing.
        let dry = access
            .create_person(CreatePersonRequest {
                project_id,
                person: person_input("Dry"),
                dry_run: true,
                expected_version: None,
            })
            .unwrap();
        assert!(dry.dry_run);
        assert!(!dry.changed);
        assert!(dry.entity_id.is_some());
        assert_eq!(
            slot.lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .persons()
                .unwrap()
                .len(),
            0
        );

        let created = access
            .create_person(CreatePersonRequest {
                project_id,
                person: person_input("Ada"),
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        let person_id = created.entity_id.unwrap();
        let version = created.version.clone().unwrap();
        assert!(created.changed);

        let card = access
            .get_person(GetPersonRequest {
                project_id,
                person_id,
                limits: None,
            })
            .unwrap();
        assert_eq!(card.person.id, person_id);
        assert_eq!(
            card.version.as_deref(),
            Some(version.as_str()),
            "get_person exposes the optimistic-concurrency token for update_person"
        );

        // A stale token is rejected before the write.
        let stale = access
            .update_person(UpdatePersonRequest {
                project_id,
                person_id,
                patch: gentree_mcp::dto::PersonPatch {
                    notes: Some("changed".to_owned()),
                    ..gentree_mcp::dto::PersonPatch::default()
                },
                dry_run: false,
                expected_version: Some("1999-01-01T00:00:00Z".to_owned()),
            })
            .unwrap_err();
        assert_eq!(stale.code, codes::STALE_WRITE);

        let updated = access
            .update_person(UpdatePersonRequest {
                project_id,
                person_id,
                patch: gentree_mcp::dto::PersonPatch {
                    notes: Some("changed".to_owned()),
                    ..gentree_mcp::dto::PersonPatch::default()
                },
                dry_run: false,
                expected_version: Some(version),
            })
            .unwrap();
        assert!(updated.changed);
        assert!(updated.version.is_some());

        // Destructive tools require confirm=true.
        let unconfirmed = access
            .delete_person(DeletePersonRequest {
                project_id,
                person_id,
                confirm: false,
                dry_run: true,
                expected_version: None,
            })
            .unwrap_err();
        assert_eq!(unconfirmed.code, codes::VALIDATION_ERROR);
        assert_eq!(
            unconfirmed.params.get("field").map(String::as_str),
            Some("confirm")
        );

        // A read-only store rejects writes as locked.
        let read_dir = temp_dir("mcp-access-readonly");
        let read_store = ProjectStore::create(&read_dir, "Read only").unwrap();
        let read_project_id = read_store.manifest().project_id;
        drop(read_store);
        let read_only =
            ProjectStore::open(&read_dir.join(read_project_id.to_string()), false).unwrap();
        let read_slot = Arc::new(Mutex::new(Some(read_only)));
        let read_access = AppProjectAccess::new(
            read_slot,
            read_dir.clone(),
            read_dir.join("backups"),
            &read_dir.join("appdata"),
        );
        let locked = read_access
            .create_person(CreatePersonRequest {
                project_id: read_project_id,
                person: person_input("Locked"),
                dry_run: false,
                expected_version: None,
            })
            .unwrap_err();
        assert_eq!(locked.code, codes::PROJECT_LOCKED);

        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&read_dir).unwrap();
    }

    #[test]
    fn project_access_reports_unknown_projects() {
        let dir = temp_dir("mcp-access-unknown");
        let (_slot, _project_id, access) = project_access(&dir);
        let error = access
            .get_project(GetProjectRequest {
                project_id: Uuid::now_v7(),
            })
            .unwrap_err();
        assert_eq!(error.code, codes::PROJECT_NOT_FOUND);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backup_export_restore_and_import_round_trip() {
        let dir = temp_dir("mcp-access-exchange");
        let (_slot, project_id, access) = project_access(&dir);
        access
            .create_person(CreatePersonRequest {
                project_id,
                person: person_input("Ada"),
                dry_run: false,
                expected_version: None,
            })
            .unwrap();

        // Dry-run backup reports a size and writes no archive.
        let dry_backup = access
            .backup_project(BackupProjectRequest {
                project_id,
                dry_run: true,
                expected_version: None,
            })
            .unwrap();
        assert!(dry_backup.size_bytes > 0);
        assert!(access
            .list_backups(ListBackupsRequest { project_id })
            .unwrap()
            .backups
            .is_empty());

        let backup = access
            .backup_project(BackupProjectRequest {
                project_id,
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        let backups = access
            .list_backups(ListBackupsRequest { project_id })
            .unwrap();
        assert_eq!(backups.backups.len(), 1);
        assert_eq!(backups.backups[0].backup_id, backup.backup_id);

        // Dry-run restore verifies the archive without adding a project.
        let before = access
            .list_projects(ListProjectsRequest::default())
            .unwrap()
            .total;
        access
            .restore_backup(RestoreBackupRequest {
                backup_id: backup.backup_id.clone(),
                confirm: true,
                dry_run: true,
                expected_version: None,
            })
            .unwrap();
        assert_eq!(
            access
                .list_projects(ListProjectsRequest::default())
                .unwrap()
                .total,
            before
        );
        let restored = access
            .restore_backup(RestoreBackupRequest {
                backup_id: backup.backup_id,
                confirm: true,
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        assert!(restored.changed);
        assert_ne!(restored.entity_id, Some(project_id));

        // JSON export: dry run measures the real payload, the real run writes it.
        let dry_export = access
            .export_project(ExportProjectRequest {
                project_id,
                format: ExportFormatArg::GentreeJson,
                destination: None,
                dry_run: true,
                expected_version: None,
            })
            .unwrap();
        assert!(dry_export.bytes > 0);
        let export = access
            .export_project(ExportProjectRequest {
                project_id,
                format: ExportFormatArg::GentreeJson,
                destination: None,
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        assert!(export.file_name.ends_with(".gentree.json"));
        assert!(export.bytes > 0);
        let exported_path = access.export_dir.join(&export.file_name);
        assert!(exported_path.is_file());

        let dry_import = access
            .import_project(ImportProjectRequest {
                source_path: exported_path.display().to_string(),
                format: ImportFormatArg::Auto,
                project_name: None,
                dry_run: true,
                expected_version: None,
            })
            .unwrap();
        assert!(dry_import.dry_run);
        assert!(dry_import.project_id.is_none());
        assert_eq!(dry_import.counts.persons, 1);

        let imported = access
            .import_project(ImportProjectRequest {
                source_path: exported_path.display().to_string(),
                format: ImportFormatArg::Auto,
                project_name: Some("Imported synthetic".to_owned()),
                dry_run: false,
                expected_version: None,
            })
            .unwrap();
        assert!(!imported.dry_run);
        assert!(imported.project_id.is_some());
        assert_eq!(imported.counts.persons, 1);

        fs::remove_dir_all(&dir).unwrap();
    }
}
