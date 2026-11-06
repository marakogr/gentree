//! `event.*` commands: list with filters, create/update/delete with
//! `expectedVersion`. See design.md §4 and §7.

use std::collections::BTreeMap;

use gentree_core::date::CivilDate;
use gentree_core::error::codes;
use gentree_core::record::{CitationTarget, Event, EventType};
use gentree_core::{
    backfill_relations, derive_event_relations, fill_patronymic, retract_event_relations,
    unique_father_given_name, AppError, AppResult, DateValue, Person, PlaceGeo,
    RelationBackfillReport, Relationship,
};
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
        gentree_core::ensure_residence_ranges_do_not_overlap(&events, &entity, None)?;
        let mut persons = store.persons()?;
        let mut relationships = store.relationships()?;
        let original_relationships = relationships.clone();
        derive_event_relations(&entity, &persons, &mut relationships)
            .map_err(map_derivation_error)?;
        let patronymic_changed = fill_birth_patronymic(&mut persons, &relationships, &entity);
        events.push(entity.clone());
        store.save_events(&events)?;
        if relationships != original_relationships {
            store.save_relationships(&relationships)?;
        }
        if patronymic_changed {
            store.save_persons(&persons)?;
        }
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
        gentree_core::ensure_residence_ranges_do_not_overlap(&events, &entity, Some(id))?;
        let mut persons = store.persons()?;
        let mut relationships = store.relationships()?;
        let original_relationships = relationships.clone();
        derive_event_relations(&entity, &persons, &mut relationships)
            .map_err(map_derivation_error)?;
        let patronymic_changed = fill_birth_patronymic(&mut persons, &relationships, &entity);
        events[index] = entity.clone();
        store.save_events(&events)?;
        if relationships != original_relationships {
            store.save_relationships(&relationships)?;
        }
        if patronymic_changed {
            store.save_persons(&persons)?;
        }
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
        let mut relationships = store.relationships()?;
        let original_relationships = relationships.clone();
        retract_event_relations(id, &mut relationships);
        store.save_events(&events)?;
        if relationships != original_relationships {
            store.save_relationships(&relationships)?;
        }
        Ok(())
    })
}

/// Fill the event owner's empty patronymic from a male biological parent that
/// the birth event asserts. Only `BIRTH` is considered; any other event type is
/// a no-op, and an ambiguous or non-Cyrillic father name leaves the field as it
/// was.
fn fill_birth_patronymic(
    persons: &mut [Person],
    relationships: &[Relationship],
    event: &Event,
) -> bool {
    if event.event_type != EventType::Birth {
        return false;
    }
    let Some(index) = persons
        .iter()
        .position(|person| person.id == event.person_id)
    else {
        return false;
    };
    let Some(father_given) = unique_father_given_name(persons, relationships, event.person_id)
    else {
        return false;
    };
    fill_patronymic(&mut persons[index], &father_given)
}

/// Keeps the stable code and points the form at the parent selection.
fn map_derivation_error(error: AppError) -> AppError {
    if error.code == gentree_core::PARENT_CHILD_AGE_GAP || error.code == codes::RELATIONSHIP_CYCLE {
        error.with_param("field", "participantIds")
    } else {
        error
    }
}

/// Reconcile stored events with the relationship collection when a writable
/// project opens. Read-only projects are left byte-identical.
pub(crate) fn backfill_relations_on_open(
    store: &mut ProjectStore,
) -> AppResult<RelationBackfillReport> {
    if !store.is_writable() {
        let mut empty = Vec::new();
        return Ok(backfill_relations(&[], &[], &mut empty, false));
    }
    let events = store.events()?;
    let persons = store.persons()?;
    let mut relationships = store.relationships()?;
    let original = relationships.clone();
    let report = backfill_relations(&events, &persons, &mut relationships, true);
    if relationships != original {
        store.save_relationships(&relationships)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::person::{Name, Person};
    use gentree_core::relationship::{Relationship, RelationshipType};
    use gentree_core::DateValue;

    fn person(birth: DateValue) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some("Test".to_owned()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap();
        person.birth = birth;
        person
    }

    fn marriage(owner: Uuid, partner: Uuid) -> Event {
        let mut event = Event::new(owner, EventType::Marriage);
        event.participant_ids = vec![partner];
        event
    }

    #[test]
    fn backfill_creates_missing_rows_once() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(tmp.path(), "Synthetic").unwrap();
        let a = person(DateValue::exact_year(1970));
        let b = person(DateValue::exact_year(1972));
        let (a_id, b_id) = (a.id, b.id);
        store.save_persons(&[a, b]).unwrap();
        store.save_events(&[marriage(a_id, b_id)]).unwrap();

        let first = backfill_relations_on_open(&mut store).unwrap();
        assert_eq!(first.spouse_created, 1);
        assert_eq!(store.relationships().unwrap().len(), 1);

        let second = backfill_relations_on_open(&mut store).unwrap();
        assert_eq!(second.spouse_created, 0);
        assert_eq!(store.relationships().unwrap().len(), 1);
    }

    #[test]
    fn backfill_leaves_manual_rows_and_read_only_projects_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(tmp.path(), "Synthetic").unwrap();
        let a = person(DateValue::exact_year(1970));
        let b = person(DateValue::exact_year(1972));
        let (a_id, b_id) = (a.id, b.id);
        store.save_persons(&[a, b]).unwrap();
        store.save_events(&[marriage(a_id, b_id)]).unwrap();
        let manual = Relationship::new(RelationshipType::Spouse, a_id, b_id).unwrap();
        store
            .save_relationships(std::slice::from_ref(&manual))
            .unwrap();

        let report = backfill_relations_on_open(&mut store).unwrap();
        assert_eq!(report.spouse_created, 0);
        assert_eq!(store.relationships().unwrap(), vec![manual]);

        let root = store.root().to_path_buf();
        drop(store);
        let before = std::fs::read(root.join(gentree_storage::RELATIONSHIP_FILE)).unwrap();
        let mut read_only = ProjectStore::open(&root, false).unwrap();
        let report = backfill_relations_on_open(&mut read_only).unwrap();
        assert!(report.read_only);
        let after = std::fs::read(root.join(gentree_storage::RELATIONSHIP_FILE)).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn backfill_retries_after_a_failed_write() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(tmp.path(), "Synthetic").unwrap();
        let a = person(DateValue::exact_year(1970));
        let b = person(DateValue::exact_year(1972));
        let (a_id, b_id) = (a.id, b.id);
        store.save_persons(&[a, b]).unwrap();
        store.save_events(&[marriage(a_id, b_id)]).unwrap();
        let root = store.root().to_path_buf();
        drop(store);

        // Open first so the lock exists before the write failure is injected.
        let mut locked = ProjectStore::open(&root, true).unwrap();

        // Unix `rename` replaces a read-only file, so the failure has to come
        // from the project directory instead: atomic writes create their temp
        // file there. Windows still rejects the rename over a read-only file.
        #[cfg(unix)]
        let result = {
            use std::os::unix::fs::PermissionsExt;
            let original = std::fs::metadata(&root).unwrap().permissions();
            let mode = original.mode();
            let mut read_only = original;
            read_only.set_mode(mode & !0o222);
            std::fs::set_permissions(&root, read_only).unwrap();

            let result = backfill_relations_on_open(&mut locked);

            let mut restored = std::fs::metadata(&root).unwrap().permissions();
            restored.set_mode(mode);
            std::fs::set_permissions(&root, restored).unwrap();
            result
        };
        #[cfg(windows)]
        let result = {
            let path = root.join(gentree_storage::RELATIONSHIP_FILE);
            let original = std::fs::metadata(&path).unwrap().permissions();
            let mut read_only = original.clone();
            read_only.set_readonly(true);
            std::fs::set_permissions(&path, read_only).unwrap();

            let result = backfill_relations_on_open(&mut locked);

            std::fs::set_permissions(&path, original).unwrap();
            result
        };

        assert!(result.is_err());
        drop(locked);

        let mut store = ProjectStore::open(&root, true).unwrap();
        let report = backfill_relations_on_open(&mut store).unwrap();
        assert_eq!(report.spouse_created, 1);
        assert_eq!(store.relationships().unwrap().len(), 1);
    }

    #[test]
    fn a_birth_event_fills_an_empty_patronymic_from_its_father() {
        let mut father = person(DateValue::exact_year(1970));
        father.gender = gentree_core::Gender::Male;
        father.names[0].given = Some("Игорь".to_owned());
        let mut child = person(DateValue::exact_year(2000));
        child.gender = gentree_core::Gender::Female;
        let relationship =
            Relationship::new(RelationshipType::ParentChild, father.id, child.id).unwrap();
        let mut event = Event::new(child.id, EventType::Birth);
        event.participant_ids = vec![father.id];

        let mut persons = vec![father, child.clone()];
        assert!(fill_birth_patronymic(
            &mut persons,
            std::slice::from_ref(&relationship),
            &event
        ));
        let stored = persons.iter().find(|person| person.id == child.id).unwrap();
        assert_eq!(stored.names[0].patronymic.as_deref(), Some("Игоревна"));

        // A non-birth event never triggers the fill.
        let mut unfilled = child.clone();
        unfilled.names[0].patronymic = None;
        let mut persons = vec![persons.into_iter().next().unwrap(), unfilled.clone()];
        let death = Event::new(child.id, EventType::Death);
        assert!(!fill_birth_patronymic(
            &mut persons,
            std::slice::from_ref(&relationship),
            &death
        ));
        assert_eq!(
            persons
                .iter()
                .find(|person| person.id == unfilled.id)
                .unwrap()
                .names[0]
                .patronymic,
            None
        );
    }

    #[test]
    fn backfill_derives_birth_parents_from_existing_participants() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(tmp.path(), "Synthetic").unwrap();
        let parent = person(DateValue::exact_year(1970));
        let child = person(DateValue::exact_year(2000));
        let (parent_id, child_id) = (parent.id, child.id);
        store.save_persons(&[parent, child]).unwrap();
        let mut event = Event::new(child_id, EventType::Birth);
        event.participant_ids = vec![parent_id];
        store.save_events(&[event]).unwrap();

        let report = backfill_relations_on_open(&mut store).unwrap();
        assert_eq!(report.parent_created, 1);
        let rows = store.relationships().unwrap();
        assert_eq!(rows[0].person_id, parent_id);
        assert_eq!(rows[0].related_person_id, child_id);
    }
}
