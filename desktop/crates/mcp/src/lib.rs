//! Tool layer shared by the desktop chat and the domain services.
//!
//! There is no MCP server: the crate keeps the tool catalogue and the access
//! seam, and the desktop chat calls them in process. The crate has no Tauri, no
//! file system and no storage dependency:
//!
//! - [`ProjectAccess`] is the only seam to the application; the desktop
//!   implements it over the same services the Tauri commands use.
//! - [`McpServer`] holds the 26 tool definitions as `rmcp` routes; the chat
//!   reads their JSON Schemas and maps domain errors to tool errors.
//! - [`testing::FakeProjectAccess`] is an in-memory test double with one
//!   synthetic person; real AT5 data never enters this crate.
//!
//! Tool descriptions and messages are English; the UI never renders them.

pub mod access;
pub mod dto;
pub mod server;
pub mod testing;

pub use access::ProjectAccess;
pub use dto::{
    require_confirm, BackupInfo, BackupProjectRequest, CardLimits, CreateEventRequest,
    CreatePersonRequest, CreateRelationshipRequest, DateInput, DeletePersonRequest,
    DeleteRelationshipRequest, EventCard, EventInput, EventPatch, EventTypeArg, ExportFormatArg,
    ExportProjectRequest, ExportResult, ExternalIdInput, FindPathRequest, GenderArg,
    GetAncestorsRequest, GetCurrentDateRequest, GetEventRequest, GetKinshipRequest,
    GetPersonRequest, GetProjectRequest, GetSourceRequest, GetTimelineRequest,
    GetTreeOverviewRequest, ImportFormatArg, ImportProjectRequest, ImportReport,
    ListBackupsRequest, ListBackupsResponse, ListProjectsRequest, ListProjectsResponse,
    ListSourcesRequest, ListSourcesResponse, NameInput, NameTypeArg, PersonCard, PersonInput,
    PersonPatch, RelationshipKindArg, RestoreBackupRequest, RootPerson, SearchHit, SearchRequest,
    SearchResponse, SourceCard, TimelineResult, TreeDateRange, TreeOverview, TreeSummary,
    UpdateEventRequest, UpdatePersonRequest, ValidateProjectRequest, WriteOptions, WriteResult,
};
pub use server::{current_date, current_date_payload, tool_names, McpServer};
pub use testing::{AccessCall, FakeProjectAccess};
