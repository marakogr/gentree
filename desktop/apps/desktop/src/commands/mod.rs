//! Tauri commands for persons, events, relationships and the ancestor graph.
//! Contracts: design.md §3, §5, §7, §11; ADR-0014 (codes only, no localized text).

pub mod chat;
pub mod chat_history;
pub mod event;
pub mod export;
pub mod geocode;
pub mod graph;
pub mod import;
pub mod media;
pub mod merge;
pub mod path;
pub mod person;
pub mod relationship;
pub mod search;
pub mod timeline;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use gentree_core::date::CivilDate;
use gentree_core::error::codes;
use gentree_core::person::{Gender, Person};
use gentree_core::record::{Citation, CitationTarget, EventType};
use gentree_core::validation::{
    validate_project as validate_snapshot, ProjectSnapshot, ValidationReport,
};
use gentree_core::{AppError, AppResult};
use gentree_storage::{delete_project, ProjectStore};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::AppState;

/// One entity with its optimistic-concurrency token (`updatedAt`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Versioned<T> {
    pub entity: T,
    pub version: String,
}

/// Paged result: `total` counts the filtered rows, not only the page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: usize,
}

/// Run `action` on the open project or fail with `PROJECT_NOT_FOUND`.
pub(crate) fn with_store<T>(
    state: &State<'_, AppState>,
    action: impl FnOnce(&mut ProjectStore) -> AppResult<T>,
) -> AppResult<T> {
    let mut guard = crate::lock_or(&state.project, "state poisoned")?;
    let store = guard
        .as_mut()
        .ok_or_else(|| AppError::new(codes::PROJECT_NOT_FOUND, "No project is open"))?;
    action(store)
}

/// Current token of one row, read back from its envelope.
pub(crate) fn entity_version(store: &ProjectStore, file: &str, id: Uuid) -> AppResult<String> {
    store
        .collection_versions(file)?
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            AppError::new(codes::NOT_FOUND, "Entity not found").with_param("id", id.to_string())
        })
}

/// `versions[id]` or `PROJECT_CORRUPTED` when the envelope has no `updatedAt`.
pub(crate) fn version_from(versions: &BTreeMap<Uuid, String>, id: Uuid) -> AppResult<String> {
    versions.get(&id).cloned().ok_or_else(|| {
        AppError::new(codes::PROJECT_CORRUPTED, "Envelope has no updatedAt")
            .with_param("id", id.to_string())
    })
}

/// Reject a write whose token no longer matches the stored envelope.
pub(crate) fn require_version(
    store: &ProjectStore,
    file: &str,
    id: Uuid,
    expected: &str,
) -> AppResult<()> {
    store.check_version(file, id, expected)
}

/// Pairs every row with its current envelope token.
pub(crate) fn versioned<T>(
    rows: impl IntoIterator<Item = T>,
    versions: &BTreeMap<Uuid, String>,
    id: impl Fn(&T) -> Uuid,
) -> AppResult<Vec<Versioned<T>>> {
    rows.into_iter()
        .map(|entity| {
            let version = version_from(versions, id(&entity))?;
            Ok(Versioned { entity, version })
        })
        .collect()
}

/// `NOT_FOUND` for a person id; the message and param are part of the IPC and
/// tool error contract, so both sides share this constructor.
pub(crate) fn person_not_found(id: Uuid) -> AppError {
    AppError::new(codes::NOT_FOUND, "Person not found").with_param("id", id.to_string())
}

/// Command and tool arguments arrive as strings; a malformed id is a
/// validation error on the named field.
pub(crate) fn parse_uuid(field: &str, raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw.trim()).map_err(|_| AppError::validation(field, "invalidUuid"))
}

/// Optional `YYYY-MM-DD` bound; a parse failure names the boundary field.
pub(crate) fn parse_date_bound(field: &str, raw: Option<&str>) -> AppResult<Option<CivilDate>> {
    raw.map(CivilDate::parse)
        .transpose()
        .map_err(|error| error.with_param("field", field))
}

/// Citations that do not point at the removed `(target, id)` row. Callers save
/// the result before the owning collection, so no citation dangles.
pub(crate) fn citations_without(
    store: &ProjectStore,
    target_type: CitationTarget,
    id: Uuid,
) -> AppResult<Vec<Citation>> {
    Ok(store
        .citations()?
        .into_iter()
        .filter(|citation| !(citation.target_type == target_type && citation.target_id == id))
        .collect())
}

/// Best-effort cleanup after a failed create: move the folder to `.trash`,
/// never delete files. Shared by import and merge, so a half-written project
/// never becomes reachable through the project list.
pub(crate) fn discard_project(projects_dir: &Path, project_dir: &Path) {
    if project_dir.is_dir() {
        let _ = delete_project(project_dir, &projects_dir.join(".trash"));
    }
}

/// Validates the open project; one implementation for the IPC command and the
/// chat `validate_project` tool.
pub(crate) fn validate_store(store: &ProjectStore) -> AppResult<ValidationReport> {
    let persons = store.persons()?;
    let events = store.events()?;
    let relationships = store.relationships()?;
    let sources = store.sources()?;
    let citations = store.citations()?;
    let media = store.media()?;
    Ok(validate_snapshot(ProjectSnapshot {
        persons: &persons,
        events: &events,
        relationships: &relationships,
        sources: &sources,
        citations: &citations,
        media: &media,
    }))
}

/// Display names by person id, built once per request.
pub(crate) fn display_names(persons: &[Person]) -> HashMap<Uuid, String> {
    persons
        .iter()
        .map(|person| (person.id, person.display_name()))
        .collect()
}

/// Genders by person id; unknown ids read as [`Gender::Unknown`].
pub(crate) fn gender_map(persons: &[Person]) -> BTreeMap<Uuid, Gender> {
    persons
        .iter()
        .map(|person| (person.id, person.gender))
        .collect()
}

/// Locale-free event type table, shared by the IPC commands, the search index
/// and the chat so a new variant is added in one place.
const EVENT_TYPES: [(&str, EventType); 9] = [
    ("birth", EventType::Birth),
    ("death", EventType::Death),
    ("marriage", EventType::Marriage),
    ("divorce", EventType::Divorce),
    ("burial", EventType::Burial),
    ("residence", EventType::Residence),
    ("occupation", EventType::Occupation),
    ("education", EventType::Education),
    ("other", EventType::Other),
];

/// English wire name of an event type.
pub(crate) fn event_type_name(event_type: EventType) -> &'static str {
    EVENT_TYPES
        .iter()
        .find_map(|(name, kind)| (*kind == event_type).then_some(*name))
        .unwrap_or("other")
}

/// Parses a case-insensitive event type name; `None` lets each caller attach
/// the error field and params of its own contract.
pub(crate) fn parse_event_type(raw: &str) -> Option<EventType> {
    let raw = raw.trim();
    EVENT_TYPES
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(raw))
        .map(|(_, kind)| *kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_type_round_trips_through_the_shared_table() {
        for (name, event_type) in EVENT_TYPES {
            assert_eq!(event_type_name(event_type), name);
            assert_eq!(parse_event_type(name), Some(event_type));
            assert_eq!(
                parse_event_type(&name.to_ascii_uppercase()),
                Some(event_type)
            );
        }
        assert_eq!(parse_event_type(" christening "), None);
    }

    #[test]
    fn uuid_parsing_trims_and_names_the_field() {
        let id = Uuid::now_v7();
        assert_eq!(parse_uuid("personId", &format!(" {id} ")).unwrap(), id);
        let error = parse_uuid("personId", "nope").unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("personId")
        );
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("invalidUuid")
        );
    }
}
