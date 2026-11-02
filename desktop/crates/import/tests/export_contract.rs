//! AT5/GEDCOM archive export contract tests. Synthetic data only.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use gentree_core::date::{CivilDate, DateValue};
use gentree_core::person::{Gender, Name, NameType, Person};
use gentree_core::record::{Citation, CitationTarget, Confidence, Event, EventType, Media, Source};
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_import::gedcom::parse_bundle;
use gentree_import::{export_archive, read_at5_bundle, ExportFormat};
use gentree_storage::{store_media_file, ProjectStore};
use uuid::Uuid;

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

struct Sample {
    root: PathBuf,
    media_checksum: String,
}

/// Three people, a marriage, two parent links, three events and one photo.
fn sample_project(dir: &Path) -> Sample {
    let projects = dir.join("projects");
    let mut store = ProjectStore::create(&projects, "Family").unwrap();
    let root = store.root().to_path_buf();

    let mut father = person("Ivan", "Petrov", Gender::Male);
    father.birth = DateValue::exact_day(CivilDate::new(1950, 5, 9).unwrap());
    father.notes = Some("Synthetic biography".into());

    let mut mother = person("Maria", "Ivanova", Gender::Female);
    mother.birth = DateValue::exact_year(1952);
    mother.names.push(Name {
        surname: Some("Sidorova".into()),
        name_type: NameType::Married,
        ..Name::default()
    });

    let mut child = person("Petr", "Petrov", Gender::Male);
    child.birth = DateValue::exact_day(CivilDate::new(1975, 3, 1).unwrap());

    let father_id = father.id;
    let mother_id = mother.id;

    let father_child =
        Relationship::new(RelationshipType::ParentChild, father_id, child.id).unwrap();
    let mother_child =
        Relationship::new(RelationshipType::ParentChild, mother_id, child.id).unwrap();
    let spouse = Relationship::new(RelationshipType::Spouse, father_id, mother_id).unwrap();

    let mut marriage = Event::new(father_id, EventType::Marriage);
    marriage.date = DateValue::exact_day(CivilDate::new(1974, 6, 15).unwrap());
    marriage.place = Some("Synthetic City".into());
    marriage.participant_ids = vec![mother_id];

    let mut occupation = Event::new(child.id, EventType::Occupation);
    occupation.date = DateValue::exact_year(1995);
    occupation.description = Some("Synthetic employer".into());

    store
        .save_persons(&[father.clone(), mother.clone(), child.clone()])
        .unwrap();
    store
        .save_relationships(&[father_child, mother_child, spouse])
        .unwrap();
    store.save_events(&[marriage, occupation]).unwrap();

    let source = root.join("scan.jpg");
    fs::write(&source, b"synthetic-jpeg-bytes").unwrap();
    let (relative, checksum) = store_media_file(&root, &source).unwrap();
    let file_name = relative.rsplit('/').next().unwrap().to_owned();
    store
        .save_media(&[Media {
            id: Uuid::now_v7(),
            file_name,
            mime_type: "image/jpeg".into(),
            checksum: checksum.clone(),
            caption: Some("Synthetic portrait".into()),
            source_id: None,
            person_id: Some(father_id),
            event_id: None,
            primary: false,
        }])
        .unwrap();
    drop(store);

    Sample {
        root,
        media_checksum: checksum,
    }
}

fn entries(archive: &Path) -> HashSet<String> {
    let mut zip = zip::ZipArchive::new(File::open(archive).unwrap()).unwrap();
    (0..zip.len())
        .map(|index| zip.by_index(index).unwrap().name().to_owned())
        .collect()
}

fn extract(archive: &Path, target: &Path) {
    let mut zip = zip::ZipArchive::new(File::open(archive).unwrap()).unwrap();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).unwrap();
        let path = target.join(entry.name());
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut out = File::create(path).unwrap();
        io::copy(&mut entry, &mut out).unwrap();
    }
}

fn person_by_surname<'a>(persons: &'a [Person], surname: &str) -> &'a Person {
    persons
        .iter()
        .find(|person| {
            person
                .names
                .iter()
                .any(|name| name.surname.as_deref() == Some(surname))
        })
        .unwrap_or_else(|| panic!("person with surname {surname} not found"))
}

fn person_by_given<'a>(persons: &'a [Person], given: &str) -> &'a Person {
    persons
        .iter()
        .find(|person| {
            person
                .names
                .iter()
                .any(|name| name.given.as_deref() == Some(given))
        })
        .unwrap_or_else(|| panic!("person with given name {given} not found"))
}

#[test]
fn at5_archive_round_trips_data_and_media() {
    let dir = tempfile::tempdir().unwrap();
    let sample = sample_project(dir.path());
    let archive = dir.path().join("family.zip");

    let report = export_archive(&sample.root, ExportFormat::At5, &archive).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("places, descriptions")),
        "{:?}",
        report.warnings
    );

    let names = entries(&archive);
    assert!(names.contains("family.at5"), "{names:?}");
    assert!(names.contains("family.files/scan.jpg"), "{names:?}");
    assert_eq!(names.len(), 2, "{names:?}");

    let out = dir.path().join("out");
    extract(&archive, &out);
    let bundle = read_at5_bundle(&out.join("family.at5")).unwrap();

    assert_eq!(bundle.persons.len(), 3);
    assert_eq!(bundle.relationships.len(), 3);
    assert_eq!(bundle.events.len(), 5);
    assert_eq!(bundle.media.len(), 1);

    let father = person_by_surname(&bundle.persons, "Petrov");
    assert_eq!(father.gender, Gender::Male);
    assert_eq!(
        father.birth.precision,
        gentree_core::date::DatePrecision::Day
    );
    assert_eq!(father.birth.start.unwrap().to_iso(), "1950-05-09");
    assert_eq!(father.notes.as_deref(), Some("Synthetic biography"));

    let mother = person_by_surname(&bundle.persons, "Ivanova");
    assert!(mother
        .names
        .iter()
        .any(|name| name.surname.as_deref() == Some("Sidorova")
            && name.name_type == NameType::Married));

    let child = person_by_given(&bundle.persons, "Petr");
    let parents = bundle
        .relationships
        .iter()
        .filter(|row| row.rel_type == RelationshipType::ParentChild)
        .filter(|row| row.related_person_id == child.id)
        .count();
    assert_eq!(parents, 2);

    let spouse = bundle
        .relationships
        .iter()
        .find(|row| row.rel_type == RelationshipType::Spouse)
        .expect("spouse edge");
    assert_ne!(spouse.person_id, spouse.related_person_id);

    let media = &bundle.media[0];
    assert_eq!(media.file_name, "scan.jpg");
    assert_eq!(media.checksum, sample.media_checksum);
    assert_eq!(media.person_id, Some(father.id));
    assert!(bundle.media_files[0].source.is_some());
}

#[test]
fn gedcom_archive_round_trips_data_and_media() {
    let dir = tempfile::tempdir().unwrap();
    let sample = sample_project(dir.path());
    let archive = dir.path().join("family.zip");

    let report = export_archive(&sample.root, ExportFormat::Gedcom, &archive).unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let names = entries(&archive);
    assert!(names.contains("family.ged"), "{names:?}");
    assert!(names.contains("family.files/scan.jpg"), "{names:?}");
    assert_eq!(names.len(), 2, "{names:?}");

    let out = dir.path().join("out");
    extract(&archive, &out);
    let bundle = parse_bundle(&out.join("family.ged"), &[]).unwrap();

    assert_eq!(bundle.persons.len(), 3);
    assert_eq!(bundle.relationships.len(), 3);
    assert_eq!(bundle.events.len(), 5);
    assert_eq!(bundle.media.len(), 1);

    let father = person_by_surname(&bundle.persons, "Petrov");
    assert_eq!(father.birth.start.unwrap().to_iso(), "1950-05-09");
    assert_eq!(father.notes.as_deref(), Some("Synthetic biography"));

    let mother = person_by_surname(&bundle.persons, "Ivanova");
    assert!(mother
        .names
        .iter()
        .any(|name| name.surname.as_deref() == Some("Sidorova")));

    let marriage = bundle
        .events
        .iter()
        .find(|event| event.event_type == EventType::Marriage)
        .expect("marriage event");
    assert_eq!(marriage.place.as_deref(), Some("Synthetic City"));
    assert_eq!(marriage.participant_ids.len(), 1);

    let media = &bundle.media[0];
    assert_eq!(media.file_name, "scan.jpg");
    assert_eq!(media.checksum, sample.media_checksum);
    assert_eq!(media.person_id, Some(father.id));
    assert_eq!(media.caption.as_deref(), Some("Synthetic portrait"));
}

#[test]
fn gedcom7_archive_writes_sources_and_citations_without_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut store = ProjectStore::create(&projects, "Sources").unwrap();
    let mut owner = person("Ivan", "Petrov", Gender::Male);
    owner.birth = DateValue::exact_year(1950);
    store.save_persons(std::slice::from_ref(&owner)).unwrap();

    let source = Source::new("Synthetic register").unwrap();
    let mut citation = Citation::new(source.id, CitationTarget::Person, owner.id);
    citation.page = Some("p. 7".into());
    citation.confidence = Some(Confidence::High);
    let mut event = Event::new(owner.id, EventType::Occupation);
    event.date = DateValue::exact_year(1970);
    event.source_ids = vec![source.id];
    store.save_events(std::slice::from_ref(&event)).unwrap();
    store.save_sources(std::slice::from_ref(&source)).unwrap();
    store
        .save_citations(std::slice::from_ref(&citation))
        .unwrap();
    let root = store.root().to_path_buf();
    drop(store);

    let archive = dir.path().join("family.zip");
    let report = export_archive(&root, ExportFormat::Gedcom7, &archive).unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let out = dir.path().join("out");
    extract(&archive, &out);
    let text = fs::read_to_string(out.join("family.ged")).unwrap();
    assert!(text.contains("2 VERS 7.0.18\r\n"), "{text}");
    assert!(!text.contains("CONC") && !text.contains("CONT"), "{text}");
    assert!(
        text.contains("0 @S1@ SOUR\r\n1 TITL Synthetic register\r\n"),
        "{text}"
    );
    assert!(
        text.contains("1 SOUR @S1@\r\n2 PAGE p. 7\r\n2 QUAY 3\r\n"),
        "{text}"
    );
    // The event source link is written even without a Citation row for it.
    assert!(
        text.contains("1 OCCU\r\n2 DATE 1970\r\n2 SOUR @S1@\r\n"),
        "{text}"
    );
}

#[test]
fn gedcom_551_archive_still_reports_sources_as_not_included() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut store = ProjectStore::create(&projects, "Sources551").unwrap();
    let owner = person("Ivan", "Petrov", Gender::Male);
    store.save_persons(std::slice::from_ref(&owner)).unwrap();
    let source = Source::new("Synthetic register").unwrap();
    store.save_sources(std::slice::from_ref(&source)).unwrap();
    let root = store.root().to_path_buf();
    drop(store);

    let archive = dir.path().join("family.zip");
    let report = export_archive(&root, ExportFormat::Gedcom, &archive).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("sources and citations")),
        "{:?}",
        report.warnings
    );

    let out = dir.path().join("out");
    extract(&archive, &out);
    let text = fs::read_to_string(out.join("family.ged")).unwrap();
    assert!(text.contains("2 VERS 5.5.1\r\n"), "{text}");
    assert!(!text.contains("SOUR @S1@"), "{text}");
}

#[test]
fn missing_media_is_skipped_and_reported_without_a_file_name() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut store = ProjectStore::create(&projects, "Missing").unwrap();
    let person = person("Ivan", "Petrov", Gender::Male);
    store.save_persons(std::slice::from_ref(&person)).unwrap();
    store
        .save_media(&[Media {
            id: Uuid::now_v7(),
            file_name: "missing.jpg".into(),
            mime_type: "image/jpeg".into(),
            checksum: "a".repeat(64),
            caption: None,
            source_id: None,
            person_id: Some(person.id),
            event_id: None,
            primary: false,
        }])
        .unwrap();
    let root = store.root().to_path_buf();
    drop(store);

    let archive = dir.path().join("missing.zip");
    let report = export_archive(&root, ExportFormat::At5, &archive).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("1 media file(s) are missing")),
        "{:?}",
        report.warnings
    );
    assert!(
        report
            .warnings
            .iter()
            .all(|warning| !warning.contains("missing.jpg")),
        "{:?}",
        report.warnings
    );

    let names = entries(&archive);
    assert!(names.contains("missing.at5"), "{names:?}");
    assert!(
        !names.iter().any(|name| name.contains(".files/")),
        "{names:?}"
    );

    let out = dir.path().join("out");
    extract(&archive, &out);
    let bundle = read_at5_bundle(&out.join("missing.at5")).unwrap();
    assert_eq!(bundle.media.len(), 0);
    assert_eq!(bundle.persons.len(), 1);
}
