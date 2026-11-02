//! EAV AT5 contract tests. Synthetic data only: the shape mirrors a real
//! export (25 tables, EAV values) but every value here is invented.

use std::fs;
use std::path::{Path, PathBuf};

use gentree_core::date::{DatePrecision, DateQualifier, DateValue};
use gentree_core::person::{Gender, NameType, Person};
use gentree_core::record::{Event, EventType};
use gentree_core::relationship::RelationshipType;
use gentree_import::{read_at5_bundle, At5Bundle};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

/// Real AT5 table shape: identity columns only, names and dates in EAV tables.
const EAV_SCHEMA: &str = "
    CREATE TABLE Persons (
        id INTEGER, db_id INTEGER, sex INTEGER, lifespan TEXT,
        birth_id INTEGER, birth_db_id INTEGER,
        death_id INTEGER, death_db_id INTEGER, isfav INTEGER
    );
    CREATE TABLE Events (
        id INTEGER, db_id INTEGER, et_id INTEGER, et_db_id INTEGER,
        isfav INTEGER, alive INTEGER
    );
    CREATE TABLE EventTypes (
        id INTEGER, db_id INTEGER, namelocale TEXT, gedname TEXT,
        showoncreate INTEGER, ord INTEGER
    );
    CREATE TABLE EventDetails (
        id INTEGER, db_id INTEGER, p_id INTEGER, p_db_id INTEGER,
        e_id INTEGER, e_db_id INTEGER, er_id INTEGER, er_db_id INTEGER,
        e_ord INTEGER, p_ord INTEGER
    );
    CREATE TABLE ValuesStr (
        f_id INTEGER, f_db_id INTEGER, rec_id INTEGER, rec_db_id INTEGER,
        rec_table INTEGER, lang_id INTEGER, vstr TEXT, vblob BLOB,
        lconf INTEGER, ltrust INTEGER, comment TEXT
    );
    CREATE TABLE ValuesDates (
        f_id INTEGER, f_db_id INTEGER, rec_id INTEGER, rec_db_id INTEGER,
        rec_table INTEGER, d INTEGER, m INTEGER, y INTEGER,
        d2 INTEGER, m2 INTEGER, y2 INTEGER,
        isjulian INTEGER, isdateBC INTEGER, isdate2BC INTEGER, type INTEGER,
        sortdate INTEGER, sortdate2 INTEGER, sortdate3 INTEGER, sortdate4 INTEGER,
        lconf INTEGER, ltrust INTEGER, comment TEXT,
        unknownyeardigits INTEGER, id INTEGER
    );
    CREATE TABLE Documents (
        id INTEGER, db_id INTEGER, path TEXT, preview BLOB,
        previewage INTEGER, isfav INTEGER
    );
    CREATE TABLE DocumentDetails (
        id INTEGER, db_id INTEGER, d_id INTEGER, d_db_id INTEGER,
        rec_id INTEGER, rec_db_id INTEGER, rec_table INTEGER,
        d_ord INTEGER, r_ord INTEGER
    );
    CREATE TABLE Fields (
        id INTEGER, db_id INTEGER, tablecode INTEGER, ord INTEGER, datatype INTEGER
    );
    CREATE TABLE Global (id INTEGER, guid TEXT, mainlang_id INTEGER, version TEXT);
";

const SCAN_BYTES: &[u8] = b"synthetic-jpeg-bytes";

/// Create one synthetic EAV database and return its path.
fn database(dir: &Path, data: &str) -> PathBuf {
    let path = dir.join("at5.db");
    {
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(EAV_SCHEMA).unwrap();
        connection.execute_batch(data).unwrap();
    }
    path
}

fn write_scan(dir: &Path) {
    let files = dir.join("at5.files");
    fs::create_dir_all(&files).unwrap();
    fs::write(files.join("scan.jpg"), SCAN_BYTES).unwrap();
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn by_external<'a>(bundle: &'a At5Bundle, value: &str) -> &'a Person {
    bundle
        .persons
        .iter()
        .find(|person| {
            person
                .external_ids
                .iter()
                .any(|external| external.value == value)
        })
        .unwrap_or_else(|| panic!("person {value} not imported"))
}

fn event_of<'a>(bundle: &'a At5Bundle, person: &Person, event_type: EventType) -> &'a Event {
    bundle
        .events
        .iter()
        .find(|event| event.person_id == person.id && event.event_type == event_type)
        .unwrap_or_else(|| panic!("{event_type:?} event not imported"))
}

fn has_warning(bundle: &At5Bundle, needle: &str) -> bool {
    bundle
        .report
        .warnings
        .iter()
        .any(|warning| warning.contains(needle))
}

/// 3 persons, 2 events (BIRT/MARR), 1 parent-child edge, 1 spouse edge and one
/// document. Names come from `ValuesStr`, dates from `ValuesDates`.
fn core_fixture(dir: &Path) -> PathBuf {
    let path = database(
        dir,
        "
        INSERT INTO EventTypes (id, db_id, namelocale, gedname) VALUES
            (1, 1, 'Birth', 'BIRT'),
            (2, 1, 'Marriage', 'MARR');
        INSERT INTO Events (id, db_id, et_id, et_db_id) VALUES
            (10, 1, 1, 1),
            (20, 1, 2, 1);
        INSERT INTO Persons (id, db_id, sex, birth_id, birth_db_id) VALUES
            (1, 1, 1, NULL, NULL),
            (2, 1, 2, NULL, NULL),
            (3, 1, 1, 10, 1);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (66, 1, 1, 13, 'РРІР°РЅ'),
            (64, 1, 1, 13, 'РџРµС‚СЂРѕРІ'),
            (67, 1, 1, 13, 'РЎРµСЂРіРµРµРІРёС‡'),
            (89, 1, 1, 13, 'СЃРёРЅС‚РµС‚РёС‡РµСЃРєР°СЏ Р±РёРѕРіСЂР°С„РёСЏ'),
            (66, 2, 1, 13, 'РњР°СЂРёСЏ'),
            (64, 2, 1, 13, 'РРІР°РЅРѕРІР°'),
            (65, 2, 1, 13, 'РЎРёРґРѕСЂРѕРІР°'),
            (66, 3, 1, 13, 'РџС‘С‚СЂ'),
            (66, 3, 1, 13, 'Р’С‚РѕСЂРѕРµРРјСЏ'),
            (64, 3, 1, 13, 'РџРµС‚СЂРѕРІ');
        INSERT INTO ValuesDates (rec_id, rec_db_id, rec_table, y, type) VALUES
            (10, 1, 7, 2000, 0);
        INSERT INTO ValuesDates (rec_id, rec_db_id, rec_table, d, m, y, type) VALUES
            (20, 1, 7, 15, 6, 1999, 0);
        INSERT INTO EventDetails (id, db_id, p_id, p_db_id, e_id, e_db_id) VALUES
            (1, 1, 1, 1, 10, 1),
            (2, 1, 3, 1, 10, 1),
            (3, 1, 1, 1, 20, 1),
            (4, 1, 2, 1, 20, 1);
        INSERT INTO Documents (id, db_id, path) VALUES (1, 1, 'photos/scan.jpg');
        INSERT INTO DocumentDetails (id, db_id, d_id, d_db_id, rec_id, rec_db_id, rec_table)
            VALUES (1, 1, 1, 1, 1, 1, 13);
        INSERT INTO Fields (id, db_id, tablecode) VALUES (66, 1, 13);
        INSERT INTO Global (id, version) VALUES (1, 'synthetic');
        ",
    );
    write_scan(dir);
    path
}

#[test]
fn reads_eav_persons_names_events_relationships_and_media() {
    let dir = tempfile::tempdir().unwrap();
    let path = core_fixture(dir.path());
    let bundle = read_at5_bundle(&path).unwrap();
    let report = &bundle.report;

    assert_eq!(bundle.persons.len(), 3);
    assert_eq!(report.persons, 3);
    assert_eq!(bundle.events.len(), 2);
    assert_eq!(report.events, 2);
    assert_eq!(bundle.relationships.len(), 2);
    assert_eq!(report.relationships, 2);
    assert_eq!(bundle.media.len(), 1);
    assert_eq!(report.media, 1);
    assert!(report.conflicts.is_empty());
    assert!(!has_warning(&bundle, "unknown table"));

    let father = by_external(&bundle, "1:1");
    let mother = by_external(&bundle, "2:1");
    let child = by_external(&bundle, "3:1");

    // Gender codes 1/2, names from ValuesStr, first value wins.
    assert_eq!(father.gender, Gender::Male);
    assert_eq!(mother.gender, Gender::Female);
    assert_eq!(child.gender, Gender::Male);
    assert_eq!(father.names.len(), 1);
    assert_eq!(
        father.display_name(),
        "РџРµС‚СЂРѕРІ РРІР°РЅ РЎРµСЂРіРµРµРІРёС‡"
    );
    assert_eq!(
        father.names[0].patronymic.as_deref(),
        Some("РЎРµСЂРіРµРµРІРёС‡")
    );
    assert!(father.names[0].is_primary);
    assert_eq!(
        father.notes.as_deref(),
        Some("СЃРёРЅС‚РµС‚РёС‡РµСЃРєР°СЏ Р±РёРѕРіСЂР°С„РёСЏ")
    );
    assert_eq!(child.names[0].given.as_deref(), Some("РџС‘С‚СЂ"));

    // The maiden name becomes a second, non-primary MARRIED name.
    assert_eq!(mother.names.len(), 2);
    assert_eq!(mother.names[0].surname.as_deref(), Some("РРІР°РЅРѕРІР°"));
    assert_eq!(mother.names[1].surname.as_deref(), Some("РЎРёРґРѕСЂРѕРІР°"));
    assert_eq!(mother.names[1].name_type, NameType::Married);
    assert!(!mother.names[1].is_primary);

    // Birth date comes from the BIRT event (YEAR, original preserved).
    assert_eq!(child.birth.precision, DatePrecision::Year);
    assert_eq!(child.birth.qualifier, DateQualifier::Exact);
    assert_eq!(child.birth.original.as_deref(), Some("2000"));
    assert_eq!(child.birth.start.unwrap().to_iso(), "2000-01-01");
    // Nobody invented a birth date for the parents.
    assert_eq!(father.birth, DateValue::unknown(None));

    let birth = event_of(&bundle, child, EventType::Birth);
    assert_eq!(birth.date.original.as_deref(), Some("2000"));

    // MARR is a full DAY date and produces the spouse edge.
    let marriage = event_of(&bundle, father, EventType::Marriage);
    assert_eq!(marriage.date.precision, DatePrecision::Day);
    assert_eq!(marriage.date.original.as_deref(), Some("1999-06-15"));
    assert_eq!(marriage.date.start.unwrap().to_iso(), "1999-06-15");

    let parent_edge = bundle
        .relationships
        .iter()
        .find(|row| row.rel_type == RelationshipType::ParentChild)
        .expect("parent-child edge");
    assert_eq!(parent_edge.person_id, father.id);
    assert_eq!(parent_edge.related_person_id, child.id);
    let spouse = bundle
        .relationships
        .iter()
        .find(|row| row.rel_type == RelationshipType::Spouse)
        .expect("spouse edge");
    assert!(spouse.person_id < spouse.related_person_id);

    // Media metadata only: basename sanitised, checksum of the real file.
    let scan = &bundle.media[0];
    assert_eq!(scan.file_name, "scan.jpg");
    assert_eq!(scan.mime_type, "image/jpeg");
    assert_eq!(scan.checksum, sha256_hex(SCAN_BYTES));
    assert!(scan.source_id.is_none());
    assert_eq!(bundle.media_files.len(), 1);
    assert!(bundle.media_files[0].source.is_some());

    // DocumentDetails links the document to the person it depicts.
    assert_eq!(scan.person_id, Some(father.id));
}

#[test]
fn document_details_link_documents_to_persons_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = database(
        dir.path(),
        "
        INSERT INTO Persons (id, db_id, sex) VALUES
            (1, 1, 1),
            (2, 1, 2);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (66, 1, 1, 13, 'Ivan'),
            (64, 1, 1, 13, 'Petrov'),
            (66, 2, 1, 13, 'Maria'),
            (64, 2, 1, 13, 'Ivanova');
        INSERT INTO Documents (id, db_id, path) VALUES
            (1, 1, 'photos/scan.jpg'),
            (2, 1, 'photos/place.jpg'),
            (3, 1, 'photos/unlinked.jpg');
        INSERT INTO DocumentDetails (id, db_id, d_id, d_db_id, rec_id, rec_db_id, rec_table) VALUES
            (1, 1, 1, 1, 2, 1, 13),
            (2, 1, 2, 1, 1, 1, 14);
        ",
    );
    write_scan(dir.path());
    let files = dir.path().join("at5.files");
    fs::write(files.join("place.jpg"), b"synthetic-place").unwrap();
    fs::write(files.join("unlinked.jpg"), b"synthetic-unlinked").unwrap();

    let bundle = read_at5_bundle(&path).unwrap();
    let ivan = by_external(&bundle, "1:1");
    let maria = by_external(&bundle, "2:1");

    let linked = |name: &str| {
        bundle
            .media
            .iter()
            .find(|media| media.file_name == name)
            .unwrap_or_else(|| panic!("media {name} not imported"))
    };
    // A document owned by a Persons row gets that person.
    assert_eq!(linked("scan.jpg").person_id, Some(maria.id));
    // A non-person owner (rec_table 14 is Places) and an unlinked document
    // stay without a person.
    assert_eq!(linked("place.jpg").person_id, None);
    assert_eq!(linked("unlinked.jpg").person_id, None);
    assert_ne!(ivan.id, maria.id);
    assert!(
        !bundle
            .report
            .warnings
            .iter()
            .any(|warning| warning.contains("DocumentDetails")),
        "{:?}",
        bundle.report.warnings
    );
}

#[test]
fn death_date_and_unknown_event_type() {
    let dir = tempfile::tempdir().unwrap();
    let path = database(
        dir.path(),
        "
        INSERT INTO EventTypes (id, db_id, namelocale, gedname) VALUES
            (1, 1, 'Death', 'DEAT'),
            (2, 1, 'Blessing', 'BLESS');
        INSERT INTO Events (id, db_id, et_id, et_db_id) VALUES
            (10, 1, 1, 1),
            (20, 1, 2, 1);
        INSERT INTO Persons (id, db_id, sex, death_id, death_db_id) VALUES
            (1, 1, 2, 10, 1);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (66, 1, 1, 13, 'РђРЅРЅР°'),
            (64, 1, 1, 13, 'РРІР°РЅРѕРІР°');
        INSERT INTO ValuesDates (rec_id, rec_db_id, rec_table, d, m, y, type) VALUES
            (10, 1, 7, 2, 3, 1950, 0);
        INSERT INTO EventDetails (id, db_id, p_id, p_db_id, e_id, e_db_id) VALUES
            (1, 1, 1, 1, 20, 1);
        ",
    );
    let bundle = read_at5_bundle(&path).unwrap();
    let person = by_external(&bundle, "1:1");

    assert_eq!(person.death.precision, DatePrecision::Day);
    assert_eq!(person.death.original.as_deref(), Some("1950-03-02"));
    assert_eq!(person.death.start.unwrap().to_iso(), "1950-03-02");
    assert_eq!(person.death.end.unwrap().to_iso(), "1950-03-03");

    assert_eq!(bundle.events.len(), 2);
    let death = event_of(&bundle, person, EventType::Death);
    assert_eq!(death.original_type, None);
    let other = event_of(&bundle, person, EventType::Other);
    // The GEDCOM tag is kept when the enum has no matching variant.
    assert_eq!(other.original_type.as_deref(), Some("BLESS"));
    assert!(has_warning(&bundle, "OTHER"));
    assert!(bundle.relationships.is_empty());
}

#[test]
fn julian_range_and_partial_year_dates_stay_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let path = database(
        dir.path(),
        "
        INSERT INTO EventTypes (id, db_id, namelocale, gedname) VALUES
            (1, 1, 'Birth', 'BIRT');
        INSERT INTO Events (id, db_id, et_id, et_db_id) VALUES
            (10, 1, 1, 1),
            (20, 1, 1, 1),
            (30, 1, 1, 1);
        INSERT INTO Persons (id, db_id, sex, birth_id, birth_db_id) VALUES
            (1, 1, 1, 10, 1),
            (2, 1, 2, 20, 1),
            (3, 1, 1, 30, 1);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (64, 1, 1, 13, 'РџРµСЂРІС‹Р№'),
            (64, 2, 1, 13, 'Р’С‚РѕСЂРѕР№'),
            (64, 3, 1, 13, 'РўСЂРµС‚РёР№');
        INSERT INTO ValuesDates (rec_id, rec_db_id, rec_table, y, isjulian) VALUES
            (10, 1, 7, 1900, 1);
        INSERT INTO ValuesDates (rec_id, rec_db_id, rec_table, y, m, d, y2, m2, d2) VALUES
            (20, 1, 7, 1800, 1, 1, 1801, 1, 1);
        INSERT INTO ValuesDates (rec_id, rec_db_id, rec_table, y, unknownyeardigits) VALUES
            (30, 1, 7, 1950, 2);
        ",
    );
    let bundle = read_at5_bundle(&path).unwrap();

    assert_eq!(bundle.persons.len(), 3);
    for person in &bundle.persons {
        assert_eq!(person.birth, DateValue::unknown(None), "{person:?}");
        assert_eq!(person.birth.precision, DatePrecision::Unknown);
        assert_eq!(person.birth.qualifier, DateQualifier::Unknown);
    }
    let date_warnings = bundle
        .report
        .warnings
        .iter()
        .filter(|warning| warning.contains("event date at row"))
        .count();
    assert_eq!(date_warnings, 3, "{:?}", bundle.report.warnings);
}

#[test]
fn long_names_are_skipped_and_unmapped_fields_warn_once() {
    let dir = tempfile::tempdir().unwrap();
    let long_name = "Р°".repeat(201);
    let path = database(
        dir.path(),
        &format!(
            "
        INSERT INTO Persons (id, db_id, sex) VALUES (1, 1, 1);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (66, 1, 1, 13, '{long_name}'),
            (64, 1, 1, 13, 'РџРµС‚СЂРѕРІ'),
            (99, 1, 1, 13, 'Р»РёС€РЅРµРµ'),
            (99, 1, 1, 13, 'РµС‰С‘ Р»РёС€РЅРµРµ');
        "
        ),
    );
    let bundle = read_at5_bundle(&path).unwrap();
    assert_eq!(bundle.persons.len(), 1);
    let person = &bundle.persons[0];
    assert_eq!(person.names[0].given, None);
    assert_eq!(person.names[0].surname.as_deref(), Some("РџРµС‚СЂРѕРІ"));
    assert_eq!(
        bundle
            .report
            .warnings
            .iter()
            .filter(|warning| warning.contains("unrecognised EAV field 99"))
            .count(),
        1
    );
    assert_eq!(
        bundle
            .report
            .warnings
            .iter()
            .filter(|warning| warning.contains("longer than 200"))
            .count(),
        1
    );
}

#[test]
fn document_preview_blob_is_hashed_without_a_files_folder() {
    let dir = tempfile::tempdir().unwrap();
    // Minimal JPEG-shaped bytes: SOI, payload, EOI.
    let preview = [0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9];
    let path = database(
        dir.path(),
        "
        INSERT INTO Persons (id, db_id, sex) VALUES (1, 1, 1);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (64, 1, 1, 13, 'РџРµС‚СЂРѕРІ');
        INSERT INTO Documents (id, db_id, path, preview) VALUES
            (1, 1, 'album/scan.jpg', X'FFD8FF0102FFD9');
        ",
    );
    let bundle = read_at5_bundle(&path).unwrap();
    assert_eq!(bundle.media.len(), 1);
    let scan = &bundle.media[0];
    assert_eq!(scan.file_name, "scan.jpg");
    assert_eq!(scan.mime_type, "image/jpeg");
    assert_eq!(scan.checksum, sha256_hex(&preview));
}

#[test]
fn person_without_name_values_is_imported_with_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let path = database(
        dir.path(),
        "INSERT INTO Persons (id, db_id, sex) VALUES (1, 1, 1);",
    );
    let bundle = read_at5_bundle(&path).unwrap();
    assert_eq!(bundle.persons.len(), 1);
    assert!(bundle.persons[0].names.is_empty());
    assert!(has_warning(&bundle, "without a name"));
}

#[test]
fn simplified_person_table_wins_over_eav_detection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("at5.db");
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE persons (id INTEGER PRIMARY KEY, name TEXT, surname TEXT);
                 CREATE TABLE Fields (id INTEGER, tablecode INTEGER);
                 CREATE TABLE ValuesStr (f_id INTEGER, rec_table INTEGER, vstr TEXT);
                 INSERT INTO persons (id, name, surname) VALUES (1, 'РРІР°РЅ', 'РџРµС‚СЂРѕРІ');
                 INSERT INTO ValuesStr (f_id, rec_table, vstr) VALUES (66, 13, 'Р”СЂСѓРіРѕРµ');",
            )
            .unwrap();
    }
    let bundle = read_at5_bundle(&path).unwrap();
    assert_eq!(bundle.persons.len(), 1);
    assert_eq!(bundle.persons[0].display_name(), "РџРµС‚СЂРѕРІ РРІР°РЅ");
}

/// Real AT5 keeps a long person text in `vblob` (UTF-8) and only a truncated
/// preview in `vstr`; the full blob must win so notes are not cut off.
#[test]
fn biography_uses_full_vblob_instead_of_vstr_preview() {
    let dir = tempfile::tempdir().unwrap();
    let path = database(
        dir.path(),
        "
        INSERT INTO Persons (id, db_id, sex) VALUES (1, 1, 1), (2, 1, 2);
        INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr) VALUES
            (66, 1, 1, 13, 'Ivan'),
            (66, 2, 1, 13, 'Maria');
        ",
    );

    let full = format!("{}\nsecond paragraph", "note ".repeat(40));
    let preview = full.chars().take(150).collect::<String>();
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr, vblob)
                 VALUES (89, 1, 1, 13, ?1, ?2)",
                params![preview, full.as_bytes()],
            )
            .unwrap();
        // A blob that is not UTF-8 is not text: the preview is the fallback.
        connection
            .execute(
                "INSERT INTO ValuesStr (f_id, rec_id, rec_db_id, rec_table, vstr, vblob)
                 VALUES (89, 2, 1, 13, ?1, ?2)",
                params!["short fallback note", &[0xff_u8, 0xfe, 0x00][..]],
            )
            .unwrap();
    }

    let bundle = read_at5_bundle(&path).unwrap();
    let father = by_external(&bundle, "1:1");
    let mother = by_external(&bundle, "2:1");

    assert!(full.chars().count() > 150);
    assert_eq!(father.notes.as_deref(), Some(full.as_str()));
    assert_eq!(mother.notes.as_deref(), Some("short fallback note"));
}

/// Aggregate-only diagnostic against a real baseline. Ignored by default and
/// gated on `GENTREE_AT5_BASELINE`; it never prints names, places, paths or
/// issue texts. Run:
/// `GENTREE_AT5_BASELINE=<path> cargo test -p gentree-import --test at5_eav_contract -- --ignored --nocapture`
#[test]
#[ignore = "reads a local private baseline; aggregates only"]
fn print_baseline_aggregates() {
    let Ok(path) = std::env::var("GENTREE_AT5_BASELINE") else {
        eprintln!("GENTREE_AT5_BASELINE is not set; nothing to do");
        return;
    };
    let bundle = read_at5_bundle(Path::new(&path)).unwrap();
    let report = &bundle.report;
    let count = |needle: &str| {
        report
            .warnings
            .iter()
            .filter(|warning| warning.contains(needle))
            .count()
    };
    let julian = count("unsupported calendar");
    let ranges = count("date ranges");
    let partial = count("partial year");
    println!(
        "persons={} relationships={} events={} media={} warnings={} issues={} julian={julian} ranges={ranges} partial={partial} qualifier={}",
        report.persons,
        report.relationships,
        report.events,
        report.media,
        report.warnings.len(),
        report.issues.len(),
        count("unknown date qualifier"),
    );
    // Warning categories, counted only. Printed as a single aggregate line so
    // no report text (which could contain a table name but never a value)
    // reaches the transcript.
    println!(
        "no_name={} long_name={} sex={} validation={} no_participant={} missing_birth={} missing_death={} no_birth_date={} no_death_date={} participant_broken={} unmapped_field={} unmapped_owner={} empty_value={} duplicate={} unknown_table={} media_missing={} document_details={}",
        count("has no name values"),
        count("longer than 200"),
        count("unsupported sex code"),
        count("failed validation"),
        count("has no participant"),
        count("references a birth event"),
        count("references a death event"),
        count("birth event of the person"),
        count("death event of the person"),
        count("participant at row"),
        count("unrecognised EAV field"),
        count("EAV values for table code"),
        count("is empty; skipped"),
        count("duplicate"),
        count("unknown table"),
        count("document"),
        count("DocumentDetails"),
    );
    println!(
        "media_no_source={} media_not_jpeg={}",
        count("neither a file nor a preview"),
        count("is not a JPEG"),
    );
    println!(
        "date_problem={} day_without_month={} no_type_tag={} unmapped_tags={} no_spouse={} no_parent={} no_owner={} no_identifier={} unreadable_file={} no_field_id={}",
        count("date kept UNKNOWN"),
        count("day without month"),
        count("no usable type tag"),
        count("does not map"),
        count("no spouse link"),
        count("no parent links"),
        count("no owner reference"),
        count("has no identifier"),
        count("cannot be read"),
        count("without a field id"),
    );
}
