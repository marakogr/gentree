//! GEDCOM events, places, notes and media contract tests.
//!
//! Synthetic data only: the GEDCOM bytes and the media files are built here,
//! per ADR-0013.

use std::fs;
use std::path::{Path, PathBuf};

use gentree_core::date::{DatePrecision, DateQualifier};
use gentree_core::person::PersonId;
use gentree_core::record::{Event, EventType};
use gentree_import::gedcom::{self, GedcomBundle};

const EVENTS_FIXTURE: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 SEX M
1 BIRT
2 DATE 15 MAY 1950
2 PLAC Москва, Россия
2 ADDR Городская больница
2 NOTE родился дома
1 DEAT
2 DATE ABT 2000
2 CAUS Пневмония
1 BURI
2 DATE 2000
2 ADDR Новое кладбище
1 RESI
2 DATE 1990
2 ADDR Ленинград
1 OCCU Плотник
1 EDUC 5 классов
0 @I2@ INDI
1 NAME Мария /Иванова/
1 SEX F
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 07 MAR 1972
2 PLAC Москва
2 TYPE Церковный обряд
2 AGNC ЗАГС
1 DIV
2 DATE 1980
2 CAUS Развод
2 AGNC Суд
0 TRLR
";

const MEDIA_FIXTURE: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 OBJE
2 FILE photos/scan.jpg
2 FORM jpg
2 TITL Семейный снимок
1 OBJE
2 FILE photos/scan.jpg
0 @F1@ FAM
1 OBJE
2 FILE photos/scan.jpg
0 @M1@ OBJE
1 FILE documents/doc.pdf
1 TITL Документ
0 TRLR
";

const PERSON_MEDIA_FIXTURE: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ivan /Petrov/
1 OBJE
2 FILE photos/one.jpg
0 @I2@ INDI
1 NAME Maria /Ivanova/
1 OBJE
2 FILE photos/two.jpg
0 @M1@ OBJE
1 FILE documents/shared.pdf
0 TRLR
";

fn write_text(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, contents).unwrap();
    path
}

fn write_bytes(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

fn parse(path: &Path, extra: &[PathBuf]) -> GedcomBundle {
    gedcom::parse_bundle(path, extra).unwrap()
}

fn event(bundle: &GedcomBundle, event_type: EventType) -> &Event {
    bundle
        .events
        .iter()
        .find(|event| event.event_type == event_type)
        .unwrap_or_else(|| panic!("no {event_type:?} event in {:?}", bundle.events))
}

fn given_name(bundle: &GedcomBundle, given: &str) -> PersonId {
    bundle
        .persons
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some(given))
        .unwrap()
        .id
}

#[test]
fn maps_individual_and_family_events() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_text(dir.path(), "events.ged", EVENTS_FIXTURE);
    let bundle = parse(&path, &[]);

    assert_eq!(bundle.persons.len(), 2);
    assert_eq!(bundle.persons.len(), bundle.report.persons);
    assert_eq!(bundle.relationships.len(), 1);
    assert_eq!(bundle.relationships.len(), bundle.report.relationships);
    assert_eq!(bundle.events.len(), 8, "{:?}", bundle.events);

    let ivan = given_name(&bundle, "Иван");
    let birth = event(&bundle, EventType::Birth);
    assert_eq!(birth.person_id, ivan);
    assert_eq!(birth.place.as_deref(), Some("Москва, Россия"));
    assert_eq!(birth.date.precision, DatePrecision::Day);
    assert_eq!(birth.date.start.unwrap().to_iso(), "1950-05-15");
    assert_eq!(birth.description.as_deref(), Some("родился дома"));
    assert_eq!(
        birth.details.get("hospital").map(String::as_str),
        Some("Городская больница")
    );
    assert_eq!(birth.original_type, None);
    assert!(birth.source_ids.is_empty());

    let death = event(&bundle, EventType::Death);
    assert_eq!(death.person_id, ivan);
    assert_eq!(death.date.qualifier, DateQualifier::Approximate);
    assert_eq!(death.date.start.unwrap().to_iso(), "2000-01-01");
    assert_eq!(
        death.details.get("cause").map(String::as_str),
        Some("Пневмония")
    );
    assert_eq!(death.description, None);

    let burial = event(&bundle, EventType::Burial);
    assert_eq!(burial.person_id, ivan);
    assert_eq!(
        burial.details.get("cemetery").map(String::as_str),
        Some("Новое кладбище")
    );

    let residence = event(&bundle, EventType::Residence);
    assert_eq!(residence.person_id, ivan);
    assert_eq!(
        residence.details.get("address").map(String::as_str),
        Some("Ленинград")
    );
    assert_eq!(residence.description, None);

    // OCCU/EDUC: the tag value becomes a detail, not a duplicate description.
    let occupation = event(&bundle, EventType::Occupation);
    assert_eq!(occupation.person_id, ivan);
    assert_eq!(
        occupation.details.get("position").map(String::as_str),
        Some("Плотник")
    );
    assert_eq!(occupation.description, None);

    let education = event(&bundle, EventType::Education);
    assert_eq!(education.person_id, ivan);
    assert_eq!(
        education.details.get("qualification").map(String::as_str),
        Some("5 классов")
    );
    assert_eq!(education.description, None);

    // A family event is attached to the husband, and the lost participant is
    // reported once without repeating any value.
    let marriage = event(&bundle, EventType::Marriage);
    assert_eq!(marriage.person_id, ivan);
    assert_eq!(marriage.place.as_deref(), Some("Москва"));
    assert_eq!(marriage.date.precision, DatePrecision::Day);
    assert_eq!(marriage.date.start.unwrap().to_iso(), "1972-03-07");
    assert_eq!(
        marriage.details.get("marriage_rite").map(String::as_str),
        Some("Церковный обряд")
    );
    assert_eq!(
        marriage.details.get("officiant").map(String::as_str),
        Some("ЗАГС")
    );
    // MARRIAGE.TYPE is the rite, so it must not leak into the description.
    assert_eq!(marriage.description, None);

    let divorce = event(&bundle, EventType::Divorce);
    assert_eq!(divorce.person_id, ivan);
    assert_eq!(divorce.date.start.unwrap().to_iso(), "1980-01-01");
    assert_eq!(
        divorce.details.get("reason").map(String::as_str),
        Some("Развод")
    );
    assert_eq!(
        divorce.details.get("court").map(String::as_str),
        Some("Суд")
    );
    assert_eq!(divorce.description, None);

    let participant_warnings = bundle
        .report
        .warnings
        .iter()
        .filter(|warning| warning.contains("participant"))
        .count();
    assert_eq!(participant_warnings, 1, "{:?}", bundle.report.warnings);
    for warning in &bundle.report.warnings {
        assert!(!warning.contains("Плотник"), "{warning}");
        assert!(!warning.contains("Москва"), "{warning}");
    }
}

#[test]
fn details_note_merges_and_stays_out_of_description() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 BIRT
2 DATE 1950
2 ADDR Из тега
2 NOTE [gentree:details] {\"birth_certificate\":\"I-123\",\"hospital\":\"Из заметки\"}
2 NOTE обычная заметка
0 TRLR
";
    let path = write_text(dir.path(), "details.ged", source);
    let bundle = parse(&path, &[]);

    let birth = event(&bundle, EventType::Birth);
    // An explicit Gentree note wins over the standard tag.
    assert_eq!(
        birth.details.get("hospital").map(String::as_str),
        Some("Из заметки")
    );
    assert_eq!(
        birth.details.get("birth_certificate").map(String::as_str),
        Some("I-123")
    );
    assert_eq!(birth.description.as_deref(), Some("обычная заметка"));
    assert!(
        !birth
            .description
            .as_deref()
            .unwrap_or_default()
            .contains("gentree:details"),
        "{:?}",
        birth.description
    );
    assert!(
        bundle
            .report
            .warnings
            .iter()
            .all(|warning| !warning.contains("details note")),
        "{:?}",
        bundle.report.warnings
    );
}

#[test]
fn malformed_details_note_stays_visible_as_description() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 DEAT
2 DATE 2000
2 NOTE [gentree:details] {\"cause\": 5}
2 NOTE обычная заметка
0 TRLR
";
    let path = write_text(dir.path(), "bad-details.ged", source);
    let bundle = parse(&path, &[]);

    let death = event(&bundle, EventType::Death);
    assert!(death.details.is_empty(), "{:?}", death.details);
    let description = death.description.as_deref().unwrap_or_default();
    // A wrong shape is not dropped: the line stays visible next to the notes.
    assert!(description.contains("[gentree:details] {\"cause\": 5}"));
    assert!(description.contains("обычная заметка"));
    assert!(
        bundle
            .report
            .warnings
            .iter()
            .any(|warning| warning.contains("details note") && warning.contains("not valid")),
        "{:?}",
        bundle.report.warnings
    );
    // The report never repeats values, so it stays safe to log.
    for warning in &bundle.report.warnings {
        assert!(!warning.contains("\"cause\""), "{warning}");
        assert!(!warning.contains("обычная"), "{warning}");
    }
}

#[test]
fn finds_media_in_files_folder_and_extra_dir() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_text(dir.path(), "ged.ged", MEDIA_FIXTURE);
    write_bytes(
        &dir.path().join("ged.ged.files").join("photos/scan.jpg"),
        b"jpeg-bytes",
    );
    let extra = dir.path().join("extra");
    write_bytes(&extra.join("doc.pdf"), b"%PDF-1.4 synthetic");

    let bundle = parse(&path, std::slice::from_ref(&extra));

    assert_eq!(bundle.media.len(), 2, "{:?}", bundle.media);
    let scan = bundle
        .media
        .iter()
        .find(|media| media.file_name == "scan.jpg")
        .unwrap();
    assert_eq!(scan.mime_type, "image/jpeg");
    assert_eq!(
        scan.checksum,
        "0111dbc398b94eacda6759809c050530868ee7e313b3381c2f95ce8b55331c50"
    );
    assert_eq!(scan.caption.as_deref(), Some("Семейный снимок"));
    assert_eq!(scan.source_id, None);

    let document = bundle
        .media
        .iter()
        .find(|media| media.file_name == "doc.pdf")
        .unwrap();
    assert_eq!(document.mime_type, "application/pdf");
    assert_eq!(
        document.checksum,
        "105156e58646c5274f4f7420d8cd21020fc3cca3eeffb8453fbd3b5859675a7c"
    );
    assert_eq!(document.caption.as_deref(), Some("Документ"));

    // The same file referenced three times (INDI twice, FAM once) is one entry.
    assert_eq!(
        bundle
            .media
            .iter()
            .filter(|media| media.file_name == "scan.jpg")
            .count(),
        1
    );
    assert!(
        bundle.report.issues.is_empty(),
        "{:?}",
        bundle.report.issues
    );
}

#[test]
fn individual_media_links_to_the_person() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_text(dir.path(), "ged.ged", PERSON_MEDIA_FIXTURE);
    let files = dir.path().join("ged.ged.files");
    write_bytes(&files.join("photos/one.jpg"), b"first-photo");
    write_bytes(&files.join("photos/two.jpg"), b"second-photo");
    write_bytes(&files.join("documents/shared.pdf"), b"%PDF-1.4 shared");

    let bundle = parse(&path, &[]);
    assert_eq!(bundle.media.len(), 3, "{:?}", bundle.media);

    let ivan = given_name(&bundle, "Ivan");
    let maria = given_name(&bundle, "Maria");
    let media = |name: &str| {
        bundle
            .media
            .iter()
            .find(|media| media.file_name == name)
            .unwrap_or_else(|| panic!("media {name} not imported"))
    };

    assert_eq!(media("one.jpg").person_id, Some(ivan));
    assert_eq!(media("two.jpg").person_id, Some(maria));
    // A top-level OBJE nobody references belongs to no person.
    assert_eq!(media("shared.pdf").person_id, None);
}

#[test]
fn missing_media_is_reported_without_failing() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_text(dir.path(), "ged.ged", MEDIA_FIXTURE);

    let bundle = parse(&path, &[]);

    assert_eq!(bundle.persons.len(), 1);
    assert!(bundle.media.is_empty(), "{:?}", bundle.media);
    assert!(
        bundle
            .report
            .issues
            .iter()
            .any(|issue| issue.contains("were not found")),
        "{:?}",
        bundle.report.issues
    );
    for issue in &bundle.report.issues {
        assert!(!issue.contains("scan.jpg"), "{issue}");
        assert!(!issue.contains("doc.pdf"), "{issue}");
    }
}

#[test]
fn refuses_path_traversal_and_absolute_paths() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 OBJE
2 FILE ../outside.jpg
1 OBJE
2 FILE C:\\photos\\outside.jpg
0 TRLR
";
    let path = write_text(dir.path(), "ged.ged", source);
    // The file exists next to the media folder, so a broken check would find it.
    write_bytes(&dir.path().join("outside.jpg"), b"photo-bytes");
    fs::create_dir_all(dir.path().join("ged.ged.files")).unwrap();

    let bundle = parse(&path, &[]);

    assert_eq!(bundle.persons.len(), 1);
    assert!(bundle.media.is_empty(), "{:?}", bundle.media);
    assert!(
        bundle
            .report
            .issues
            .iter()
            .any(|issue| issue.contains("were refused")),
        "{:?}",
        bundle.report.issues
    );
    for issue in &bundle.report.issues {
        assert!(!issue.contains("outside.jpg"), "{issue}");
        assert!(!issue.contains("C:\\"), "{issue}");
    }
}

#[test]
fn unknown_event_tag_becomes_other_with_original_type() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 CENS
2 DATE 1900
1 CENS
2 DATE 1910
1 CHR
2 DATE 01 JAN 1950
0 TRLR
";
    let path = write_text(dir.path(), "other.ged", source);
    let bundle = parse(&path, &[]);

    assert_eq!(bundle.events.len(), 3, "{:?}", bundle.events);
    assert!(
        bundle
            .events
            .iter()
            .all(|event| event.event_type == EventType::Other),
        "{:?}",
        bundle.events
    );
    assert_eq!(
        bundle
            .events
            .iter()
            .filter(|event| event.original_type.as_deref() == Some("CENS"))
            .count(),
        2
    );
    assert!(bundle
        .events
        .iter()
        .any(|event| event.original_type.as_deref() == Some("CHR")));
    // One warning per tag, not per record.
    assert_eq!(
        bundle
            .report
            .warnings
            .iter()
            .filter(|warning| warning.contains("CENS"))
            .count(),
        1,
        "{:?}",
        bundle.report.warnings
    );
    assert_eq!(
        bundle
            .report
            .warnings
            .iter()
            .filter(|warning| warning.contains("CHR"))
            .count(),
        1,
        "{:?}",
        bundle.report.warnings
    );
}

#[test]
fn parse_wrapper_still_returns_persons_and_relationships() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_text(dir.path(), "legacy.ged", EVENTS_FIXTURE);

    let (persons, relationships, report) = gedcom::parse(&path).unwrap();
    assert_eq!(persons.len(), 2);
    assert_eq!(relationships.len(), 1);
    assert_eq!(report.persons, 2);
    assert_eq!(report.relationships, 1);

    // The bundle is the same read path; only the person ids differ per run.
    let bundle = parse(&path, &[]);
    assert_eq!(bundle.persons.len(), persons.len());
    assert_eq!(bundle.relationships.len(), relationships.len());
    assert_eq!(bundle.report.warnings, report.warnings);
    assert_eq!(bundle.report.issues, report.issues);
}
