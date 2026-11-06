//! `relationship.*` commands. Rows are validated as a set by storage, so
//! self-links, duplicates, spouse order and parent cycles are rejected there.

use gentree_core::record::CitationTarget;
use gentree_core::relationship::{Relationship, RelationshipSet, RelationshipType};
use gentree_core::{
    add_parent_to_birth_events, fill_patronymic, remove_parent_from_birth_events,
    unique_father_given_name, AppError, AppResult, Person,
};
use gentree_storage::{ProjectStore, RELATIONSHIP_FILE};
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use super::{citations_without, entity_version, require_version, versioned, with_store, Versioned};
use crate::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipInput {
    #[serde(rename = "type")]
    pub rel_type: RelationshipType,
    pub person_id: Uuid,
    pub related_person_id: Uuid,
    #[serde(default)]
    pub notes: Option<String>,
}

fn ensure_persons(store: &mut ProjectStore, a: Uuid, b: Uuid) -> AppResult<(Person, Person)> {
    let persons = store.persons()?;
    let find = |id: Uuid| {
        persons
            .iter()
            .find(|person| person.id == id)
            .cloned()
            .ok_or_else(|| {
                AppError::validation("personId", "notFound").with_param("id", id.to_string())
            })
    };
    Ok((find(a)?, find(b)?))
}

#[tauri::command]
pub fn relationship_list(
    state: State<'_, AppState>,
    person_id: Option<Uuid>,
) -> Result<Vec<Versioned<Relationship>>, AppError> {
    with_store(&state, |store| {
        let versions = store.collection_versions(RELATIONSHIP_FILE)?;
        let mut rows: Vec<Relationship> = store
            .relationships()?
            .into_iter()
            .filter(|row| {
                person_id.is_none_or(|id| row.person_id == id || row.related_person_id == id)
            })
            .collect();
        rows.sort_by(|left, right| {
            left.person_id
                .cmp(&right.person_id)
                .then_with(|| left.related_person_id.cmp(&right.related_person_id))
                .then_with(|| left.id.cmp(&right.id))
        });
        versioned(rows, &versions, |row| row.id)
    })
}

/// Create one relation and mirror a biological parent edge into the child's
/// birth event. The relation is validated before either collection is written;
/// events are written first so a failed relation write is repaired by the next
/// event save (which derives the missing parent row).
pub(crate) fn create_relationship(
    store: &mut ProjectStore,
    relationship: RelationshipInput,
) -> AppResult<Versioned<Relationship>> {
    let (person, related) = ensure_persons(
        store,
        relationship.person_id,
        relationship.related_person_id,
    )?;
    let mut entity = Relationship::new(
        relationship.rel_type,
        relationship.person_id,
        relationship.related_person_id,
    )?;
    // `person_id` is the parent for parent edges and the age rule applies
    // to `PARENT_CHILD` only; the core function skips adoptive edges.
    gentree_core::ensure_parent_child_age_gap(entity.rel_type, &person, &related)?;
    entity.notes = relationship
        .notes
        .map(|notes| notes.trim().to_owned())
        .filter(|notes| !notes.is_empty());

    let mut rows = store.relationships()?;
    rows.push(entity.clone());
    // Validate the resulting set before touching events: a duplicate or a cycle
    // must leave both collections unchanged.
    RelationshipSet::new(rows.clone())?;

    // A biological father with an unambiguous given name fills an empty
    // patronymic. The fill is computed from the future relation set, so a
    // second male biological parent makes the rule ambiguous and leaves the
    // field untouched.
    let mut persons = store.persons()?;
    let mut persons_changed = false;
    if entity.rel_type == RelationshipType::ParentChild {
        if let Some(index) = persons
            .iter()
            .position(|person| person.id == entity.related_person_id)
        {
            let father_given = unique_father_given_name(&persons, &rows, entity.related_person_id);
            if let Some(father_given) = father_given {
                persons_changed = fill_patronymic(&mut persons[index], &father_given);
            }
        }
    }

    // Only a biological parent edge is mirrored. `person_id` is the parent and
    // `related_person_id` the child; adoptive edges never touch a birth event.
    if entity.rel_type == RelationshipType::ParentChild {
        let mut events = store.events()?;
        if add_parent_to_birth_events(&mut events, entity.related_person_id, &person) {
            store.save_events(&events)?;
        }
    }
    store.save_relationships(&rows)?;
    if persons_changed {
        store.save_persons(&persons)?;
    }
    let version = entity_version(store, RELATIONSHIP_FILE, entity.id)?;
    Ok(Versioned { entity, version })
}

/// Delete one relation and remove a biological parent from the child's birth
/// events. Events are written first so a deleted parent cannot be re-derived
/// from a still-present participant by the next event save.
pub(crate) fn delete_relationship(
    store: &mut ProjectStore,
    id: Uuid,
    expected_version: &str,
) -> AppResult<()> {
    require_version(store, RELATIONSHIP_FILE, id, expected_version)?;

    let stored = store.relationships()?;
    let existing = stored.iter().find(|row| row.id == id).cloned();
    let rows: Vec<Relationship> = stored.into_iter().filter(|row| row.id != id).collect();
    let citations = citations_without(store, CitationTarget::Relationship, id)?;

    if let Some(row) = existing.filter(|row| row.rel_type == RelationshipType::ParentChild) {
        let mut events = store.events()?;
        if remove_parent_from_birth_events(&mut events, row.related_person_id, row.person_id) {
            store.save_events(&events)?;
        }
    }

    store.save_citations(&citations)?;
    store.save_relationships(&rows)?;
    Ok(())
}

#[tauri::command]
pub fn relationship_create(
    state: State<'_, AppState>,
    relationship: RelationshipInput,
) -> Result<Versioned<Relationship>, AppError> {
    with_store(&state, |store| create_relationship(store, relationship))
}

#[tauri::command]
pub fn relationship_delete(
    state: State<'_, AppState>,
    id: Uuid,
    expected_version: String,
) -> Result<(), AppError> {
    with_store(&state, |store| {
        delete_relationship(store, id, &expected_version)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::person::{Gender, Name, Person};
    use gentree_core::record::{Event, EventType};
    use gentree_core::{derive_event_relations, DateValue};
    use uuid::Uuid;

    fn person(gender: Gender, birth_year: i32) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some("Synthetic".to_owned()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap();
        person.gender = gender;
        person.birth = DateValue::exact_year(birth_year);
        person
    }

    fn named(gender: Gender, given: &str, birth_year: i32) -> Person {
        let mut person = person(gender, birth_year);
        person.names[0].given = Some(given.to_owned());
        person
    }

    fn stored_person(store: &ProjectStore, id: Uuid) -> Person {
        store
            .persons()
            .unwrap()
            .into_iter()
            .find(|person| person.id == id)
            .unwrap()
    }

    fn birth(child: Uuid, parents: &[Uuid], year: i32) -> Event {
        let mut event = Event::new(child, EventType::Birth);
        event.date = DateValue::exact_year(year);
        event.participant_ids = parents.to_vec();
        event
    }

    fn parent_edge(parent: Uuid, child: Uuid) -> RelationshipInput {
        RelationshipInput {
            rel_type: RelationshipType::ParentChild,
            person_id: parent,
            related_person_id: child,
            notes: None,
        }
    }

    fn version_of(store: &ProjectStore, id: Uuid) -> String {
        store
            .collection_versions(RELATIONSHIP_FILE)
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap()
    }

    fn setup() -> (tempfile::TempDir, ProjectStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProjectStore::create(tmp.path(), "Synthetic").unwrap();
        (tmp, store)
    }

    #[test]
    fn create_mirrors_a_father_then_a_mother_into_the_birth_event() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let mother = person(Gender::Female, 1972);
        let child = person(Gender::Unknown, 2000);
        let (father_id, mother_id, child_id) = (father.id, mother.id, child.id);
        store.save_persons(&[father, mother, child]).unwrap();
        store.save_events(&[birth(child_id, &[], 2000)]).unwrap();

        create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        assert_eq!(store.events().unwrap()[0].participant_ids, vec![father_id]);

        create_relationship(&mut store, parent_edge(mother_id, child_id)).unwrap();
        assert_eq!(
            store.events().unwrap()[0].participant_ids,
            vec![father_id, mother_id]
        );
        assert_eq!(store.relationships().unwrap().len(), 2);

        // Saving the event again derives nothing new: the manual rows already
        // satisfy it, so repeated saves stay stable.
        let events = store.events().unwrap();
        let persons = store.persons().unwrap();
        let mut rows = store.relationships().unwrap();
        derive_event_relations(&events[0], &persons, &mut rows).unwrap();
        derive_event_relations(&events[0], &persons, &mut rows).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn create_fills_an_empty_patronymic_from_a_male_father() {
        let (_tmp, mut store) = setup();
        let father = named(Gender::Male, "Игорь", 1970);
        let son = named(Gender::Male, "Synthetic", 2000);
        let daughter = named(Gender::Female, "Synthetic", 2002);
        let (father_id, son_id, daughter_id) = (father.id, son.id, daughter.id);
        store.save_persons(&[father, son, daughter]).unwrap();

        create_relationship(&mut store, parent_edge(father_id, son_id)).unwrap();
        assert_eq!(
            stored_person(&store, son_id).names[0].patronymic.as_deref(),
            Some("Игоревич")
        );

        create_relationship(&mut store, parent_edge(father_id, daughter_id)).unwrap();
        assert_eq!(
            stored_person(&store, daughter_id).names[0]
                .patronymic
                .as_deref(),
            Some("Игоревна")
        );
    }

    #[test]
    fn create_keeps_a_non_empty_patronymic_and_skips_unknown_cases() {
        let (_tmp, mut store) = setup();
        let father = named(Gender::Male, "Иван", 1970);
        let latin_father = named(Gender::Male, "Ivan", 1968);
        let mut kept = named(Gender::Male, "Synthetic", 2000);
        kept.names[0].patronymic = Some("Своё".to_owned());
        let unknown = named(Gender::Unknown, "Synthetic", 2002);
        let latin = named(Gender::Male, "Synthetic", 2004);
        let (father_id, latin_father_id) = (father.id, latin_father.id);
        let (kept_id, unknown_id, latin_id) = (kept.id, unknown.id, latin.id);
        store
            .save_persons(&[father, latin_father, kept, unknown, latin])
            .unwrap();

        create_relationship(&mut store, parent_edge(father_id, kept_id)).unwrap();
        create_relationship(&mut store, parent_edge(father_id, unknown_id)).unwrap();
        create_relationship(&mut store, parent_edge(latin_father_id, latin_id)).unwrap();

        assert_eq!(
            stored_person(&store, kept_id).names[0]
                .patronymic
                .as_deref(),
            Some("Своё")
        );
        assert_eq!(stored_person(&store, unknown_id).names[0].patronymic, None);
        assert_eq!(stored_person(&store, latin_id).names[0].patronymic, None);
    }

    #[test]
    fn create_gives_an_unknown_gender_parent_the_first_free_slot() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let unknown = person(Gender::Unknown, 1971);
        let child = person(Gender::Unknown, 2000);
        let (father_id, unknown_id, child_id) = (father.id, unknown.id, child.id);
        store.save_persons(&[father, unknown, child]).unwrap();
        store.save_events(&[birth(child_id, &[], 2000)]).unwrap();

        create_relationship(&mut store, parent_edge(unknown_id, child_id)).unwrap();
        assert_eq!(store.events().unwrap()[0].participant_ids, vec![unknown_id]);

        create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        assert_eq!(
            store.events().unwrap()[0].participant_ids,
            vec![father_id, unknown_id]
        );
    }

    #[test]
    fn create_leaves_fully_occupied_slots_untouched_and_still_stores_the_row() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let mother = person(Gender::Female, 1972);
        let other = person(Gender::Male, 1968);
        let child = person(Gender::Unknown, 2000);
        let (father_id, mother_id, other_id, child_id) = (father.id, mother.id, other.id, child.id);
        store.save_persons(&[father, mother, other, child]).unwrap();
        store
            .save_events(&[birth(child_id, &[father_id, mother_id], 2000)])
            .unwrap();

        create_relationship(&mut store, parent_edge(other_id, child_id)).unwrap();
        assert_eq!(
            store.events().unwrap()[0].participant_ids,
            vec![father_id, mother_id]
        );
        assert_eq!(store.relationships().unwrap().len(), 1);
    }

    #[test]
    fn create_does_not_touch_a_birth_event_for_an_adoptive_edge() {
        let (_tmp, mut store) = setup();
        let parent = person(Gender::Male, 1970);
        let child = person(Gender::Unknown, 2000);
        let (parent_id, child_id) = (parent.id, child.id);
        store.save_persons(&[parent, child]).unwrap();
        store.save_events(&[birth(child_id, &[], 2000)]).unwrap();

        create_relationship(
            &mut store,
            RelationshipInput {
                rel_type: RelationshipType::AdoptiveParentChild,
                person_id: parent_id,
                related_person_id: child_id,
                notes: None,
            },
        )
        .unwrap();
        assert!(store.events().unwrap()[0].participant_ids.is_empty());
    }

    #[test]
    fn create_updates_the_earliest_birth_with_a_free_slot() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let mother = person(Gender::Female, 1972);
        let late = person(Gender::Male, 1975);
        let child = person(Gender::Unknown, 2000);
        let (father_id, mother_id, late_id, child_id) = (father.id, mother.id, late.id, child.id);
        store.save_persons(&[father, mother, late, child]).unwrap();
        store
            .save_events(&[
                birth(child_id, &[father_id, mother_id], 1905),
                birth(child_id, &[], 1900),
            ])
            .unwrap();

        create_relationship(&mut store, parent_edge(late_id, child_id)).unwrap();
        let events = store.events().unwrap();
        let early = events
            .iter()
            .find(|event| event.date == DateValue::exact_year(1900))
            .unwrap();
        let late_event = events
            .iter()
            .find(|event| event.date == DateValue::exact_year(1905))
            .unwrap();
        assert_eq!(early.participant_ids, vec![late_id]);
        assert_eq!(late_event.participant_ids, vec![father_id, mother_id]);
    }

    #[test]
    fn create_rejects_a_duplicate_before_touching_the_event() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let child = person(Gender::Unknown, 2000);
        let (father_id, child_id) = (father.id, child.id);
        store.save_persons(&[father, child]).unwrap();
        store.save_events(&[birth(child_id, &[], 2000)]).unwrap();

        create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        let error = create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap_err();
        assert_eq!(error.code, gentree_core::codes::DUPLICATE_RELATIONSHIP);
        assert_eq!(store.events().unwrap()[0].participant_ids, vec![father_id]);
        assert_eq!(store.relationships().unwrap().len(), 1);
    }

    #[test]
    fn delete_removes_the_parent_and_keeps_a_birth_without_parents_valid() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let mother = person(Gender::Female, 1972);
        let child = person(Gender::Unknown, 2000);
        let (father_id, mother_id, child_id) = (father.id, mother.id, child.id);
        store.save_persons(&[father, mother, child]).unwrap();
        store
            .save_events(&[birth(child_id, &[father_id, mother_id], 2000)])
            .unwrap();

        let father_row = create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        let father_version = version_of(&store, father_row.entity.id);
        delete_relationship(&mut store, father_row.entity.id, &father_version).unwrap();
        assert_eq!(store.events().unwrap()[0].participant_ids, vec![mother_id]);
        assert_eq!(store.relationships().unwrap().len(), 0);

        let mother_row = create_relationship(&mut store, parent_edge(mother_id, child_id)).unwrap();
        let mother_version = version_of(&store, mother_row.entity.id);
        delete_relationship(&mut store, mother_row.entity.id, &mother_version).unwrap();
        let events = store.events().unwrap();
        assert!(events[0].participant_ids.is_empty());
        events[0].validate().unwrap();
    }

    #[test]
    fn delete_keeps_the_surviving_parent_in_the_role_their_gender_names() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let mother = person(Gender::Female, 1972);
        let child = person(Gender::Unknown, 2000);
        let (father_id, mother_id, child_id) = (father.id, mother.id, child.id);
        store.save_persons(&[father, mother, child]).unwrap();
        store.save_events(&[birth(child_id, &[], 2000)]).unwrap();
        let father_row = create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        create_relationship(&mut store, parent_edge(mother_id, child_id)).unwrap();

        let version = version_of(&store, father_row.entity.id);
        delete_relationship(&mut store, father_row.entity.id, &version).unwrap();

        // The compact array holds one id. It must be the mother, and she must
        // still be stored and related as a female parent, never as the father.
        let events = store.events().unwrap();
        assert_eq!(events[0].participant_ids, vec![mother_id]);
        assert_eq!(stored_person(&store, mother_id).gender, Gender::Female);
        let rows = store.relationships().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].person_id, mother_id);
        assert_eq!(rows[0].related_person_id, child_id);

        // Symmetrically, deleting the mother keeps the father in his role.
        let mother_row = &rows[0];
        let mother_version = version_of(&store, mother_row.id);
        delete_relationship(&mut store, mother_row.id, &mother_version).unwrap();
        let events = store.events().unwrap();
        assert!(events[0].participant_ids.is_empty());
        assert!(store.relationships().unwrap().is_empty());

        let father_again =
            create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        assert_eq!(store.events().unwrap()[0].participant_ids, vec![father_id]);
        let version = version_of(&store, father_again.entity.id);
        delete_relationship(&mut store, father_again.entity.id, &version).unwrap();
        assert!(store.events().unwrap()[0].participant_ids.is_empty());
        assert_eq!(stored_person(&store, father_id).gender, Gender::Male);
    }

    #[test]
    fn delete_does_not_recreate_the_row_on_the_next_event_save() {
        let (_tmp, mut store) = setup();
        let father = person(Gender::Male, 1970);
        let child = person(Gender::Unknown, 2000);
        let (father_id, child_id) = (father.id, child.id);
        store.save_persons(&[father, child]).unwrap();
        store.save_events(&[birth(child_id, &[], 2000)]).unwrap();

        let row = create_relationship(&mut store, parent_edge(father_id, child_id)).unwrap();
        let version = version_of(&store, row.entity.id);
        delete_relationship(&mut store, row.entity.id, &version).unwrap();

        let events = store.events().unwrap();
        let persons = store.persons().unwrap();
        let mut rows = store.relationships().unwrap();
        derive_event_relations(&events[0], &persons, &mut rows).unwrap();
        assert!(rows.is_empty());
    }
}
