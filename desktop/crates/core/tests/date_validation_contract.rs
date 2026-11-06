//! Contract tests for the date validation rules (issue #79).
//!
//! Synthetic data only. Each test mirrors a scenario in
//! `openspec/changes/date-validation-rules/specs/data-validation/spec.md`.

use gentree_core::{
    ensure_event_within_lifespan, ensure_life_events_compatible, ensure_parent_child_age_gap,
    ensure_residence_ranges_do_not_overlap, validate_project, CivilDate, DatePrecision,
    DateQualifier, DateValue, Event, EventType, Gender, Name, Person, ProjectSnapshot,
    Relationship, RelationshipType, Severity, EVENT_OUT_OF_LIFESPAN, PARENT_CHILD_AGE_GAP,
    RESIDENCE_RANGE_OVERLAP,
};
use uuid::Uuid;

fn id(value: u128) -> Uuid {
    Uuid::from_u128(value)
}

fn day(year: i32, month: u8, day: u8) -> DateValue {
    DateValue::exact_day(CivilDate::new(year, month, day).unwrap())
}

fn open_range(start: CivilDate) -> DateValue {
    DateValue {
        start: Some(start),
        end: None,
        precision: DatePrecision::Year,
        qualifier: DateQualifier::Range,
        original: None,
    }
}

fn person(id: Uuid, birth: DateValue) -> Person {
    Person {
        id,
        gender: Gender::Unknown,
        names: vec![Name {
            given: Some("Synthetic".to_owned()),
            ..Name::default()
        }],
        birth,
        death: DateValue::default(),
        notes: None,
        external_ids: Vec::new(),
    }
}

fn event(id: Uuid, person_id: Uuid, event_type: EventType, date: DateValue) -> Event {
    let mut event = Event::new(person_id, event_type);
    event.id = id;
    event.date = date;
    event
}

fn residence(id: Uuid, person_id: Uuid, date: DateValue) -> Event {
    event(id, person_id, EventType::Residence, date)
}

// --- Open-ended residence -------------------------------------------------

#[test]
fn ongoing_residence_round_trips_without_inventing_an_end() {
    let person_id = id(1);
    let open = residence(
        id(10),
        person_id,
        open_range(CivilDate::new(1950, 1, 1).unwrap()),
    );
    open.validate()
        .expect("residence accepts a range without an end");

    let json = serde_json::to_value(&open).unwrap();
    let back: Event = serde_json::from_value(json).unwrap();
    assert_eq!(back.date.start, open.date.start);
    assert!(back.date.end.is_none());
    assert_eq!(back.date.precision, DatePrecision::Year);
    assert_eq!(back.date.qualifier, DateQualifier::Range);
}

#[test]
fn closed_range_and_unknown_date_are_unchanged() {
    let mut closed = residence(id(10), id(1), DateValue::exact_year(1950));
    closed.date.end = Some(CivilDate::new(1961, 1, 1).unwrap());
    closed.date.qualifier = DateQualifier::Range;
    closed.validate().unwrap();
    assert!(closed.date.end.is_some());

    let unknown = residence(id(11), id(1), DateValue::default());
    unknown.validate().unwrap();
    assert!(unknown.date.start.is_none() && unknown.date.end.is_none());
}

#[test]
fn open_range_is_rejected_outside_residence() {
    let open = open_range(CivilDate::new(1950, 1, 1).unwrap());
    let birth = event(id(10), id(1), EventType::Birth, open.clone());
    assert!(birth.validate().is_err());

    let mut person = person(id(1), open);
    person.id = id(1);
    assert!(person.validate().is_err());
}

// --- Residence overlap ----------------------------------------------------

#[test]
fn manual_overlap_is_rejected_and_adjacency_is_allowed() {
    let person_id = id(1);
    let first = residence(id(10), person_id, DateValue::exact_year(1950));

    let overlapping = residence(id(11), person_id, DateValue::exact_year(1950));
    let error =
        ensure_residence_ranges_do_not_overlap(std::slice::from_ref(&first), &overlapping, None)
            .expect_err("overlap");
    assert_eq!(error.code, RESIDENCE_RANGE_OVERLAP);
    assert!(error.params.contains_key("personId"));
    assert!(error.params.contains_key("eventId"));
    assert!(error.params.contains_key("otherEventId"));

    let adjacent = residence(id(12), person_id, DateValue::exact_year(1951));
    ensure_residence_ranges_do_not_overlap(&[first], &adjacent, None).unwrap();
}

#[test]
fn open_end_and_open_start_extend_to_infinity() {
    let person_id = id(1);
    let open = residence(
        id(10),
        person_id,
        open_range(CivilDate::new(1970, 1, 1).unwrap()),
    );
    let later = residence(id(11), person_id, DateValue::exact_year(1980));
    assert!(ensure_residence_ranges_do_not_overlap(&[open], &later, None).is_err());

    let mut before = residence(
        id(12),
        person_id,
        DateValue::before(CivilDate::new(1980, 1, 1).unwrap()),
    );
    before.date.precision = DatePrecision::Year;
    let open = residence(
        id(13),
        person_id,
        open_range(CivilDate::new(1970, 1, 1).unwrap()),
    );
    assert!(ensure_residence_ranges_do_not_overlap(&[before], &open, None).is_err());
}

#[test]
fn unknown_residence_date_is_not_compared_and_legacy_overlap_only_warns() {
    let person = person(id(1), DateValue::exact_year(1900));
    let first = residence(id(10), id(1), DateValue::exact_year(1950));
    let second = residence(id(11), id(1), DateValue::exact_year(1950));
    let unknown = residence(id(12), id(1), DateValue::default());
    ensure_residence_ranges_do_not_overlap(&[unknown], &first, None).unwrap();

    let report = validate_project(ProjectSnapshot {
        persons: std::slice::from_ref(&person),
        events: &[first, second],
        ..ProjectSnapshot::default()
    });
    assert!(report.is_valid(), "legacy findings must not be errors");
    assert_eq!(report.counts.error, 0);
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.code == RESIDENCE_RANGE_OVERLAP)
        .expect("overlap warning");
    assert_eq!(issue.severity, Severity::Warning);
}

// --- Birth ordering -------------------------------------------------------

#[test]
fn same_year_and_same_month_are_not_before_birth() {
    let by_month = person(
        id(1),
        DateValue::exact_month(CivilDate::new(1950, 5, 1).unwrap()),
    );
    let by_day = person(id(2), day(1950, 5, 10));

    assert!(ensure_event_within_lifespan(
        &by_month,
        &residence(id(10), id(1), DateValue::exact_year(1950))
    )
    .is_ok());
    assert!(ensure_event_within_lifespan(
        &by_day,
        &residence(
            id(11),
            id(2),
            DateValue::exact_month(CivilDate::new(1950, 5, 1).unwrap())
        )
    )
    .is_ok());
    assert!(
        ensure_event_within_lifespan(&by_day, &residence(id(12), id(2), day(1950, 5, 10))).is_ok()
    );
}

#[test]
fn exact_earlier_date_and_earlier_year_are_before_birth() {
    let by_day = person(id(1), day(1950, 5, 10));
    let by_year = person(id(2), DateValue::exact_year(1950));

    let error = ensure_event_within_lifespan(&by_day, &residence(id(10), id(1), day(1950, 5, 9)))
        .expect_err("earlier day");
    assert_eq!(error.code, EVENT_OUT_OF_LIFESPAN);
    assert_eq!(error.params.get("bound").map(String::as_str), Some("birth"));

    let error = ensure_event_within_lifespan(
        &by_year,
        &residence(id(11), id(2), DateValue::exact_year(1949)),
    )
    .expect_err("earlier year");
    assert_eq!(error.code, EVENT_OUT_OF_LIFESPAN);
}

#[test]
fn open_ended_and_ranged_starts_before_birth_are_rejected() {
    let person = person(id(1), DateValue::exact_year(1950));
    let open = residence(
        id(10),
        id(1),
        open_range(CivilDate::new(1940, 1, 1).unwrap()),
    );
    let error = ensure_event_within_lifespan(&person, &open).expect_err("open start before birth");
    assert_eq!(error.code, EVENT_OUT_OF_LIFESPAN);

    let mut ranged = residence(id(11), id(1), DateValue::exact_year(1948));
    ranged.date.end = Some(CivilDate::new(1961, 1, 1).unwrap());
    ranged.date.qualifier = DateQualifier::Range;
    assert!(ensure_event_within_lifespan(&person, &ranged).is_err());
}

#[test]
fn open_ended_start_unit_containing_the_birth_is_accepted() {
    let person = person(
        id(1),
        DateValue::exact_month(CivilDate::new(1950, 5, 1).unwrap()),
    );
    let open = residence(
        id(10),
        id(1),
        open_range(CivilDate::new(1950, 1, 1).unwrap()),
    );
    ensure_event_within_lifespan(&person, &open).unwrap();
}

#[test]
fn unknown_dates_skip_birth_ordering() {
    let dated_person = person(id(1), DateValue::exact_year(1950));
    let unknown = residence(id(10), id(1), DateValue::default());
    ensure_event_within_lifespan(&dated_person, &unknown).unwrap();

    let undated_person = person(id(2), DateValue::default());
    let dated = residence(id(11), id(2), DateValue::exact_year(1900));
    ensure_event_within_lifespan(&undated_person, &dated).unwrap();
}

#[test]
fn birth_and_death_contradiction_stays_on_whole_intervals() {
    let person_id = id(1);
    let birth = event(
        id(10),
        person_id,
        EventType::Birth,
        DateValue::exact_year(1950),
    );
    let death = event(
        id(11),
        person_id,
        EventType::Death,
        DateValue::exact_year(1950),
    );
    ensure_life_events_compatible(std::slice::from_ref(&death), &birth, None).unwrap();
    ensure_life_events_compatible(std::slice::from_ref(&birth), &death, None).unwrap();

    let late_birth = event(
        id(12),
        person_id,
        EventType::Birth,
        DateValue::exact_year(1981),
    );
    let early_death = event(
        id(13),
        person_id,
        EventType::Death,
        DateValue::exact_year(1900),
    );
    assert!(ensure_life_events_compatible(&[early_death], &late_birth, None).is_err());

    let late_death = event(
        id(14),
        person_id,
        EventType::Death,
        DateValue::exact_year(1900),
    );
    let early_birth = event(
        id(15),
        person_id,
        EventType::Birth,
        DateValue::exact_year(1981),
    );
    assert!(ensure_life_events_compatible(&[early_birth], &late_death, None).is_err());
}

// --- Parent age -----------------------------------------------------------

#[test]
fn parent_must_be_at_least_eleven_years_older() {
    let parent = person(id(1), day(1900, 1, 1));
    let nine = person(id(2), day(1909, 1, 1));
    let ten = person(id(3), day(1910, 1, 1));
    let ten_and_364 = person(id(4), day(1910, 12, 31));
    let eleven = person(id(5), day(1911, 1, 1));
    let older = person(id(6), day(1930, 1, 1));

    for too_young in [&nine, &ten, &ten_and_364] {
        let error = ensure_parent_child_age_gap(RelationshipType::ParentChild, &parent, too_young)
            .expect_err("less than eleven years");
        assert_eq!(error.code, PARENT_CHILD_AGE_GAP);
        assert_eq!(error.params.get("minYears").map(String::as_str), Some("11"));
    }
    ensure_parent_child_age_gap(RelationshipType::ParentChild, &parent, &eleven).unwrap();
    ensure_parent_child_age_gap(RelationshipType::ParentChild, &parent, &older).unwrap();
}

#[test]
fn unknown_births_and_adoption_skip_the_age_gap() {
    let parent = person(id(1), day(1900, 1, 1));
    let child = person(id(2), day(1904, 1, 1));
    let unknown = person(id(3), DateValue::default());

    ensure_parent_child_age_gap(RelationshipType::ParentChild, &parent, &unknown).unwrap();
    ensure_parent_child_age_gap(RelationshipType::ParentChild, &unknown, &child).unwrap();
    ensure_parent_child_age_gap(RelationshipType::AdoptiveParentChild, &parent, &child).unwrap();
}

#[test]
fn legacy_age_gap_is_reported_as_a_warning() {
    let parent = person(id(1), day(1900, 1, 1));
    let child = person(id(2), day(1905, 1, 1));
    let relationship = Relationship::new(RelationshipType::ParentChild, id(1), id(2)).unwrap();

    let report = validate_project(ProjectSnapshot {
        persons: &[parent, child],
        relationships: std::slice::from_ref(&relationship),
        ..ProjectSnapshot::default()
    });

    assert!(report.is_valid());
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.code == PARENT_CHILD_AGE_GAP)
        .expect("age-gap warning");
    assert_eq!(issue.severity, Severity::Warning);
    assert!(issue.params.contains_key("parentId"));
    assert!(issue.params.contains_key("childId"));
}

// --- No retroactive rewrite ----------------------------------------------

#[test]
fn validation_does_not_rewrite_legacy_rows() {
    let person = person(id(1), DateValue::exact_year(1900));
    let first = residence(id(10), id(1), DateValue::exact_year(1950));
    let second = residence(id(11), id(1), DateValue::exact_year(1950));
    let before = serde_json::to_string(&(person.clone(), first.clone(), second.clone())).unwrap();

    let report = validate_project(ProjectSnapshot {
        persons: std::slice::from_ref(&person),
        events: &[first.clone(), second.clone()],
        ..ProjectSnapshot::default()
    });

    let after = serde_json::to_string(&(person, first, second)).unwrap();
    assert_eq!(before, after);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == RESIDENCE_RANGE_OVERLAP));
}
