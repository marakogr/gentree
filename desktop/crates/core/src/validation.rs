//! Project-level validation and deletion planning.
//!
//! Contracts: domain invariants and deletion semantics. The module is pure:
//! no I/O, no mutation, and no user-facing
//! strings. [`ValidationIssue::params`] carries stable identifiers only; the UI
//! maps `code`/`params` through its own dictionaries.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{codes, AppError};
use crate::person::Person;
use crate::record::{Citation, CitationTarget, Event, EventType, Media, Source};
use crate::relationship::{Relationship, RelationshipSet};

/// Issue code: an id occurs more than once, within or across collections.
pub const DUPLICATE_ID: &str = "DUPLICATE_ID";
/// Issue code: a reference points at an entity that is not in the snapshot.
pub const DANGLING_REFERENCE: &str = "DANGLING_REFERENCE";
/// Issue code: an event date falls outside the owner's birth/death interval.
pub const EVENT_OUT_OF_LIFESPAN: &str = "EVENT_OUT_OF_LIFESPAN";
/// Issue code: a person has more than one `BIRTH` or `DEATH` event.
///
/// Birth and death are single events of a life; residence, occupation, education
/// and other event types may legitimately repeat.
pub const DUPLICATE_LIFE_EVENT: &str = "DUPLICATE_LIFE_EVENT";
/// Error code: a create/update would add a second `BIRTH` or `DEATH` event to
/// the same person. Existing duplicates stay editable, but no new one is
/// accepted; imports and merges write rows directly and only warn.
pub const LIFE_EVENT_ALREADY_EXISTS: &str = "LIFE_EVENT_ALREADY_EXISTS";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub severity: Severity,
    pub entity_ids: Vec<Uuid>,
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueCounts {
    pub error: usize,
    pub warning: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub checked_at: String,
    pub issues: Vec<ValidationIssue>,
    pub counts: IssueCounts,
}

impl ValidationReport {
    /// True when the report contains no `ERROR` issue; warnings do not block.
    pub fn is_valid(&self) -> bool {
        self.counts.error == 0
    }
}

/// Borrowed view of one project's domain data. The caller owns the vectors;
/// validation never mutates them.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectSnapshot<'a> {
    pub persons: &'a [Person],
    pub events: &'a [Event],
    pub relationships: &'a [Relationship],
    pub sources: &'a [Source],
    pub citations: &'a [Citation],
    pub media: &'a [Media],
}

/// Validate a whole project snapshot. Issue order is deterministic: duplicate
/// ids (sorted by id), dangling references (collection order), relationship
/// invariants, per-entity validation, duplicate life events, then lifespan
/// warnings.
pub fn validate_project(snapshot: ProjectSnapshot<'_>) -> ValidationReport {
    let mut issues = Vec::new();
    issues.extend(duplicate_id_issues(&snapshot));
    issues.extend(dangling_reference_issues(&snapshot));
    issues.extend(relationship_issues(snapshot.relationships));
    issues.extend(entity_issues(&snapshot));
    issues.extend(duplicate_life_event_issues(&snapshot));
    issues.extend(lifespan_issues(&snapshot));

    let counts = IssueCounts {
        error: issues
            .iter()
            .filter(|issue| issue.severity == Severity::Error)
            .count(),
        warning: issues
            .iter()
            .filter(|issue| issue.severity == Severity::Warning)
            .count(),
    };

    ValidationReport {
        checked_at: crate::now_rfc3339(),
        issues,
        counts,
    }
}

fn record_id(seen: &mut BTreeMap<Uuid, Vec<&'static str>>, id: Uuid, kind: &'static str) {
    seen.entry(id).or_default().push(kind);
}

fn duplicate_id_issues(snapshot: &ProjectSnapshot<'_>) -> Vec<ValidationIssue> {
    let mut seen: BTreeMap<Uuid, Vec<&'static str>> = BTreeMap::new();
    for person in snapshot.persons {
        record_id(&mut seen, person.id, "person");
    }
    for event in snapshot.events {
        record_id(&mut seen, event.id, "event");
    }
    for relationship in snapshot.relationships {
        record_id(&mut seen, relationship.id, "relationship");
    }
    for source in snapshot.sources {
        record_id(&mut seen, source.id, "source");
    }
    for citation in snapshot.citations {
        record_id(&mut seen, citation.id, "citation");
    }
    for media in snapshot.media {
        record_id(&mut seen, media.id, "media");
    }

    seen.into_iter()
        .filter(|(_, kinds)| kinds.len() > 1)
        .map(|(id, mut kinds)| {
            kinds.sort_unstable();
            let mut params = BTreeMap::new();
            params.insert("count".to_owned(), kinds.len().to_string());
            params.insert("kinds".to_owned(), kinds.join(","));
            ValidationIssue {
                code: DUPLICATE_ID.to_owned(),
                severity: Severity::Error,
                entity_ids: vec![id],
                params,
            }
        })
        .collect()
}

fn dangling_issue(
    target_kind: &str,
    missing_id: Uuid,
    field: &str,
    entity_id: Uuid,
) -> ValidationIssue {
    let mut params = BTreeMap::new();
    params.insert("kind".to_owned(), target_kind.to_owned());
    params.insert("id".to_owned(), missing_id.to_string());
    params.insert("field".to_owned(), field.to_owned());
    ValidationIssue {
        code: DANGLING_REFERENCE.to_owned(),
        severity: Severity::Error,
        entity_ids: vec![entity_id],
        params,
    }
}

fn dangling_reference_issues(snapshot: &ProjectSnapshot<'_>) -> Vec<ValidationIssue> {
    let person_ids: HashSet<Uuid> = snapshot.persons.iter().map(|person| person.id).collect();
    let event_ids: HashSet<Uuid> = snapshot.events.iter().map(|event| event.id).collect();
    let relationship_ids: HashSet<Uuid> = snapshot
        .relationships
        .iter()
        .map(|relationship| relationship.id)
        .collect();
    let source_ids: HashSet<Uuid> = snapshot.sources.iter().map(|source| source.id).collect();
    let media_ids: HashSet<Uuid> = snapshot.media.iter().map(|media| media.id).collect();

    let mut issues = Vec::new();

    for relationship in snapshot.relationships {
        if !person_ids.contains(&relationship.person_id) {
            issues.push(dangling_issue(
                "person",
                relationship.person_id,
                "personId",
                relationship.id,
            ));
        }
        if !person_ids.contains(&relationship.related_person_id) {
            issues.push(dangling_issue(
                "person",
                relationship.related_person_id,
                "relatedPersonId",
                relationship.id,
            ));
        }
    }

    for event in snapshot.events {
        if !person_ids.contains(&event.person_id) {
            issues.push(dangling_issue(
                "person",
                event.person_id,
                "personId",
                event.id,
            ));
        }
        for source_id in &event.source_ids {
            if !source_ids.contains(source_id) {
                issues.push(dangling_issue("source", *source_id, "sourceIds", event.id));
            }
        }
    }

    for citation in snapshot.citations {
        if !source_ids.contains(&citation.source_id) {
            issues.push(dangling_issue(
                "source",
                citation.source_id,
                "sourceId",
                citation.id,
            ));
        }
        let (target_kind, known) = match citation.target_type {
            CitationTarget::Person => ("person", &person_ids),
            CitationTarget::Event => ("event", &event_ids),
            CitationTarget::Relationship => ("relationship", &relationship_ids),
            CitationTarget::Media => ("media", &media_ids),
        };
        if !known.contains(&citation.target_id) {
            issues.push(dangling_issue(
                target_kind,
                citation.target_id,
                "targetId",
                citation.id,
            ));
        }
    }

    for media in snapshot.media {
        if let Some(source_id) = media.source_id {
            if !source_ids.contains(&source_id) {
                issues.push(dangling_issue("source", source_id, "sourceId", media.id));
            }
        }
        // A person link may predate media unlinking on person deletion (kept as
        // is, ADR-0018); an event link is new, so it is always checked.
        if let Some(event_id) = media.event_id {
            if !event_ids.contains(&event_id) {
                issues.push(dangling_issue("event", event_id, "eventId", media.id));
            }
        }
    }

    issues
}

/// The same invariants as [`RelationshipSet::new`] (self-link, canonical spouse
/// order, duplicates, parent cycles), applied row by row so every offending row
/// is reported instead of only the first one.
fn relationship_issues(rows: &[Relationship]) -> Vec<ValidationIssue> {
    let mut set = RelationshipSet::default();
    let mut issues = Vec::new();
    for row in rows {
        if let Err(error) = set.push(row.clone()) {
            let AppError {
                code, mut params, ..
            } = error;
            params
                .entry("personId".to_owned())
                .or_insert_with(|| row.person_id.to_string());
            params
                .entry("relatedPersonId".to_owned())
                .or_insert_with(|| row.related_person_id.to_string());
            issues.push(ValidationIssue {
                code,
                severity: Severity::Error,
                entity_ids: vec![row.id],
                params,
            });
        }
    }
    issues
}

fn issue_from_validation(error: AppError, entity_id: Uuid) -> ValidationIssue {
    ValidationIssue {
        code: codes::VALIDATION_ERROR.to_owned(),
        severity: Severity::Error,
        entity_ids: vec![entity_id],
        params: error.params,
    }
}

fn push_validation(
    issues: &mut Vec<ValidationIssue>,
    entity_id: Uuid,
    result: crate::error::AppResult<()>,
) {
    if let Err(error) = result {
        issues.push(issue_from_validation(error, entity_id));
    }
}

/// Per-entity checks. Media checksum format and empty source titles are covered
/// by [`Media::validate`] and [`Source::validate`] respectively.
fn entity_issues(snapshot: &ProjectSnapshot<'_>) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    for person in snapshot.persons {
        push_validation(&mut issues, person.id, person.validate());
    }
    for event in snapshot.events {
        push_validation(&mut issues, event.id, event.validate());
    }
    for source in snapshot.sources {
        push_validation(&mut issues, source.id, source.validate());
    }
    for citation in snapshot.citations {
        push_validation(&mut issues, citation.id, citation.validate());
    }
    for media in snapshot.media {
        push_validation(&mut issues, media.id, media.validate());
    }
    issues
}

/// Rejects an event whose date falls outside the person's known life span.
///
/// Only bounds the data actually has are used: an unknown birth or death date
/// never invents a limit. Death and burial may happen at/after the death bound
/// (and must not precede the birth bound); every other type must not precede
/// the birth or reach the death bound. A blank event date is always allowed.
pub fn ensure_event_within_lifespan(person: &Person, candidate: &Event) -> crate::AppResult<()> {
    let Some(start) = candidate.date.start else {
        return Ok(());
    };
    let bound = match candidate.event_type {
        EventType::Death | EventType::Burial => person
            .birth
            .start
            .filter(|birth| start < *birth)
            .map(|_| "birth"),
        _ => person
            .birth
            .start
            .filter(|birth| start < *birth)
            .map(|_| "birth")
            .or_else(|| {
                person
                    .death
                    .end
                    .filter(|death_end| start >= *death_end)
                    .map(|_| "death")
            }),
    };
    let Some(bound) = bound else {
        return Ok(());
    };
    Err(AppError::new(
        EVENT_OUT_OF_LIFESPAN,
        "Event date is outside the person's life span",
    )
    .with_param("personId", candidate.person_id.to_string())
    .with_param("eventId", candidate.id.to_string())
    .with_param("bound", bound.to_owned()))
}

/// Rejects a life event that contradicts the other one already stored.
///
/// Birth and death may repeat in legacy data, so the check compares the new
/// row with every stored life event of the same person: a birth after a known
/// death, or a death before a known birth, is incompatible. `replaced` is the
/// row an update overwrites and never counts as its own counterpart.
pub fn ensure_life_events_compatible(
    existing: &[Event],
    candidate: &Event,
    replaced: Option<Uuid>,
) -> crate::AppResult<()> {
    if !matches!(candidate.event_type, EventType::Birth | EventType::Death) {
        return Ok(());
    }
    let Some(start) = candidate.date.start else {
        return Ok(());
    };
    let counterpart = match candidate.event_type {
        EventType::Birth => EventType::Death,
        _ => EventType::Birth,
    };
    let conflicting = existing.iter().any(|event| {
        Some(event.id) != replaced
            && event.id != candidate.id
            && event.event_type == counterpart
            && event.person_id == candidate.person_id
            && event.date.start.is_some_and(|other| {
                if counterpart == EventType::Death {
                    start > other
                } else {
                    start < other
                }
            })
    });
    if !conflicting {
        return Ok(());
    }
    let bound = if candidate.event_type == EventType::Birth {
        "death"
    } else {
        "birth"
    };
    Err(
        AppError::new(EVENT_OUT_OF_LIFESPAN, "Life events contradict each other")
            .with_param("personId", candidate.person_id.to_string())
            .with_param("eventId", candidate.id.to_string())
            .with_param("bound", bound.to_owned()),
    )
}

/// Rejects a new `BIRTH` or `DEATH` event for a person who already owns one.
///
/// The create/update commands call this so the rule is enforced where rows are
/// written by hand; imports and merges bypass it and remain warnings in
/// [`validate_project`]. `replaced` is the row an update overwrites, which must
/// not count as its own duplicate.
pub fn ensure_single_life_event(
    existing: &[Event],
    candidate: &Event,
    replaced: Option<Uuid>,
) -> crate::AppResult<()> {
    let event_type = match candidate.event_type {
        EventType::Birth => "BIRTH",
        EventType::Death => "DEATH",
        _ => return Ok(()),
    };
    let duplicate = existing.iter().any(|event| {
        Some(event.id) != replaced
            && event.id != candidate.id
            && event.event_type == candidate.event_type
            && event.person_id == candidate.person_id
    });
    if !duplicate {
        return Ok(());
    }
    Err(AppError::new(
        LIFE_EVENT_ALREADY_EXISTS,
        "A person can have only one birth and one death event",
    )
    .with_param("personId", candidate.person_id.to_string())
    .with_param("eventType", event_type.to_owned()))
}

/// Warn when one person owns more than one `BIRTH` or `DEATH` event.
///
/// Only those two types are unique: a person is born once and dies once.
/// Residence, occupation, education and the remaining types may repeat, so they
/// are never reported here even when a person has several of them.
fn duplicate_life_event_issues(snapshot: &ProjectSnapshot<'_>) -> Vec<ValidationIssue> {
    let mut groups: BTreeMap<(Uuid, &'static str), Vec<Uuid>> = BTreeMap::new();
    for event in snapshot.events {
        let event_type = match event.event_type {
            EventType::Birth => "BIRTH",
            EventType::Death => "DEATH",
            _ => continue,
        };
        groups
            .entry((event.person_id, event_type))
            .or_default()
            .push(event.id);
    }

    groups
        .into_iter()
        .filter(|(_, event_ids)| event_ids.len() > 1)
        .map(|((person_id, event_type), mut event_ids)| {
            event_ids.sort_unstable();
            let mut params = BTreeMap::new();
            params.insert("personId".to_owned(), person_id.to_string());
            params.insert("eventType".to_owned(), event_type.to_owned());
            params.insert("count".to_owned(), event_ids.len().to_string());
            let mut entity_ids = vec![person_id];
            entity_ids.extend(event_ids);
            ValidationIssue {
                code: DUPLICATE_LIFE_EVENT.to_owned(),
                severity: Severity::Warning,
                entity_ids,
                params,
            }
        })
        .collect()
}

/// Warn when an event lies wholly before the owner's birth or at/after the
/// owner's death. Unknown and open-ended dates are never invented into a bound:
/// the check only runs on bounds the data actually has.
fn lifespan_issues(snapshot: &ProjectSnapshot<'_>) -> Vec<ValidationIssue> {
    let persons: BTreeMap<Uuid, &Person> = snapshot
        .persons
        .iter()
        .map(|person| (person.id, person))
        .collect();

    let mut issues = Vec::new();
    for event in snapshot.events {
        let Some(person) = persons.get(&event.person_id) else {
            // Dangling references are reported separately.
            continue;
        };
        // Death and burial legitimately happen at/after the death bound.
        if matches!(event.event_type, EventType::Death | EventType::Burial) {
            continue;
        }
        let date = &event.date;
        let before_birth = person
            .birth
            .start
            .is_some_and(|birth| match (date.start, date.end) {
                (_, Some(end)) => end <= birth,
                (Some(start), None) => start < birth,
                (None, None) => false,
            });
        let after_death = person
            .death
            .end
            .is_some_and(|death_end| date.start.is_some_and(|start| start >= death_end));

        let bound = if before_birth {
            "birth"
        } else if after_death {
            "death"
        } else {
            continue;
        };

        let mut params = BTreeMap::new();
        params.insert("personId".to_owned(), person.id.to_string());
        params.insert("eventId".to_owned(), event.id.to_string());
        params.insert("bound".to_owned(), bound.to_owned());
        issues.push(ValidationIssue {
            code: EVENT_OUT_OF_LIFESPAN.to_owned(),
            severity: Severity::Warning,
            entity_ids: vec![event.id, person.id],
            params,
        });
    }
    issues
}

/// Deletion plan for one person (ADR-0009 §delete).
///
/// Relationships touching the person are removed. An event owned by the person
/// is removed when there are no co-participants; an event with co-participants
/// survives, the person is detached and the first co-participant becomes the
/// owner (handled by the caller with [`Event::detach_person`]). Citations whose
/// target is one of the removed entities are removed too. Media rows and files
/// are untouched: a media *link* is not the file, and unlinking is a separate
/// operation.
///
/// Returns an empty plan when `person_id` is absent from `persons`; callers
/// resolve the person before planning a delete.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPlan {
    pub removed_persons: Vec<Uuid>,
    /// Events that have nobody left after detaching the person.
    pub removed_event_ids: Vec<Uuid>,
    pub removed_relationship_ids: Vec<Uuid>,
    pub removed_citation_ids: Vec<Uuid>,
    /// Events that reference the person but survive because other participants
    /// remain. The caller must detach the person from each of them.
    pub kept_event_ids: Vec<Uuid>,
}

/// Plan the rows to delete when `person_id` is removed, without mutating the
/// input slices. See [`RemovalPlan`] for the exact rules.
pub fn removal_plan(
    person_id: Uuid,
    persons: &[Person],
    events: &[Event],
    relationships: &[Relationship],
    citations: &[Citation],
) -> RemovalPlan {
    if !persons.iter().any(|person| person.id == person_id) {
        return RemovalPlan::default();
    }

    let mut removed_event_ids = Vec::new();
    let mut kept_event_ids = Vec::new();
    for event in events {
        if !event.involves(person_id) {
            continue;
        }
        if event.person_id == person_id && event.participant_ids.is_empty() {
            removed_event_ids.push(event.id);
        } else {
            kept_event_ids.push(event.id);
        }
    }

    let mut removed_relationship_ids = Vec::new();
    for relationship in relationships {
        if relationship.person_id == person_id || relationship.related_person_id == person_id {
            removed_relationship_ids.push(relationship.id);
        }
    }

    let removed_events: HashSet<Uuid> = removed_event_ids.iter().copied().collect();
    let removed_relationships: HashSet<Uuid> = removed_relationship_ids.iter().copied().collect();
    let mut removed_citation_ids = Vec::new();
    for citation in citations {
        let target_removed = match citation.target_type {
            CitationTarget::Person => citation.target_id == person_id,
            CitationTarget::Event => removed_events.contains(&citation.target_id),
            CitationTarget::Relationship => removed_relationships.contains(&citation.target_id),
            CitationTarget::Media => false,
        };
        if target_removed {
            removed_citation_ids.push(citation.id);
        }
    }

    RemovalPlan {
        removed_persons: vec![person_id],
        removed_event_ids,
        removed_relationship_ids,
        removed_citation_ids,
        kept_event_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::{CivilDate, DateValue};
    use crate::person::{Gender, Name};
    use crate::record::EventType;

    fn uuid(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    fn name(given: &str, surname: &str) -> Name {
        Name {
            given: Some(given.into()),
            surname: Some(surname.into()),
            is_primary: true,
            ..Name::default()
        }
    }

    fn person_named(
        id: Uuid,
        given: &str,
        surname: &str,
        birth: Option<i32>,
        death: Option<i32>,
    ) -> Person {
        Person {
            id,
            gender: Gender::Unknown,
            names: vec![name(given, surname)],
            birth: birth.map(DateValue::exact_year).unwrap_or_default(),
            death: death.map(DateValue::exact_year).unwrap_or_default(),
            notes: None,
            external_ids: Vec::new(),
        }
    }

    fn person(id: Uuid, birth: Option<i32>, death: Option<i32>) -> Person {
        person_named(id, "Ivan", "Petrov", birth, death)
    }

    fn source(id: Uuid, title: &str) -> Source {
        Source {
            id,
            title: title.into(),
            author: None,
            publication: None,
            repository: None,
            url: None,
            notes: None,
        }
    }

    fn event(id: Uuid, person_id: Uuid, event_type: EventType, date: DateValue) -> Event {
        Event {
            id,
            person_id,
            event_type,
            date,
            place: None,
            place_geo: None,
            description: None,
            source_ids: Vec::new(),
            original_type: None,
            participant_ids: Vec::new(),
            details: std::collections::BTreeMap::new(),
        }
    }

    fn media(id: Uuid, checksum: String, source_id: Option<Uuid>) -> Media {
        Media {
            id,
            file_name: "scan.jpg".into(),
            mime_type: "image/jpeg".into(),
            checksum,
            caption: None,
            source_id,
            person_id: None,
            event_id: None,
            primary: false,
        }
    }

    #[test]
    fn clean_project_is_valid() {
        let person_id = uuid(1);
        let source_id = uuid(2);
        let persons = vec![person(person_id, Some(1950), Some(2000))];
        let sources = vec![source(source_id, "Parish register")];
        let mut birth = event(
            uuid(3),
            person_id,
            EventType::Birth,
            DateValue::exact_year(1950),
        );
        birth.source_ids = vec![source_id];
        let events = vec![birth];
        let citations = vec![Citation::new(source_id, CitationTarget::Person, person_id)];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            relationships: &[],
            sources: &sources,
            citations: &citations,
            media: &[],
        });

        assert!(report.is_valid(), "{report:?}");
        assert!(report.issues.is_empty(), "{report:?}");
        assert_eq!(
            report.counts,
            IssueCounts {
                error: 0,
                warning: 0
            }
        );
        assert!(!report.checked_at.is_empty());
    }

    #[test]
    fn duplicate_id_is_reported() {
        let id = uuid(1);
        let persons = vec![person(id, None, None), person(id, None, None)];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, DUPLICATE_ID);
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(issue.entity_ids, vec![id]);
        assert_eq!(issue.params.get("count").map(String::as_str), Some("2"));
        assert_eq!(
            issue.params.get("kinds").map(String::as_str),
            Some("person,person")
        );
    }

    #[test]
    fn dangling_event_person_is_reported() {
        let missing = uuid(9);
        let persons = vec![person(uuid(1), None, None)];
        let events = vec![event(
            missing,
            missing,
            EventType::Birth,
            DateValue::default(),
        )];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, DANGLING_REFERENCE);
        assert_eq!(issue.entity_ids, vec![events[0].id]);
        assert_eq!(issue.params.get("kind").map(String::as_str), Some("person"));
        assert_eq!(
            issue.params.get("id").map(String::as_str),
            Some(missing.to_string().as_str())
        );
        assert_eq!(
            issue.params.get("field").map(String::as_str),
            Some("personId")
        );
    }

    #[test]
    fn dangling_citation_target_is_reported() {
        let source_id = uuid(2);
        let missing = uuid(9);
        let persons = vec![person(uuid(1), None, None)];
        let sources = vec![source(source_id, "Parish register")];
        let citations = vec![Citation::new(source_id, CitationTarget::Person, missing)];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            sources: &sources,
            citations: &citations,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, DANGLING_REFERENCE);
        assert_eq!(issue.entity_ids, vec![citations[0].id]);
        assert_eq!(issue.params.get("kind").map(String::as_str), Some("person"));
        assert_eq!(
            issue.params.get("field").map(String::as_str),
            Some("targetId")
        );
    }

    #[test]
    fn relationship_cycle_is_mapped_to_issue() {
        let a = uuid(1);
        let b = uuid(2);
        let c = uuid(3);
        let persons = vec![
            person(a, None, None),
            person(b, None, None),
            person(c, None, None),
        ];
        let relationships = vec![
            Relationship::new(crate::relationship::RelationshipType::ParentChild, a, b).unwrap(),
            Relationship::new(crate::relationship::RelationshipType::ParentChild, b, c).unwrap(),
            Relationship::new(crate::relationship::RelationshipType::ParentChild, c, a).unwrap(),
        ];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            relationships: &relationships,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, codes::RELATIONSHIP_CYCLE);
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(issue.entity_ids, vec![relationships[2].id]);
        assert!(issue.params.contains_key("personId"));
        assert!(issue.params.contains_key("relatedPersonId"));
    }

    #[test]
    fn event_outside_lifespan_is_a_warning() {
        let person_id = uuid(1);
        let persons = vec![person(person_id, Some(1950), Some(1980))];
        let events = vec![
            event(
                uuid(10),
                person_id,
                EventType::Residence,
                DateValue::exact_year(1940),
            ),
            event(
                uuid(11),
                person_id,
                EventType::Occupation,
                DateValue::exact_year(1990),
            ),
        ];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            ..ProjectSnapshot::default()
        });

        assert!(report.is_valid(), "{report:?}");
        assert_eq!(report.counts.warning, 2, "{report:?}");
        assert_eq!(report.issues[0].code, EVENT_OUT_OF_LIFESPAN);
        assert_eq!(report.issues[0].severity, Severity::Warning);
        assert_eq!(
            report.issues[0].params.get("bound").map(String::as_str),
            Some("birth")
        );
        assert_eq!(
            report.issues[1].params.get("bound").map(String::as_str),
            Some("death")
        );
        for issue in &report.issues {
            assert_eq!(issue.entity_ids.len(), 2);
        }
    }

    #[test]
    fn duplicate_birth_and_death_events_are_warnings() {
        let person_id = uuid(1);
        let persons = vec![person(person_id, Some(1950), Some(2000))];
        let events = vec![
            event(
                uuid(10),
                person_id,
                EventType::Birth,
                DateValue::exact_year(1950),
            ),
            event(
                uuid(11),
                person_id,
                EventType::Birth,
                DateValue::exact_year(1950),
            ),
            event(
                uuid(12),
                person_id,
                EventType::Death,
                DateValue::exact_year(2000),
            ),
            event(
                uuid(13),
                person_id,
                EventType::Death,
                DateValue::exact_year(2000),
            ),
        ];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            ..ProjectSnapshot::default()
        });

        assert!(report.is_valid(), "{report:?}");
        assert_eq!(report.counts.warning, 2, "{report:?}");
        for (event_type, expected) in [
            ("BIRTH", [uuid(10), uuid(11)]),
            ("DEATH", [uuid(12), uuid(13)]),
        ] {
            let issue = report
                .issues
                .iter()
                .find(|issue| issue.params.get("eventType").map(String::as_str) == Some(event_type))
                .unwrap_or_else(|| panic!("missing {event_type} issue: {report:?}"));
            assert_eq!(issue.code, DUPLICATE_LIFE_EVENT);
            assert_eq!(issue.severity, Severity::Warning);
            assert_eq!(issue.params.get("count").map(String::as_str), Some("2"));
            assert_eq!(
                issue.params.get("personId").map(String::as_str),
                Some(person_id.to_string().as_str())
            );
            assert_eq!(
                issue.entity_ids,
                [vec![person_id], expected.to_vec()].concat()
            );
        }
    }

    #[test]
    fn a_second_create_of_a_life_event_is_refused_but_editing_itself_is_not() {
        let person_id = uuid(1);
        let existing = event(
            uuid(10),
            person_id,
            EventType::Birth,
            DateValue::exact_year(1950),
        );
        let events = vec![existing.clone()];

        // A new row with another id would be the second birth of this person.
        let second = event(
            uuid(11),
            person_id,
            EventType::Birth,
            DateValue::exact_year(1951),
        );
        let error = ensure_single_life_event(&events, &second, None).expect_err("duplicate");
        assert_eq!(error.code, LIFE_EVENT_ALREADY_EXISTS);
        assert_eq!(
            error.params.get("eventType").map(String::as_str),
            Some("BIRTH")
        );

        // Saving the existing birth (its own slot) stays allowed.
        assert!(ensure_single_life_event(&events, &existing, Some(existing.id)).is_ok());
        // Another event type or another person is never blocked.
        let residence = event(
            uuid(12),
            person_id,
            EventType::Residence,
            DateValue::exact_year(1960),
        );
        assert!(ensure_single_life_event(&events, &residence, None).is_ok());
        let other = event(
            uuid(13),
            uuid(2),
            EventType::Birth,
            DateValue::exact_year(1950),
        );
        assert!(ensure_single_life_event(&events, &other, None).is_ok());
    }

    #[test]
    fn an_event_outside_the_known_life_span_is_refused() {
        let person_id = uuid(1);
        let person = person(person_id, Some(1950), Some(1980));
        let before = event(
            uuid(10),
            person_id,
            EventType::Residence,
            DateValue::exact_year(1940),
        );
        let error = ensure_event_within_lifespan(&person, &before).expect_err("too early");
        assert_eq!(error.code, EVENT_OUT_OF_LIFESPAN);
        assert_eq!(error.params.get("bound").map(String::as_str), Some("birth"));

        let after = event(
            uuid(11),
            person_id,
            EventType::Occupation,
            DateValue::exact_year(1990),
        );
        let error = ensure_event_within_lifespan(&person, &after).expect_err("too late");
        assert_eq!(error.params.get("bound").map(String::as_str), Some("death"));

        // Death and burial legitimately reach or pass the death bound.
        for (id, event_type, year) in [
            (uuid(12), EventType::Death, 1980),
            (uuid(13), EventType::Burial, 1981),
        ] {
            let event = event(id, person_id, event_type, DateValue::exact_year(year));
            assert!(ensure_event_within_lifespan(&person, &event).is_ok());
        }
        // A blank date is never invented into a violation.
        let undated = event(
            uuid(14),
            person_id,
            EventType::Residence,
            DateValue::default(),
        );
        assert!(ensure_event_within_lifespan(&person, &undated).is_ok());
    }

    #[test]
    fn birth_after_death_and_death_before_birth_are_refused() {
        let person_id = uuid(1);
        let birth = event(
            uuid(10),
            person_id,
            EventType::Birth,
            DateValue::exact_year(1950),
        );
        let death = event(
            uuid(11),
            person_id,
            EventType::Death,
            DateValue::exact_year(1980),
        );
        let events = vec![birth.clone(), death.clone()];

        let late_birth = event(
            uuid(12),
            person_id,
            EventType::Birth,
            DateValue::exact_year(1990),
        );
        let error = ensure_life_events_compatible(&events, &late_birth, None)
            .expect_err("birth after death");
        assert_eq!(error.code, EVENT_OUT_OF_LIFESPAN);
        assert_eq!(error.params.get("bound").map(String::as_str), Some("death"));

        let early_death = event(
            uuid(13),
            person_id,
            EventType::Death,
            DateValue::exact_year(1940),
        );
        assert!(ensure_life_events_compatible(&events, &early_death, None).is_err());

        // Saving an existing row does not conflict with itself.
        assert!(ensure_life_events_compatible(&events, &birth, Some(birth.id)).is_ok());
        // A non-life event is never compared.
        let residence = event(
            uuid(14),
            person_id,
            EventType::Residence,
            DateValue::exact_year(1990),
        );
        assert!(ensure_life_events_compatible(&events, &residence, None).is_ok());
    }

    #[test]
    fn repeated_residence_and_occupation_events_are_allowed() {
        let person_id = uuid(1);
        let persons = vec![person(person_id, Some(1950), Some(2000))];
        let events = vec![
            event(
                uuid(10),
                person_id,
                EventType::Residence,
                DateValue::exact_year(1960),
            ),
            event(
                uuid(11),
                person_id,
                EventType::Residence,
                DateValue::exact_year(1970),
            ),
            event(
                uuid(12),
                person_id,
                EventType::Occupation,
                DateValue::exact_year(1965),
            ),
            event(
                uuid(13),
                person_id,
                EventType::Occupation,
                DateValue::exact_year(1975),
            ),
        ];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            ..ProjectSnapshot::default()
        });

        assert!(
            !report
                .issues
                .iter()
                .any(|issue| issue.code == DUPLICATE_LIFE_EVENT),
            "{report:?}"
        );
    }

    #[test]
    fn invalid_date_is_mapped_to_validation_error() {
        let person_id = uuid(1);
        let persons = vec![person(person_id, None, None)];
        let mut date = DateValue::unknown(None);
        date.start = Some(CivilDate::new(1950, 1, 1).unwrap());
        let events = vec![event(uuid(10), person_id, EventType::Birth, date)];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, codes::VALIDATION_ERROR);
        assert_eq!(issue.entity_ids, vec![events[0].id]);
        assert_eq!(issue.params.get("field").map(String::as_str), Some("date"));
        assert_eq!(
            issue.params.get("rule").map(String::as_str),
            Some("unknownHasBounds")
        );
    }

    #[test]
    fn media_checksum_and_empty_source_title_are_errors() {
        let source_id = uuid(2);
        let sources = vec![source(source_id, "   ")];
        let media = vec![
            media(uuid(10), "abc".into(), Some(source_id)),
            media(uuid(11), "a".repeat(64), Some(source_id)),
        ];

        let report = validate_project(ProjectSnapshot {
            sources: &sources,
            media: &media,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 2, "{report:?}");
        assert!(report.issues.iter().any(|issue| {
            issue.code == codes::VALIDATION_ERROR
                && issue.params.get("field").map(String::as_str) == Some("title")
                && issue.params.get("rule").map(String::as_str) == Some("required")
        }));
        assert!(report.issues.iter().any(|issue| {
            issue.code == codes::VALIDATION_ERROR
                && issue.entity_ids == vec![media[0].id]
                && issue.params.get("field").map(String::as_str) == Some("checksum")
        }));
    }

    #[test]
    fn dangling_event_media_link_is_reported() {
        let person_id = uuid(1);
        let persons = vec![person(person_id, None, None)];
        let event = event(
            uuid(3),
            person_id,
            EventType::Birth,
            DateValue::exact_year(1900),
        );
        let mut linked = media(uuid(10), "a".repeat(64), None);
        linked.event_id = Some(event.id);
        let mut dangling = media(uuid(11), "b".repeat(64), None);
        dangling.event_id = Some(uuid(99));

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: std::slice::from_ref(&event),
            media: &[linked, dangling],
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, DANGLING_REFERENCE);
        assert_eq!(issue.entity_ids, vec![uuid(11)]);
        assert_eq!(issue.params.get("kind").map(String::as_str), Some("event"));
        assert_eq!(
            issue.params.get("field").map(String::as_str),
            Some("eventId")
        );
        assert_eq!(issue.params.get("id"), Some(&uuid(99).to_string()));
    }

    #[test]
    fn death_before_birth_is_an_error() {
        let persons = vec![person(uuid(1), Some(1960), Some(1950))];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let issue = &report.issues[0];
        assert_eq!(issue.code, codes::VALIDATION_ERROR);
        assert_eq!(issue.entity_ids, vec![persons[0].id]);
        assert_eq!(issue.params.get("field").map(String::as_str), Some("death"));
        assert_eq!(
            issue.params.get("rule").map(String::as_str),
            Some("beforeBirth")
        );
    }

    #[test]
    fn removal_plan_removes_owned_rows_and_keeps_unrelated() {
        let a = uuid(1);
        let b = uuid(2);
        let c = uuid(4);
        let persons = vec![
            person(a, None, None),
            person(b, None, None),
            person(c, None, None),
        ];
        let owned = event(uuid(10), a, EventType::Birth, DateValue::default());
        let unrelated = event(uuid(11), b, EventType::Birth, DateValue::default());
        let events = vec![owned.clone(), unrelated.clone()];
        let touching =
            Relationship::new(crate::relationship::RelationshipType::Spouse, a, b).unwrap();
        let unrelated_relationship =
            Relationship::new(crate::relationship::RelationshipType::ParentChild, b, c).unwrap();
        let relationships = vec![touching.clone(), unrelated_relationship.clone()];
        let source_id = uuid(3);
        let citations = vec![
            Citation::new(source_id, CitationTarget::Person, a),
            Citation::new(source_id, CitationTarget::Event, owned.id),
            Citation::new(source_id, CitationTarget::Relationship, touching.id),
            Citation::new(source_id, CitationTarget::Event, unrelated.id),
            Citation::new(
                source_id,
                CitationTarget::Relationship,
                unrelated_relationship.id,
            ),
        ];

        let plan = removal_plan(a, &persons, &events, &relationships, &citations);

        assert_eq!(plan.removed_persons, vec![a]);
        assert_eq!(plan.removed_event_ids, vec![owned.id]);
        assert!(plan.kept_event_ids.is_empty());
        assert_eq!(plan.removed_relationship_ids, vec![touching.id]);
        assert_eq!(
            plan.removed_citation_ids,
            vec![citations[0].id, citations[1].id, citations[2].id]
        );
        assert!(!plan.removed_event_ids.contains(&unrelated.id));
        assert!(!plan
            .removed_relationship_ids
            .contains(&unrelated_relationship.id));
    }

    #[test]
    fn removal_plan_for_unknown_person_is_empty() {
        let persons = vec![person(uuid(1), None, None)];
        let events = vec![event(
            uuid(10),
            uuid(9),
            EventType::Birth,
            DateValue::default(),
        )];

        let plan = removal_plan(uuid(9), &persons, &events, &[], &[]);

        assert_eq!(plan, RemovalPlan::default());
    }

    #[test]
    fn report_serializes_to_camel_case_without_cyrillic() {
        let persons = vec![person_named(uuid(1), "Иван", "Петров", Some(1950), None)];
        let sources = vec![source(uuid(2), "   ")];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            sources: &sources,
            ..ProjectSnapshot::default()
        });

        assert_eq!(report.counts.error, 1, "{report:?}");
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("checkedAt").is_some());
        assert!(json.get("checked_at").is_none());
        assert_eq!(json["counts"]["error"], 1);
        assert_eq!(json["counts"]["warning"], 0);
        assert!(json["issues"][0].get("entityIds").is_some());
        assert!(json["issues"][0].get("params").is_some());

        let text = serde_json::to_string(&report).unwrap();
        assert!(
            !text.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "{text}"
        );
    }

    #[test]
    fn death_and_burial_are_not_out_of_lifespan() {
        let person_id = uuid(1);
        let persons = vec![person(person_id, Some(1950), Some(1980))];
        let events = vec![
            event(
                uuid(10),
                person_id,
                EventType::Death,
                DateValue::exact_year(1980),
            ),
            event(
                uuid(11),
                person_id,
                EventType::Burial,
                DateValue::exact_year(1981),
            ),
        ];

        let report = validate_project(ProjectSnapshot {
            persons: &persons,
            events: &events,
            ..ProjectSnapshot::default()
        });

        assert!(report.is_valid(), "{report:?}");
        assert_eq!(report.counts.warning, 0, "{report:?}");
    }
}
