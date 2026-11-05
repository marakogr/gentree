//! Contract tests for the project merge MVP (ADR-0017).
//!
//! Synthetic data only: no real AT5 baseline, names and dates are invented.

use std::collections::BTreeMap;

use gentree_core::merge::codes;
use gentree_core::{
    apply_merge, merge_preview, validate_project, Citation, CitationTarget, CivilDate, DateValue,
    Event, EventDecision, EventMatch, EventType, ExternalId, FieldPolicy, Gender, MatchConfidence,
    Media, MergeAction, MergeDecisions, MergeOutput, MergeWarning, Name, Person, PersonDecision,
    PersonMatch, PlaceGeo, PlacePrecision, PlaceSource, ProjectSnapshot, RelationOrigin,
    Relationship, RelationshipType, Side, Source,
};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

fn id(value: u128) -> Uuid {
    Uuid::from_u128(value)
}

fn name(given: &str, surname: &str) -> Name {
    Name {
        given: Some(given.to_owned()),
        surname: Some(surname.to_owned()),
        is_primary: true,
        ..Name::default()
    }
}

fn person(person_id: Uuid, given: &str, surname: &str) -> Person {
    Person {
        id: person_id,
        gender: Gender::Unknown,
        names: vec![name(given, surname)],
        birth: DateValue::default(),
        death: DateValue::default(),
        notes: None,
        external_ids: Vec::new(),
    }
}

fn year(value: i32) -> DateValue {
    DateValue::exact_year(value)
}

fn day(year: i32, month: u8, day: u8) -> DateValue {
    DateValue::exact_day(CivilDate::new(year, month, day).unwrap())
}

fn event(event_id: Uuid, owner: Uuid, event_type: EventType) -> Event {
    let mut row = Event::new(owner, event_type);
    row.id = event_id;
    row
}

fn snapshot<'a>(
    persons: &'a [Person],
    events: &'a [Event],
    relationships: &'a [Relationship],
    sources: &'a [Source],
    citations: &'a [Citation],
    media: &'a [Media],
) -> ProjectSnapshot<'a> {
    ProjectSnapshot {
        persons,
        events,
        relationships,
        sources,
        citations,
        media,
    }
}

fn merge_person(left: Uuid, right: Uuid) -> PersonDecision {
    PersonDecision {
        left_id: left,
        right_id: right,
        action: MergeAction::Merge,
        base: Side::Left,
        fields: BTreeMap::new(),
    }
}

fn keep_person(left: Uuid, right: Uuid) -> PersonDecision {
    PersonDecision {
        left_id: left,
        right_id: right,
        action: MergeAction::KeepBoth,
        base: Side::Left,
        fields: BTreeMap::new(),
    }
}

fn merge_event(left: Uuid, right: Uuid) -> EventDecision {
    EventDecision {
        left_event_id: left,
        right_event_id: right,
        action: MergeAction::Merge,
        base: Side::Left,
        fields: BTreeMap::new(),
    }
}

fn keep_event(left: Uuid, right: Uuid) -> EventDecision {
    EventDecision {
        left_event_id: left,
        right_event_id: right,
        action: MergeAction::KeepBoth,
        base: Side::Left,
        fields: BTreeMap::new(),
    }
}

fn has_evidence(matched: &PersonMatch, code: &str) -> bool {
    matched.evidence.iter().any(|row| row.code == code)
}

fn event_has_evidence(matched: &EventMatch, code: &str) -> bool {
    matched.evidence.iter().any(|row| row.code == code)
}

fn has_warning(warnings: &[MergeWarning], code: &str) -> bool {
    warnings.iter().any(|row| row.code == code)
}

fn output_error_count(output: &MergeOutput) -> usize {
    validate_project(ProjectSnapshot {
        persons: &output.persons,
        events: &output.events,
        relationships: &output.relationships,
        sources: &output.sources,
        citations: &output.citations,
        media: &output.media,
    })
    .counts
    .error
}

// ---------------------------------------------------------------------------
// Person matching
// ---------------------------------------------------------------------------

#[test]
fn exact_scoped_external_id_matches_across_different_names() {
    let mut left = person(id(1), "Иван", "Петров");
    left.external_ids = vec![ExternalId {
        source: "AT5".to_owned(),
        value: "42".to_owned(),
    }];
    let mut right = person(id(2), "Ivan", "Petroff");
    right.external_ids = vec![ExternalId {
        source: "AT5".to_owned(),
        value: "42".to_owned(),
    }];

    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    let matched = &preview.matches[0];
    assert_eq!(matched.confidence, MatchConfidence::High);
    assert_eq!(matched.id, format!("{}:{}", id(1), id(2)));
    let external = matched
        .evidence
        .iter()
        .find(|row| row.code == codes::EXTERNAL_ID)
        .expect("external id evidence");
    assert_eq!(
        external.params.get("scoped").map(String::as_str),
        Some("true")
    );
    assert_eq!(external.params.get("value").map(String::as_str), Some("42"));
    assert!(preview.unmatched_right.is_empty());
}

#[test]
fn external_ids_are_scoped_to_their_source() {
    // Same value, different source: AT5 and GEDCOM identifiers are local, so
    // this is not evidence. The names differ and the dates are unknown, so the
    // pair must not be suggested.
    let mut left = person(id(1), "Иван", "Петров");
    left.external_ids = vec![ExternalId {
        source: "AT5".to_owned(),
        value: "42".to_owned(),
    }];
    let mut right = person(id(2), "Иван", "Сидоров");
    right.external_ids = vec![ExternalId {
        source: "GEDCOM".to_owned(),
        value: "42".to_owned(),
    }];

    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert!(preview.matches.is_empty());
    assert!(preview.warnings.is_empty());
    assert_eq!(preview.unmatched_right.len(), 1);
}

#[test]
fn same_name_and_compatible_birth_matches() {
    // A year and a day inside it are compatible: comparisons use intervals.
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = day(1950, 5, 1);

    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    let matched = &preview.matches[0];
    assert_eq!(matched.confidence, MatchConfidence::High);
    assert!(has_evidence(matched, codes::SAME_FULL_NAME));
    let compatible = matched
        .evidence
        .iter()
        .find(|row| row.code == codes::COMPATIBLE_DATES)
        .expect("compatible dates evidence");
    assert_eq!(
        compatible.params.get("field").map(String::as_str),
        Some("birth")
    );
    assert_eq!(matched.field_diffs, vec!["birth".to_owned()]);
}

#[test]
fn unknown_births_keep_a_name_match_ambiguous() {
    // Both birth dates unknown: the name still suggests a pair, but the score
    // can only be 50, which is deliberately Ambiguous.
    let left = person(id(1), "Анна", "Иванова");
    let right = person(id(2), "Анна", "Иванова");
    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    assert_eq!(preview.matches[0].confidence, MatchConfidence::Ambiguous);
    assert!(has_evidence(&preview.matches[0], codes::SAME_FULL_NAME));

    // One known birth and one unknown is not a bound either; still Ambiguous.
    let mut known = person(id(3), "Анна", "Иванова");
    known.birth = year(1950);
    let unknown = person(id(4), "Анна", "Иванова");
    let known_people = [known];
    let unknown_people = [unknown];
    let preview = merge_preview(
        snapshot(&known_people, &[], &[], &[], &[], &[]),
        snapshot(&unknown_people, &[], &[], &[], &[], &[]),
    );
    assert_eq!(preview.matches.len(), 1);
    assert_eq!(preview.matches[0].confidence, MatchConfidence::Ambiguous);
}

#[test]
fn same_name_with_conflicting_birth_years_is_not_suggested() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = year(1962);

    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert!(preview.matches.is_empty());
    assert!(has_warning(&preview.warnings, codes::DATE_CONFLICT));
    assert_eq!(preview.unmatched_right.len(), 1);
}

#[test]
fn gender_conflict_is_not_suggested() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.gender = Gender::Female;
    left.birth = year(1950);
    let mut right = person(id(2), "Анна", "Иванова");
    right.gender = Gender::Male;
    right.birth = year(1950);

    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert!(preview.matches.is_empty());
    assert!(has_warning(&preview.warnings, codes::GENDER_CONFLICT));
}

#[test]
fn same_name_siblings_are_ambiguous_not_silently_merged() {
    let left_ivan = person(id(1), "Иван", "Петров");
    let left_brother = person(id(2), "Иван", "Петров");
    let right_ivan = person(id(3), "Иван", "Петров");
    let left_people = [left_ivan, left_brother];
    let right_people = [right_ivan];

    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    let matched = &preview.matches[0];
    assert_eq!(matched.confidence, MatchConfidence::Ambiguous);
    assert!(has_evidence(matched, codes::AMBIGUOUS_CANDIDATES));
    assert!(has_warning(&preview.warnings, codes::AMBIGUOUS_CANDIDATES));
    // The best pair is deterministic: the first left row wins.
    assert_eq!(matched.left.id, id(1));
    assert_eq!(preview.counts.ambiguous_people, 1);
}

#[test]
fn name_variants_are_compared_not_only_the_primary_one() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.names.push(Name {
        given: Some("Анна".to_owned()),
        surname: Some("Петрова".to_owned()),
        name_type: gentree_core::NameType::Married,
        is_primary: false,
        ..Name::default()
    });
    let mut right = person(id(2), "Анна", "Петрова");
    right.birth = DateValue::default();
    let left_people = [left];
    let right_people = [right];

    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    assert!(has_evidence(&preview.matches[0], codes::SAME_FULL_NAME));
}

#[test]
fn patronymic_typed_into_the_given_field_still_matches() {
    // One project keeps `given = "Мария Петровна"` and no patronymic, the other
    // splits the same three tokens into given and patronymic. They describe the
    // same person, so the suggestion must not be lost.
    let mut left = person(id(1), "Мария Петровна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Мария", "Иванова");
    right.names[0].patronymic = Some("Петровна".to_owned());
    right.birth = year(1950);
    let left_people = [left];
    let right_people = [right];

    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    let matched = &preview.matches[0];
    assert_eq!(matched.confidence, MatchConfidence::High);
    assert!(has_evidence(matched, codes::SAME_FULL_NAME));
    // Only the storage shape differs; the values themselves are equal.
    assert_eq!(matched.field_diffs, Vec::<String>::new());
}

#[test]
fn different_patronymic_is_not_a_full_name_match() {
    let mut left = person(id(1), "Мария Петровна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Мария", "Иванова");
    right.names[0].patronymic = Some("Сергеевна".to_owned());
    right.birth = year(1950);
    let left_people = [left];
    let right_people = [right];

    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 1);
    let matched = &preview.matches[0];
    assert_eq!(matched.confidence, MatchConfidence::Medium);
    assert!(has_evidence(matched, codes::SAME_NAME_PARTS));
    assert!(!has_evidence(matched, codes::SAME_FULL_NAME));
}

#[test]
fn shared_relative_adds_evidence_and_a_bonus() {
    let left_parent = person(id(1), "Иван", "Петров");
    let left_child = person(id(2), "Пётр", "Петров");
    let right_parent = person(id(11), "Иван", "Петров");
    let right_child = person(id(12), "Пётр", "Петров");
    let left_people = [left_parent, left_child];
    let right_people = [right_parent, right_child];
    let left_relationships =
        [Relationship::new(RelationshipType::ParentChild, id(1), id(2)).unwrap()];
    let right_relationships =
        [Relationship::new(RelationshipType::ParentChild, id(11), id(12)).unwrap()];

    let preview = merge_preview(
        snapshot(&left_people, &[], &left_relationships, &[], &[], &[]),
        snapshot(&right_people, &[], &right_relationships, &[], &[], &[]),
    );

    assert_eq!(preview.matches.len(), 2);
    for matched in &preview.matches {
        assert!(has_evidence(matched, codes::SHARED_RELATIVE));
    }
}

#[test]
fn unmatched_right_person_is_reported_and_copied() {
    let left_person = person(id(1), "Иван", "Петров");
    let right_person = person(id(2), "Мария", "Сидорова");
    let left_people = [left_person];
    let right_people = [right_person];

    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );
    assert!(preview.matches.is_empty());
    assert_eq!(preview.unmatched_right.len(), 1);
    assert_eq!(preview.unmatched_right[0].id, id(2));
    assert_eq!(preview.counts.right_people, 1);

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions::default(),
    )
    .expect("apply");

    assert_eq!(output.persons.len(), 2);
    assert_eq!(output.person_map.get(&id(2)), Some(&id(2)));
    assert_eq!(output.report.merged_people, 0);
    assert_eq!(output.report.kept_both_people, 0);
    assert_eq!(output.report.unmatched_right_people, 1);
}

// ---------------------------------------------------------------------------
// Apply: people
// ---------------------------------------------------------------------------

#[test]
fn keep_both_preserves_both_people_and_their_events() {
    let mut left = person(id(1), "Иван", "Петров");
    left.birth = year(1920);
    let mut right = person(id(2), "Иван", "Петров");
    right.birth = year(1920);

    let mut left_event = event(id(10), id(1), EventType::Birth);
    left_event.date = year(1920);
    let mut right_event = event(id(20), id(2), EventType::Birth);
    right_event.date = year(1920);

    let left_people = [left];
    let right_people = [right];
    let left_events = [left_event];
    let right_events = [right_event];

    let preview = merge_preview(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
    );
    assert_eq!(preview.matches.len(), 1);
    assert_eq!(preview.matches[0].event_matches.len(), 1);

    let decisions = MergeDecisions {
        persons: vec![keep_person(id(1), id(2))],
        events: vec![keep_event(id(10), id(20))],
    };
    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &decisions,
    )
    .expect("apply");

    assert_eq!(output.persons.len(), 2);
    assert_eq!(output.events.len(), 2);
    assert_eq!(output.person_map.get(&id(2)), Some(&id(2)));
    assert_eq!(output.event_map.get(&id(20)), Some(&id(20)));
    assert_eq!(output.report.kept_both_people, 1);
    assert_eq!(output.report.kept_both_events, 1);
    assert!(has_warning(
        &output.report.warnings,
        codes::PERSON_KEPT_BOTH
    ));
    assert!(has_warning(&output.report.warnings, codes::EVENT_KEPT_BOTH));
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn merge_unions_names_and_external_ids_and_respects_field_policies() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1980);
    left.notes = Some("заметка слева".to_owned());
    left.external_ids = vec![ExternalId {
        source: "AT5".to_owned(),
        value: "1".to_owned(),
    }];
    let mut married = name("Анна", "Петрова");
    married.name_type = gentree_core::NameType::Married;

    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = day(1980, 4, 1);
    right.death = year(2050);
    right.gender = Gender::Female;
    right.notes = Some("заметка справа".to_owned());
    right.names = vec![
        married,
        Name {
            given: Some("Анна".to_owned()),
            surname: Some("Иванова".to_owned()),
            is_primary: false,
            ..Name::default()
        },
    ];
    right.external_ids = vec![
        ExternalId {
            source: "AT5".to_owned(),
            value: "1".to_owned(),
        },
        ExternalId {
            source: "GEDCOM".to_owned(),
            value: "P1".to_owned(),
        },
    ];

    let left_people = [left];
    let right_people = [right];
    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );
    assert_eq!(preview.matches.len(), 1);
    // Left has no gender, right has Female, so the UI shows a gender diff.
    assert!(preview.matches[0]
        .field_diffs
        .contains(&"gender".to_owned()));
    assert!(preview.matches[0].field_diffs.contains(&"notes".to_owned()));

    let mut fields = BTreeMap::new();
    fields.insert("gender".to_owned(), FieldPolicy::Right);
    fields.insert("notes".to_owned(), FieldPolicy::Both);
    let decisions = MergeDecisions {
        persons: vec![PersonDecision {
            left_id: id(1),
            right_id: id(2),
            action: MergeAction::Merge,
            base: Side::Left,
            fields,
        }],
        events: Vec::new(),
    };

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &decisions,
    )
    .expect("apply");

    assert_eq!(output.persons.len(), 1);
    let merged = &output.persons[0];
    assert_eq!(merged.id, id(1));
    assert_eq!(merged.gender, Gender::Female);
    assert_eq!(merged.birth, year(1980));
    assert_eq!(merged.death, year(2050));
    assert_eq!(
        merged.notes.as_deref(),
        Some("заметка слева\n\nзаметка справа")
    );
    assert_eq!(merged.external_ids.len(), 2);
    assert_eq!(merged.names.iter().filter(|row| row.is_primary).count(), 1);
    assert_eq!(merged.names.len(), 2);
    assert_eq!(merged.display_name(), "Иванова Анна");
    assert_eq!(output.report.merged_people, 1);
    assert_eq!(output.person_map.get(&id(2)), Some(&id(1)));
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn notes_default_to_both_only_when_they_differ() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1980);
    left.notes = Some("одно и то же".to_owned());
    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = year(1980);
    right.notes = Some("одно и то же".to_owned());

    let left_people = [left];
    let right_people = [right];
    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect("apply");
    assert_eq!(output.persons[0].notes.as_deref(), Some("одно и то же"));

    // Right base with differing notes keeps the right text first.
    let mut left = person(id(3), "Анна", "Иванова");
    left.birth = year(1980);
    left.notes = Some("слева".to_owned());
    let mut right = person(id(4), "Анна", "Иванова");
    right.birth = year(1980);
    right.notes = Some("справа".to_owned());
    let left_people = [left];
    let right_people = [right];
    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![PersonDecision {
                base: Side::Right,
                ..merge_person(id(3), id(4))
            }],
            events: Vec::new(),
        },
    )
    .expect("apply");
    assert_eq!(output.persons[0].notes.as_deref(), Some("справа\n\nслева"));
}

#[test]
fn conflicting_birth_without_a_policy_is_a_structured_error() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = year(1960);

    let left_people = [left];
    let right_people = [right];
    let error = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect_err("conflicting births must not be resolved silently");

    assert_eq!(error.code, gentree_core::codes::MERGE_CONFLICT);
    assert_eq!(
        error.params.get("rule").map(String::as_str),
        Some("birthConflict")
    );
}

#[test]
fn explicit_policy_resolves_a_birth_conflict() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = year(1960);

    let left_people = [left];
    let right_people = [right];
    let mut fields = BTreeMap::new();
    fields.insert("birth".to_owned(), FieldPolicy::Right);
    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![PersonDecision {
                fields,
                ..merge_person(id(1), id(2))
            }],
            events: Vec::new(),
        },
    )
    .expect("explicit policy resolves the conflict");
    assert_eq!(output.persons[0].birth, year(1960));
}

#[test]
fn copied_rows_with_colliding_ids_get_deterministic_fresh_ids() {
    // A project merged with itself: ids collide everywhere. KeepBoth must not
    // produce duplicate ids, and repeating the apply must produce equal rows.
    let left_person = person(id(1), "Иван", "Петров");
    let right_person = person(id(1), "Иван", "Петров");
    let left_event = event(id(50), id(1), EventType::Residence);
    let right_event = event(id(50), id(1), EventType::Residence);

    let left_people = [left_person];
    let right_people = [right_person];
    let left_events = [left_event];
    let right_events = [right_event];
    let decisions = MergeDecisions {
        persons: vec![keep_person(id(1), id(1))],
        events: vec![keep_event(id(50), id(50))],
    };

    let first = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &decisions,
    )
    .expect("apply");
    let second = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &decisions,
    )
    .expect("apply");

    assert_eq!(first, second);
    assert_eq!(first.persons.len(), 2);
    let copied_person = first.persons[1].id;
    assert_ne!(copied_person, id(1));
    assert_eq!(first.person_map.get(&id(1)), Some(&copied_person));
    let copied_event = first.events[1].id;
    assert_ne!(copied_event, id(50));
    assert_eq!(first.events[1].person_id, copied_person);
    assert_eq!(output_error_count(&first), 0);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

fn matched_people() -> ([Person; 1], [Person; 1]) {
    let mut left = person(id(1), "Иван", "Петров");
    left.birth = year(1920);
    let mut right = person(id(2), "Иван", "Петров");
    right.birth = year(1920);
    ([left], [right])
}

#[test]
fn exact_event_duplicates_are_high_and_merge() {
    let (left_people, right_people) = matched_people();
    let mut left_event = event(id(10), id(1), EventType::Marriage);
    left_event.date = year(1945);
    left_event.place = Some("Москва".to_owned());
    left_event
        .details
        .insert("officiant".to_owned(), "Иванов".to_owned());
    let mut right_event = event(id(20), id(2), EventType::Marriage);
    right_event.date = year(1945);
    right_event.place = Some("Москва".to_owned());
    right_event
        .details
        .insert("officiant".to_owned(), "Иванов".to_owned());

    let left_events = [left_event];
    let right_events = [right_event];
    let preview = merge_preview(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
    );
    assert_eq!(preview.matches.len(), 1);
    assert_eq!(preview.matches[0].event_matches.len(), 1);
    let matched_event = &preview.matches[0].event_matches[0];
    assert_eq!(matched_event.confidence, MatchConfidence::High);
    assert!(event_has_evidence(matched_event, codes::SAME_EVENT_DATE));
    assert!(event_has_evidence(matched_event, codes::SAME_PLACE));
    assert!(matched_event.field_diffs.is_empty());

    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![merge_event(id(10), id(20))],
        },
    )
    .expect("apply");

    assert_eq!(output.events.len(), 1);
    assert_eq!(output.events[0].id, id(10));
    assert_eq!(output.event_map.get(&id(20)), Some(&id(10)));
    assert_eq!(output.report.merged_events, 1);
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn event_merge_applies_field_and_detail_policies() {
    let (left_people, right_people) = matched_people();
    let left_witness = person(id(3), "Свидетель", "Слева");
    let right_witness = person(id(4), "Свидетель", "Справа");

    let mut left_event = event(id(10), id(1), EventType::Residence);
    left_event.date = year(1990);
    left_event.place = Some("Москва".to_owned());
    left_event.description = Some("слева".to_owned());
    left_event
        .details
        .insert("address".to_owned(), "Ленина 1".to_owned());
    left_event
        .details
        .insert("floor".to_owned(), "2".to_owned());
    left_event.participant_ids = vec![id(3)];

    let mut right_event = event(id(20), id(2), EventType::Residence);
    right_event.date = day(1990, 6, 1);
    right_event.place = Some("Москва".to_owned());
    right_event.description = Some("справа".to_owned());
    right_event
        .details
        .insert("address".to_owned(), "Тверская 2".to_owned());
    right_event.participant_ids = vec![id(4)];

    let left_people = [left_people[0].clone(), left_witness];
    let right_people = [right_people[0].clone(), right_witness];
    let left_events = [left_event];
    let right_events = [right_event];

    let preview = merge_preview(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
    );
    // Different non-empty descriptions are deliberately not suggested.
    assert!(preview.matches[0].event_matches.is_empty());

    let mut fields = BTreeMap::new();
    fields.insert("date".to_owned(), FieldPolicy::Right);
    fields.insert("description".to_owned(), FieldPolicy::Both);
    fields.insert("details.address".to_owned(), FieldPolicy::Right);

    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![EventDecision {
                fields,
                ..merge_event(id(10), id(20))
            }],
        },
    )
    .expect("apply");

    let merged = &output.events[0];
    assert_eq!(merged.id, id(10));
    assert_eq!(merged.person_id, id(1));
    assert_eq!(merged.date, day(1990, 6, 1));
    assert_eq!(merged.place.as_deref(), Some("Москва"));
    assert_eq!(merged.description.as_deref(), Some("слева\n\nсправа"));
    assert_eq!(
        merged.details.get("address").map(String::as_str),
        Some("Тверская 2")
    );
    // A missing key is filled from the other side.
    assert_eq!(merged.details.get("floor").map(String::as_str), Some("2"));
    assert_eq!(merged.participant_ids.len(), 2);
    assert!(merged.participant_ids.contains(&id(3)));
    assert!(!merged.participant_ids.contains(&id(1)));
    let mapped_witness = output
        .person_map
        .get(&id(4))
        .copied()
        .expect("witness copy");
    assert!(merged.participant_ids.contains(&mapped_witness));
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn conflicting_event_dates_are_not_suggested_and_both_are_kept() {
    let (left_people, right_people) = matched_people();
    let mut left_event = event(id(10), id(1), EventType::Residence);
    left_event.date = year(1990);
    left_event.place = Some("Москва".to_owned());
    let mut right_event = event(id(20), id(2), EventType::Residence);
    right_event.date = year(1995);
    right_event.place = Some("Москва".to_owned());

    let left_events = [left_event];
    let right_events = [right_event];
    let preview = merge_preview(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
    );
    assert!(preview.matches[0].event_matches.is_empty());

    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![merge_event(id(10), id(20))],
        },
    );
    assert_eq!(
        error_rule(&output.expect_err("conflicting dates must not be merged")),
        Some("dateConflict")
    );

    // No decision: the right event is copied, never dropped.
    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect("apply");
    assert_eq!(output.events.len(), 2);
    assert_eq!(output.event_map.get(&id(20)), Some(&id(20)));
    assert_eq!(output.report.kept_both_events, 1);
}

fn error_rule(error: &gentree_core::AppError) -> Option<&str> {
    error.params.get("rule").map(String::as_str)
}

// ---------------------------------------------------------------------------
// Relationships, sources, citations, media
// ---------------------------------------------------------------------------

#[test]
fn relationships_are_remapped_deduped_and_type_conflicts_keep_the_left_edge() {
    let left_people = [
        person(id(1), "Иван", "Петров"),
        person(id(2), "Мария", "Петрова"),
        person(id(3), "Пётр", "Петров"),
    ];
    let right_people = [
        person(id(11), "Иван", "Петров"),
        person(id(12), "Мария", "Петрова"),
        person(id(13), "Пётр", "Петров"),
    ];
    let mut left_relationships = vec![
        Relationship::new(RelationshipType::Spouse, id(1), id(2)).unwrap(),
        Relationship::new(RelationshipType::ParentChild, id(3), id(1)).unwrap(),
    ];
    left_relationships[0].id = id(100);
    left_relationships[1].id = id(101);

    let mut right_relationships = vec![
        Relationship::new(RelationshipType::Spouse, id(11), id(12)).unwrap(),
        Relationship::new(RelationshipType::Partner, id(11), id(12)).unwrap(),
        Relationship::new(RelationshipType::ParentChild, id(13), id(11)).unwrap(),
        Relationship::new(RelationshipType::ParentChild, id(12), id(13)).unwrap(),
    ];
    right_relationships[0].id = id(200);
    right_relationships[1].id = id(201);
    right_relationships[2].id = id(202);
    right_relationships[3].id = id(203);

    let decisions = MergeDecisions {
        persons: vec![
            merge_person(id(1), id(11)),
            merge_person(id(2), id(12)),
            merge_person(id(3), id(13)),
        ],
        events: Vec::new(),
    };
    let output = apply_merge(
        snapshot(&left_people, &[], &left_relationships, &[], &[], &[]),
        snapshot(&right_people, &[], &right_relationships, &[], &[], &[]),
        &decisions,
    )
    .expect("apply");

    assert_eq!(output.relationships.len(), 3);
    assert_eq!(output.relationship_map.get(&id(200)), Some(&id(100)));
    assert_eq!(output.relationship_map.get(&id(201)), Some(&id(100)));
    assert_eq!(output.relationship_map.get(&id(202)), Some(&id(101)));
    assert_eq!(output.relationship_map.get(&id(203)), Some(&id(203)));
    assert!(has_warning(
        &output.report.warnings,
        codes::RELATIONSHIP_CONFLICT
    ));
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn merge_keeps_the_earliest_relationship_id_and_unions_provenance() {
    let left_people = [
        person(id(1), "Ivan", "Petrov"),
        person(id(2), "Maria", "Petrova"),
    ];
    let right_people = [
        person(id(11), "Ivan", "Petrov"),
        person(id(12), "Maria", "Petrova"),
    ];
    let mut left = Relationship::new(RelationshipType::Spouse, id(1), id(2)).unwrap();
    left.id = id(100);
    left.origin = RelationOrigin::Event;
    left.source_event_ids = vec![id(10)];
    let mut right = Relationship::new(RelationshipType::Spouse, id(11), id(12)).unwrap();
    right.id = id(200);
    right.origin = RelationOrigin::Event;
    right.source_event_ids = vec![id(20)];

    let output = apply_merge(
        snapshot(&left_people, &[], &[left], &[], &[], &[]),
        snapshot(&right_people, &[], &[right.clone()], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(11)), merge_person(id(2), id(12))],
            events: Vec::new(),
        },
    )
    .expect("apply");

    assert_eq!(output.relationships.len(), 1);
    let merged = &output.relationships[0];
    assert_eq!(merged.id, id(100));
    assert_eq!(merged.origin, RelationOrigin::Event);
    assert_eq!(merged.source_event_ids, vec![id(10), id(20)]);

    // A manual row on either side wins over an automatic row.
    let mut manual = right;
    manual.origin = RelationOrigin::Manual;
    manual.source_event_ids.clear();
    let output = apply_merge(
        snapshot(
            &left_people,
            &[],
            output.relationships.as_slice(),
            &[],
            &[],
            &[],
        ),
        snapshot(&right_people, &[], &[manual], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(11)), merge_person(id(2), id(12))],
            events: Vec::new(),
        },
    )
    .expect("apply");
    assert_eq!(output.relationships.len(), 1);
    assert_eq!(output.relationships[0].id, id(100));
    assert_eq!(output.relationships[0].origin, RelationOrigin::Manual);
    assert_eq!(
        output.relationships[0].source_event_ids,
        vec![id(10), id(20)]
    );
}

#[test]
fn a_relationship_cycle_aborts_apply() {
    let left_people = [
        person(id(1), "Иван", "Петров"),
        person(id(2), "Пётр", "Петров"),
    ];
    let right_people = [
        person(id(11), "Иван", "Петров"),
        person(id(12), "Пётр", "Петров"),
    ];
    let left_relationships =
        [Relationship::new(RelationshipType::ParentChild, id(1), id(2)).unwrap()];
    let right_relationships =
        [Relationship::new(RelationshipType::ParentChild, id(12), id(11)).unwrap()];

    let error = apply_merge(
        snapshot(&left_people, &[], &left_relationships, &[], &[], &[]),
        snapshot(&right_people, &[], &right_relationships, &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(11)), merge_person(id(2), id(12))],
            events: Vec::new(),
        },
    )
    .expect_err("a cycle must abort");

    assert_eq!(error.code, gentree_core::codes::RELATIONSHIP_CYCLE);
}

#[test]
fn sources_and_citations_are_remapped_without_dangling_references() {
    let mut left = person(id(1), "Иван", "Петров");
    left.birth = year(1900);
    let mut right = person(id(2), "Иван", "Петров");
    right.birth = year(1900);

    let mut left_source = Source::new("Метрическая книга").unwrap();
    left_source.id = id(100);
    let mut right_source = Source::new("  метрическая   КНИГА  ").unwrap();
    right_source.id = id(200);
    let mut other_source = Source::new("Исповедная ведомость").unwrap();
    other_source.id = id(201);

    let mut left_citation = Citation::new(id(100), CitationTarget::Person, id(1));
    left_citation.id = id(300);
    left_citation.page = Some("1".to_owned());
    let mut duplicate_citation = Citation::new(id(200), CitationTarget::Person, id(2));
    duplicate_citation.id = id(400);
    duplicate_citation.page = Some("1".to_owned());
    let mut extra_citation = Citation::new(id(201), CitationTarget::Person, id(2));
    extra_citation.id = id(401);
    let mut dropped_citation = Citation::new(id(201), CitationTarget::Relationship, id(999));
    dropped_citation.id = id(402);

    let left_people = [left];
    let right_people = [right];
    let left_sources = [left_source];
    let right_sources = [right_source, other_source];
    let left_citations = [left_citation];
    let right_citations = [duplicate_citation, extra_citation, dropped_citation];

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &left_sources, &left_citations, &[]),
        snapshot(
            &right_people,
            &[],
            &[],
            &right_sources,
            &right_citations,
            &[],
        ),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect("apply");

    assert_eq!(output.sources.len(), 2);
    assert_eq!(output.source_map.get(&id(200)), Some(&id(100)));
    assert_eq!(output.source_map.get(&id(201)), Some(&id(201)));
    // The exact duplicate is deduplicated; the extra one is copied.
    assert_eq!(output.citations.len(), 2);
    assert!(output.citations.iter().all(|row| row.source_id != id(200)));
    assert!(has_warning(
        &output.report.warnings,
        codes::CITATION_TARGET_DROPPED
    ));
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn media_links_are_remapped_and_identical_rows_are_deduplicated() {
    let mut left = person(id(1), "Иван", "Петров");
    left.birth = year(1900);
    let mut right = person(id(2), "Иван", "Петров");
    right.birth = year(1900);

    let mut left_source = Source::new("Метрическая книга").unwrap();
    left_source.id = id(100);
    let mut right_source = Source::new("Метрическая книга").unwrap();
    right_source.id = id(200);

    let checksum = "a".repeat(64);
    let left_media = Media {
        id: id(500),
        file_name: "scan.jpg".to_owned(),
        mime_type: "image/jpeg".to_owned(),
        checksum: checksum.clone(),
        caption: None,
        source_id: Some(id(100)),
        person_id: Some(id(1)),
        event_id: None,
        primary: false,
    };
    let mut duplicate_media = left_media.clone();
    duplicate_media.id = id(600);
    duplicate_media.person_id = Some(id(2));
    duplicate_media.source_id = Some(id(200));
    let mut other_media = left_media.clone();
    other_media.id = id(601);
    other_media.person_id = Some(id(2));
    other_media.source_id = Some(id(200));
    other_media.caption = Some("другой подписью".to_owned());

    let left_people = [left];
    let right_people = [right];
    let left_sources = [left_source];
    let right_sources = [right_source];
    let left_media = [left_media];
    let right_media = [duplicate_media, other_media];

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &left_sources, &[], &left_media),
        snapshot(&right_people, &[], &[], &right_sources, &[], &right_media),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect("apply");

    assert_eq!(output.media.len(), 2);
    assert_eq!(output.media_map.get(&id(600)), Some(&id(500)));
    assert_eq!(output.media_map.get(&id(601)), Some(&id(601)));
    let copied = output.media.iter().find(|row| row.id == id(601)).unwrap();
    assert_eq!(copied.person_id, Some(id(1)));
    assert_eq!(copied.source_id, Some(id(100)));
    assert_eq!(output_error_count(&output), 0);
}

#[test]
fn event_media_links_are_remapped_and_never_dangle() {
    let mut left = person(id(1), "Иван", "Петров");
    left.birth = year(1900);
    let mut right = person(id(2), "Иван", "Петров");
    right.birth = year(1900);

    let left_event = event(id(10), id(1), EventType::Birth);
    let right_event = event(id(20), id(2), EventType::Birth);

    let checksum = "c".repeat(64);
    let merged_link = Media {
        id: id(600),
        file_name: "certificate.pdf".to_owned(),
        mime_type: "application/pdf".to_owned(),
        checksum: checksum.clone(),
        caption: Some("synthetic certificate".to_owned()),
        source_id: None,
        person_id: None,
        event_id: Some(id(20)),
        primary: false,
    };
    // Same bytes and name as the row above, but attached to no event: the dedupe
    // key includes the event link, so this is a separate row, not a duplicate.
    let mut unlinked_copy = merged_link.clone();
    unlinked_copy.id = id(601);
    unlinked_copy.event_id = None;
    // A link to an event that is not part of the merge is dropped with a warning.
    let mut dangling_link = merged_link.clone();
    dangling_link.id = id(602);
    dangling_link.event_id = Some(id(999));
    dangling_link.caption = Some("synthetic attachment".to_owned());

    let left_people = [left];
    let right_people = [right];
    let left_events = [left_event];
    let right_events = [right_event];
    let right_media = [merged_link, unlinked_copy, dangling_link];

    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &right_media),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![merge_event(id(10), id(20))],
        },
    )
    .expect("apply");

    let merged = output.media.iter().find(|row| row.id == id(600)).unwrap();
    assert_eq!(merged.event_id, Some(id(10)));
    assert_eq!(merged.person_id, None);

    let unlinked = output.media.iter().find(|row| row.id == id(601)).unwrap();
    assert_eq!(unlinked.event_id, None);

    let dropped = output.media.iter().find(|row| row.id == id(602)).unwrap();
    assert_eq!(dropped.event_id, None);
    assert!(has_warning(
        &output.report.warnings,
        codes::REFERENCE_DROPPED
    ));

    // Every surviving link points at an event that exists in the output.
    for row in &output.media {
        if let Some(event_id) = row.event_id {
            assert!(output.events.iter().any(|event| event.id == event_id));
        }
    }
    assert_eq!(output_error_count(&output), 0);
}

// ---------------------------------------------------------------------------
// Report, determinism and validation
// ---------------------------------------------------------------------------

#[test]
fn report_counts_add_up() {
    let left_people = [person(id(1), "Иван", "Петров")];
    let right_people = [
        person(id(2), "Иван", "Петров"),
        person(id(3), "Мария", "Петрова"),
        person(id(4), "Пётр", "Сидоров"),
    ];

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2)), keep_person(id(1), id(3))],
            events: Vec::new(),
        },
    );
    assert!(
        output.is_err(),
        "two decisions cannot share the same left person"
    );

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect("apply");

    assert_eq!(output.report.merged_people, 1);
    assert_eq!(output.report.kept_both_people, 0);
    assert_eq!(output.report.unmatched_right_people, 2);
    assert_eq!(
        output.report.merged_people
            + output.report.kept_both_people
            + output.report.unmatched_right_people,
        right_people.len()
    );
    assert_eq!(output.persons.len(), 3);
}

#[test]
fn duplicate_decisions_are_rejected() {
    let left_people = [person(id(1), "Иван", "Петров")];
    let right_people = [person(id(2), "Иван", "Петров")];
    let error = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2)), merge_person(id(1), id(2))],
            events: Vec::new(),
        },
    )
    .expect_err("a right person may be decided once");
    assert_eq!(error_rule(&error), Some("duplicateRightPerson"));

    let error = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![PersonDecision {
                left_id: id(99),
                ..merge_person(id(1), id(2))
            }],
            events: Vec::new(),
        },
    )
    .expect_err("unknown ids are rejected");
    assert_eq!(error_rule(&error), Some("unknownPersonDecision"));
}

#[test]
fn applying_the_same_decisions_twice_is_deterministic() {
    let mut left = person(id(1), "Иван", "Петров");
    left.birth = year(1900);
    let mut right = person(id(2), "Иван", "Петров");
    right.birth = day(1900, 2, 2);
    let other_right = person(id(3), "Мария", "Петрова");

    let mut left_event = event(id(10), id(1), EventType::Birth);
    left_event.date = year(1900);
    let mut right_event = event(id(20), id(2), EventType::Birth);
    right_event.date = day(1900, 2, 2);
    let mut copied_event = event(id(30), id(3), EventType::Residence);
    copied_event.date = year(1950);

    let mut left_source = Source::new("Метрическая книга").unwrap();
    left_source.id = id(100);
    let mut right_source = Source::new("Метрическая книга").unwrap();
    right_source.id = id(200);
    let left_citation = Citation::new(id(100), CitationTarget::Event, id(10));
    let right_citation = Citation::new(id(200), CitationTarget::Event, id(20));

    let left_people = [left];
    let right_people = [right, other_right];
    let left_events = [left_event];
    let right_events = [right_event, copied_event];
    let left_sources = [left_source];
    let right_sources = [right_source];
    let left_citations = [left_citation];
    let right_citations = [right_citation];
    let decisions = MergeDecisions {
        persons: vec![merge_person(id(1), id(2))],
        events: vec![merge_event(id(10), id(20))],
    };

    let first = apply_merge(
        snapshot(
            &left_people,
            &left_events,
            &[],
            &left_sources,
            &left_citations,
            &[],
        ),
        snapshot(
            &right_people,
            &right_events,
            &[],
            &right_sources,
            &right_citations,
            &[],
        ),
        &decisions,
    )
    .expect("apply");
    let second = apply_merge(
        snapshot(
            &left_people,
            &left_events,
            &[],
            &left_sources,
            &left_citations,
            &[],
        ),
        snapshot(
            &right_people,
            &right_events,
            &[],
            &right_sources,
            &right_citations,
            &[],
        ),
        &decisions,
    )
    .expect("apply");

    assert_eq!(first, second);
    assert_eq!(first.report, second.report);
}

#[test]
fn json_contract_uses_camel_case_fields_and_readable_enum_values() {
    let mut left = person(id(1), "Анна", "Иванова");
    left.birth = year(1950);
    let mut right = person(id(2), "Анна", "Иванова");
    right.birth = year(1950);
    let left_people = [left];
    let right_people = [right];

    let preview = merge_preview(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
    );
    assert_eq!(preview.matches.len(), 1);
    let value = serde_json::to_value(&preview).expect("serialize preview");
    assert_eq!(value["matches"][0]["left"]["id"], id(1).to_string());
    assert_eq!(value["matches"][0]["confidence"], "High");
    assert_eq!(value["counts"]["matchedPeople"], 1);
    assert!(value["matches"][0]["eventMatches"].is_array());
    assert!(value["unmatchedRight"].is_array());
    assert!(value["warnings"].is_array());

    let mut fields = BTreeMap::new();
    fields.insert("notes".to_owned(), FieldPolicy::Both);
    let decisions = MergeDecisions {
        persons: vec![PersonDecision {
            left_id: id(1),
            right_id: id(2),
            action: MergeAction::Merge,
            base: Side::Left,
            fields,
        }],
        events: Vec::new(),
    };
    let value = serde_json::to_value(&decisions).expect("serialize decisions");
    assert_eq!(value["persons"][0]["action"], "Merge");
    assert_eq!(value["persons"][0]["base"], "Left");
    assert_eq!(value["persons"][0]["fields"]["notes"], "Both");

    let output = apply_merge(
        snapshot(&left_people, &[], &[], &[], &[], &[]),
        snapshot(&right_people, &[], &[], &[], &[], &[]),
        &decisions,
    )
    .expect("apply");
    let value = serde_json::to_value(&output).expect("serialize output");
    assert_eq!(value["report"]["mergedPeople"], 1);
    assert_eq!(value["personMap"][id(2).to_string()], id(1).to_string());
    assert!(value["relationshipMap"].is_object());
}

#[test]
fn realistic_merged_output_validates() {
    let mut left_father = person(id(1), "Иван", "Петров");
    left_father.birth = year(1900);
    let left_mother = person(id(2), "Мария", "Петрова");
    let mut left_child = person(id(3), "Пётр", "Петров");
    left_child.birth = year(1925);

    let mut right_father = person(id(11), "Иван", "Петров");
    right_father.birth = day(1900, 3, 3);
    right_father.external_ids = vec![ExternalId {
        source: "AT5".to_owned(),
        value: "1".to_owned(),
    }];
    let mut right_child = person(id(12), "Пётр", "Петров");
    right_child.birth = day(1925, 3, 10);

    let mut left_birth_event = event(id(30), id(3), EventType::Birth);
    left_birth_event.date = year(1925);
    let mut right_birth_event = event(id(40), id(12), EventType::Birth);
    right_birth_event.date = day(1925, 3, 10);
    let mut right_residence = event(id(41), id(12), EventType::Residence);
    right_residence.date = year(1950);
    right_residence.place = Some("Ленинград".to_owned());

    let left_relationships = [
        Relationship::new(RelationshipType::Spouse, id(1), id(2)).unwrap(),
        Relationship::new(RelationshipType::ParentChild, id(1), id(3)).unwrap(),
        Relationship::new(RelationshipType::ParentChild, id(2), id(3)).unwrap(),
    ];
    let right_relationships =
        [Relationship::new(RelationshipType::ParentChild, id(11), id(12)).unwrap()];

    let mut left_source = Source::new("Метрическая книга").unwrap();
    left_source.id = id(100);
    let mut right_source = Source::new("Домовая книга").unwrap();
    right_source.id = id(200);
    let left_citation = Citation::new(id(100), CitationTarget::Person, id(3));
    let right_citation = Citation::new(id(200), CitationTarget::Event, id(41));
    let media = Media {
        id: id(500),
        file_name: "scan.jpg".to_owned(),
        mime_type: "image/jpeg".to_owned(),
        checksum: "b".repeat(64),
        caption: None,
        source_id: Some(id(100)),
        person_id: Some(id(3)),
        event_id: None,
        primary: true,
    };

    let left_people = [left_father, left_mother, left_child];
    let right_people = [right_father, right_child];
    let left_events = [left_birth_event];
    let right_events = [right_birth_event, right_residence];
    let left_sources = [left_source];
    let right_sources = [right_source];
    let left_citations = [left_citation];
    let right_citations = [right_citation];
    let left_media = [media];

    let preview = merge_preview(
        snapshot(
            &left_people,
            &left_events,
            &left_relationships,
            &left_sources,
            &left_citations,
            &left_media,
        ),
        snapshot(
            &right_people,
            &right_events,
            &right_relationships,
            &right_sources,
            &right_citations,
            &[],
        ),
    );
    assert_eq!(preview.matches.len(), 2);

    let output = apply_merge(
        snapshot(
            &left_people,
            &left_events,
            &left_relationships,
            &left_sources,
            &left_citations,
            &left_media,
        ),
        snapshot(
            &right_people,
            &right_events,
            &right_relationships,
            &right_sources,
            &right_citations,
            &[],
        ),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(11)), merge_person(id(3), id(12))],
            events: vec![merge_event(id(30), id(40))],
        },
    )
    .expect("apply");

    let report = validate_project(ProjectSnapshot {
        persons: &output.persons,
        events: &output.events,
        relationships: &output.relationships,
        sources: &output.sources,
        citations: &output.citations,
        media: &output.media,
    });
    assert_eq!(report.counts.error, 0, "issues: {:?}", report.issues);
    assert_eq!(output.persons.len(), 3);
    assert_eq!(output.report.merged_people, 2);
    assert_eq!(output.report.merged_events, 1);
    assert_eq!(output.events.len(), 2);
}

// ---------------------------------------------------------------------------
// Event place points (ADR-0020)
// ---------------------------------------------------------------------------

fn point(lat: f64, lon: f64, source: PlaceSource) -> PlaceGeo {
    PlaceGeo {
        lat,
        lon,
        precision: PlacePrecision::Settlement,
        source,
        provider_ref: Some(format!("N{}", (lat * 10.0) as i64)),
        label: Some("Ивановка".to_owned()),
    }
}

#[test]
fn equal_place_text_with_different_points_needs_a_choice() {
    let (left_people, right_people) = matched_people();
    let mut left_event = event(id(10), id(1), EventType::Residence);
    left_event.date = year(1945);
    left_event.place = Some("Ивановка".to_owned());
    left_event.place_geo = Some(point(57.0, 49.0, PlaceSource::Photon));
    let mut right_event = event(id(20), id(2), EventType::Residence);
    right_event.date = year(1945);
    right_event.place = Some("Ивановка".to_owned());
    right_event.place_geo = Some(point(52.0, 42.0, PlaceSource::Dadata));

    let left_events = [left_event];
    let right_events = [right_event];
    let preview = merge_preview(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
    );
    let matched = &preview.matches[0].event_matches[0];
    assert!(matched.field_diffs.contains(&"placeGeo".to_owned()));
    assert!(!matched.field_diffs.contains(&"place".to_owned()));

    let mut fields = BTreeMap::new();
    fields.insert("placeGeo".to_owned(), FieldPolicy::Right);
    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![EventDecision {
                fields,
                ..merge_event(id(10), id(20))
            }],
        },
    )
    .expect("apply");

    let merged = &output.events[0];
    assert_eq!(merged.place.as_deref(), Some("Ивановка"));
    let merged_point = merged.place_geo.as_ref().expect("point");
    assert_eq!(merged_point.lat, 52.0);
    assert_eq!(merged_point.source, PlaceSource::Dadata);
}

#[test]
fn the_point_follows_the_chosen_place_side() {
    let (left_people, right_people) = matched_people();
    let mut left_event = event(id(10), id(1), EventType::Residence);
    left_event.date = year(1945);
    left_event.place = Some("Ивановка".to_owned());
    left_event.place_geo = Some(point(57.0, 49.0, PlaceSource::Photon));
    let mut right_event = event(id(20), id(2), EventType::Residence);
    right_event.date = year(1945);
    right_event.place = Some("Другая".to_owned());
    right_event.place_geo = Some(point(52.0, 42.0, PlaceSource::Photon));

    let left_events = [left_event];
    let right_events = [right_event];

    let mut fields = BTreeMap::new();
    fields.insert("place".to_owned(), FieldPolicy::Right);
    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![EventDecision {
                fields,
                ..merge_event(id(10), id(20))
            }],
        },
    )
    .expect("apply");

    let merged = &output.events[0];
    assert_eq!(merged.place.as_deref(), Some("Другая"));
    let merged_point = merged.place_geo.as_ref().expect("point");
    assert_eq!(merged_point.lat, 52.0);
}

#[test]
fn a_point_on_one_side_survives_a_merge_with_equal_text() {
    let (left_people, right_people) = matched_people();
    let mut left_event = event(id(10), id(1), EventType::Residence);
    left_event.date = year(1945);
    left_event.place = Some("Ивановка".to_owned());
    left_event.place_geo = Some(point(57.0, 49.0, PlaceSource::Photon));
    let mut right_event = event(id(20), id(2), EventType::Residence);
    right_event.date = year(1945);
    right_event.place = Some("Ивановка".to_owned());

    let left_events = [left_event];
    let right_events = [right_event];
    let preview = merge_preview(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
    );
    assert!(preview.matches[0].event_matches[0].field_diffs.is_empty());

    let output = apply_merge(
        snapshot(&left_people, &left_events, &[], &[], &[], &[]),
        snapshot(&right_people, &right_events, &[], &[], &[], &[]),
        &MergeDecisions {
            persons: vec![merge_person(id(1), id(2))],
            events: vec![merge_event(id(10), id(20))],
        },
    )
    .expect("apply");

    let merged_point = output.events[0].place_geo.as_ref().expect("point");
    assert_eq!(merged_point.lat, 57.0);
}
