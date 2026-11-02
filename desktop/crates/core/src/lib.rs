//! Domain layer: no I/O, no Tauri, no HTTP, no localization.
//! Contracts: domain invariants and the project format.

pub mod date;
pub mod error;
pub mod event_fields;
pub mod geo;
pub mod graph;
pub mod kinship;
pub mod merge;
pub mod path;
pub mod person;
pub mod place;
pub mod project;
pub mod record;
pub mod relationship;
pub mod validation;

pub use date::{CivilDate, DatePrecision, DateQualifier, DateValue};
pub use error::{codes, AppError, AppResult};
pub use event_fields::{
    builtin_event_field_keys, is_valid_event_detail_key, MAX_EVENT_DETAILS, MAX_EVENT_DETAIL_KEY,
    MAX_EVENT_DETAIL_VALUE,
};
pub use geo::{PlaceGeo, PlacePrecision, PlaceSource};
pub use graph::{
    AncestorEdge, AncestorGraph, AncestorNode, AncestorRole, DescendantEdge, DescendantGraph,
    DescendantNode, DescendantRole, DEFAULT_GENERATIONS,
};
pub use kinship::{KinshipDescriptor, KinshipEdge, KinshipEdgeKind, KinshipKind, KinshipLine};
pub use merge::{
    apply_merge, merge_preview, EventDecision, EventMatch, FieldPolicy, MatchConfidence,
    MatchEvidence, MergeAction, MergeDecisions, MergeEvent, MergeOutput, MergePerson, MergePreview,
    MergePreviewCounts, MergeReport, MergeWarning, PersonDecision, PersonMatch, Side,
};
pub use path::{EdgeDirection, PathResult, PathStep, MAX_ALTERNATIVES};
pub use person::{ExternalId, Gender, Name, NameType, Person, PersonId};
pub use place::{apply_place_geo, normalize_place_text, ApplyPlaceGeoResult};
pub use project::{Counts, Manifest, ProjectId, FORMAT_VERSION, SCHEMA_VERSION};
pub use record::{Citation, CitationTarget, Confidence, Event, EventType, Media, Source};
pub use relationship::{Relationship, RelationshipSet, RelationshipType};
pub use validation::{
    ensure_event_within_lifespan, ensure_life_events_compatible, ensure_single_life_event,
    removal_plan, validate_project, IssueCounts, ProjectSnapshot, RemovalPlan, Severity,
    ValidationIssue, ValidationReport,
};

/// RFC 3339 timestamp used in manifest/JSONL envelopes (UTC).
pub fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
