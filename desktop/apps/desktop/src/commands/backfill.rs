//! On-open migration for projects created before the current life-event and
//! parent sync. Writable projects only, in this order:
//!
//! 1. create the `BIRTH`/`DEATH` event a person's own date implies;
//! 2. derive missing relations from stored events (the relation backfill);
//! 3. mirror every biological parent relation into the child's birth event.
//!
//! The report carries counts only: never ids, names, dates, places or paths.

use std::collections::HashMap;

use gentree_core::person::Person;
use gentree_core::relationship::RelationshipType;
use gentree_core::{add_parent_to_birth_events, AppResult, RelationBackfillReport};
use gentree_storage::ProjectStore;
use uuid::Uuid;

use super::event::backfill_relations_on_open;
use super::person::create_missing_life_events;

/// Reconciles an opened project with the life events and parent relations it
/// implies. Read-only projects are left byte-identical and report
/// `readOnly = true`. Running it twice on the same project changes nothing.
pub(crate) fn backfill_on_open(store: &mut ProjectStore) -> AppResult<RelationBackfillReport> {
    if !store.is_writable() {
        return Ok(RelationBackfillReport {
            read_only: true,
            ..RelationBackfillReport::default()
        });
    }
    let mut report = RelationBackfillReport {
        life_events_created: create_missing_life_events_in(store)?,
        ..backfill_relations_on_open(store)?
    };
    report.parents_added = fill_birth_parents(store)?;
    Ok(report)
}

/// Step 1: one `BIRTH`/`DEATH` event per known date that has no owned event.
fn create_missing_life_events_in(store: &mut ProjectStore) -> AppResult<usize> {
    let persons = store.persons()?;
    if persons.is_empty() {
        return Ok(0);
    }
    let mut events = store.events()?;
    let created = create_missing_life_events(&mut events, &persons);
    if created > 0 {
        store.save_events(&events)?;
    }
    Ok(created)
}

/// Step 3: add every biological parent to the child's earliest birth event with
/// a free slot. A relation already mirrored, a full birth cast and an unknown
/// person are left alone.
fn fill_birth_parents(store: &mut ProjectStore) -> AppResult<usize> {
    let relationships = store.relationships()?;
    if !relationships
        .iter()
        .any(|row| row.rel_type == RelationshipType::ParentChild)
    {
        return Ok(0);
    }
    let parents: HashMap<Uuid, Person> = store
        .persons()?
        .into_iter()
        .map(|person| (person.id, person))
        .collect();
    let mut events = store.events()?;
    let mut added = 0;
    for row in relationships
        .iter()
        .filter(|row| row.rel_type == RelationshipType::ParentChild)
    {
        let Some(parent) = parents.get(&row.person_id) else {
            continue;
        };
        if add_parent_to_birth_events(&mut events, row.related_person_id, parent) {
            added += 1;
        }
    }
    if added > 0 {
        store.save_events(&events)?;
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::person::{Gender, Name, Person};
    use gentree_core::record::{Event, EventType};
    use gentree_core::relationship::Relationship;
    use gentree_core::DateValue;
    use gentree_storage::{EVENT_FILE, RELATIONSHIP_FILE};

    fn person(given: &str, birth: DateValue, gender: Gender) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some(given.to_owned()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap();
        person.birth = birth;
        person.gender = gender;
        person
    }

    fn synthetic_project() -> (tempfile::TempDir, ProjectStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProjectStore::create(tmp.path(), "Synthetic").unwrap();
        (tmp, store)
    }

    fn birth(date: DateValue, participants: &[Uuid]) -> Event {
        let mut event = Event::new(Uuid::nil(), EventType::Birth);
        event.date = date;
        event.participant_ids = participants.to_vec();
        event
    }

    fn owned_birth(child: Uuid, date: DateValue, participants: &[Uuid]) -> Event {
        let mut event = birth(date, participants);
        event.person_id = child;
        event
    }

    fn parent_edge(parent: Uuid, child: Uuid) -> Relationship {
        Relationship::new(RelationshipType::ParentChild, parent, child).unwrap()
    }

    #[test]
    fn a_known_date_without_an_event_gains_one() {
        let (_tmp, mut store) = synthetic_project();
        let child = person("Child", DateValue::exact_year(1980), Gender::Unknown);
        let mut dead = person("Ancestor", DateValue::exact_year(1900), Gender::Female);
        dead.death = DateValue::exact_year(1970);
        let mut undated = person("Undated", DateValue::default(), Gender::Unknown);
        undated.death = DateValue::default();
        let (child_id, ancestor_id) = (child.id, dead.id);
        store
            .save_persons(&[child.clone(), dead.clone(), undated])
            .unwrap();

        let report = backfill_on_open(&mut store).unwrap();
        assert_eq!(report.life_events_created, 3);
        assert!(!report.read_only);

        let events = store.events().unwrap();
        let birth = events
            .iter()
            .find(|event| event.person_id == child_id && event.event_type == EventType::Birth)
            .expect("birth event");
        assert_eq!(birth.date, child.birth);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.person_id == ancestor_id)
                .count(),
            2
        );

        let second = backfill_on_open(&mut store).unwrap();
        assert_eq!(second.life_events_created, 0);
        assert_eq!(store.events().unwrap().len(), events.len());
    }

    #[test]
    fn an_existing_event_with_another_date_is_not_overwritten() {
        let (_tmp, mut store) = synthetic_project();
        let child = person("Child", DateValue::exact_year(1980), Gender::Unknown);
        let child_id = child.id;
        store.save_persons(std::slice::from_ref(&child)).unwrap();
        store
            .save_events(&[owned_birth(child_id, DateValue::exact_year(1979), &[])])
            .unwrap();

        let report = backfill_on_open(&mut store).unwrap();
        assert_eq!(report.life_events_created, 0);
        let events = store.events().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].date, DateValue::exact_year(1979));
    }

    #[test]
    fn an_existing_parent_relation_fills_the_child_birth_event() {
        let (_tmp, mut store) = synthetic_project();
        let father = person("Father", DateValue::exact_year(1950), Gender::Male);
        let child = person("Child", DateValue::exact_year(1980), Gender::Unknown);
        let (father_id, child_id) = (father.id, child.id);
        store
            .save_persons(&[father.clone(), child.clone()])
            .unwrap();
        store
            .save_relationships(&[parent_edge(father_id, child_id)])
            .unwrap();

        let report = backfill_on_open(&mut store).unwrap();
        assert_eq!(report.life_events_created, 2);
        assert_eq!(report.parents_added, 1);

        let events = store.events().unwrap();
        let birth = events
            .iter()
            .find(|event| event.person_id == child_id && event.event_type == EventType::Birth)
            .unwrap();
        assert_eq!(birth.participant_ids, vec![father_id]);
        assert_eq!(store.relationships().unwrap().len(), 1);

        let second = backfill_on_open(&mut store).unwrap();
        assert_eq!(second.parents_added, 0);
        assert_eq!(second.life_events_created, 0);
        assert_eq!(store.events().unwrap().len(), events.len());
        assert_eq!(store.relationships().unwrap().len(), 1);
    }

    #[test]
    fn fully_occupied_slots_are_left_alone() {
        let (_tmp, mut store) = synthetic_project();
        let father = person("Father", DateValue::exact_year(1950), Gender::Male);
        let child = person("Child", DateValue::exact_year(1980), Gender::Unknown);
        let first = person("First", DateValue::exact_year(1952), Gender::Male);
        let second = person("Second", DateValue::exact_year(1953), Gender::Female);
        let (father_id, child_id, first_id, second_id) = (father.id, child.id, first.id, second.id);
        store
            .save_persons(&[father.clone(), child.clone(), first.clone(), second.clone()])
            .unwrap();
        store
            .save_events(&[owned_birth(
                child_id,
                DateValue::exact_year(1980),
                &[first_id, second_id],
            )])
            .unwrap();
        store
            .save_relationships(&[parent_edge(father_id, child_id)])
            .unwrap();

        let report = backfill_on_open(&mut store).unwrap();
        assert_eq!(report.parents_added, 0);
        let events = store.events().unwrap();
        let birth = events
            .iter()
            .find(|event| event.person_id == child_id && event.event_type == EventType::Birth)
            .unwrap();
        assert_eq!(birth.participant_ids, vec![first_id, second_id]);
        // The two listed participants keep their derived rows and the father
        // keeps the relation that could not be mirrored.
        assert_eq!(store.relationships().unwrap().len(), 3);
    }

    #[test]
    fn a_second_open_is_a_no_op() {
        let (_tmp, mut store) = synthetic_project();
        let father = person("Father", DateValue::exact_year(1950), Gender::Male);
        let mother = person("Mother", DateValue::exact_year(1955), Gender::Female);
        let child = person("Child", DateValue::exact_year(1980), Gender::Unknown);
        let (father_id, mother_id, child_id) = (father.id, mother.id, child.id);
        store
            .save_persons(&[father.clone(), mother.clone(), child.clone()])
            .unwrap();
        store
            .save_relationships(&[
                parent_edge(father_id, child_id),
                parent_edge(mother_id, child_id),
            ])
            .unwrap();

        let first = backfill_on_open(&mut store).unwrap();
        assert_eq!(first.life_events_created, 3);
        assert_eq!(first.parents_added, 2);
        let events = store.events().unwrap();
        let birth = events
            .iter()
            .find(|event| event.person_id == child_id && event.event_type == EventType::Birth)
            .unwrap();
        // Father first, mother second.
        assert_eq!(birth.participant_ids, vec![father_id, mother_id]);

        let second = backfill_on_open(&mut store).unwrap();
        assert_eq!(second.life_events_created, 0);
        assert_eq!(second.parents_added, 0);
        assert_eq!(second.spouse_created, 0);
        assert_eq!(second.parent_created, 0);
        assert_eq!(store.events().unwrap(), events);
        assert_eq!(store.relationships().unwrap().len(), 2);
    }

    #[test]
    fn a_read_only_project_is_byte_identical() {
        let (_tmp, mut store) = synthetic_project();
        let father = person("Father", DateValue::exact_year(1950), Gender::Male);
        let child = person("Child", DateValue::exact_year(1980), Gender::Unknown);
        let (father_id, child_id) = (father.id, child.id);
        store.save_persons(&[father, child]).unwrap();
        store
            .save_relationships(&[parent_edge(father_id, child_id)])
            .unwrap();
        let root = store.root().to_path_buf();
        drop(store);

        let events_before = std::fs::read(root.join(EVENT_FILE)).unwrap();
        let relations_before = std::fs::read(root.join(RELATIONSHIP_FILE)).unwrap();

        let mut read_only = ProjectStore::open(&root, false).unwrap();
        let report = backfill_on_open(&mut read_only).unwrap();
        assert!(report.read_only);
        assert_eq!(report.life_events_created, 0);
        assert_eq!(report.parents_added, 0);
        drop(read_only);

        assert_eq!(std::fs::read(root.join(EVENT_FILE)).unwrap(), events_before);
        assert_eq!(
            std::fs::read(root.join(RELATIONSHIP_FILE)).unwrap(),
            relations_before
        );
    }

    #[test]
    fn the_report_has_counts_only() {
        let report = RelationBackfillReport {
            spouse_created: 1,
            parent_created: 2,
            ambiguous_skipped: 3,
            life_events_created: 4,
            parents_added: 5,
            read_only: false,
        };
        let json = serde_json::to_value(report).unwrap();
        let object = json.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "ambiguousSkipped",
                "lifeEventsCreated",
                "parentCreated",
                "parentsAdded",
                "readOnly",
                "spouseCreated",
            ]
        );
        // No value can carry personal data: every leaf is a count or a flag.
        for value in object.values() {
            assert!(value.is_u64() || value.is_boolean());
        }
    }
}
