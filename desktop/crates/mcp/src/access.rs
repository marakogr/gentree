//! The single seam between the tool layer and the desktop application.
//!
//! [`ProjectAccess`] mirrors the tool catalogue one-to-one. The desktop app
//! implements it on top of the same services the Tauri commands use, so the
//! tool layer never touches storage, the file system or Tauri state itself.
//!
//! Contract for implementors:
//!
//! - Object-safe by design: no generics, no `Self` returns, so
//!   `Arc<dyn ProjectAccess>` is usable. Methods are synchronous because the
//!   storage layer is; the server calls them on a blocking pool.
//! - Every method returns [`AppError`] with a stable [`gentree_core::codes`]
//!   code. Unknown projects/entities are `PROJECT_NOT_FOUND`/`NOT_FOUND`, an
//!   entity of another project is `NOT_FOUND`, a write while the project is
//!   open read-only elsewhere is `PROJECT_LOCKED`.
//! - Write requests carry `dryRun` and `expectedVersion`; read them through
//!   `request.options()` ([`crate::dto::WriteOptions`]). `dry_run = true`
//!   validates and returns a plan and MUST NOT write.
//! - `expected_version = Some(token)` MUST fail with `STALE_WRITE` when the
//!   stored token differs, before any write.
//! - Destructive calls arrive with `confirm = true` already checked by the
//!   tool layer; `dry_run` is still available on them.
//!
//! Responses never carry file system paths, storage keys or internal file ids.

use gentree_core::{
    AncestorGraph, AppResult, KinshipDescriptor, Manifest, PathResult, ValidationReport,
};

use crate::dto::{
    BackupInfo, BackupProjectRequest, CreateEventRequest, CreatePersonRequest,
    CreateRelationshipRequest, DeletePersonRequest, DeleteRelationshipRequest, EventCard,
    ExportProjectRequest, ExportResult, FindPathRequest, GetAncestorsRequest, GetEventRequest,
    GetKinshipRequest, GetPersonRequest, GetProjectRequest, GetSourceRequest, GetTimelineRequest,
    GetTreeOverviewRequest, ImportProjectRequest, ImportReport, ListBackupsRequest,
    ListBackupsResponse, ListProjectsRequest, ListProjectsResponse, ListSourcesRequest,
    ListSourcesResponse, PersonCard, RestoreBackupRequest, SearchRequest, SearchResponse,
    SourceCard, TimelineResult, TreeOverview, UpdateEventRequest, UpdatePersonRequest,
    ValidateProjectRequest, WriteResult,
};

/// Data and mutations the tools need from the running application.
///
/// The trait is deliberately one method per tool: adding a tool is a contract
/// change in `dto.rs` plus one method here, and every implementation is forced
/// to handle it.
pub trait ProjectAccess: Send + Sync {
    /// Active, non-deleted projects, newest update first.
    fn list_projects(&self, request: ListProjectsRequest) -> AppResult<ListProjectsResponse>;

    /// Manifest of one project: name, counts, versions, timestamps.
    fn get_project(&self, request: GetProjectRequest) -> AppResult<Manifest>;

    /// Counts, event date range and parentless roots of one project.
    fn get_tree_overview(&self, request: GetTreeOverviewRequest) -> AppResult<TreeOverview>;

    /// Full-text search over persons, events and sources.
    fn search(&self, request: SearchRequest) -> AppResult<SearchResponse>;

    /// One person with events, relationships, related persons, media and
    /// citations.
    fn get_person(&self, request: GetPersonRequest) -> AppResult<PersonCard>;

    /// One event with its participants and citations.
    fn get_event(&self, request: GetEventRequest) -> AppResult<EventCard>;

    /// Sources of one project, oldest first, with pagination.
    fn list_sources(&self, request: ListSourcesRequest) -> AppResult<ListSourcesResponse>;

    /// One source with every citation that points at it.
    fn get_source(&self, request: GetSourceRequest) -> AppResult<SourceCard>;

    /// Ancestor graph with placeholders for unknown parents; never siblings.
    fn get_ancestors(&self, request: GetAncestorsRequest) -> AppResult<AncestorGraph>;

    /// Dated and undated events in a range, ordered by date.
    fn get_timeline(&self, request: GetTimelineRequest) -> AppResult<TimelineResult>;

    /// Shortest path between two persons (see ADR-0011 tie-break rules).
    fn find_path(&self, request: FindPathRequest) -> AppResult<PathResult>;

    /// Structural kinship descriptor between two persons.
    fn get_kinship(&self, request: GetKinshipRequest) -> AppResult<KinshipDescriptor>;

    /// Domain validation report for the whole project.
    fn validate_project(&self, request: ValidateProjectRequest) -> AppResult<ValidationReport>;

    /// Backup archives of one project, newest first.
    fn list_backups(&self, request: ListBackupsRequest) -> AppResult<ListBackupsResponse>;

    /// Creates a person. `PROJECT_LOCKED` when another process holds the
    /// write lock; `VALIDATION_ERROR` for an invalid payload.
    fn create_person(&self, request: CreatePersonRequest) -> AppResult<WriteResult>;

    /// Applies a person patch. `STALE_WRITE` on a version mismatch.
    fn update_person(&self, request: UpdatePersonRequest) -> AppResult<WriteResult>;

    /// Deletes a person together with their private events and citations.
    /// Shared events are never removed (see ADR-0005 / `removal_plan`).
    fn delete_person(&self, request: DeletePersonRequest) -> AppResult<WriteResult>;

    /// Creates an event for one person.
    fn create_event(&self, request: CreateEventRequest) -> AppResult<WriteResult>;

    /// Applies an event patch. `STALE_WRITE` on a version mismatch.
    fn update_event(&self, request: UpdateEventRequest) -> AppResult<WriteResult>;

    /// Creates a relationship; self-links, duplicates and cycles are rejected.
    fn create_relationship(&self, request: CreateRelationshipRequest) -> AppResult<WriteResult>;

    /// Deletes one relationship row.
    fn delete_relationship(&self, request: DeleteRelationshipRequest) -> AppResult<WriteResult>;

    /// Writes a `.gentree.zip` backup of one project.
    fn backup_project(&self, request: BackupProjectRequest) -> AppResult<BackupInfo>;

    /// Exports the project; the response names the file, not its path.
    fn export_project(&self, request: ExportProjectRequest) -> AppResult<ExportResult>;

    /// Imports a file into a new project. Never overwrites an existing one.
    fn import_project(&self, request: ImportProjectRequest) -> AppResult<ImportReport>;

    /// Restores a backup into a new project copy.
    fn restore_backup(&self, request: RestoreBackupRequest) -> AppResult<WriteResult>;
}
