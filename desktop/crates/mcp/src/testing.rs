//! In-memory [`ProjectAccess`] test double.
//!
//! Everything here is fabricated: one project and one person with no real data.
//! It exists so the tool layer can be tested without a
//! project directory, a lock file or Tauri. Real AT5 data must never be added
//! to this module.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use gentree_core::error::codes;
use gentree_core::person::{Gender, Name, Person};
use gentree_core::record::{Citation, CitationTarget, Event, EventType, Source};
use gentree_core::relationship::{Relationship, RelationshipSet};
use gentree_core::{
    AppError, AppResult, Counts, DateValue, IssueCounts, Manifest, ValidationReport, SCHEMA_VERSION,
};

use crate::access::ProjectAccess;
use crate::dto::{
    BackupInfo, BackupProjectRequest, CreateEventRequest, CreatePersonRequest,
    CreateRelationshipRequest, DeletePersonRequest, DeleteRelationshipRequest, EventCard,
    ExportProjectRequest, ExportResult, FindPathRequest, GetAncestorsRequest, GetEventRequest,
    GetKinshipRequest, GetPersonRequest, GetProjectRequest, GetSourceRequest, GetTimelineRequest,
    GetTreeOverviewRequest, ImportProjectRequest, ImportReport, ListBackupsRequest,
    ListBackupsResponse, ListProjectsRequest, ListProjectsResponse, ListSourcesRequest,
    ListSourcesResponse, NameInput, PersonCard, PersonInput, RestoreBackupRequest, RootPerson,
    SearchHit, SearchRequest, SearchResponse, SourceCard, TimelineResult, TreeDateRange,
    TreeOverview, TreeSummary, UpdateEventRequest, UpdatePersonRequest, ValidateProjectRequest,
    WriteResult,
};

/// Project id of the synthetic fixture.
#[must_use]
pub const fn fake_project_id() -> uuid::Uuid {
    uuid::Uuid::from_u128(0x1111_1111_1111_7111_8111_1111_1111_1111)
}

/// Person id of the synthetic fixture.
#[must_use]
pub const fn fake_person_id() -> uuid::Uuid {
    uuid::Uuid::from_u128(0x2222_2222_2222_7222_8222_2222_2222_2222)
}

/// Event id of the synthetic fixture.
#[must_use]
pub const fn fake_event_id() -> uuid::Uuid {
    uuid::Uuid::from_u128(0x3333_3333_3333_7333_8333_3333_3333_3333)
}

/// Source id of the synthetic fixture.
#[must_use]
pub const fn fake_source_id() -> uuid::Uuid {
    uuid::Uuid::from_u128(0x4444_4444_4444_7444_8444_4444_4444_4444)
}

/// Display name of the synthetic fixture (surname first, as the domain renders
/// it).
pub const FAKE_PERSON_NAME: &str = "Person Fixture";

/// One recorded call to the fake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessCall {
    /// Tool name, matching the tool catalogue.
    pub tool: &'static str,
    /// `dry_run` flag the tool passed down.
    pub dry_run: bool,
}

#[derive(Debug)]
struct Inner {
    calls: Mutex<Vec<AccessCall>>,
    writes: AtomicUsize,
}

/// Single-project, single-person fake.
#[derive(Debug, Clone)]
pub struct FakeProjectAccess {
    inner: Arc<Inner>,
    manifest: Manifest,
    person: Person,
    event: Event,
    source: Source,
    citation: Citation,
}

impl Default for FakeProjectAccess {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeProjectAccess {
    /// Builds the fixture.
    ///
    /// # Panics
    ///
    /// Panics only when the hardcoded fixture stops satisfying the domain
    /// invariants, which is a programming error in this module.
    #[must_use]
    pub fn new() -> Self {
        let manifest = Manifest {
            format_version: gentree_core::FORMAT_VERSION,
            schema_version: SCHEMA_VERSION,
            project_id: fake_project_id(),
            name: "Synthetic project".to_owned(),
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-02T00:00:00Z".to_owned(),
            app_version: "0.0.0-test".to_owned(),
            home_person_id: Some(fake_person_id()),
            content_hash: "sha256:synthetic".to_owned(),
            counts: Counts {
                persons: 1,
                events: 1,
                sources: 1,
                citations: 1,
                ..Counts::default()
            },
        };
        let source = Source {
            id: fake_source_id(),
            title: "Synthetic source".to_owned(),
            author: None,
            publication: None,
            repository: None,
            url: None,
            notes: None,
        };
        let event = Event {
            id: fake_event_id(),
            person_id: fake_person_id(),
            event_type: EventType::Birth,
            date: DateValue::exact_year(1950),
            place: Some("Synthetic place".to_owned()),
            place_geo: None,
            description: Some("Synthetic event".to_owned()),
            source_ids: vec![fake_source_id()],
            original_type: None,
            participant_ids: Vec::new(),
            details: std::collections::BTreeMap::new(),
        };
        let citation = Citation {
            id: uuid::Uuid::now_v7(),
            source_id: fake_source_id(),
            target_type: CitationTarget::Event,
            target_id: fake_event_id(),
            page: None,
            confidence: None,
        };
        let person = PersonInput {
            names: vec![NameInput {
                given: Some("Fixture".to_owned()),
                surname: Some("Person".to_owned()),
                is_primary: true,
                ..NameInput::default()
            }],
            gender: crate::dto::GenderArg::Female,
            birth: crate::dto::DateInput {
                start: Some("1950-01-01".to_owned()),
                end: Some("1951-01-01".to_owned()),
                precision: crate::dto::DatePrecisionArg::Year,
                qualifier: crate::dto::DateQualifierArg::Exact,
                original: Some("1950".to_owned()),
            },
            ..PersonInput::default()
        }
        .to_person_with_id(fake_person_id())
        .expect("synthetic fixture satisfies domain invariants");
        Self {
            inner: Arc::new(Inner {
                calls: Mutex::new(Vec::new()),
                writes: AtomicUsize::new(0),
            }),
            manifest,
            person,
            event,
            source,
            citation,
        }
    }

    /// Every recorded call, in order.
    #[must_use]
    pub fn calls(&self) -> Vec<AccessCall> {
        self.inner
            .calls
            .lock()
            .map(|calls| calls.clone())
            .unwrap_or_default()
    }

    /// Number of calls that actually wrote (`dry_run = false`).
    #[must_use]
    pub fn write_calls(&self) -> usize {
        self.inner.writes.load(Ordering::SeqCst)
    }

    /// The synthetic person.
    #[must_use]
    pub fn person(&self) -> &Person {
        &self.person
    }

    /// The synthetic manifest.
    #[must_use]
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn record(&self, tool: &'static str, dry_run: bool) {
        if let Ok(mut calls) = self.inner.calls.lock() {
            calls.push(AccessCall { tool, dry_run });
        }
        if !dry_run {
            self.inner.writes.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn read(&self, tool: &'static str) -> AppResult<()> {
        self.record(tool, true);
        Ok(())
    }

    fn project(&self, project_id: uuid::Uuid) -> AppResult<()> {
        if project_id == self.manifest.project_id {
            Ok(())
        } else {
            Err(AppError::new(codes::PROJECT_NOT_FOUND, "Project not found")
                .with_param("projectId", project_id.to_string()))
        }
    }

    fn write_result(&self, dry_run: bool, entity_id: Option<uuid::Uuid>) -> WriteResult {
        WriteResult {
            dry_run,
            would_change: true,
            changed: !dry_run,
            entity_id,
            version: Some("2026-01-02T00:00:00Z".to_owned()),
            issues: Vec::new(),
        }
    }
}

impl ProjectAccess for FakeProjectAccess {
    fn list_projects(&self, request: ListProjectsRequest) -> AppResult<ListProjectsResponse> {
        self.read("list_projects")?;
        let limit = request.limit.unwrap_or(50).clamp(1, 200) as usize;
        let offset = request.offset.unwrap_or(0) as usize;
        let projects = if offset == 0 && limit > 0 {
            vec![self.manifest.clone()]
        } else {
            Vec::new()
        };
        Ok(ListProjectsResponse { projects, total: 1 })
    }

    fn get_project(&self, request: GetProjectRequest) -> AppResult<Manifest> {
        self.read("get_project")?;
        self.project(request.project_id)?;
        Ok(self.manifest.clone())
    }

    fn get_tree_overview(&self, request: GetTreeOverviewRequest) -> AppResult<TreeOverview> {
        self.read("get_tree_overview")?;
        self.project(request.project_id)?;
        let date = self.event.date.start;
        Ok(TreeOverview {
            tree: TreeSummary {
                id: self.manifest.project_id,
                name: self.manifest.name.clone(),
                home_person_id: self.manifest.home_person_id,
            },
            counts: self.manifest.counts.clone(),
            date_range: TreeDateRange {
                start: date,
                end: date,
            },
            roots: vec![RootPerson {
                id: self.person.id,
                first_name: Some("Fixture".to_owned()),
                last_name: Some("Person".to_owned()),
            }],
            root_count: 1,
        })
    }

    fn search(&self, request: SearchRequest) -> AppResult<SearchResponse> {
        self.read("search")?;
        self.project(request.project_id)?;
        Ok(SearchResponse {
            results: vec![SearchHit {
                entity_type: "PERSON".to_owned(),
                entity_id: self.person.id,
                title: self.person.display_name(),
                snippet: Some(format!("match for {}", request.query)),
                score: 1.0,
            }],
            has_more: false,
            next_cursor: None,
        })
    }

    fn get_person(&self, request: GetPersonRequest) -> AppResult<PersonCard> {
        self.read("get_person")?;
        self.project(request.project_id)?;
        if request.person_id != self.person.id {
            return Err(AppError::new(codes::NOT_FOUND, "Person not found")
                .with_param("personId", request.person_id.to_string()));
        }
        Ok(PersonCard {
            person: self.person.clone(),
            events: vec![self.event.clone()],
            relationships: Vec::new(),
            related_persons: Vec::new(),
            media: Vec::new(),
            citations: vec![self.citation.clone()],
            truncated: false,
            version: Some("2026-01-02T00:00:00Z".to_owned()),
        })
    }

    fn get_event(&self, request: GetEventRequest) -> AppResult<EventCard> {
        self.read("get_event")?;
        self.project(request.project_id)?;
        if request.event_id != self.event.id {
            return Err(AppError::new(codes::NOT_FOUND, "Event not found")
                .with_param("eventId", request.event_id.to_string()));
        }
        Ok(EventCard {
            event: self.event.clone(),
            participants: vec![self.person.clone()],
            citations: vec![self.citation.clone()],
            media: Vec::new(),
        })
    }

    fn list_sources(&self, request: ListSourcesRequest) -> AppResult<ListSourcesResponse> {
        self.read("list_sources")?;
        self.project(request.project_id)?;
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let offset = request.offset.unwrap_or(0);
        let items = if offset == 0 && limit > 0 {
            vec![self.source.clone()]
        } else {
            Vec::new()
        };
        Ok(ListSourcesResponse {
            items,
            total: 1,
            limit,
            offset,
        })
    }

    fn get_source(&self, request: GetSourceRequest) -> AppResult<SourceCard> {
        self.read("get_source")?;
        self.project(request.project_id)?;
        if request.source_id != self.source.id {
            return Err(AppError::new(codes::NOT_FOUND, "Source not found")
                .with_param("sourceId", request.source_id.to_string()));
        }
        Ok(SourceCard {
            source: self.source.clone(),
            citations: vec![self.citation.clone()],
        })
    }

    fn get_ancestors(
        &self,
        request: GetAncestorsRequest,
    ) -> AppResult<gentree_core::AncestorGraph> {
        self.read("get_ancestors")?;
        self.project(request.project_id)?;
        let set = RelationshipSet::default();
        Ok(set.ancestors(request.person_id, request.generations.unwrap_or(3)))
    }

    fn get_timeline(&self, request: GetTimelineRequest) -> AppResult<TimelineResult> {
        self.read("get_timeline")?;
        self.project(request.project_id)?;
        Ok(TimelineResult::default())
    }

    fn find_path(&self, request: FindPathRequest) -> AppResult<gentree_core::PathResult> {
        self.read("find_path")?;
        self.project(request.project_id)?;
        Ok(RelationshipSet::default().find_path(request.from_person_id, request.to_person_id))
    }

    fn get_kinship(
        &self,
        request: GetKinshipRequest,
    ) -> AppResult<gentree_core::KinshipDescriptor> {
        self.read("get_kinship")?;
        self.project(request.project_id)?;
        let gender: Gender = self.person.gender;
        Ok(RelationshipSet::default().kinship(
            request.from_person_id,
            request.to_person_id,
            &move |_| gender,
        ))
    }

    fn validate_project(&self, request: ValidateProjectRequest) -> AppResult<ValidationReport> {
        self.read("validate_project")?;
        self.project(request.project_id)?;
        Ok(ValidationReport {
            checked_at: "2026-01-02T00:00:00Z".to_owned(),
            issues: Vec::new(),
            counts: IssueCounts::default(),
        })
    }

    fn list_backups(&self, request: ListBackupsRequest) -> AppResult<ListBackupsResponse> {
        self.read("list_backups")?;
        self.project(request.project_id)?;
        Ok(ListBackupsResponse {
            backups: vec![BackupInfo {
                backup_id: "backup-0001".to_owned(),
                created_at: "2026-01-02T00:00:00Z".to_owned(),
                size_bytes: 1024,
                schema_version: SCHEMA_VERSION,
            }],
        })
    }

    fn create_person(&self, request: CreatePersonRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("create_person", request.dry_run);
        let person = request.person.to_person()?;
        Ok(self.write_result(request.dry_run, Some(person.id)))
    }

    fn update_person(&self, request: UpdatePersonRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("update_person", request.dry_run);
        if request.person_id != self.person.id {
            return Err(AppError::new(codes::NOT_FOUND, "Person not found"));
        }
        let _ = request.patch.apply(&self.person)?;
        Ok(self.write_result(request.dry_run, Some(request.person_id)))
    }

    fn delete_person(&self, request: DeletePersonRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("delete_person", request.dry_run);
        if request.person_id != self.person.id {
            return Err(AppError::new(codes::NOT_FOUND, "Person not found"));
        }
        Ok(self.write_result(request.dry_run, Some(request.person_id)))
    }

    fn create_event(&self, request: CreateEventRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("create_event", request.dry_run);
        let event = request.event.to_event()?;
        Ok(self.write_result(request.dry_run, Some(event.id)))
    }

    fn update_event(&self, request: UpdateEventRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("update_event", request.dry_run);
        Ok(self.write_result(request.dry_run, Some(request.event_id)))
    }

    fn create_relationship(&self, request: CreateRelationshipRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("create_relationship", request.dry_run);
        let relationship = Relationship::new(
            request.relationship_type.into(),
            request.person_id,
            request.related_person_id,
        )?;
        Ok(self.write_result(request.dry_run, Some(relationship.id)))
    }

    fn delete_relationship(&self, request: DeleteRelationshipRequest) -> AppResult<WriteResult> {
        self.project(request.project_id)?;
        self.record("delete_relationship", request.dry_run);
        Ok(self.write_result(request.dry_run, Some(request.relationship_id)))
    }

    fn backup_project(&self, request: BackupProjectRequest) -> AppResult<BackupInfo> {
        self.project(request.project_id)?;
        self.record("backup_project", request.dry_run);
        Ok(BackupInfo {
            backup_id: "backup-0002".to_owned(),
            created_at: "2026-01-02T00:00:00Z".to_owned(),
            size_bytes: 2048,
            schema_version: SCHEMA_VERSION,
        })
    }

    fn export_project(&self, request: ExportProjectRequest) -> AppResult<ExportResult> {
        self.project(request.project_id)?;
        self.record("export_project", request.dry_run);
        Ok(ExportResult {
            file_name: "synthetic-project.gentree.zip".to_owned(),
            bytes: 4096,
            format: "GENTREE_ZIP".to_owned(),
        })
    }

    fn import_project(&self, request: ImportProjectRequest) -> AppResult<ImportReport> {
        if request.source_path.trim().is_empty() {
            return Err(AppError::validation("sourcePath", "required"));
        }
        self.record("import_project", request.dry_run);
        Ok(ImportReport {
            dry_run: request.dry_run,
            project_id: (!request.dry_run).then(fake_project_id),
            counts: Counts {
                persons: 1,
                ..Counts::default()
            },
            issues: Vec::new(),
        })
    }

    fn restore_backup(&self, request: RestoreBackupRequest) -> AppResult<WriteResult> {
        self.record("restore_backup", request.dry_run);
        Ok(self.write_result(request.dry_run, Some(fake_project_id())))
    }
}

/// Synthetic person used by the fake; useful for assertions in other crates.
#[must_use]
pub fn fake_person() -> Person {
    Person {
        id: fake_person_id(),
        gender: Gender::Female,
        names: vec![Name {
            given: Some("Fixture".to_owned()),
            surname: Some("Person".to_owned()),
            is_primary: true,
            ..Name::default()
        }],
        birth: DateValue::exact_year(1950),
        death: DateValue::default(),
        notes: None,
        external_ids: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{PersonPatch, SearchRequest};

    #[test]
    fn fixture_is_honest_about_unknown_data() {
        let fake = FakeProjectAccess::new();
        assert_eq!(fake.person().display_name(), FAKE_PERSON_NAME);
        assert_eq!(
            fake.person().birth.precision,
            gentree_core::DatePrecision::Year
        );
        assert!(fake.person().death.start.is_none());
    }

    #[test]
    fn dry_run_does_not_count_as_a_write() {
        let fake = FakeProjectAccess::new();
        fake.create_person(CreatePersonRequest {
            project_id: fake_project_id(),
            person: PersonInput {
                names: vec![NameInput {
                    given: Some("Another".to_owned()),
                    is_primary: true,
                    ..NameInput::default()
                }],
                ..PersonInput::default()
            },
            dry_run: true,
            expected_version: None,
        })
        .unwrap();
        assert_eq!(fake.write_calls(), 0);
        assert_eq!(fake.calls().len(), 1);

        fake.update_person(UpdatePersonRequest {
            project_id: fake_project_id(),
            person_id: fake_person_id(),
            patch: PersonPatch::default(),
            dry_run: false,
            expected_version: None,
        })
        .unwrap();
        assert_eq!(fake.write_calls(), 1);
    }

    #[test]
    fn unknown_project_is_reported() {
        let fake = FakeProjectAccess::new();
        let error = fake
            .search(SearchRequest {
                project_id: uuid::Uuid::now_v7(),
                query: "any".to_owned(),
                types: None,
                limit: None,
                cursor: None,
            })
            .unwrap_err();
        assert_eq!(error.code, codes::PROJECT_NOT_FOUND);
    }
}
