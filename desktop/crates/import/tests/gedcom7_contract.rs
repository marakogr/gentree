//! GEDCOM 7.0 contract tests. Synthetic data only, per ADR-0019.
//!
//! The fixtures are hand-written, not produced by a genealogy application, and
//! contain no real people. They pin the 7.0 header, the absence of `CONC` and
//! `CHAR`, `CONT` round-tripping, UTF-8, version autodetection, round-tripping,
//! and the report of structures the domain cannot hold.

use std::fs;
use std::path::{Path, PathBuf};

use gentree_core::date::{CivilDate, DateValue};
use gentree_core::person::{ExternalId, Gender, Name, Person};
use gentree_core::record::{Citation, CitationTarget, Confidence, Event, EventType, Media, Source};
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_import::gedcom::{self, ExportMedia, GedcomVersion};
use uuid::Uuid;

const FIXTURE_551: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Synthetic/
0 TRLR
";

const FIXTURE_70: &str = "\
0 HEAD
1 GEDC
2 VERS 7.0.18
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Synthetic/
0 TRLR
";

fn write_text(dir: &Path, file: &str, contents: &str) -> PathBuf {
    let path = dir.join(file);
    fs::write(&path, contents.as_bytes()).unwrap();
    path
}

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

#[test]
fn detects_the_declared_version_and_ignores_head_sour_vers() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_text(dir.path(), "v551.ged", FIXTURE_551);
    assert_eq!(
        gedcom::detect_version(&path).unwrap(),
        GedcomVersion::V5_5_1
    );

    let path = write_text(dir.path(), "v7.ged", FIXTURE_70);
    assert_eq!(gedcom::detect_version(&path).unwrap(), GedcomVersion::V7_0);

    // The application version sits at the same level under HEAD.SOUR and must
    // never be mistaken for the specification version.
    let header = "\
0 HEAD
1 SOUR GENTREE
2 VERS 9.9.9
1 GEDC
2 VERS 7.0.18
0 TRLR
";
    let path = write_text(dir.path(), "sour-vers.ged", header);
    assert_eq!(gedcom::detect_version(&path).unwrap(), GedcomVersion::V7_0);
}

#[test]
fn export_70_writes_the_7_header_without_conc_or_char() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = person("Иван", "Петров", Gender::Male);
    // Longer than the 5.5.1 line limit; 7.0 must keep it on one line.
    owner.notes = Some("Заметка ".repeat(80).trim().to_owned());

    let path = dir.path().join("family.ged");
    let report = gedcom::export_versioned(
        std::slice::from_ref(&owner),
        &[],
        &[],
        &[],
        &[],
        &[],
        GedcomVersion::V7_0,
        &path,
    )
    .unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let text = fs::read_to_string(&path).unwrap();
    assert!(text.starts_with("0 HEAD\r\n"), "{text}");
    assert!(text.contains("1 GEDC\r\n2 VERS 7.0.18\r\n"), "{text}");
    // 7.0 removed HEAD.CHAR: UTF-8 is mandatory and no encoding is declared.
    assert!(!text.contains("1 CHAR"), "{text}");
    assert!(!text.contains("LINEAGE-LINKED"), "{text}");
    // 7.0 removed CONC; long values are never wrapped.
    assert!(!text.contains("CONC"), "{text}");
    assert!(text.contains("1 NAME Иван /Петров/\r\n"), "{text}");
    let note_line = text
        .lines()
        .find(|line| line.starts_with("1 NOTE "))
        .expect("note line");
    assert!(
        note_line.len() > 200,
        "7.0 must not wrap: {}",
        note_line.len()
    );

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.version, GedcomVersion::V7_0);
    assert_eq!(bundle.persons.len(), 1);
    assert_eq!(bundle.persons[0].notes, owner.notes);
}

#[test]
fn export_70_preserves_multiline_notes_with_cont() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = person("Ivan", "Petrov", Gender::Male);
    // 7.0 kept CONT for embedded newlines, including blank ones.
    owner.notes = Some("First line\n\nThird line".to_owned());

    let path = dir.path().join("family.ged");
    let report = gedcom::export_versioned(
        std::slice::from_ref(&owner),
        &[],
        &[],
        &[],
        &[],
        &[],
        GedcomVersion::V7_0,
        &path,
    )
    .unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("1 NOTE First line\r\n2 CONT\r\n2 CONT Third line\r\n"),
        "{text}"
    );

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.persons[0].notes, owner.notes);
}

#[test]
fn export_70_keeps_people_events_relationships_media_sources_and_citations() {
    let dir = tempfile::tempdir().unwrap();
    let mut father = person("Ivan", "Petrov", Gender::Male);
    father.birth = DateValue::exact_day(CivilDate::new(1950, 5, 9).unwrap());
    let mut mother = person("Maria", "Ivanova", Gender::Female);
    mother.birth = DateValue::exact_year(1952);
    let child = person("Petr", "Petrov", Gender::Male);

    let spouse = Relationship::new(RelationshipType::Spouse, father.id, mother.id).unwrap();
    let father_child =
        Relationship::new(RelationshipType::ParentChild, father.id, child.id).unwrap();
    let mother_child =
        Relationship::new(RelationshipType::ParentChild, mother.id, child.id).unwrap();

    let mut birth = Event::new(father.id, EventType::Birth);
    birth.date = DateValue::exact_day(CivilDate::new(1950, 5, 9).unwrap());
    birth.place = Some("Synthetic City".into());
    birth
        .details
        .insert("hospital".into(), "City hospital".into());
    let mut marriage = Event::new(father.id, EventType::Marriage);
    marriage.date = DateValue::exact_year(1974);
    marriage.participant_ids = vec![mother.id];

    let source_id = Uuid::now_v7();
    let mut citation = Citation::new(source_id, CitationTarget::Person, father.id);
    citation.page = Some("p. 12".into());
    citation.confidence = Some(Confidence::High);
    let mut event_citation = Citation::new(source_id, CitationTarget::Event, birth.id);
    event_citation.page = Some("entry 3".into());
    let source = Source {
        id: source_id,
        title: "Synthetic register".into(),
        author: Some("Synthetic archive".into()),
        publication: Some("Synthetic press".into()),
        repository: None,
        url: Some("https://example.invalid/source".into()),
        notes: Some("Synthetic note".into()),
    };

    let media_dir = dir.path().join("family.files");
    fs::create_dir_all(&media_dir).unwrap();
    fs::write(media_dir.join("scan.jpg"), b"synthetic-jpeg-bytes").unwrap();
    let media = Media {
        id: Uuid::now_v7(),
        file_name: "scan.jpg".into(),
        mime_type: "image/jpeg".into(),
        checksum: "a".repeat(64),
        caption: Some("Synthetic portrait".into()),
        source_id: None,
        person_id: Some(father.id),
        event_id: None,
        primary: false,
    };
    let export_media = ExportMedia {
        media: &media,
        file_name: "scan.jpg",
    };

    let path = dir.path().join("family.ged");
    let report = gedcom::export_versioned(
        &[father.clone(), mother.clone(), child.clone()],
        &[spouse, father_child, mother_child],
        &[birth, marriage],
        &[export_media],
        &[source],
        &[citation, event_citation],
        GedcomVersion::V7_0,
        &path,
    )
    .unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let text = fs::read_to_string(&path).unwrap();
    // 7.0 media are records linked by pointer, not inline OBJE.FILE.
    assert!(
        text.contains("0 @M1@ OBJE\r\n1 FILE scan.jpg\r\n2 FORM image/jpeg\r\n"),
        "{text}"
    );
    assert!(text.contains("2 TITL Synthetic portrait\r\n"), "{text}");
    assert!(text.contains("1 OBJE @M1@\r\n"), "{text}");
    assert!(
        text.contains("0 @S1@ SOUR\r\n1 TITL Synthetic register\r\n"),
        "{text}"
    );
    assert!(text.contains("1 AUTH Synthetic archive\r\n"), "{text}");
    assert!(text.contains("1 PUBL Synthetic press\r\n"), "{text}");
    assert!(
        text.contains("1 WWW https://example.invalid/source\r\n"),
        "{text}"
    );
    assert!(text.contains("1 SOUR @S1@\r\n"), "{text}");
    assert!(text.contains("2 PAGE p. 12\r\n"), "{text}");
    assert!(text.contains("2 QUAY 3\r\n"), "{text}");
    assert!(text.contains("3 PAGE entry 3\r\n"), "{text}");

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.version, GedcomVersion::V7_0);
    assert_eq!(bundle.persons.len(), 3);
    assert_eq!(bundle.relationships.len(), 3);
    assert_eq!(
        bundle.events.len(),
        3,
        "{:?}",
        bundle
            .events
            .iter()
            .map(|event| event.event_type)
            .collect::<Vec<_>>()
    );
    assert_eq!(bundle.media.len(), 1);
    assert_eq!(bundle.media[0].mime_type, "image/jpeg");
    assert_eq!(
        bundle.media[0].caption.as_deref(),
        Some("Synthetic portrait")
    );

    let father = bundle
        .persons
        .iter()
        .find(|person| person.names[0].surname.as_deref() == Some("Petrov"))
        .unwrap();
    assert_eq!(father.birth.start.unwrap().to_iso(), "1950-05-09");
    let birth = bundle
        .events
        .iter()
        .find(|event| event.event_type == EventType::Birth)
        .unwrap();
    assert_eq!(birth.place.as_deref(), Some("Synthetic City"));
    assert_eq!(
        birth.details.get("hospital").map(String::as_str),
        Some("City hospital")
    );

    // Sources and citations are not imported yet; the reader reports them by
    // tag instead of dropping them silently.
    assert!(
        bundle
            .report
            .warnings
            .iter()
            .any(|warning| warning.contains("SOUR")),
        "{:?}",
        bundle.report.warnings
    );
}

#[test]
fn import_70_maps_exid_and_reports_structures_without_a_domain_field() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 7.0.18
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Synthetic/
1 SEX F
1 BIRT
2 DATE 1 JAN 2000
3 TIME 10:00
3 PHRASE around the new year
2 SDATE 2000
1 FAMC @F1@
2 PEDI ADOPTED
1 EXID external-42
1 _CUSTOM synthetic value
1 NO MARR
0 @I2@ INDI
1 NAME Boris /Synthetic/
1 SNOTE @N1@
0 @N1@ SNOTE shared text
0 @F1@ FAM
1 CHIL @I1@
0 TRLR
";
    let path = write_text(dir.path(), "v7.ged", source);
    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();

    assert_eq!(bundle.version, GedcomVersion::V7_0);
    assert_eq!(bundle.persons.len(), 2);
    let anna = &bundle.persons[0];
    assert_eq!(anna.gender, Gender::Female);
    assert_eq!(anna.birth.start.unwrap().to_iso(), "2000-01-01");
    assert_eq!(
        anna.external_ids,
        vec![ExternalId {
            source: "GEDCOM".into(),
            value: "external-42".into(),
        }]
    );
    let boris = &bundle.persons[1];
    assert_eq!(boris.notes.as_deref(), Some("shared text"));

    let warnings = &bundle.report.warnings;
    assert!(
        warnings.iter().any(|warning| warning.contains("INDI.NO")),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|warning| warning.contains("_CUSTOM")),
        "{warnings:?}"
    );
    for tag in ["SDATE", "DATE.TIME", "DATE.PHRASE", "FAMC.PEDI"] {
        assert!(
            warnings.iter().any(|warning| warning.contains(tag)),
            "{tag} missing: {warnings:?}"
        );
    }
    assert!(
        warnings
            .iter()
            .all(|warning| !warning.contains("imported with 5.5.1 rules")),
        "{warnings:?}"
    );
    // A report must stay loggable: no values from the file.
    for warning in warnings {
        assert!(!warning.contains("synthetic value"), "{warning}");
        assert!(!warning.contains("external-42"), "{warning}");
    }
}

#[test]
fn import_70_reads_media_records_and_missing_media_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 7.0.18
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Synthetic/
1 OBJE @M1@
0 @M1@ OBJE
1 FILE scan.jpg
2 FORM image/jpeg
2 TITL Synthetic portrait
0 TRLR
";
    let path = write_text(dir.path(), "v7.ged", source);
    let media_dir = dir.path().join("v7.files");
    fs::create_dir_all(&media_dir).unwrap();
    fs::write(media_dir.join("scan.jpg"), b"synthetic-jpeg-bytes").unwrap();

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.media.len(), 1);
    assert_eq!(bundle.media_files.len(), 1);
    assert_eq!(bundle.media[0].file_name, "scan.jpg");
    assert_eq!(
        bundle.media[0].caption.as_deref(),
        Some("Synthetic portrait")
    );
    assert_eq!(bundle.media[0].person_id, Some(bundle.persons[0].id));

    fs::remove_file(media_dir.join("scan.jpg")).unwrap();
    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert!(bundle.media.is_empty());
    assert!(
        bundle
            .report
            .issues
            .iter()
            .any(|issue| issue.contains("media file")),
        "{:?}",
        bundle.report.issues
    );
}

#[test]
fn export_70_escapes_a_leading_at_and_round_trips_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = person("Ivan", "Petrov", Gender::Male);
    owner.notes = Some("@I1@ and me@example.invalid".into());
    let path = dir.path().join("family.ged");
    gedcom::export_versioned(
        std::slice::from_ref(&owner),
        &[],
        &[],
        &[],
        &[],
        &[],
        GedcomVersion::V7_0,
        &path,
    )
    .unwrap();

    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("1 NOTE @@I1@ and me@example.invalid\r\n"),
        "{text}"
    );
    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.persons[0].notes, owner.notes);
}

#[test]
fn export_70_preserves_blank_lines_in_a_note_with_cont() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = person("Ivan", "Petrov", Gender::Male);
    owner.notes = Some("first line\n\nsecond line".into());
    let path = dir.path().join("family.ged");
    let report = gedcom::export_versioned(
        std::slice::from_ref(&owner),
        &[],
        &[],
        &[],
        &[],
        &[],
        GedcomVersion::V7_0,
        &path,
    )
    .unwrap();

    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("1 NOTE first line\r\n2 CONT\r\n2 CONT second line\r\n"),
        "{text}"
    );
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    // 7.0 kept CONT, so the blank line survives the round-trip.
    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(
        bundle.persons[0].notes.as_deref(),
        Some("first line\n\nsecond line")
    );
}

#[test]
fn export_551_is_unchanged_by_the_version_selector() {
    let dir = tempfile::tempdir().unwrap();
    let owner = person("Ivan", "Petrov", Gender::Male);
    let path = dir.path().join("family.ged");
    gedcom::export(std::slice::from_ref(&owner), &[], &path).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("2 VERS 5.5.1\r\n2 FORM LINEAGE-LINKED\r\n"),
        "{text}"
    );
    assert!(text.contains("1 CHAR UTF-8\r\n"), "{text}");
}
