//! `event.*` commands: list with filters, create/update/delete with
//! `expectedVersion`. See design.md §4 and §7.

use std::collections::BTreeMap;

use gentree_core::date::CivilDate;
use gentree_core::error::codes;
use gentree_core::record::{CitationTarget, Event, EventType};
use gentree_core::{AppError, AppResult, DateValue, PlaceGeo};
use gentree_storage::{ProjectStore, EVENT_FILE};
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use super::{
    citations_without, entity_version, parse_date_bound, require_version, versioned, with_store,
    Versioned,
};
use crate::AppState;

/// Create/update payload; `id` is generated on create when absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    #[serde(default)]
    pub id: Option<Uuid>,
    pub person_id: Uuid,
    #[serde(rename = "type")]
    pub event_type: EventType,
    #[serde(default)]
    pub date: DateValue,
    #[serde(default)]
    pub place: Option<String>,
    /// Confirmed map point for `place` (ADR-0020). Omitted or null clears it.
    #[serde(default)]
    pub place_geo: Option<PlaceGeo>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub source_ids: Vec<Uuid>,
    #[serde(default)]
    pub original_type: Option<String>,
    #[serde(default)]
    pub participant_ids: Vec<Uuid>,
    /// Type-specific values (ADR-0015); an absent map means no details.
    #[serde(default)]
    pub details: BTreeMap<String, String>,
}

impl EventInput {
    fn into_event(self) -> Event {
        Event {
            id: self.id.unwrap_or_else(Uuid::now_v7),
            person_id: self.person_id,
            event_type: self.event_type,
            date: self.date,
            place: self.place,
            place_geo: self.place_geo,
            description: self.description,
            source_ids: self.source_ids,
            original_type: self.original_type,
            participant_ids: self.participant_ids,
            details: self.details,
        }
    }

    fn require_id(&self) -> AppResult<Uuid> {
        self.id
            .ok_or_else(|| AppError::validation("id", "required"))
    }
}

fn not_found(id: Uuid) -> AppError {
    AppError::new(codes::NOT_FOUND, "Event not found").with_param("id", id.to_string())
}

fn ensure_person(store: &ProjectStore, person_id: Uuid) -> AppResult<gentree_core::Person> {
    store
        .persons()?
        .into_iter()
        .find(|person| person.id == person_id)
        .ok_or_else(|| AppError::validation("personId", "notFound"))
}

fn ensure_participants(store: &ProjectStore, event: &Event) -> AppResult<()> {
    if event.participant_ids.is_empty() {
        return Ok(());
    }
    let persons = store.persons()?;
    if event
        .participant_ids
        .iter()
        .all(|id| persons.iter().any(|person| person.id == *id))
    {
        Ok(())
    } else {
        Err(AppError::validation("participantIds", "notFound"))
    }
}

/// Half-open date overlap: `[start, end)` intersects the filter range.
pub(crate) fn date_matches(
    value: &DateValue,
    from: Option<CivilDate>,
    to: Option<CivilDate>,
) -> bool {
    let after_from = match from {
        None => true,
        Some(bound) => match (value.start, value.end) {
            (_, Some(end)) => end > bound,
            (Some(start), None) => start >= bound,
            (None, None) => false,
        },
    };
    let before_to = match to {
        None => true,
        Some(bound) => match (value.start, value.end) {
            (Some(start), _) => start < bound,
            (None, Some(end)) => end <= bound,
            (None, None) => false,
        },
    };
    after_from && before_to
}

pub(crate) fn event_order(left: &Event, right: &Event) -> std::cmp::Ordering {
    match (left.date.start, right.date.start) {
        (Some(a), Some(b)) => a.cmp(&b).then_with(|| left.id.cmp(&right.id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.id.cmp(&right.id),
    }
}

#[tauri::command]
pub fn event_list(
    state: State<'_, AppState>,
    person_id: Option<Uuid>,
    r#type: Option<EventType>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<Versioned<Event>>, AppError> {
    let from = parse_date_bound("from", from.as_deref())?;
    let to = parse_date_bound("to", to.as_deref())?;

    with_store(&state, |store| {
        let versions = store.collection_versions(EVENT_FILE)?;
        let mut events: Vec<Event> = store
            .events()?
            .into_iter()
            .filter(|event| {
                person_id.is_none_or(|id| event.involves(id))
                    && r#type.is_none_or(|kind| event.event_type == kind)
                    && date_matches(&event.date, from, to)
            })
            .collect();
        events.sort_by(event_order);
        versioned(events, &versions, |event| event.id)
    })
}

#[tauri::command]
pub fn event_create(
    state: State<'_, AppState>,
    event: EventInput,
) -> Result<Versioned<Event>, AppError> {
    with_store(&state, |store| {
        let entity = event.into_event();
        entity.validate()?;
        let person = ensure_person(store, entity.person_id)?;
        ensure_participants(store, &entity)?;
        let mut events = store.events()?;
        if events.iter().any(|existing| existing.id == entity.id) {
            return Err(AppError::validation("id", "duplicate"));
        }
        gentree_core::ensure_single_life_event(&events, &entity, None)?;
        gentree_core::ensure_life_events_compatible(&events, &entity, None)?;
        gentree_core::ensure_event_within_lifespan(&person, &entity)?;
        events.push(entity.clone());
        store.save_events(&events)?;
        let version = entity_version(store, EVENT_FILE, entity.id)?;
        Ok(Versioned { entity, version })
    })
}

#[tauri::command]
pub fn event_update(
    state: State<'_, AppState>,
    event: EventInput,
    expected_version: String,
) -> Result<Versioned<Event>, AppError> {
    with_store(&state, |store| {
        let id = event.require_id()?;
        let entity = event.into_event();
        entity.validate()?;
        let person = ensure_person(store, entity.person_id)?;
        ensure_participants(store, &entity)?;
        require_version(store, EVENT_FILE, id, &expected_version)?;

        let mut events = store.events()?;
        let index = events
            .iter()
            .position(|existing| existing.id == id)
            .ok_or_else(|| not_found(id))?;
        // Editing an existing birth/death keeps its slot even when old data has
        // duplicates; only a new slot (another id, person or type) is refused.
        let previous = &events[index];
        if previous.person_id != entity.person_id || previous.event_type != entity.event_type {
            gentree_core::ensure_single_life_event(&events, &entity, Some(id))?;
        }
        gentree_core::ensure_life_events_compatible(&events, &entity, Some(id))?;
        gentree_core::ensure_event_within_lifespan(&person, &entity)?;
        events[index] = entity.clone();
        store.save_events(&events)?;
        let version = entity_version(store, EVENT_FILE, id)?;
        Ok(Versioned { entity, version })
    })
}

/// Bulk confirmation of a map point for events with the same typed place
/// (ADR-0020). One project mutation, never one `event_update` per event.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceGeoApplyInput {
    pub event_ids: Vec<Uuid>,
    pub expected_place: String,
    pub point: PlaceGeo,
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub fn event_place_geo_apply(
    state: State<'_, AppState>,
    input: PlaceGeoApplyInput,
) -> Result<gentree_core::ApplyPlaceGeoResult, AppError> {
    with_store(&state, |store| {
        let mut events = store.events()?;
        let result = gentree_core::apply_place_geo(
            &mut events,
            &input.event_ids,
            &input.expected_place,
            &input.point,
            input.overwrite,
        )?;
        if result.applied > 0 {
            store.save_events(&events)?;
        }
        Ok(result)
    })
}

#[tauri::command]
pub fn event_delete(
    state: State<'_, AppState>,
    id: Uuid,
    expected_version: String,
) -> Result<(), AppError> {
    with_store(&state, |store| {
        require_version(store, EVENT_FILE, id, &expected_version)?;

        let events: Vec<Event> = store
            .events()?
            .into_iter()
            .filter(|event| event.id != id)
            .collect();
        let citations = citations_without(store, CitationTarget::Event, id)?;

        // Attachments keep their rows and files but lose the event link, so no
        // row points at a removed event (ADR-0018). Written first: a crash
        // after this step leaves an unlinked row and an existing event, never a
        // dangling reference.
        super::media::unlink_event_media(store, id)?;

        // Citations next: no citation may point at a removed event.
        store.save_citations(&citations)?;
        store.save_events(&events)?;
        Ok(())
    })
}
