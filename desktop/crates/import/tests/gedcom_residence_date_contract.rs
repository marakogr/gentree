//! A residence period that is still ongoing must survive a GEDCOM round-trip.
//!
//! GEDCOM has no "until now" marker, so the open period is written as a start
//! only (`FROM <date>`) and read back as a `RANGE` with no end. The source
//! project is deleted after writing the export, so the test proves the GEDCOM
//! file alone restores the date. Synthetic data only, per ADR-0013.

use std::fs;

use gentree_core::date::{CivilDate, DatePrecision, DateQualifier, DateValue};
use gentree_core::person::{Gender, Name, Person, PersonId};
use gentree_core::record::{Event, EventType};
use gentree_import::gedcom::{self, GedcomVersion};
use gentree_storage::ProjectStore;

fn person(given: &str, surname: &str) -> Person {
    let mut person = Person::new(vec![Name {
        given: Some(given.into()),
        surname: Some(surname.into()),
        is_primary: true,
        ..Name::default()
    }])
    .unwrap();
    person.gender = Gender::Male;
    person
}

/// `RANGE` with a start and no end: the person lives there since 1990.
fn open_residence(person_id: PersonId) -> Event {
    let mut event = Event::new(person_id, EventType::Residence);
    event.date = DateValue {
        start: Some(CivilDate::new(1990, 1, 1).unwrap()),
        end: None,
        precision: DatePrecision::Year,
        qualifier: DateQualifier::Range,
        original: None,
    };
    event.details = [("address".to_owned(), "12 Main Street".to_owned())]
        .into_iter()
        .collect();
    event
}

#[test]
fn an_ongoing_residence_period_round_trips_in_5_5_1_and_7_0() {
    for version in [GedcomVersion::V5_5_1, GedcomVersion::V7_0] {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        fs::create_dir_all(&projects).unwrap();

        let owner = person("Ivan", "Petrov");
        let residence = open_residence(owner.id);

        let mut store = ProjectStore::create(&projects, "Synthetic archive").unwrap();
        store.save_persons(std::slice::from_ref(&owner)).unwrap();
        store.save_events(std::slice::from_ref(&residence)).unwrap();
        let project_dir = store.root().to_path_buf();
        let stored_persons = store.persons().unwrap();
        let stored_events = store.events().unwrap();
        drop(store);

        let ged = dir.path().join("archive.ged");
        let report = gedcom::export_versioned(
            &stored_persons,
            &[],
            &stored_events,
            &[],
            &[],
            &[],
            version,
            &ged,
        )
        .unwrap();

        let text = fs::read_to_string(&ged).unwrap();
        assert!(
            text.contains("2 DATE FROM 1990"),
            "{version:?} export lost the open period:\n{text}"
        );
        assert!(
            !text.contains("BET"),
            "{version:?} invented a closed period:\n{text}"
        );
        assert!(
            !report
                .warnings
                .iter()
                .any(|warning| warning.contains("no GEDCOM representation")),
            "{version:?} reported a representable date as lost: {:?}",
            report.warnings
        );

        // The export is the only surviving copy once the project is gone.
        fs::remove_dir_all(&project_dir).unwrap();
        assert!(!project_dir.exists());

        let bundle = gedcom::parse_bundle(&ged, &[]).unwrap();
        assert_eq!(bundle.events.len(), 1, "{:?}", bundle.events);
        let restored = &bundle.events[0];
        assert_eq!(restored.event_type, EventType::Residence);
        assert_eq!(
            restored.date,
            DateValue {
                start: Some(CivilDate::new(1990, 1, 1).unwrap()),
                end: None,
                precision: DatePrecision::Year,
                qualifier: DateQualifier::Range,
                original: Some("FROM 1990".to_owned()),
            },
            "{version:?} restored date"
        );
        assert_eq!(
            restored.details.get("address").map(String::as_str),
            Some("12 Main Street")
        );
    }
}
