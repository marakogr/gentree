//! End-to-end GEDCOM round-trip for type-specific event details (ADR-0015).
//!
//! The source project is deleted after writing the export and then imported
//! again, so the test proves the GEDCOM file alone restores the data. Synthetic
//! data only.

use std::fs;

use gentree_core::date::DateValue;
use gentree_core::person::{Gender, Name, Person, PersonId};
use gentree_core::record::{Event, EventType};
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_import::gedcom;
use gentree_storage::ProjectStore;

fn name(given: &str, surname: &str) -> Name {
    Name {
        given: Some(given.into()),
        surname: Some(surname.into()),
        is_primary: true,
        ..Name::default()
    }
}

fn person(given: &str, surname: &str, gender: Gender) -> Person {
    let mut person = Person::new(vec![name(given, surname)]).unwrap();
    person.gender = gender;
    person
}

fn detail_event(
    person_id: PersonId,
    event_type: EventType,
    year: i32,
    details: &[(&str, &str)],
    description: Option<&str>,
) -> Event {
    let mut event = Event::new(person_id, event_type);
    event.date = DateValue::exact_year(year);
    event.description = description.map(str::to_owned);
    event.details = details
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    event
}

#[test]
fn person_biography_is_never_parsed_as_event_details() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("person-note.ged");
    fs::write(
        &path,
        "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ivan /Petrov/
1 NOTE [gentree:details] {\"hospital\":\"not an event\"}
1 NOTE Synthetic biography
0 TRLR
",
    )
    .unwrap();

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.persons.len(), 1);
    assert!(bundle.events.is_empty(), "{:?}", bundle.events);
    let notes = bundle.persons[0].notes.as_deref().unwrap_or_default();
    assert!(notes.contains("Synthetic biography"), "{notes:?}");
    assert!(notes.contains("[gentree:details]"), "{notes:?}");
}

#[test]
fn export_then_delete_then_import_restores_event_details() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    fs::create_dir_all(&projects).unwrap();

    let mut owner = person("Ivan", "Petrov", Gender::Male);
    owner.birth = DateValue::exact_year(1950);
    owner.death = DateValue::exact_year(2000);
    owner.notes = Some("Synthetic biography of the owner".into());
    let spouse = person("Maria", "Ivanova", Gender::Female);
    let union = Relationship::new(RelationshipType::Spouse, owner.id, spouse.id).unwrap();
    // Long enough to exercise CONC wrapping inside the JSON note; no trailing
    // space, because imported detail values are trimmed.
    let long_institution = "Synthetic long institution ".repeat(12).trim().to_owned();
    let mut events = vec![
        detail_event(
            owner.id,
            EventType::Birth,
            1950,
            &[
                ("hospital", "City hospital"),
                ("birth_certificate", "I-123"),
            ],
            Some("synthetic birth note"),
        ),
        detail_event(
            owner.id,
            EventType::Death,
            2000,
            &[("cause", "Pneumonia"), ("death_certificate", "D-456")],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Marriage,
            1975,
            &[
                ("marriage_rite", "Church rite"),
                ("officiant", "Registry office"),
                ("marriage_certificate", "M-789"),
            ],
            Some("synthetic marriage note"),
        ),
        detail_event(
            owner.id,
            EventType::Divorce,
            1990,
            &[
                ("reason", "Irreconcilable differences"),
                ("court", "City court"),
                ("divorce_certificate", "V-321"),
            ],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Burial,
            2000,
            &[
                ("cemetery", "New cemetery"),
                ("grave", "Plot 7"),
                ("burial_rite", "Quiet rite"),
            ],
            Some("synthetic burial note"),
        ),
        detail_event(
            owner.id,
            EventType::Residence,
            1980,
            &[("address", "12 Main Street")],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Occupation,
            1970,
            &[("position", "Carpenter"), ("employer", "Workshop")],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Education,
            1968,
            &[
                ("qualification", "Higher"),
                // Long enough to exercise CONC wrapping inside the JSON note.
                ("institution", long_institution.as_str()),
                ("faculty", "Physics"),
                ("specialty", "Optics"),
            ],
            None,
        ),
    ];
    // Marriage and divorce belong to the family record, so the exporter needs
    // the spouse as a co-participant.
    for event in &mut events {
        if matches!(event.event_type, EventType::Marriage | EventType::Divorce) {
            event.participant_ids = vec![spouse.id];
        }
    }

    // A real project folder is the source of truth before the export.
    let mut store = ProjectStore::create(&projects, "Synthetic archive").unwrap();
    store
        .save_persons(&[owner.clone(), spouse.clone()])
        .unwrap();
    store
        .save_relationships(std::slice::from_ref(&union))
        .unwrap();
    store.save_events(&events).unwrap();
    let project_dir = store.root().to_path_buf();
    let stored_persons = store.persons().unwrap();
    let stored_relationships = store.relationships().unwrap();
    let stored_events = store.events().unwrap();
    drop(store);

    let ged = dir.path().join("archive.ged");
    gedcom::export_full(
        &stored_persons,
        &stored_relationships,
        &stored_events,
        &[],
        &ged,
    )
    .unwrap();

    // The export is the only surviving copy once the project is gone.
    fs::remove_dir_all(&project_dir).unwrap();
    assert!(!project_dir.exists());

    let bundle = gedcom::parse_bundle(&ged, &[]).unwrap();
    assert_eq!(bundle.persons.len(), 2);
    assert_eq!(bundle.events.len(), events.len(), "{:?}", bundle.events);
    assert_eq!(bundle.relationships.len(), 1);

    let restored_person = bundle
        .persons
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some("Ivan"))
        .expect("the owner must survive the export");
    assert_eq!(restored_person.names[0].surname.as_deref(), Some("Petrov"));
    assert_eq!(restored_person.gender, Gender::Male);
    // The biography is a person note, never an event detail container.
    assert_eq!(
        restored_person.notes.as_deref(),
        Some("Synthetic biography of the owner")
    );
    assert!(
        !restored_person
            .notes
            .as_deref()
            .unwrap_or_default()
            .contains("gentree:details"),
        "{:?}",
        restored_person.notes
    );
    assert!(
        !restored_person
            .notes
            .as_deref()
            .unwrap_or_default()
            .contains("City hospital"),
        "{:?}",
        restored_person.notes
    );
    assert_eq!(
        restored_person.birth.start.map(|date| date.year),
        Some(1950)
    );
    assert_eq!(
        restored_person.death.start.map(|date| date.year),
        Some(2000)
    );
    let restored_spouse = bundle
        .persons
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some("Maria"))
        .expect("the spouse must survive the export");
    assert_eq!(restored_spouse.names[0].surname.as_deref(), Some("Ivanova"));
    assert_eq!(restored_spouse.gender, Gender::Female);

    for expected in &events {
        let actual = bundle
            .events
            .iter()
            .find(|event| event.event_type == expected.event_type)
            .unwrap_or_else(|| panic!("no {:?} event restored", expected.event_type));
        assert_eq!(
            actual.details, expected.details,
            "{:?} details",
            expected.event_type
        );
        assert_eq!(
            actual.description, expected.description,
            "{:?} description",
            expected.event_type
        );
        assert_eq!(
            actual.date.start.map(|date| date.year),
            expected.date.start.map(|date| date.year),
            "{:?} date",
            expected.event_type
        );
        assert!(
            !actual
                .description
                .as_deref()
                .unwrap_or_default()
                .contains("gentree:details"),
            "{:?}",
            actual.description
        );
    }

    // Saving the imported bundle as a fresh project keeps the details intact.
    let restored_dir = dir.path().join("restored");
    fs::create_dir_all(&restored_dir).unwrap();
    let mut restored = ProjectStore::create(&restored_dir, "Restored archive").unwrap();
    restored.save_persons(&bundle.persons).unwrap();
    restored.save_relationships(&bundle.relationships).unwrap();
    restored.save_events(&bundle.events).unwrap();
    let restored_root = restored.root().to_path_buf();
    drop(restored);

    let reopened = ProjectStore::open(&restored_root, false).unwrap();
    let saved_events = reopened.events().unwrap();
    assert_eq!(saved_events.len(), events.len(), "{saved_events:?}");
    for expected in &events {
        let actual = saved_events
            .iter()
            .find(|event| event.event_type == expected.event_type)
            .unwrap_or_else(|| panic!("no {:?} event persisted", expected.event_type));
        assert_eq!(
            actual.details, expected.details,
            "{:?} details after save",
            expected.event_type
        );
        assert_eq!(
            actual.description, expected.description,
            "{:?} description after save",
            expected.event_type
        );
    }
}
