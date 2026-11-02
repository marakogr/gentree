//! Wire DTOs shared by the tools and [`crate::ProjectAccess`].
//!
//! Inputs are plain `serde` structs that also derive `schemars::JsonSchema`, so
//! the JSON Schema shown to an agent and the type the tool deserializes cannot
//! drift apart. Outputs reuse the core domain types (`Person`, `Event`, ...)
//! because they are already stable `serde` contracts; they are returned as
//! structured content, not through a schema.
//!
//! Ids are `Uuid`s and serialize as canonical UUID strings. Dates use the core
//! [`gentree_core::DateValue`] shape (ADR-0010) through [`DateInput`]: no
//! timestamp is invented, unknown dates keep `precision = UNKNOWN` and an
//! optional `original` text.

use std::collections::BTreeMap;

use gentree_core::person::{ExternalId, Gender, Name, NameType, Person};
use gentree_core::record::{Event, EventType, Source};
use gentree_core::relationship::RelationshipType;
use gentree_core::{
    AppError, AppResult, CivilDate, Counts, DatePrecision, DateQualifier, DateValue, Manifest,
    ValidationIssue,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Input primitives
// ---------------------------------------------------------------------------

/// Gender of a person. `UNKNOWN` is the honest default, never a guess.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GenderArg {
    Male,
    Female,
    #[default]
    Unknown,
}

impl From<GenderArg> for Gender {
    fn from(value: GenderArg) -> Self {
        match value {
            GenderArg::Male => Self::Male,
            GenderArg::Female => Self::Female,
            GenderArg::Unknown => Self::Unknown,
        }
    }
}

/// Kind of a name record.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NameTypeArg {
    #[default]
    Birth,
    Married,
    Religious,
    Other,
}

impl From<NameTypeArg> for NameType {
    fn from(value: NameTypeArg) -> Self {
        match value {
            NameTypeArg::Birth => Self::Birth,
            NameTypeArg::Married => Self::Married,
            NameTypeArg::Religious => Self::Religious,
            NameTypeArg::Other => Self::Other,
        }
    }
}

/// Precision of a date value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DatePrecisionArg {
    Day,
    Month,
    Year,
    #[default]
    Unknown,
}

impl From<DatePrecisionArg> for DatePrecision {
    fn from(value: DatePrecisionArg) -> Self {
        match value {
            DatePrecisionArg::Day => Self::Day,
            DatePrecisionArg::Month => Self::Month,
            DatePrecisionArg::Year => Self::Year,
            DatePrecisionArg::Unknown => Self::Unknown,
        }
    }
}

/// Qualifier of a date value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DateQualifierArg {
    Exact,
    Approximate,
    Before,
    After,
    Range,
    #[default]
    Unknown,
}

impl From<DateQualifierArg> for DateQualifier {
    fn from(value: DateQualifierArg) -> Self {
        match value {
            DateQualifierArg::Exact => Self::Exact,
            DateQualifierArg::Approximate => Self::Approximate,
            DateQualifierArg::Before => Self::Before,
            DateQualifierArg::After => Self::After,
            DateQualifierArg::Range => Self::Range,
            DateQualifierArg::Unknown => Self::Unknown,
        }
    }
}

/// Event type. `OTHER` keeps the source wording in `originalType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventTypeArg {
    Birth,
    Death,
    Marriage,
    Divorce,
    Burial,
    Residence,
    Occupation,
    Education,
    Other,
}

impl From<EventTypeArg> for EventType {
    fn from(value: EventTypeArg) -> Self {
        match value {
            EventTypeArg::Birth => Self::Birth,
            EventTypeArg::Death => Self::Death,
            EventTypeArg::Marriage => Self::Marriage,
            EventTypeArg::Divorce => Self::Divorce,
            EventTypeArg::Burial => Self::Burial,
            EventTypeArg::Residence => Self::Residence,
            EventTypeArg::Occupation => Self::Occupation,
            EventTypeArg::Education => Self::Education,
            EventTypeArg::Other => Self::Other,
        }
    }
}

/// Kind of relationship between two persons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RelationshipKindArg {
    ParentChild,
    AdoptiveParentChild,
    Spouse,
    Partner,
}

impl From<RelationshipKindArg> for RelationshipType {
    fn from(value: RelationshipKindArg) -> Self {
        match value {
            RelationshipKindArg::ParentChild => Self::ParentChild,
            RelationshipKindArg::AdoptiveParentChild => Self::AdoptiveParentChild,
            RelationshipKindArg::Spouse => Self::Spouse,
            RelationshipKindArg::Partner => Self::Partner,
        }
    }
}

/// A civil (timezone-free) date value, `[start, end)`.
///
/// `start`/`end` are ISO `YYYY-MM-DD` strings. Unknown dates carry no bounds,
/// `precision = UNKNOWN`, and the source wording in `original` (ADR-0010).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DateInput {
    /// Inclusive lower bound, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// Exclusive upper bound, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default)]
    pub precision: DatePrecisionArg,
    #[serde(default)]
    pub qualifier: DateQualifierArg,
    /// Source text exactly as written, e.g. "spring 1942".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
}

impl DateInput {
    /// Converts to the core date value and validates bounds/precision rules.
    pub fn to_core(&self) -> AppResult<DateValue> {
        let start = self.start.as_deref().map(CivilDate::parse).transpose()?;
        let end = self.end.as_deref().map(CivilDate::parse).transpose()?;
        let value = DateValue {
            start,
            end,
            precision: self.precision.into(),
            qualifier: self.qualifier.into(),
            original: self.original.clone(),
        };
        value.validate()?;
        Ok(value)
    }
}

/// One name of a person.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NameInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub given: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patronymic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default)]
    pub name_type: NameTypeArg,
    #[serde(default)]
    pub is_primary: bool,
}

impl NameInput {
    fn to_core(&self) -> Name {
        Name {
            given: self.given.clone(),
            patronymic: self.patronymic.clone(),
            surname: self.surname.clone(),
            prefix: self.prefix.clone(),
            suffix: self.suffix.clone(),
            name_type: self.name_type.into(),
            is_primary: self.is_primary,
        }
    }
}

/// External identifier, e.g. an AT5 or GEDCOM id. Never used for deduplication
/// on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIdInput {
    /// Source system, e.g. `AT5`.
    pub source: String,
    /// Identifier in that system.
    pub value: String,
}

impl ExternalIdInput {
    fn to_core(&self) -> ExternalId {
        ExternalId {
            source: self.source.clone(),
            value: self.value.clone(),
        }
    }
}

/// Full person payload for `create_person`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PersonInput {
    /// Names are optional: unknown individuals are valid (see `Person::validate`).
    pub names: Vec<NameInput>,
    #[serde(default)]
    pub gender: GenderArg,
    #[serde(default)]
    pub birth: DateInput,
    #[serde(default)]
    pub death: DateInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub external_ids: Vec<ExternalIdInput>,
}

impl PersonInput {
    /// Builds a new core person with a fresh id and validates it.
    pub fn to_person(&self) -> AppResult<Person> {
        self.to_person_with_id(Uuid::now_v7())
    }

    /// Builds a core person with an explicit id (used by tests and importers).
    pub fn to_person_with_id(&self, id: Uuid) -> AppResult<Person> {
        let person = Person {
            id,
            gender: self.gender.into(),
            names: self.names.iter().map(NameInput::to_core).collect(),
            birth: self.birth.to_core()?,
            death: self.death.to_core()?,
            notes: self.notes.clone(),
            external_ids: self
                .external_ids
                .iter()
                .map(ExternalIdInput::to_core)
                .collect(),
        };
        person.validate()?;
        Ok(person)
    }
}

/// Patch payload for `update_person`. Absent fields keep their current value;
/// an empty `notes` string clears the notes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PersonPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<NameInput>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<GenderArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth: Option<DateInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death: Option<DateInput>,
    /// `null`/absent keeps the current notes; an empty string clears them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ids: Option<Vec<ExternalIdInput>>,
}

impl PersonPatch {
    /// Applies the patch to a copy and validates the result.
    pub fn apply(&self, person: &Person) -> AppResult<Person> {
        let mut updated = person.clone();
        if let Some(names) = &self.names {
            updated.names = names.iter().map(NameInput::to_core).collect();
        }
        if let Some(gender) = self.gender {
            updated.gender = gender.into();
        }
        if let Some(birth) = &self.birth {
            updated.birth = birth.to_core()?;
        }
        if let Some(death) = &self.death {
            updated.death = death.to_core()?;
        }
        if let Some(notes) = &self.notes {
            updated.notes = (!notes.is_empty()).then(|| notes.clone());
        }
        if let Some(external_ids) = &self.external_ids {
            updated.external_ids = external_ids.iter().map(ExternalIdInput::to_core).collect();
        }
        updated.validate()?;
        Ok(updated)
    }
}

/// Event payload for `create_event`. Events belong to exactly one person in
/// this schema version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    /// Owner of the event.
    pub person_id: Uuid,
    #[serde(rename = "type")]
    pub event_type: EventTypeArg,
    #[serde(default)]
    pub date: DateInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub source_ids: Vec<Uuid>,
    /// Type-specific values keyed by a stable lowercase snake_case id
    /// (ADR-0015). Omit the object for an event without details.
    ///
    /// Built-in keys depend on `type`: BIRTH `birth_certificate`, `hospital`;
    /// DEATH `cause`, `death_certificate`; MARRIAGE `marriage_certificate`,
    /// `marriage_rite`, `officiant`; DIVORCE `reason`, `court`,
    /// `divorce_certificate`; BURIAL `cemetery`, `grave`, `burial_rite`,
    /// `burial_officiant`;
    /// RESIDENCE `address`; OCCUPATION `position`, `employer`; EDUCATION
    /// `institution`, `faculty`, `specialty`, `qualification`; OTHER has none.
    ///
    /// Custom keys come from the user's `config.yaml`
    /// (`event_fields.custom`), so they cannot be listed here. Read the event
    /// before changing it, and keep the existing keys you do not mean to drop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, String>>,
}

impl EventInput {
    /// Builds a new core event with a fresh id and validates it.
    pub fn to_event(&self) -> AppResult<Event> {
        let mut event = Event::new(self.person_id, self.event_type.into());
        event.date = self.date.to_core()?;
        event.place = self.place.clone();
        event.description = self.description.clone();
        event.source_ids = self.source_ids.clone();
        event.details = self.details.clone().unwrap_or_default();
        event.validate()?;
        Ok(event)
    }
}

/// Patch payload for `update_event`. Absent fields keep their current value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventPatch {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub event_type: Option<EventTypeArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<DateInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<Uuid>>,
    /// Type-specific values (ADR-0015). `None` keeps the current map; `Some`
    /// replaces the **whole** map, so `Some({})` clears every detail. Read the
    /// event first and repeat the keys you want to keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, String>>,
}

impl EventPatch {
    /// Applies the patch to a copy and validates the result.
    pub fn apply(&self, event: &Event) -> AppResult<Event> {
        let mut updated = event.clone();
        if let Some(event_type) = self.event_type {
            updated.event_type = event_type.into();
        }
        if let Some(date) = &self.date {
            updated.date = date.to_core()?;
        }
        if let Some(place) = &self.place {
            updated.place = (!place.is_empty()).then(|| place.clone());
        }
        if let Some(description) = &self.description {
            updated.description = (!description.is_empty()).then(|| description.clone());
        }
        if let Some(source_ids) = &self.source_ids {
            updated.source_ids = source_ids.clone();
        }
        if let Some(details) = &self.details {
            // The patch value replaces the whole map; absent keeps it.
            updated.details = details.clone();
        }
        updated.validate()?;
        Ok(updated)
    }
}

/// Limits for the person card sub-collections. Values may only lower the
/// server-side ceiling.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relationships: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citations: Option<u32>,
}

/// Output format of `export_project`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportFormatArg {
    /// `.gentree.zip`: manifest, JSONL data and media.
    #[default]
    GentreeZip,
    /// `.gentree.json`: data without media.
    GentreeJson,
}

/// Input format of `import_project`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ImportFormatArg {
    /// Detect by file extension and content.
    #[default]
    Auto,
    GentreeZip,
    GentreeJson,
    At5,
    Gedcom,
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/// Arguments of `list_projects`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsRequest {
    /// Page size, 1-200 (default 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Offset into the list, 0-1 000 000 (default 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

/// Result of `list_projects`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsResponse {
    pub projects: Vec<Manifest>,
    /// Number of projects before pagination.
    pub total: usize,
}

/// Arguments of `get_project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetProjectRequest {
    pub project_id: Uuid,
}

/// Arguments of `get_tree_overview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetTreeOverviewRequest {
    pub project_id: Uuid,
}

/// Identity of the project in a tree overview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSummary {
    pub id: Uuid,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_person_id: Option<Uuid>,
}

/// Date span of the dated events in a project, without invented bounds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeDateRange {
    pub start: Option<CivilDate>,
    pub end: Option<CivilDate>,
}

/// One person without a parent edge in the project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootPerson {
    pub id: Uuid,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

/// Result of `get_tree_overview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOverview {
    pub tree: TreeSummary,
    pub counts: Counts,
    pub date_range: TreeDateRange,
    /// Root persons, capped at 50; `root_count` is the uncapped total.
    pub roots: Vec<RootPerson>,
    pub root_count: usize,
}

/// Arguments of `search`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub project_id: Uuid,
    /// Search text, 2-100 characters.
    pub query: String,
    /// Entity types to include: `person`, `event`, `source`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<String>>,
    /// Page size, 1-50 (default 20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Opaque cursor from a previous response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// One search hit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// `PERSON`, `EVENT` or `SOURCE`.
    pub entity_type: String,
    pub entity_id: Uuid,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub score: f32,
}

/// Result of `search`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Arguments of `get_person`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetPersonRequest {
    pub project_id: Uuid,
    pub person_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<CardLimits>,
}

/// One person with the records that touch them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonCard {
    pub person: Person,
    pub events: Vec<Event>,
    pub relationships: Vec<gentree_core::Relationship>,
    /// Both ends of `relationships`, so the client never resolves ids itself.
    pub related_persons: Vec<Person>,
    pub media: Vec<gentree_core::Media>,
    pub citations: Vec<gentree_core::Citation>,
    /// True when a sub-collection hit its limit.
    pub truncated: bool,
    /// Optimistic-concurrency token for `update_person`. The model never
    /// sends it; the backend fixes it when the confirmation card is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Arguments of `get_event`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetEventRequest {
    pub project_id: Uuid,
    pub event_id: Uuid,
}

/// One event with its participants, citations and attached files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCard {
    pub event: Event,
    /// Owner first, then co-participants, in the stored order.
    pub participants: Vec<Person>,
    pub citations: Vec<gentree_core::record::Citation>,
    /// Scans and documents attached to the event (ADR-0018).
    #[serde(default)]
    pub media: Vec<gentree_core::Media>,
}

/// Arguments of `list_sources`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListSourcesRequest {
    pub project_id: Uuid,
    /// Page size, 1-200 (default 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Offset into the list, 0-1 000 000 (default 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

/// Result of `list_sources`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSourcesResponse {
    pub items: Vec<Source>,
    /// Number of sources before pagination.
    pub total: usize,
    pub limit: u32,
    pub offset: u32,
}

/// Arguments of `get_source`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetSourceRequest {
    pub project_id: Uuid,
    pub source_id: Uuid,
}

/// One source with every citation that points at it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCard {
    pub source: Source,
    pub citations: Vec<gentree_core::record::Citation>,
}

/// Arguments of `get_ancestors`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetAncestorsRequest {
    pub project_id: Uuid,
    pub person_id: Uuid,
    /// Ancestor levels above the root, 0-3 (default 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generations: Option<u32>,
}

/// Arguments of `get_timeline`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetTimelineRequest {
    pub project_id: Uuid,
    /// Inclusive lower bound, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Exclusive upper bound, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// Restrict to these persons.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_ids: Option<Vec<Uuid>>,
    /// Event types to include.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<String>>,
    /// Include events with an unknown date (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_undated: Option<bool>,
    /// Page size, 1-200 (default 100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Opaque cursor from a previous response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Result of `get_timeline`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResult {
    /// Dated events, ordered by `date.start`.
    pub events: Vec<Event>,
    /// Events without a usable date.
    pub undated: Vec<Event>,
    pub truncated: bool,
}

/// Arguments of `find_path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FindPathRequest {
    pub project_id: Uuid,
    pub from_person_id: Uuid,
    pub to_person_id: Uuid,
}

/// Arguments of `get_kinship`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetKinshipRequest {
    pub project_id: Uuid,
    /// Person the relationship is described from.
    pub from_person_id: Uuid,
    /// Person the relationship points at.
    pub to_person_id: Uuid,
}

/// Arguments of `validate_project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValidateProjectRequest {
    pub project_id: Uuid,
}

/// Arguments of `get_current_date`.
///
/// The tool takes no arguments: it reports the clock of the machine running the
/// app, so it stays independent of the project and of the tree data.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("properties" = {}))]
pub struct GetCurrentDateRequest {}

/// Arguments of `list_backups`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListBackupsRequest {
    pub project_id: Uuid,
}

/// One backup file. The file system path is never exposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Opaque handle accepted by `restore_backup`.
    pub backup_id: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub schema_version: u32,
}

/// Result of `list_backups`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBackupsResponse {
    pub backups: Vec<BackupInfo>,
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

/// Options every write tool carries: `dryRun` and optimistic concurrency.
///
/// Implementations read them through [`WriteOptions::from`] style accessors on
/// each request (`request.options()`), so the rule "dry run never writes,
/// stale version never overwrites" is expressed once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriteOptions {
    /// Validate and report, do not write.
    pub dry_run: bool,
    /// Optimistic-concurrency token; a mismatch is `STALE_WRITE`.
    pub expected_version: Option<String>,
}

macro_rules! write_options {
    ($($request:ty),* $(,)?) => {
        $(
            impl $request {
                /// Write options carried by this request.
                #[must_use]
                pub fn options(&self) -> WriteOptions {
                    WriteOptions {
                        dry_run: self.dry_run,
                        expected_version: self.expected_version.clone(),
                    }
                }
            }
        )*
    };
}

write_options!(
    CreatePersonRequest,
    UpdatePersonRequest,
    DeletePersonRequest,
    CreateEventRequest,
    UpdateEventRequest,
    CreateRelationshipRequest,
    DeleteRelationshipRequest,
    BackupProjectRequest,
    ExportProjectRequest,
    ImportProjectRequest,
    RestoreBackupRequest,
);

/// Result of every write tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    /// True when the call only validated the payload.
    pub dry_run: bool,
    /// True when the validated payload describes a change; always true for a
    /// successful dry run of a mutating call.
    pub would_change: bool,
    /// True when this call actually wrote to the project.
    pub changed: bool,
    /// Affected entity (or new project for `import_project`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<Uuid>,
    /// New optimistic-concurrency token, when the entity has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Domain problems found while validating a dry run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<ValidationIssue>,
}

/// Arguments of `create_person`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePersonRequest {
    pub project_id: Uuid,
    pub person: PersonInput,
    /// Validate without writing (default false).
    #[serde(default)]
    pub dry_run: bool,
    /// Reject the write with `STALE_WRITE` when the project changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `update_person`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePersonRequest {
    pub project_id: Uuid,
    pub person_id: Uuid,
    pub patch: PersonPatch,
    #[serde(default)]
    pub dry_run: bool,
    /// Token from a previous read. Mismatch is `STALE_WRITE`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `delete_person`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeletePersonRequest {
    pub project_id: Uuid,
    pub person_id: Uuid,
    /// Must be `true`; otherwise the call fails with `VALIDATION_ERROR`.
    #[serde(default)]
    pub confirm: bool,
    /// When true, return the removal plan without deleting anything.
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `create_event`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventRequest {
    pub project_id: Uuid,
    pub event: EventInput,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `update_event`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEventRequest {
    pub project_id: Uuid,
    pub event_id: Uuid,
    pub patch: EventPatch,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `create_relationship`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateRelationshipRequest {
    pub project_id: Uuid,
    pub relationship_type: RelationshipKindArg,
    /// For parent edges this is the parent; the other side is the child.
    pub person_id: Uuid,
    pub related_person_id: Uuid,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `delete_relationship`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRelationshipRequest {
    pub project_id: Uuid,
    pub relationship_id: Uuid,
    /// Must be `true`; otherwise the call fails with `VALIDATION_ERROR`.
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `backup_project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackupProjectRequest {
    pub project_id: Uuid,
    /// Validate without writing the archive (default false).
    #[serde(default)]
    pub dry_run: bool,
    /// Unused: a backup does not modify an existing entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Arguments of `export_project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectRequest {
    pub project_id: Uuid,
    #[serde(default)]
    pub format: ExportFormatArg,
    /// Optional directory or file chosen by the user; defaults to the app's
    /// export folder. Never echoed back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    /// Unused: an export does not modify an existing entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Result of `export_project`; contains a file name, never an absolute path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub file_name: String,
    pub bytes: u64,
    pub format: String,
}

/// Arguments of `import_project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectRequest {
    /// Absolute path of the file to import.
    pub source_path: String,
    #[serde(default)]
    pub format: ImportFormatArg,
    /// New project name; defaults to the name found in the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// Parse and validate without creating a project (default false).
    #[serde(default)]
    pub dry_run: bool,
    /// Unused: import creates a new project instead of updating one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Result of `import_project`. No file paths, no field values.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub dry_run: bool,
    /// New project id when the import created one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    pub counts: Counts,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<ValidationIssue>,
}

/// Arguments of `restore_backup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBackupRequest {
    /// Handle from `list_backups`.
    pub backup_id: String,
    /// Must be `true`; otherwise the call fails with `VALIDATION_ERROR`.
    #[serde(default)]
    pub confirm: bool,
    /// When true, verify the archive without restoring anything.
    #[serde(default)]
    pub dry_run: bool,
    /// Unused: restore creates a new copy of the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// Enforces the `confirm: true` requirement of destructive tools.
pub fn require_confirm(confirm: bool) -> AppResult<()> {
    if confirm {
        Ok(())
    } else {
        Err(AppError::validation("confirm", "required"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(given: &str) -> NameInput {
        NameInput {
            given: Some(given.to_owned()),
            surname: Some("Synthetic".to_owned()),
            is_primary: true,
            ..NameInput::default()
        }
    }

    #[test]
    fn person_input_allows_unnamed_persons() {
        let input = PersonInput::default();
        let person = input.to_person().unwrap();
        assert!(person.names.is_empty());
        assert_eq!(person.display_name(), "");

        let input = PersonInput {
            names: vec![name("Ada")],
            ..PersonInput::default()
        };
        let person = input.to_person().unwrap();
        assert_eq!(person.display_name(), "Synthetic Ada");
        assert_eq!(person.gender, Gender::Unknown);
        assert_eq!(person.birth.precision, DatePrecision::Unknown);
    }

    #[test]
    fn date_input_keeps_unknown_dates_honest() {
        let unknown = DateInput::default().to_core().unwrap();
        assert!(unknown.start.is_none() && unknown.end.is_none());
        assert_eq!(unknown.precision, DatePrecision::Unknown);

        let year = DateInput {
            start: Some("1950-01-01".into()),
            end: Some("1951-01-01".into()),
            precision: DatePrecisionArg::Year,
            qualifier: DateQualifierArg::Exact,
            original: Some("1950".into()),
        };
        let value = year.to_core().unwrap();
        assert_eq!(value.start.unwrap().to_iso(), "1950-01-01");
        assert_eq!(value.original.as_deref(), Some("1950"));

        let bad = DateInput {
            start: Some("1950-13-01".into()),
            precision: DatePrecisionArg::Day,
            qualifier: DateQualifierArg::Exact,
            ..DateInput::default()
        };
        assert_eq!(bad.to_core().unwrap_err().code, "VALIDATION_ERROR");
    }

    #[test]
    fn person_patch_keeps_absent_fields() {
        let original = PersonInput {
            names: vec![name("Ada")],
            notes: Some("keep".into()),
            ..PersonInput::default()
        }
        .to_person()
        .unwrap();

        let patched = PersonPatch::default().apply(&original).unwrap();
        assert_eq!(patched, original);

        let cleared = PersonPatch {
            notes: Some(String::new()),
            ..PersonPatch::default()
        }
        .apply(&original)
        .unwrap();
        assert_eq!(cleared.notes, None);
        assert_eq!(cleared.names, original.names);
    }

    #[test]
    fn event_patch_validates_dates() {
        let person_id = Uuid::now_v7();
        let event = EventInput {
            person_id,
            event_type: EventTypeArg::Birth,
            date: DateInput::default(),
            place: None,
            description: None,
            source_ids: Vec::new(),
            details: None,
        }
        .to_event()
        .unwrap();

        let patched = EventPatch {
            place: Some("Synthetic place".into()),
            ..EventPatch::default()
        }
        .apply(&event)
        .unwrap();
        assert_eq!(patched.place.as_deref(), Some("Synthetic place"));

        let bad = EventPatch {
            date: Some(DateInput {
                start: Some("1960-01-01".into()),
                end: Some("1950-01-01".into()),
                precision: DatePrecisionArg::Day,
                qualifier: DateQualifierArg::Range,
                ..DateInput::default()
            }),
            ..EventPatch::default()
        }
        .apply(&event)
        .unwrap_err();
        assert_eq!(
            bad.params.get("rule").map(String::as_str),
            Some("startNotBeforeEnd")
        );
    }

    #[test]
    fn event_details_are_created_replaced_and_cleared() {
        use std::collections::BTreeMap;

        let mut details = BTreeMap::new();
        details.insert("institution".to_owned(), "МГУ".to_owned());
        details.insert("specialty".to_owned(), "История".to_owned());
        let event = EventInput {
            person_id: Uuid::now_v7(),
            event_type: EventTypeArg::Education,
            date: DateInput::default(),
            place: None,
            description: None,
            source_ids: Vec::new(),
            details: Some(details.clone()),
        }
        .to_event()
        .unwrap();
        assert_eq!(event.details, details);

        // An absent patch keeps the current map.
        let kept = EventPatch::default().apply(&event).unwrap();
        assert_eq!(kept.details, details);

        // A present patch replaces the whole map.
        let mut replacement = BTreeMap::new();
        replacement.insert("faculty".to_owned(), "Истфак".to_owned());
        let replaced = EventPatch {
            details: Some(replacement.clone()),
            ..EventPatch::default()
        }
        .apply(&event)
        .unwrap();
        assert_eq!(replaced.details, replacement);

        // An empty map clears the details.
        let cleared = EventPatch {
            details: Some(BTreeMap::new()),
            ..EventPatch::default()
        }
        .apply(&event)
        .unwrap();
        assert!(cleared.details.is_empty());
        let stored = serde_json::to_value(&cleared).unwrap();
        assert!(stored.get("details").is_none());

        // Invalid keys are rejected by the generic domain check.
        let mut bad = BTreeMap::new();
        bad.insert("Not A Key".to_owned(), "x".to_owned());
        let error = EventPatch {
            details: Some(bad),
            ..EventPatch::default()
        }
        .apply(&event)
        .unwrap_err();
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("invalidKey")
        );
    }

    #[test]
    fn confirm_is_mandatory_for_destructive_tools() {
        let error = require_confirm(false).unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("confirm")
        );
        require_confirm(true).unwrap();
    }

    #[test]
    fn current_date_request_accepts_an_empty_object() {
        // The tool advertises no parameters; a model may send `{}` or nothing.
        let request: GetCurrentDateRequest = serde_json::from_str("{}").expect("empty object");
        assert_eq!(request, GetCurrentDateRequest::default());
        assert!(serde_json::from_str::<GetCurrentDateRequest>("null").is_err());
    }

    #[test]
    fn write_requests_expose_their_options() {
        let request = CreatePersonRequest {
            project_id: Uuid::now_v7(),
            person: PersonInput {
                names: vec![name("Ada")],
                ..PersonInput::default()
            },
            dry_run: true,
            expected_version: Some("v1".to_owned()),
        };
        assert_eq!(
            request.options(),
            WriteOptions {
                dry_run: true,
                expected_version: Some("v1".to_owned()),
            }
        );
        let fresh = CreatePersonRequest {
            dry_run: false,
            expected_version: None,
            ..request
        };
        assert!(fresh.options().expected_version.is_none());
        assert!(!fresh.options().dry_run);
    }
}
