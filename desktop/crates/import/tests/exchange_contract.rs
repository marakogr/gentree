//! JSON/ZIP exchange contract tests. Synthetic data only, per ADR-0013.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use gentree_core::date::{CivilDate, DatePrecision, DateValue};
use gentree_core::person::{Gender, Name, Person};
use gentree_core::record::{Citation, CitationTarget, Event, EventType, Media, Source};
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_import::{
    export_json, export_zip, import_json, import_zip, ImportBundle, ProjectSnapshotData,
};
use gentree_storage::{list_projects, ProjectStore};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const EXPORTED_AT: &str = "2026-10-22T00:00:00Z";

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

fn entry_names(path: &Path) -> HashSet<String> {
    let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|index| archive.by_index(index).unwrap().name().to_owned())
        .collect()
}

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, contents) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(contents).unwrap();
    }
    zip.finish().unwrap();
}

fn rewrite_entry(source: &Path, target: &Path, file: &str, contents: &[u8]) {
    let mut input = zip::ZipArchive::new(File::open(source).unwrap()).unwrap();
    let mut output = zip::ZipWriter::new(File::create(target).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for index in 0..input.len() {
        let mut entry = input.by_index(index).unwrap();
        let name = entry.name().to_owned();
        output.start_file(name.clone(), options).unwrap();
        if name == file {
            output.write_all(contents).unwrap();
        } else {
            std::io::copy(&mut entry, &mut output).unwrap();
        }
    }
    output.finish().unwrap();
}

fn import_one_project(dir: &Path, bundle: &ImportBundle) -> String {
    assert_eq!(bundle.report.persons, bundle.persons.len());
    let manifests = list_projects(dir).unwrap();
    assert_eq!(manifests.len(), 1, "import must create exactly one project");
    manifests[0].project_id.to_string()
}

#[test]
fn json_round_trip_keeps_person_event_relationship_and_source() {
    let dir = tempfile::tempdir().unwrap();
    let mut father = person("Иван", "Петров", Gender::Male);
    father.birth = DateValue::exact_year(1950);
    father.notes = Some("первая запись".into());
    let child = person("Пётр", "Петров", Gender::Male);

    let mut birth = Event::new(father.id, EventType::Birth);
    birth.date = DateValue::exact_day(CivilDate::new(1950, 5, 9).unwrap());
    birth.place = Some("Москва".into());
    birth
        .details
        .insert("hospital".into(), "Родильный дом №1".into());

    let edge = Relationship::new(RelationshipType::ParentChild, father.id, child.id).unwrap();
    let book = Source::new("Метрическая книга").unwrap();
    let citation = Citation::new(book.id, CitationTarget::Person, father.id);
    let father_id = father.id;
    let child_id = child.id;

    let persons = vec![father, child];
    let events = vec![birth];
    let relationships = vec![edge];
    let sources = vec![book];
    let citations = vec![citation];
    let media: Vec<Media> = Vec::new();

    let file = dir.path().join("family.gentree.json");
    export_json(
        ProjectSnapshotData {
            exported_at: EXPORTED_AT,
            persons: &persons,
            events: &events,
            relationships: &relationships,
            sources: &sources,
            citations: &citations,
            media: &media,
        },
        &file,
    )
    .unwrap();

    let projects = dir.path().join("projects");
    let bundle = import_json(&file, &projects).unwrap();
    assert_eq!(bundle.report.persons, 2);
    assert!(
        bundle.report.issues.is_empty(),
        "{:?}",
        bundle.report.issues
    );

    let mut expected = persons.clone();
    expected.sort_by_key(|person| person.id);
    assert_eq!(bundle.persons, expected);

    assert_eq!(bundle.events.len(), 1);
    assert_eq!(bundle.events[0].date.precision, DatePrecision::Day);
    assert_eq!(bundle.events[0].date.start.unwrap().to_iso(), "1950-05-09");
    assert_eq!(bundle.events[0].place.as_deref(), Some("Москва"));
    assert_eq!(
        bundle.events[0].details.get("hospital").map(String::as_str),
        Some("Родильный дом №1")
    );

    assert_eq!(bundle.relationships.len(), 1);
    assert_eq!(
        bundle.relationships[0].rel_type,
        RelationshipType::ParentChild
    );
    assert_eq!(bundle.relationships[0].person_id, father_id);
    assert_eq!(bundle.relationships[0].related_person_id, child_id);
    assert_eq!(bundle.sources.len(), 1);
    assert_eq!(bundle.sources[0].title, "Метрическая книга");
    assert_eq!(bundle.citations.len(), 1);
    assert_eq!(bundle.citations[0].target_id, father_id);
    assert!(bundle.media.is_empty());

    // The import persisted the data as a new, valid project.
    let project_id = import_one_project(&projects, &bundle);
    let store = ProjectStore::open(&projects.join(project_id), false).unwrap();
    assert!(store.validate_layout().unwrap().ok);
    assert_eq!(store.events().unwrap(), bundle.events);
}

#[test]
fn zip_export_and_import_round_trip_with_media_and_checksums() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut project = ProjectStore::create(&projects, "Семья").unwrap();

    let mut father = person("Иван", "Петров", Gender::Male);
    father.birth = DateValue::exact_year(1950);
    let child = person("Пётр", "Петров", Gender::Male);
    let mut birth = Event::new(child.id, EventType::Birth);
    birth.date = DateValue::exact_year(1975);
    let edge = Relationship::new(RelationshipType::ParentChild, father.id, child.id).unwrap();
    let book = Source::new("Метрическая книга").unwrap();
    let citation = Citation::new(book.id, CitationTarget::Event, birth.id);

    project
        .save_persons(&[father.clone(), child.clone()])
        .unwrap();
    project.save_events(std::slice::from_ref(&birth)).unwrap();
    project
        .save_relationships(std::slice::from_ref(&edge))
        .unwrap();
    project.save_sources(std::slice::from_ref(&book)).unwrap();
    project
        .save_citations(std::slice::from_ref(&citation))
        .unwrap();

    let media_bytes = b"\xff\xd8\xff\xe0 synthetic jpeg".to_vec();
    let source_file = dir.path().join("scan.jpg");
    fs::write(&source_file, &media_bytes).unwrap();
    let (relative, checksum) =
        gentree_storage::store_media_file(project.root(), &source_file).unwrap();
    assert_eq!(relative, format!("media/{}/scan.jpg", &checksum[..2]));
    let media = Media {
        id: Uuid::now_v7(),
        file_name: "scan.jpg".into(),
        mime_type: "image/jpeg".into(),
        checksum,
        caption: Some("обложка".into()),
        source_id: Some(book.id),
        person_id: None,
        event_id: None,
        primary: false,
    };
    project.save_media(std::slice::from_ref(&media)).unwrap();

    let project_dir = project.root().to_path_buf();
    drop(project);

    let target = dir.path().join("export.gentree.zip");
    export_zip(&project_dir, &target).unwrap();
    let first = fs::read(&target).unwrap();
    export_zip(&project_dir, &target).unwrap();
    assert_eq!(
        first,
        fs::read(&target).unwrap(),
        "zip export must be deterministic for the same project"
    );

    let names = entry_names(&target);
    assert!(names.contains("manifest.json"));
    assert!(names.contains("checksums.sha256"));
    assert!(names.iter().any(|name| name.starts_with("media/")));
    assert!(!names.iter().any(|name| name.contains("index")));
    assert!(!names.iter().any(|name| name.ends_with(".lock")));
    for name in [
        "persons.jsonl",
        "relationships.jsonl",
        "events.jsonl",
        "sources.jsonl",
        "citations.jsonl",
        "media.jsonl",
    ] {
        assert!(names.contains(name), "{name} missing from export");
    }

    let imported_dir = dir.path().join("imported");
    let bundle = import_zip(&target, &imported_dir).unwrap();
    assert_eq!(bundle.report.persons, 2);
    assert!(
        bundle.report.issues.is_empty(),
        "{:?}",
        bundle.report.issues
    );
    assert_eq!(bundle.persons.len(), 2);
    assert_eq!(bundle.events, vec![birth]);
    assert_eq!(bundle.relationships, vec![edge]);
    assert_eq!(bundle.sources, vec![book]);
    assert_eq!(bundle.citations, vec![citation]);
    assert_eq!(bundle.media, vec![media.clone()]);

    let project_id = import_one_project(&imported_dir, &bundle);
    let restored = ProjectStore::open(&imported_dir.join(project_id), false).unwrap();
    assert!(restored.validate_layout().unwrap().ok);
    let restored_file = gentree_storage::resolve_media_path(restored.root(), &media).unwrap();
    assert_eq!(fs::read(restored_file).unwrap(), media_bytes);
}

#[test]
fn tampered_zip_entry_fails_checksum_validation() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut project = ProjectStore::create(&projects, "Семья").unwrap();
    project
        .save_persons(&[person("Иван", "Петров", Gender::Male)])
        .unwrap();
    let original = project.backup(dir.path()).unwrap();
    drop(project);

    let tampered = dir.path().join("tampered.zip");
    rewrite_entry(&original, &tampered, "persons.jsonl", b"{\"schema\":1}\n");

    let imported_dir = dir.path().join("imported");
    let err = import_zip(&tampered, &imported_dir).unwrap_err();
    assert!(
        err.contains("BACKUP_CHECKSUM_MISMATCH"),
        "unexpected error: {err}"
    );
    assert!(list_projects(&imported_dir).unwrap_or_default().is_empty());
}

#[test]
fn zip_without_checksum_coverage_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let project = ProjectStore::create(&projects, "Семья").unwrap();
    let original = project.backup(dir.path()).unwrap();
    drop(project);

    let tampered = dir.path().join("no-checksums.zip");
    rewrite_entry(&original, &tampered, "checksums.sha256", b"");
    let err = import_zip(&tampered, &dir.path().join("imported")).unwrap_err();
    assert!(err.contains("checksums do not cover"), "{err}");
}

#[test]
fn zip_slip_absolute_and_drive_letter_entries_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let unsafe_entries = [
        "../evil.txt",
        "/absolute.txt",
        "C:/evil.txt",
        "media\\..\\evil.txt",
    ];
    for (index, entry) in unsafe_entries.iter().enumerate() {
        let archive = dir.path().join(format!("slip-{index}.zip"));
        write_zip(
            &archive,
            &[
                ("manifest.json", b"{}".as_slice()),
                ("checksums.sha256", b"".as_slice()),
                (entry, b"x".as_slice()),
            ],
        );
        let err = import_zip(&archive, &dir.path().join(format!("imported-{index}"))).unwrap_err();
        assert!(
            err.contains("escapes the project folder"),
            "{entry}: unexpected error: {err}"
        );
    }
}

#[test]
fn json_with_unsupported_format_version_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("future.gentree.json");
    let document = serde_json::json!({
        "formatVersion": 99,
        "exportedAt": EXPORTED_AT,
        "persons": [],
        "relationships": [],
        "events": [],
        "sources": [],
        "citations": [],
        "media": [],
    });
    fs::write(&file, serde_json::to_vec(&document).unwrap()).unwrap();

    let projects = dir.path().join("projects");
    let err = import_json(&file, &projects).unwrap_err();
    assert!(err.contains("formatVersion"), "unexpected error: {err}");
    assert!(list_projects(&projects).unwrap_or_default().is_empty());
}

#[test]
fn json_export_keeps_media_metadata_without_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let image_bytes = b"SECRET-IMAGE-BYTES";
    let checksum = hex::encode(Sha256::digest(image_bytes));
    let album = Source::new("Альбом").unwrap();
    let media = vec![Media {
        id: Uuid::now_v7(),
        file_name: "scan.jpg".into(),
        mime_type: "image/jpeg".into(),
        checksum: checksum.clone(),
        caption: Some("обложка".into()),
        source_id: Some(album.id),
        person_id: None,
        event_id: None,
        primary: false,
    }];

    let target = dir.path().join("media.gentree.json");
    export_json(
        ProjectSnapshotData {
            exported_at: EXPORTED_AT,
            persons: &[],
            events: &[],
            relationships: &[],
            sources: &[],
            citations: &[],
            media: &media,
        },
        &target,
    )
    .unwrap();

    let text = fs::read_to_string(&target).unwrap();
    assert!(text.contains(&checksum));
    assert!(text.contains("scan.jpg"));
    assert!(!text.contains("SECRET-IMAGE-BYTES"));
    assert!(!text.contains("base64"));

    let document: serde_json::Value = serde_json::from_str(&text).unwrap();
    let keys: HashSet<&str> = document
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        HashSet::from([
            "formatVersion",
            "exportedAt",
            "persons",
            "relationships",
            "events",
            "sources",
            "citations",
            "media",
        ])
    );
    let media_keys: HashSet<&str> = document["media"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        media_keys,
        HashSet::from(["id", "fileName", "mimeType", "checksum", "caption", "sourceId",])
    );

    // Stable key order comes from the serde struct, not from the JSON map.
    let order = [
        "formatVersion",
        "exportedAt",
        "persons",
        "relationships",
        "events",
        "sources",
        "citations",
        "media",
    ];
    let positions: Vec<usize> = order
        .iter()
        .map(|key| text.find(&format!("\"{key}\"")).unwrap())
        .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "unexpected key order: {positions:?}"
    );
}

#[test]
fn json_export_is_deterministic_for_the_same_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = person("Иван", "Петров", Gender::Male);
    first.birth = DateValue::exact_year(1950);
    let second = person("Мария", "Иванова", Gender::Female);
    let child = person("Пётр", "Петров", Gender::Male);
    let edge = Relationship::new(RelationshipType::ParentChild, first.id, child.id).unwrap();
    let spouse = Relationship::new(RelationshipType::Spouse, first.id, second.id).unwrap();
    let book = Source::new("Книга").unwrap();

    let persons = vec![first, second, child];
    let relationships = vec![edge, spouse];
    let sources = vec![book];
    let events: Vec<Event> = Vec::new();
    let citations: Vec<Citation> = Vec::new();
    let media: Vec<Media> = Vec::new();

    let forward = dir.path().join("forward.gentree.json");
    export_json(
        ProjectSnapshotData {
            exported_at: EXPORTED_AT,
            persons: &persons,
            events: &events,
            relationships: &relationships,
            sources: &sources,
            citations: &citations,
            media: &media,
        },
        &forward,
    )
    .unwrap();

    let forward_again = dir.path().join("forward-again.gentree.json");
    export_json(
        ProjectSnapshotData {
            exported_at: EXPORTED_AT,
            persons: &persons,
            events: &events,
            relationships: &relationships,
            sources: &sources,
            citations: &citations,
            media: &media,
        },
        &forward_again,
    )
    .unwrap();
    assert_eq!(
        fs::read(&forward).unwrap(),
        fs::read(&forward_again).unwrap()
    );

    // Sorting by id makes the bytes independent of the input order.
    let reversed_persons: Vec<Person> = persons.iter().rev().cloned().collect();
    let reversed_relationships: Vec<Relationship> = relationships.iter().rev().cloned().collect();
    let reversed = dir.path().join("reversed.gentree.json");
    export_json(
        ProjectSnapshotData {
            exported_at: EXPORTED_AT,
            persons: &reversed_persons,
            events: &events,
            relationships: &reversed_relationships,
            sources: &sources,
            citations: &citations,
            media: &media,
        },
        &reversed,
    )
    .unwrap();
    assert_eq!(fs::read(&forward).unwrap(), fs::read(&reversed).unwrap());
}
