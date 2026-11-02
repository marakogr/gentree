//! AT5 bundle contract tests. Synthetic data only, per ADR-0013.

use std::fs;
use std::path::{Path, PathBuf};

use gentree_core::date::{DatePrecision, DateValue};
use gentree_core::person::{ExternalId, Gender, Name, Person};
use gentree_core::record::EventType;
use gentree_core::relationship::RelationshipType;
use gentree_import::{
    dedupe_persons, plan_at5, plan_at5_with_media_dirs, read_at5_bundle,
    read_at5_bundle_with_media_dirs, ConflictReason,
};
use rusqlite::params;
use sha2::{Digest, Sha256};

const SCHEMA: &str = "
    CREATE TABLE persons (
        id INTEGER PRIMARY KEY,
        name TEXT,
        surname TEXT,
        patronymic TEXT,
        sex TEXT,
        birth TEXT,
        death TEXT,
        notes TEXT
    );
    CREATE TABLE relations (id INTEGER PRIMARY KEY, parent INTEGER, child INTEGER);
    CREATE TABLE spouses (id INTEGER PRIMARY KEY, husband INTEGER, wife INTEGER);
    CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        person INTEGER,
        event_type TEXT,
        date TEXT,
        place TEXT,
        description TEXT
    );
    CREATE TABLE media (id INTEGER PRIMARY KEY, filename TEXT, caption TEXT);
";

/// Synthetic AT5-shaped database with a sibling `.files` folder.
fn fixture(dir: &Path) -> PathBuf {
    let path = dir.join("at5.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(SCHEMA).unwrap();

        let insert = "INSERT INTO persons \
                      (id, name, surname, patronymic, sex, birth, death, notes) \
                      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";
        connection
            .execute(
                insert,
                params![
                    1,
                    "Иван",
                    "Петров",
                    "Сергеевич",
                    "м",
                    "1950",
                    None::<String>,
                    "отец"
                ],
            )
            .unwrap();
        connection
            .execute(
                insert,
                params![
                    2,
                    "Мария",
                    "Иванова",
                    None::<String>,
                    "ж",
                    "06.05.1951",
                    None::<String>,
                    None::<String>
                ],
            )
            .unwrap();
        connection
            .execute(
                insert,
                params![
                    3,
                    "Пётр",
                    "Петров",
                    None::<String>,
                    "м",
                    "1975",
                    None::<String>,
                    None::<String>
                ],
            )
            .unwrap();

        // One good parent edge, its duplicate, and a self-link that must be
        // skipped and reported.
        connection
            .execute_batch(
                "INSERT INTO relations (id, parent, child) VALUES (1, 1, 3);
                 INSERT INTO relations (id, parent, child) VALUES (2, 1, 3);
                 INSERT INTO relations (id, parent, child) VALUES (3, 1, 1);
                 INSERT INTO spouses (id, husband, wife) VALUES (1, 1, 2);",
            )
            .unwrap();

        let insert_event = "INSERT INTO events \
                            (id, person, event_type, date, place, description) \
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
        connection
            .execute(
                insert_event,
                params![1, 1, "BIRTH", "1950", "Москва", "родился в Москве"],
            )
            .unwrap();
        connection
            .execute(
                insert_event,
                params![2, 2, "BLESSING", "1952", "Казань", "обряд"],
            )
            .unwrap();

        connection
            .execute_batch(
                "INSERT INTO media (id, filename, caption) VALUES (1, 'scan.jpg', 'скан');
                 INSERT INTO media (id, filename, caption) VALUES (2, 'missing.png', NULL);",
            )
            .unwrap();
    }

    let files = dir.join("at5.files");
    fs::create_dir_all(&files).unwrap();
    fs::write(files.join("scan.jpg"), b"synthetic-jpeg-bytes").unwrap();
    path
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Recursive listing with sizes, mtimes and contents: any write changes it.
fn snapshot(dir: &Path) -> Vec<String> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
        let mut entries = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap())
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, out);
                continue;
            }
            let relative = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let metadata = fs::metadata(&path).unwrap();
            let modified = metadata.modified().unwrap();
            let bytes = fs::read(&path).unwrap();
            out.push(format!(
                "{relative}:{}:{modified:?}:{}",
                metadata.len(),
                hex::encode(bytes)
            ));
        }
    }

    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

#[test]
fn reads_persons_relationships_events_and_media() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path());
    let bundle = read_at5_bundle(&path).unwrap();
    let report = &bundle.report;

    assert_eq!(bundle.persons.len(), 3);
    assert_eq!(report.persons, 3);
    assert_eq!(bundle.relationships.len(), 2);
    assert_eq!(report.relationships, 2);
    assert_eq!(bundle.events.len(), 2);
    assert_eq!(report.events, 2);
    assert_eq!(bundle.media.len(), 1);
    assert_eq!(report.media, 1);
    assert!(report.conflicts.is_empty());
    assert!(!report.warnings.iter().any(|w| w.contains("unknown table")));

    let ivan = &bundle.persons[0];
    let maria = &bundle.persons[1];
    let peter = &bundle.persons[2];
    assert_eq!(ivan.gender, Gender::Male);
    assert_eq!(maria.gender, Gender::Female);
    assert_eq!(ivan.external_ids[0].value, "1");

    // Parent edge points from parent to child; the duplicate and self-link are
    // skipped with issues instead of failing the import.
    let parent_edge = bundle
        .relationships
        .iter()
        .find(|row| row.rel_type == RelationshipType::ParentChild)
        .expect("parent-child relationship");
    assert_eq!(parent_edge.person_id, ivan.id);
    assert_eq!(parent_edge.related_person_id, peter.id);
    let duplicate = bundle
        .relationships
        .iter()
        .filter(|row| row.rel_type == RelationshipType::ParentChild)
        .count();
    assert_eq!(duplicate, 1, "duplicate parent edge must not be stored");
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.contains("DUPLICATE_RELATIONSHIP")));
    assert!(report.issues.iter().any(|issue| issue.contains("selfLink")));

    // Spouse rows are canonical: personId < relatedPersonId.
    let spouse = bundle
        .relationships
        .iter()
        .find(|row| row.rel_type == RelationshipType::Spouse)
        .expect("spouse relationship");
    assert!(spouse.person_id < spouse.related_person_id);
    let pair = [spouse.person_id, spouse.related_person_id];
    assert!(pair.contains(&ivan.id));
    assert!(pair.contains(&maria.id));

    let birth = bundle
        .events
        .iter()
        .find(|event| event.person_id == ivan.id)
        .expect("birth event");
    assert_eq!(birth.event_type, EventType::Birth);
    assert_eq!(birth.original_type, None);
    assert_eq!(birth.date.precision, DatePrecision::Year);
    assert_eq!(birth.date.original.as_deref(), Some("1950"));
    assert_eq!(birth.place.as_deref(), Some("Москва"));
    assert_eq!(birth.description.as_deref(), Some("родился в Москве"));
    assert!(birth.source_ids.is_empty());

    // Unknown event types keep the source value in `originalType`.
    let unknown = bundle
        .events
        .iter()
        .find(|event| event.person_id == maria.id)
        .expect("second event");
    assert_eq!(unknown.event_type, EventType::Other);
    assert_eq!(unknown.original_type.as_deref(), Some("BLESSING"));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.contains("unrecognised event type")));

    // Media metadata with a real checksum and the `.files` source to copy.
    let scan = &bundle.media[0];
    assert_eq!(scan.file_name, "scan.jpg");
    assert_eq!(scan.mime_type, "image/jpeg");
    assert_eq!(scan.caption.as_deref(), Some("скан"));
    assert_eq!(scan.checksum, sha256_hex(b"synthetic-jpeg-bytes"));
    assert!(scan.source_id.is_none());
    assert_eq!(bundle.media_files.len(), 1);
    let source = dir.path().join("at5.files").join("scan.jpg");
    assert_eq!(
        bundle.media_files[0].source.as_deref(),
        Some(source.as_path())
    );

    // The missing file is an issue, not a panic.
    assert!(report.issues.iter().any(|issue| issue.contains("missing")));
    assert!(!dir.path().join("at5.files").join("missing.png").exists());
}

#[test]
fn missing_media_file_is_reported_and_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path());
    fs::remove_file(dir.path().join("at5.files").join("scan.jpg")).unwrap();

    let bundle = read_at5_bundle(&path).unwrap();
    assert!(bundle.media.is_empty());
    assert_eq!(bundle.report.media, 0);
    assert_eq!(
        bundle
            .report
            .issues
            .iter()
            .filter(|issue| issue.contains("missing"))
            .count(),
        2
    );
    // Persons and relationships are still imported.
    assert_eq!(bundle.persons.len(), 3);
    assert_eq!(bundle.relationships.len(), 2);
}

#[test]
fn extra_media_folders_are_searched_by_file_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path());
    fs::remove_file(dir.path().join("at5.files").join("scan.jpg")).unwrap();
    let picked = dir.path().join("picked");
    fs::create_dir_all(&picked).unwrap();
    fs::write(picked.join("scan.jpg"), b"synthetic-jpeg-bytes").unwrap();
    fs::write(picked.join("missing.png"), b"synthetic-png-bytes").unwrap();

    let bundle = read_at5_bundle_with_media_dirs(&path, std::slice::from_ref(&picked)).unwrap();

    assert_eq!(bundle.media.len(), 2);
    assert_eq!(bundle.report.media, 2);
    assert!(
        bundle
            .report
            .issues
            .iter()
            .all(|issue| !issue.contains("missing")),
        "{:?}",
        bundle.report.issues
    );
    let scan = bundle
        .media_files
        .iter()
        .find(|file| file.media.file_name == "scan.jpg")
        .unwrap();
    assert_eq!(
        scan.source.as_deref(),
        Some(picked.join("scan.jpg").as_path())
    );
    assert_eq!(scan.media.checksum, sha256_hex(b"synthetic-jpeg-bytes"));
}

#[test]
fn the_files_folder_wins_over_extra_media_folders() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path());
    let picked = dir.path().join("picked");
    fs::create_dir_all(&picked).unwrap();
    // Same name, different bytes: the sibling `.files` copy must be used.
    fs::write(picked.join("scan.jpg"), b"other-bytes").unwrap();

    let bundle = read_at5_bundle_with_media_dirs(&path, std::slice::from_ref(&picked)).unwrap();

    let scan = bundle
        .media_files
        .iter()
        .find(|file| file.media.file_name == "scan.jpg")
        .unwrap();
    assert_eq!(scan.media.checksum, sha256_hex(b"synthetic-jpeg-bytes"));
    assert_eq!(
        scan.source.as_deref(),
        Some(dir.path().join("at5.files").join("scan.jpg").as_path())
    );
}

#[test]
fn plan_at5_with_media_dirs_reports_the_same_counts() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path());
    fs::remove_file(dir.path().join("at5.files").join("scan.jpg")).unwrap();
    let picked = dir.path().join("picked");
    fs::create_dir_all(&picked).unwrap();
    fs::write(picked.join("scan.jpg"), b"synthetic-jpeg-bytes").unwrap();

    let report = plan_at5_with_media_dirs(&path, std::slice::from_ref(&picked)).unwrap();

    assert_eq!(report.media, 1);
    // The still-absent second file stays an issue, not a silent drop.
    assert_eq!(
        report
            .issues
            .iter()
            .filter(|issue| issue.contains("missing"))
            .count(),
        1
    );
}

#[test]
fn plan_at5_reports_counts_without_touching_anything() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path());
    let before = snapshot(dir.path());

    let first = plan_at5(&path).unwrap();
    let second = plan_at5(&path).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.persons, 3);
    assert_eq!(first.relationships, 2);
    assert_eq!(first.events, 2);
    assert_eq!(first.media, 1);
    assert!(first.conflicts.is_empty());
    assert_eq!(snapshot(dir.path()), before, "dry run changed the folder");
}

fn person(given: &str, surname: &str, birth: Option<i32>) -> Person {
    let mut person = Person::new(vec![Name {
        given: Some(given.into()),
        surname: Some(surname.into()),
        is_primary: true,
        ..Name::default()
    }])
    .unwrap();
    if let Some(year) = birth {
        person.birth = DateValue::exact_year(year);
    }
    person
}

fn with_external(mut person: Person, value: &str) -> Person {
    person.external_ids.push(ExternalId {
        source: "AT5".into(),
        value: value.into(),
    });
    person
}

#[test]
fn dedupe_by_external_id_returns_conflict_not_a_new_person() {
    let existing = with_external(person("Иван", "Петров", Some(1950)), "1");
    let incoming = with_external(person("Иван", "Петров", Some(1950)), "1");

    let (fresh, conflicts) = dedupe_persons(std::slice::from_ref(&existing), vec![incoming]);
    assert!(fresh.is_empty());
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].incoming_index, 0);
    assert_eq!(conflicts[0].existing_id, existing.id);
    assert_eq!(conflicts[0].reason, ConflictReason::ExternalId);
}

#[test]
fn dedupe_falls_back_to_normalized_fio_and_dates() {
    let existing = person("Иван", "Петров", Some(1950));
    let same = person("  иван ", "ПЕТРОВ", Some(1950));
    let other = person("Иван", "Петров", Some(1951));

    let (fresh, conflicts) = dedupe_persons(std::slice::from_ref(&existing), vec![same, other]);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].incoming_index, 0);
    assert_eq!(conflicts[0].existing_id, existing.id);
    assert_eq!(conflicts[0].reason, ConflictReason::FioAndDates);
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].birth.start.unwrap().to_iso(), "1951-01-01");
}
