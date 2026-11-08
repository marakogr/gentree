//! GEDCOM round-trip for event place coordinates (issue #148).
//!
//! `PLAC.MAP.LATI`/`LONG` must survive an export to GEDCOM 5.5.1 and 7.0 and a
//! fresh import, for person events, family events and `RESI`/`EDUC` attributes.
//! A place text without coordinates and coordinates without a place text are
//! covered too. Synthetic data only.

use std::fs;
use std::path::Path;

use gentree_core::date::DateValue;
use gentree_core::geo::{PlaceGeo, PlacePrecision, PlaceSource};
use gentree_core::person::{Gender, Name, Person, PersonId};
use gentree_core::record::{Event, EventType};
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_import::gedcom::{self, GedcomBundle, GedcomVersion};

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

fn point(lat: f64, lon: f64) -> PlaceGeo {
    PlaceGeo {
        lat,
        lon,
        precision: PlacePrecision::Settlement,
        source: PlaceSource::Manual,
        provider_ref: Some("manual:fixture".to_owned()),
        label: Some("Provider label at selection time".to_owned()),
    }
}

fn event(person_id: PersonId, event_type: EventType, year: i32) -> Event {
    let mut event = Event::new(person_id, event_type);
    event.date = DateValue::exact_year(year);
    event
}

fn export(version: GedcomVersion, path: &Path) -> (String, GedcomBundle) {
    let owner = person("Ivan", "Petrov", Gender::Male);
    let spouse = person("Maria", "Ivanova", Gender::Female);
    let union = Relationship::new(RelationshipType::Spouse, owner.id, spouse.id).unwrap();

    // Person event with text and coordinates.
    let mut birth = event(owner.id, EventType::Birth, 1950);
    birth.place = Some("Synthetic City".to_owned());
    birth.place_geo = Some(point(57.4321, 49.1234));
    // Person event with text only: nothing may be invented for it.
    let mut death = event(owner.id, EventType::Death, 2000);
    death.place = Some("Synthetic Town".to_owned());
    // A `RESI` attribute on the equator and the prime meridian.
    let mut residence = event(owner.id, EventType::Residence, 1980);
    residence.place = Some("12 Main Street".to_owned());
    residence.place_geo = Some(point(0.0, 0.0));
    // An `EDUC` attribute with coordinates but no place text: the export keeps
    // `PLAC` without a value and never invents a name.
    let mut education = event(owner.id, EventType::Education, 1968);
    education.place_geo = Some(point(-33.8688, 151.2093));
    // A family event: the marriage belongs to the `FAM` record.
    let mut marriage = event(owner.id, EventType::Marriage, 1975);
    marriage.place = Some("Synthetic Village".to_owned());
    marriage.place_geo = Some(point(48.8566, 2.3522));
    marriage.participant_ids = vec![spouse.id];

    let events = vec![birth, death, residence, education, marriage];
    let report = gedcom::export_versioned(
        &[owner, spouse],
        std::slice::from_ref(&union),
        &events,
        &[],
        &[],
        &[],
        version,
        path,
    )
    .expect("export");
    assert_eq!(report.warnings, Vec::<String>::new());
    let text = fs::read_to_string(path).expect("read the export");
    let bundle = gedcom::parse_bundle(path, &[]).expect("import");
    (text, bundle)
}

fn restored_event(bundle: &GedcomBundle, event_type: EventType) -> &Event {
    bundle
        .events
        .iter()
        .find(|event| event.event_type == event_type)
        .unwrap_or_else(|| panic!("no {event_type:?} event restored"))
}

fn assert_restored_with_text(
    bundle: &GedcomBundle,
    event_type: EventType,
    place: &str,
    lat: f64,
    lon: f64,
) {
    let event = restored_event(bundle, event_type);
    assert_eq!(event.place.as_deref(), Some(place), "{event_type:?} place");
    let geo = event
        .place_geo
        .as_ref()
        .unwrap_or_else(|| panic!("{event_type:?} lost its coordinates"));
    assert_eq!(geo.lat, lat, "{event_type:?} latitude");
    assert_eq!(geo.lon, lon, "{event_type:?} longitude");
    assert_eq!(geo.source, PlaceSource::Gedcom, "{event_type:?} source");
    assert_eq!(
        geo.precision,
        PlacePrecision::Unknown,
        "{event_type:?} precision: GEDCOM states none"
    );
    assert_eq!(geo.label.as_deref(), Some(place), "{event_type:?} label");
    assert_eq!(geo.provider_ref, None, "{event_type:?} provider ref");
}

fn assert_round_trip(version: GedcomVersion) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archive.ged");
    let (text, bundle) = export(version, &path);

    assert_eq!(bundle.version, version);
    assert_eq!(bundle.events.len(), 5, "{:?}", bundle.events);

    assert_restored_with_text(
        &bundle,
        EventType::Birth,
        "Synthetic City",
        57.4321,
        49.1234,
    );
    // Text without coordinates stays text only.
    let death = restored_event(&bundle, EventType::Death);
    assert_eq!(death.place.as_deref(), Some("Synthetic Town"));
    assert_eq!(death.place_geo, None, "no coordinates were invented");
    assert_restored_with_text(&bundle, EventType::Residence, "12 Main Street", 0.0, 0.0);
    assert_restored_with_text(
        &bundle,
        EventType::Marriage,
        "Synthetic Village",
        48.8566,
        2.3522,
    );

    // Coordinates without a place text keep `PLAC` unvalued and get no label.
    let education = restored_event(&bundle, EventType::Education);
    assert_eq!(education.place, None);
    let geo = education
        .place_geo
        .as_ref()
        .expect("the attribute must keep its coordinates");
    assert_eq!((geo.lat, geo.lon), (-33.8688, 151.2093));
    assert_eq!(geo.source, PlaceSource::Gedcom);
    assert_eq!(geo.precision, PlacePrecision::Unknown);
    assert_eq!(geo.label, None);

    // Both versions accept hemisphere-prefixed decimal degrees, so the same
    // bytes prove the documented form for each.
    let normalized = text.replace("\r\n", "\n");
    assert!(
        normalized.contains("2 PLAC Synthetic City\n3 MAP\n4 LATI N57.4321\n4 LONG E49.1234\n"),
        "{normalized}"
    );
    assert!(
        normalized.contains("2 PLAC 12 Main Street\n3 MAP\n4 LATI N0.0\n4 LONG E0.0\n"),
        "{normalized}"
    );
    assert!(
        normalized.contains("2 PLAC\n3 MAP\n4 LATI S33.8688\n4 LONG E151.2093\n"),
        "a point without place text still writes PLAC:\n{normalized}"
    );
    assert!(
        !normalized.contains("Synthetic Town\n3 MAP"),
        "text without coordinates must not gain a MAP:\n{normalized}"
    );
    assert_eq!(
        normalized.matches("3 MAP").count(),
        4,
        "one MAP per point:\n{normalized}"
    );
}

#[test]
fn coordinates_round_trip_through_gedcom_5_5_1() {
    assert_round_trip(GedcomVersion::V5_5_1);
}

#[test]
fn coordinates_round_trip_through_gedcom_7_0() {
    assert_round_trip(GedcomVersion::V7_0);
}

#[test]
fn invalid_coordinates_are_not_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("invalid.ged");
    let owner = person("Ivan", "Petrov", Gender::Male);
    let mut birth = event(owner.id, EventType::Birth, 1950);
    birth.place = Some("Synthetic City".to_owned());
    let mut broken = point(1.0, 1.0);
    broken.lat = 91.0;
    birth.place_geo = Some(broken);

    let report = gedcom::export_versioned(
        std::slice::from_ref(&owner),
        &[],
        std::slice::from_ref(&birth),
        &[],
        &[],
        &[],
        GedcomVersion::V5_5_1,
        &path,
    )
    .expect("export");

    assert!(
        report
            .warnings
            .contains(&"event place coordinates are invalid; omitted from the export".to_owned()),
        "{:?}",
        report.warnings
    );
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("2 PLAC Synthetic City"), "{text}");
    assert!(!text.contains("MAP"), "{text}");

    // The omitted point must not survive as a made-up coordinate.
    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(restored_event(&bundle, EventType::Birth).place_geo, None);
}

#[test]
fn incomplete_and_out_of_range_coordinates_are_reported_without_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.ged");
    fs::write(
        &path,
        "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Synthetic /Person/
1 BIRT
2 DATE 1900
2 PLAC Synthetic incomplete
3 MAP
4 LATI N57.4321
1 RESI
2 DATE 1980
2 PLAC Synthetic out of range
3 MAP
4 LATI N100.5
4 LONG E200.5
0 TRLR
",
    )
    .unwrap();

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.events.len(), 2, "{:?}", bundle.events);
    for event in &bundle.events {
        assert_eq!(event.place_geo, None, "{:?}", event.event_type);
    }

    let warnings = &bundle.report.warnings;
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("without a readable LATI and LONG")),
        "{warnings:?}"
    );
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("coordinates are out of range")),
        "{warnings:?}"
    );
    // A report is safe to log: it names the structure, never the values.
    for warning in warnings {
        assert!(!warning.contains("57.4321"), "{warning}");
        assert!(!warning.contains("100.5"), "{warning}");
        assert!(!warning.contains("200.5"), "{warning}");
    }
}
