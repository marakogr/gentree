//! GEDCOM 5.5.1 contract tests. Synthetic data only, per ADR-0013.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use gentree_core::date::{CivilDate, DatePrecision, DateValue};
use gentree_core::person::{ExternalId, Gender, Name, NameType, Person};
use gentree_core::record::{Event, EventType};
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_import::gedcom;
use gentree_import::GEDCOMReport;

const DIRTY_FIXTURE: &str = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 SEX M
1 BIRT
2 DATE 1950
2 PLAC Москва
0 @I2@ INDI
1 NAME Мария /Иванова/
1 SEX F
1 BIRT
2 DATE 07 MAR 1952
0 @I3@ INDI
1 NAME Пётр /Петров/
0 @I4@ INDI
1 NAME Анна /Петрова/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE ABT 1972
1 NOTE семейная запись
0 TRLR
";

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

fn write_bytes(dir: &Path, file: &str, contents: &[u8]) -> PathBuf {
    let path = dir.join(file);
    fs::write(&path, contents).unwrap();
    path
}

fn write_text(dir: &Path, file: &str, contents: &str) -> PathBuf {
    write_bytes(dir, file, contents.as_bytes())
}

/// `(type, first name, second name)` with spouse pairs sorted, so the UUID
/// order chosen by `Relationship::new` does not affect the assertion.
fn edge_set(
    persons: &[Person],
    relationships: &[Relationship],
) -> BTreeSet<(String, String, String)> {
    let names: HashMap<_, _> = persons
        .iter()
        .map(|person| (person.id, person.display_name()))
        .collect();
    relationships
        .iter()
        .map(|relationship| {
            let mut first = names[&relationship.person_id].clone();
            let mut second = names[&relationship.related_person_id].clone();
            if relationship.rel_type.is_spouse() && second < first {
                std::mem::swap(&mut first, &mut second);
            }
            (format!("{:?}", relationship.rel_type), first, second)
        })
        .collect()
}

#[test]
fn round_trips_synthetic_family_with_cyrillic_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut husband = person("Иван", "Петров", Gender::Male);
    husband.birth = DateValue::exact_year(1950);
    husband.notes = Some("первая запись".into());
    husband.external_ids.push(ExternalId {
        source: "AT5".into(),
        value: "42".into(),
    });
    let mut wife = person("Мария", "Иванова", Gender::Female);
    wife.birth = DateValue::exact_day(CivilDate::new(1952, 3, 7).unwrap());
    let mut son = person("Пётр", "Петров", Gender::Male);
    son.birth = DateValue::exact_month(CivilDate::new(1975, 4, 1).unwrap());
    let daughter = person("Анна", "Петрова", Gender::Female);

    let persons = vec![husband, wife, son, daughter];
    let relationships = vec![
        Relationship::new(RelationshipType::Spouse, persons[0].id, persons[1].id).unwrap(),
        Relationship::new(RelationshipType::ParentChild, persons[0].id, persons[2].id).unwrap(),
        Relationship::new(RelationshipType::ParentChild, persons[0].id, persons[3].id).unwrap(),
        Relationship::new(RelationshipType::ParentChild, persons[1].id, persons[2].id).unwrap(),
        Relationship::new(RelationshipType::ParentChild, persons[1].id, persons[3].id).unwrap(),
    ];

    let path = dir.path().join("family.ged");
    let export = gedcom::export(&persons, &relationships, &path).unwrap();
    assert!(export.warnings.is_empty(), "{:?}", export.warnings);

    let text = String::from_utf8(fs::read(&path).unwrap()).unwrap();
    assert!(text.starts_with("0 HEAD\r\n"), "{text}");
    assert!(text.contains("2 VERS 5.5.1\r\n"), "{text}");
    assert!(text.contains("1 CHAR UTF-8\r\n"), "{text}");
    assert!(text.ends_with("0 TRLR\r\n"), "{text}");
    // Cyrillic survives; the surname is delimited by slashes.
    assert!(text.contains("1 NAME Иван /Петров/\r\n"), "{text}");

    let (parsed, parsed_relationships, report) = gedcom::parse(&path).unwrap();
    assert_eq!(report.persons, 4);
    assert_eq!(parsed_relationships.len(), 5);
    assert_eq!(report.persons, parsed.len());

    let ivan = parsed
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some("Иван"))
        .unwrap();
    assert_eq!(ivan.display_name(), "Петров Иван");
    assert_eq!(ivan.gender, Gender::Male);
    assert_eq!(ivan.birth.precision, DatePrecision::Year);
    assert_eq!(ivan.birth.start.unwrap().to_iso(), "1950-01-01");
    assert_eq!(ivan.birth.end.unwrap().to_iso(), "1951-01-01");
    assert_eq!(ivan.birth.original.as_deref(), Some("1950"));
    assert_eq!(ivan.notes.as_deref(), Some("первая запись"));
    assert_eq!(
        ivan.external_ids,
        vec![ExternalId {
            source: "AT5".to_owned(),
            value: "42".to_owned(),
        }]
    );

    let maria = parsed
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some("Мария"))
        .unwrap();
    assert_eq!(maria.gender, Gender::Female);
    assert_eq!(maria.birth.precision, DatePrecision::Day);
    assert_eq!(maria.birth.start.unwrap().to_iso(), "1952-03-07");

    let peter = parsed
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some("Пётр"))
        .unwrap();
    assert_eq!(peter.birth.precision, DatePrecision::Month);
    assert_eq!(peter.birth.start.unwrap().to_iso(), "1975-04-01");
    assert_eq!(peter.birth.end.unwrap().to_iso(), "1975-05-01");

    let expected: BTreeSet<(String, String, String)> = [
        ("Spouse", "Иванова Мария", "Петров Иван"),
        ("ParentChild", "Петров Иван", "Петров Пётр"),
        ("ParentChild", "Петров Иван", "Петрова Анна"),
        ("ParentChild", "Иванова Мария", "Петров Пётр"),
        ("ParentChild", "Иванова Мария", "Петрова Анна"),
    ]
    .into_iter()
    .map(|(kind, first, second)| (kind.to_owned(), first.to_owned(), second.to_owned()))
    .collect();
    assert_eq!(edge_set(&parsed, &parsed_relationships), expected);

    // A second round trip produces the same bytes: nothing drifts.
    let again = dir.path().join("family-again.ged");
    gedcom::export(&parsed, &parsed_relationships, &again).unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        fs::read(&again).unwrap(),
        "export must be stable after a round trip"
    );
}

#[test]
fn year_date_stays_year_and_month_stays_month() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = person("Пётр", "Петров", Gender::Male);
    child.birth = DateValue::exact_year(1950);
    child.death = DateValue::exact_month(CivilDate::new(1990, 5, 1).unwrap());

    let path = dir.path().join("dates.ged");
    gedcom::export(&[child], &[], &path).unwrap();
    let (persons, _, _) = gedcom::parse(&path).unwrap();

    assert_eq!(persons.len(), 1);
    assert_eq!(persons[0].birth.precision, DatePrecision::Year);
    assert_eq!(persons[0].birth.start.unwrap().to_iso(), "1950-01-01");
    assert_eq!(persons[0].birth.end.unwrap().to_iso(), "1951-01-01");
    assert_eq!(persons[0].death.precision, DatePrecision::Month);
    assert_eq!(persons[0].death.start.unwrap().to_iso(), "1990-05-01");
    assert_eq!(persons[0].death.end.unwrap().to_iso(), "1990-06-01");
}

#[test]
fn parses_ansel_and_latin1_fixtures() {
    let dir = tempfile::tempdir().unwrap();

    // ANSEL: 0xA1 = Ł, 0xE2 = combining acute (precedes its base letter).
    let mut ansel = Vec::new();
    ansel.extend_from_slice(
        b"0 HEAD\r\n1 GEDC\r\n2 VERS 5.5.1\r\n1 CHAR ANSEL\r\n0 @I1@ INDI\r\n1 NAME ",
    );
    ansel.push(0xA1);
    ansel.extend_from_slice(b"ukasz /Garc");
    ansel.push(0xE2);
    ansel.extend_from_slice(b"ia/\r\n0 TRLR\r\n");
    let path = write_bytes(dir.path(), "ansel.ged", &ansel);

    let (persons, _, report) = gedcom::parse(&path).unwrap();
    assert_eq!(persons.len(), 1);
    assert_eq!(persons[0].names[0].given.as_deref(), Some("Łukasz"));
    assert_eq!(
        persons[0].names[0].surname.as_deref(),
        Some("Garci\u{0301}a")
    );
    assert!(!persons[0].display_name().contains('Ã'), "mojibake");
    assert!(report.issues.is_empty(), "{:?}", report.issues);

    // ISO-8859-1: 0xE9 = é.
    let latin1 = b"0 HEAD\r\n1 GEDC\r\n2 VERS 5.5.1\r\n1 CHAR ISO-8859-1\r\n0 @I1@ INDI\r\n1 NAME Jos\xE9 /P\xE9rez/\r\n0 TRLR\r\n";
    let path = write_bytes(dir.path(), "latin1.ged", latin1);
    let (persons, _, _) = gedcom::parse(&path).unwrap();
    assert_eq!(persons[0].display_name(), "Pérez José");
}

#[test]
fn rejects_unsupported_encoding_instead_of_mojibake() {
    let dir = tempfile::tempdir().unwrap();
    // CP1251 bytes for "Привет" with a CP1251 declaration.
    let path = write_bytes(
        dir.path(),
        "cp1251.ged",
        b"0 HEAD\r\n1 GEDC\r\n2 VERS 5.5.1\r\n1 CHAR CP1251\r\n0 @I1@ INDI\r\n1 NAME \xCF\xF0\xE8\xE2\xE5\xF2\r\n0 TRLR\r\n",
    );
    let error = gedcom::parse(&path).unwrap_err();
    assert!(error.contains("unsupported"), "{error}");
    assert!(error.contains("CP1251"), "{error}");
}

#[test]
fn custom_tags_become_warnings_and_stay_out_of_notes() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
1 _MILI 3rd regiment
1 OCCU Carpenter
0 TRLR
";
    let path = write_text(dir.path(), "custom.ged", source);
    let (persons, _, report) = gedcom::parse(&path).unwrap();

    assert_eq!(persons.len(), 1);
    assert_eq!(persons[0].notes, None);
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("_MILI")),
        "{:?}",
        report.warnings
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("Occupation")),
        "{:?}",
        report.warnings
    );
    // Reports must be loggable: no field values.
    for warning in &report.warnings {
        assert!(!warning.contains("3rd regiment"), "{warning}");
        assert!(!warning.contains("Carpenter"), "{warning}");
    }
}

#[test]
fn married_name_tag_adds_a_second_name_without_touching_notes() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Мария /Петрова/
1 NOTE Первая строка
2 CONT вторая строка
1 _MARNM Иванова
1 _UID 5F3A2B
0 TRLR
";
    let path = write_text(dir.path(), "marnm.ged", source);
    let (persons, _, report) = gedcom::parse(&path).unwrap();

    assert_eq!(persons.len(), 1);
    let person = &persons[0];
    // Only the NOTE/CONT text reaches the notes.
    assert_eq!(
        person.notes.as_deref(),
        Some("Первая строка\nвторая строка")
    );
    assert!(!person
        .notes
        .as_deref()
        .unwrap_or_default()
        .contains("[unparsed]"));

    assert_eq!(person.names.len(), 2);
    let primary = &person.names[0];
    assert_eq!(primary.given.as_deref(), Some("Мария"));
    assert_eq!(primary.surname.as_deref(), Some("Петрова"));
    assert_eq!(primary.name_type, NameType::Married);
    assert!(primary.is_primary);

    let married = &person.names[1];
    assert_eq!(married.given, None);
    assert_eq!(married.surname.as_deref(), Some("Иванова"));
    assert_eq!(married.name_type, NameType::Birth);
    assert!(!married.is_primary);

    assert_eq!(
        person.names.iter().filter(|name| name.is_primary).count(),
        1
    );

    // Custom tags are reported by tag only: no values in the warnings.
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("_MARNM")),
        "{:?}",
        report.warnings
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("_UID")),
        "{:?}",
        report.warnings
    );
    for warning in &report.warnings {
        assert!(!warning.contains("Иванова"), "{warning}");
        assert!(!warning.contains("5F3A2B"), "{warning}");
    }
}

#[test]
fn primary_name_stays_birth_without_the_married_name_tag() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
0 TRLR
";
    let path = write_text(dir.path(), "plain.ged", source);
    let (persons, _, _) = gedcom::parse(&path).unwrap();

    assert_eq!(persons[0].names.len(), 1);
    assert_eq!(persons[0].names[0].name_type, NameType::Birth);
    assert!(persons[0].names[0].is_primary);
}

#[test]
fn married_name_under_name_becomes_primary_and_keeps_the_maiden_name() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Клавдия /Севина/
2 _MARNM Савинова
1 NOTE только текст заметки
1 _UID 5F3A2B
0 TRLR
";
    let path = write_text(dir.path(), "marnm_nested.ged", source);
    let (persons, _, report) = gedcom::parse(&path).unwrap();

    assert_eq!(persons.len(), 1);
    let person = &persons[0];
    // `NAME` is the maiden name, so `_MARNM` becomes the primary name and the
    // original NAME is kept as a second, birth name.
    assert_eq!(person.names.len(), 2);

    let primary = &person.names[0];
    assert_eq!(primary.given.as_deref(), Some("Клавдия"));
    assert_eq!(primary.surname.as_deref(), Some("Савинова"));
    assert_eq!(primary.name_type, NameType::Married);
    assert!(primary.is_primary);

    let maiden = &person.names[1];
    assert_eq!(maiden.given.as_deref(), Some("Клавдия"));
    assert_eq!(maiden.surname.as_deref(), Some("Севина"));
    assert_eq!(maiden.name_type, NameType::Birth);
    assert!(!maiden.is_primary);
    assert_eq!(
        person.names.iter().filter(|name| name.is_primary).count(),
        1
    );

    // Notes keep only the genuine NOTE text; `_MARNM` never leaks into them.
    assert_eq!(person.notes.as_deref(), Some("только текст заметки"));

    // The custom tag is mapped, so it is not reported as unparsed, and no
    // warning repeats its value (or any other field value).
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("_MARNM")),
        "{:?}",
        report.warnings
    );
    for warning in &report.warnings {
        assert!(!warning.contains("Савинова"), "{warning}");
        assert!(!warning.contains("Севина"), "{warning}");
        assert!(!warning.contains("5F3A2B"), "{warning}");
    }
}

#[test]
fn married_name_equal_to_name_surname_keeps_a_single_name() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Клавдия /Севина/
2 _MARNM Севина
0 TRLR
";
    let path = write_text(dir.path(), "marnm_equal.ged", source);
    let (persons, _, _) = gedcom::parse(&path).unwrap();

    assert_eq!(persons[0].names.len(), 1);
    let only = &persons[0].names[0];
    assert_eq!(only.given.as_deref(), Some("Клавдия"));
    assert_eq!(only.surname.as_deref(), Some("Севина"));
    assert_eq!(only.name_type, NameType::Birth);
    assert!(only.is_primary);
}

#[test]
fn reads_a_non_standard_patronymic_tag() {
    let dir = tempfile::tempdir().unwrap();
    let source = "\
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Петров/
2 _PATR Иванович
0 TRLR
";
    let path = write_text(dir.path(), "patronymic.ged", source);
    let (persons, _, _) = gedcom::parse(&path).unwrap();

    assert_eq!(persons[0].names[0].given.as_deref(), Some("Иван"));
    assert_eq!(persons[0].names[0].patronymic.as_deref(), Some("Иванович"));
}

#[test]
fn export_warns_about_unrepresentable_fields() {
    let dir = tempfile::tempdir().unwrap();
    let mut father = person("Иван", "Петров", Gender::Male);
    father.names[0].patronymic = Some("Иванович".into());
    let child = person("Пётр", "Петров", Gender::Male);
    let mut edge = Relationship::new(RelationshipType::ParentChild, father.id, child.id).unwrap();
    edge.notes = Some("крёстный".into());

    let path = dir.path().join("lossy.ged");
    let report = gedcom::export(&[father, child], &[edge], &path).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("patronymic")),
        "{:?}",
        report.warnings
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("parent-child")),
        "{:?}",
        report.warnings
    );
    for warning in &report.warnings {
        assert!(!warning.contains("Иванович"), "{warning}");
        assert!(!warning.contains("крёстный"), "{warning}");
    }

    // GEDCOM has no patronymic field, so the exported given name contains both.
    // The importer does not guess: it keeps the value as given unless the file
    // carries an explicit `_PATR`/`PATR` tag.
    let (persons, _, _) = gedcom::parse(&path).unwrap();
    assert_eq!(persons[0].names[0].given.as_deref(), Some("Иван Иванович"));
    assert_eq!(persons[0].names[0].patronymic, None);
}

fn detail_event(
    person_id: gentree_core::person::PersonId,
    event_type: EventType,
    details: &[(&str, &str)],
    description: Option<&str>,
) -> Event {
    let mut event = Event::new(person_id, event_type);
    event.date = DateValue::exact_year(2000);
    event.description = description.map(str::to_owned);
    event.details = details
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    event
}

#[test]
fn export_round_trips_type_specific_event_details() {
    let dir = tempfile::tempdir().unwrap();
    let owner = person("Ivan", "Petrov", Gender::Male);
    let spouse = person("Maria", "Ivanova", Gender::Female);
    let edge = Relationship::new(RelationshipType::Spouse, owner.id, spouse.id).unwrap();
    // Longer than the writer's line limit, so the details NOTE must use CONC.
    let long_institution = "Synthetic long institution ".repeat(12).trim().to_owned();
    let mut events = vec![
        detail_event(
            owner.id,
            EventType::Birth,
            &[
                ("hospital", "City hospital"),
                ("birth_certificate", "I-123"),
            ],
            Some("born at home"),
        ),
        detail_event(
            owner.id,
            EventType::Death,
            &[("cause", "Pneumonia"), ("death_certificate", "D-456")],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Marriage,
            &[
                ("marriage_rite", "Church rite"),
                ("officiant", "Registry office"),
                ("marriage_certificate", "M-789"),
            ],
            Some("civil ceremony"),
        ),
        detail_event(
            owner.id,
            EventType::Divorce,
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
            &[
                ("cemetery", "New cemetery"),
                ("grave", "Plot 7"),
                ("burial_rite", "Quiet rite"),
            ],
            Some("quiet burial"),
        ),
        detail_event(
            owner.id,
            EventType::Residence,
            &[("address", "12 Main Street")],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Occupation,
            &[("position", "Carpenter"), ("employer", "Workshop")],
            None,
        ),
        detail_event(
            owner.id,
            EventType::Education,
            &[
                ("qualification", "Higher"),
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

    let path = dir.path().join("details.ged");
    let report = gedcom::export_full(
        &[owner.clone(), spouse.clone()],
        &[edge],
        &events,
        &[],
        &path,
    )
    .unwrap();
    // The old aggregate warning is gone: the loss no longer exists.
    assert!(
        !report
            .warnings
            .iter()
            .any(|warning| warning.contains("type-specific details")),
        "{:?}",
        report.warnings
    );

    let text = fs::read_to_string(&path).unwrap();
    for expected in [
        "1 BIRT",
        "2 ADDR City hospital",
        "2 CAUS Pneumonia",
        "2 TYPE Church rite",
        "2 AGNC Registry office",
        "2 CAUS Irreconcilable differences",
        "2 AGNC City court",
        "2 ADDR New cemetery",
        "2 ADDR 12 Main Street",
        "1 OCCU Carpenter",
        "1 EDUC Higher",
        "2 AGNC Workshop",
    ] {
        assert!(text.contains(expected), "{expected} missing:\n{text}");
    }
    assert!(text.contains("[gentree:details]"), "{text}");
    // The remaining keys travel in the machine-readable note, not the tags.
    assert!(text.contains("\"birth_certificate\":\"I-123\""), "{text}");
    assert!(
        text.contains("\"marriage_certificate\":\"M-789\""),
        "{text}"
    );
    assert!(text.contains("\"grave\":\"Plot 7\""), "{text}");
    assert!(text.contains("CONC"), "the long note must wrap:\n{text}");

    let bundle = gedcom::parse_bundle(&path, &[]).unwrap();
    assert_eq!(bundle.persons.len(), 2);
    assert_eq!(bundle.events.len(), events.len(), "{:?}", bundle.events);
    for expected in &events {
        let actual = bundle
            .events
            .iter()
            .find(|event| event.event_type == expected.event_type)
            .unwrap_or_else(|| panic!("no {:?} event", expected.event_type));
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
}

#[test]
fn export_parse_export_is_stable() {
    let dir = tempfile::tempdir().unwrap();
    let source = write_text(dir.path(), "dirty.ged", DIRTY_FIXTURE);
    let (persons, relationships, report) = gedcom::parse(&source).unwrap();
    assert_eq!(report.persons, 4);
    assert_eq!(relationships.len(), 5);

    // Family notes survive on the spouse edge; the MARR date is mapped to an
    // event on the first spouse, not appended to the note text.
    let spouse = relationships
        .iter()
        .find(|relationship| relationship.rel_type == RelationshipType::Spouse)
        .unwrap();
    let notes = spouse.notes.as_deref().unwrap_or_default();
    assert_eq!(notes, "семейная запись");
    // The birth place has no domain field; it is reported, never appended to
    // the person notes.
    let ivan = persons
        .iter()
        .find(|person| person.names[0].given.as_deref() == Some("Иван"))
        .unwrap();
    assert_eq!(ivan.notes, None, "{:?}", ivan.notes);

    let first = dir.path().join("first.ged");
    gedcom::export(&persons, &relationships, &first).unwrap();
    let (persons, relationships, _) = gedcom::parse(&first).unwrap();
    let second = dir.path().join("second.ged");
    gedcom::export(&persons, &relationships, &second).unwrap();
    let (persons, relationships, _) = gedcom::parse(&second).unwrap();
    let third = dir.path().join("third.ged");
    gedcom::export(&persons, &relationships, &third).unwrap();

    assert_eq!(persons.len(), 4);
    assert_eq!(relationships.len(), 5);
    assert_eq!(
        fs::read(&second).unwrap(),
        fs::read(&third).unwrap(),
        "export must be stable from the second generation on"
    );
}

#[test]
fn co_parents_without_a_spouse_edge_stay_unmarried() {
    let dir = tempfile::tempdir().unwrap();
    let father = person("Иван", "Петров", Gender::Male);
    let mother = person("Мария", "Иванова", Gender::Female);
    let child = person("Пётр", "Петров", Gender::Male);
    let relationships = vec![
        Relationship::new(RelationshipType::ParentChild, father.id, child.id).unwrap(),
        Relationship::new(RelationshipType::ParentChild, mother.id, child.id).unwrap(),
    ];

    let path = dir.path().join("coparents.ged");
    gedcom::export(&[father, mother, child], &relationships, &path).unwrap();
    let (persons, parsed, report) = gedcom::parse(&path).unwrap();

    assert_eq!(persons.len(), 3);
    assert!(
        !parsed
            .iter()
            .any(|relationship| relationship.rel_type.is_spouse()),
        "export must not invent a marriage: {parsed:?}"
    );
    assert_eq!(
        parsed
            .iter()
            .filter(|relationship| relationship.rel_type == RelationshipType::ParentChild)
            .count(),
        2
    );
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
}

#[test]
fn reports_serialize_to_camel_case() {
    let report = GEDCOMReport {
        persons: 2,
        relationships: 3,
        warnings: vec!["warning".into()],
        issues: vec!["issue".into()],
    };
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["persons"], 2);
    assert_eq!(json["relationships"], 3);
    assert_eq!(json["warnings"][0], "warning");
    assert_eq!(json["issues"][0], "issue");

    let export = gentree_import::ExportReport {
        warnings: vec!["warning".into()],
    };
    let json = serde_json::to_value(&export).unwrap();
    assert_eq!(json["warnings"][0], "warning");
}
