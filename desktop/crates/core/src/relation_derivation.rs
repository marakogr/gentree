//! Derive kinship rows from the life events that assert them.
//!
//! A marriage with exactly two people asserts a spouse row; a birth with one or
//! two participants asserts parent rows. The functions here are pure domain
//! code: they never read or write storage and never localize text.
//!
//! Provenance is additive: rows created here carry [`RelationOrigin::Event`]
//! and every event id that currently asserts the pair. Manual rows are never
//! re-typed, rewritten or deleted.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;
use crate::person::{Gender, Person};
use crate::record::{Event, EventType};
use crate::relationship::{RelationOrigin, Relationship, RelationshipSet, RelationshipType};
use crate::validation::ensure_parent_child_age_gap;

/// Result of reconciling one event with the relationship collection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DerivationReport {
    pub created: usize,
    pub annotated: usize,
    pub retracted: usize,
}

/// Aggregate result of the project-open backfill. It never carries ids, names,
/// dates, places or paths.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationBackfillReport {
    pub spouse_created: usize,
    pub parent_created: usize,
    pub ambiguous_skipped: usize,
    /// Missing `BIRTH`/`DEATH` events created from the person's own dates.
    pub life_events_created: usize,
    /// Biological parents added to an existing child birth event.
    pub parents_added: usize,
    /// Empty patronymics filled from an already-stored biological father.
    pub patronymics_filled: usize,
    pub read_only: bool,
}

impl RelationBackfillReport {
    #[must_use]
    pub fn has_changes(self) -> bool {
        self.spouse_created > 0
            || self.parent_created > 0
            || self.life_events_created > 0
            || self.parents_added > 0
            || self.patronymics_filled > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DesiredKind {
    Spouse,
    ParentChild,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct PairKey {
    kind: DesiredKind,
    person: Uuid,
    related: Uuid,
}

#[derive(Debug, Clone, Copy)]
struct DesiredPair {
    key: PairKey,
    rel_type: RelationshipType,
}

impl DesiredPair {
    fn matches(self, row: &Relationship) -> bool {
        match self.key.kind {
            DesiredKind::Spouse => {
                row.rel_type.is_spouse()
                    && same_unordered_pair(row, self.key.person, self.key.related)
            }
            DesiredKind::ParentChild => {
                row.rel_type.is_parent()
                    && row.person_id == self.key.person
                    && row.related_person_id == self.key.related
            }
        }
    }
}

fn same_unordered_pair(row: &Relationship, a: Uuid, b: Uuid) -> bool {
    (row.person_id == a && row.related_person_id == b)
        || (row.person_id == b && row.related_person_id == a)
}

/// The pairs one event asserts. Fewer or more than the supported number of
/// people asserts nothing, so an ambiguous cast never guesses.
fn desired_pairs(event: &Event) -> Vec<DesiredPair> {
    match event.event_type {
        EventType::Marriage => {
            let mut people = BTreeSet::new();
            people.insert(event.person_id);
            for participant in &event.participant_ids {
                if !participant.is_nil() {
                    people.insert(*participant);
                }
            }
            if people.len() != 2 {
                return Vec::new();
            }
            let mut iter = people.into_iter();
            let first = iter.next().expect("two people");
            let second = iter.next().expect("two people");
            let (low, high) = if first < second {
                (first, second)
            } else {
                (second, first)
            };
            vec![DesiredPair {
                key: PairKey {
                    kind: DesiredKind::Spouse,
                    person: low,
                    related: high,
                },
                rel_type: RelationshipType::Spouse,
            }]
        }
        EventType::Birth => {
            let mut parents = BTreeSet::new();
            for participant in &event.participant_ids {
                if !participant.is_nil() && *participant != event.person_id {
                    parents.insert(*participant);
                }
            }
            if parents.is_empty() || parents.len() > 2 {
                return Vec::new();
            }
            parents
                .into_iter()
                .map(|parent| DesiredPair {
                    key: PairKey {
                        kind: DesiredKind::ParentChild,
                        person: parent,
                        related: event.person_id,
                    },
                    rel_type: RelationshipType::ParentChild,
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

#[derive(Debug, Default)]
struct Plan {
    created: Vec<Relationship>,
    annotate: Vec<(Uuid, Uuid)>,
    retract: Vec<(Uuid, Uuid)>,
}

fn person_map(persons: &[Person]) -> BTreeMap<Uuid, &Person> {
    persons.iter().map(|person| (person.id, person)).collect()
}

fn check_age(
    rel_type: RelationshipType,
    person_id: Uuid,
    related_id: Uuid,
    persons: &BTreeMap<Uuid, &Person>,
) -> AppResult<()> {
    if rel_type != RelationshipType::ParentChild {
        return Ok(());
    }
    let (Some(parent), Some(child)) = (persons.get(&person_id), persons.get(&related_id)) else {
        return Ok(());
    };
    ensure_parent_child_age_gap(rel_type, parent, child)
}

fn plan_event(event: &Event, persons: &[Person], rows: &[Relationship]) -> AppResult<Plan> {
    let desired = desired_pairs(event);
    let people = person_map(persons);
    let mut plan = Plan::default();

    for pair in &desired {
        if let Some(existing) = rows.iter().find(|row| pair.matches(row)) {
            if existing.origin == RelationOrigin::Event
                && !existing.source_event_ids.contains(&event.id)
            {
                plan.annotate.push((existing.id, event.id));
            }
            continue;
        }
        let mut row = Relationship::new(pair.rel_type, pair.key.person, pair.key.related)?;
        check_age(pair.rel_type, pair.key.person, pair.key.related, &people)?;
        row.origin = RelationOrigin::Event;
        row.source_event_ids = vec![event.id];
        plan.created.push(row);
    }

    // Rows this event used to assert and no longer does. A row still asserted
    // by another event survives; only an empty automatic row is deleted.
    for row in rows {
        if !row.source_event_ids.contains(&event.id) {
            continue;
        }
        if !desired.iter().any(|pair| pair.matches(row)) {
            plan.retract.push((row.id, event.id));
        }
    }

    Ok(plan)
}

fn apply_plan(rows: &mut Vec<Relationship>, plan: Plan) -> AppResult<DerivationReport> {
    let mut report = DerivationReport::default();
    let retracted: BTreeSet<Uuid> = plan
        .retract
        .iter()
        .map(|(row_id, event_id)| {
            if let Some(row) = rows.iter_mut().find(|row| row.id == *row_id) {
                row.source_event_ids.retain(|id| id != event_id);
                if row.origin == RelationOrigin::Event && row.source_event_ids.is_empty() {
                    return *row_id;
                }
            }
            Uuid::nil()
        })
        .filter(|id| !id.is_nil())
        .collect();
    if !retracted.is_empty() {
        rows.retain(|row| !retracted.contains(&row.id));
        report.retracted = retracted.len();
    }

    for (row_id, event_id) in plan.annotate {
        if let Some(row) = rows.iter_mut().find(|row| row.id == row_id) {
            if row.origin == RelationOrigin::Event && !row.source_event_ids.contains(&event_id) {
                row.source_event_ids.push(event_id);
                report.annotated += 1;
            }
        }
    }

    report.created = plan.created.len();
    rows.extend(plan.created);
    RelationshipSet::new(rows.clone())?;
    Ok(report)
}

/// Reconcile one saved event with the current rows. Idempotent; manual rows are
/// left untouched.
pub fn derive_event_relations(
    event: &Event,
    persons: &[Person],
    rows: &mut Vec<Relationship>,
) -> AppResult<DerivationReport> {
    let plan = plan_event(event, persons, rows)?;
    let original = rows.clone();
    match apply_plan(rows, plan) {
        Ok(report) => Ok(report),
        Err(error) => {
            *rows = original;
            Err(error)
        }
    }
}

/// Remove this event's provenance from every row. Automatic rows with no other
/// source are deleted; manual rows survive.
pub fn retract_event_relations(event_id: Uuid, rows: &mut Vec<Relationship>) -> usize {
    let mut removed = 0usize;
    rows.retain_mut(|row| {
        if !row.source_event_ids.contains(&event_id) {
            return true;
        }
        row.source_event_ids.retain(|id| *id != event_id);
        if row.origin == RelationOrigin::Event && row.source_event_ids.is_empty() {
            removed += 1;
            false
        } else {
            true
        }
    });
    removed
}

fn desired_map(events: &[Event]) -> (BTreeMap<PairKey, BTreeSet<Uuid>>, usize) {
    let mut desired: BTreeMap<PairKey, BTreeSet<Uuid>> = BTreeMap::new();
    let mut ambiguous = 0usize;
    for event in events {
        match event.event_type {
            EventType::Marriage => {
                let participants = event
                    .participant_ids
                    .iter()
                    .filter(|id| !id.is_nil() && **id != event.person_id)
                    .collect::<BTreeSet<_>>();
                if participants.len() > 1 {
                    ambiguous += 1;
                    continue;
                }
                for pair in desired_pairs(event) {
                    desired.entry(pair.key).or_default().insert(event.id);
                }
            }
            EventType::Birth => {
                let parents = event
                    .participant_ids
                    .iter()
                    .filter(|id| !id.is_nil() && **id != event.person_id)
                    .collect::<BTreeSet<_>>();
                if parents.len() > 2 {
                    ambiguous += 1;
                    continue;
                }
                for pair in desired_pairs(event) {
                    desired.entry(pair.key).or_default().insert(event.id);
                }
            }
            _ => {}
        }
    }
    (desired, ambiguous)
}

fn create_for_pair(
    key: PairKey,
    sources: &BTreeSet<Uuid>,
    people: &BTreeMap<Uuid, &Person>,
) -> AppResult<Option<Relationship>> {
    if key.person == key.related {
        return Ok(None);
    }
    let (rel_type, a, b) = match key.kind {
        DesiredKind::Spouse => (RelationshipType::Spouse, key.person, key.related),
        DesiredKind::ParentChild => (RelationshipType::ParentChild, key.person, key.related),
    };
    check_age(rel_type, a, b, people)?;
    let mut row = Relationship::new(rel_type, a, b)?;
    row.origin = RelationOrigin::Event;
    row.source_event_ids = sources.iter().copied().collect();
    Ok(Some(row))
}

fn reconcile_pair(
    rows: &mut Vec<Relationship>,
    key: PairKey,
    sources: &BTreeSet<Uuid>,
    people: &BTreeMap<Uuid, &Person>,
) -> AppResult<(usize, usize)> {
    let rel_type = match key.kind {
        DesiredKind::Spouse => RelationshipType::Spouse,
        DesiredKind::ParentChild => RelationshipType::ParentChild,
    };
    let pair = DesiredPair { key, rel_type };
    if let Some(existing) = rows.iter_mut().find(|row| pair.matches(row)) {
        if existing.origin == RelationOrigin::Event {
            let mut annotated = 0;
            for source in sources {
                if !existing.source_event_ids.contains(source) {
                    existing.source_event_ids.push(*source);
                    annotated += 1;
                }
            }
            return Ok((0, annotated));
        }
        return Ok((0, 0));
    }
    let Some(row) = create_for_pair(key, sources, people)? else {
        return Ok((0, 0));
    };
    rows.push(row);
    Ok((1, 0))
}

/// Backfill missing relations from stored events. A read-only project is not
/// touched. Invalid edges are skipped rather than failing the whole open.
pub fn backfill_relations(
    events: &[Event],
    persons: &[Person],
    rows: &mut Vec<Relationship>,
    writable: bool,
) -> RelationBackfillReport {
    let mut report = RelationBackfillReport {
        read_only: !writable,
        ..RelationBackfillReport::default()
    };
    if !writable {
        return report;
    }
    let (desired, ambiguous) = desired_map(events);
    report.ambiguous_skipped = ambiguous;
    if desired.is_empty() {
        return report;
    }
    let people = person_map(persons);
    let original = rows.clone();
    let mut candidate = original.clone();

    let mut spouse = 0usize;
    let mut parent = 0usize;
    let mut failed = false;
    for (key, sources) in &desired {
        match reconcile_pair(&mut candidate, *key, sources, &people) {
            Ok((created, _)) => match key.kind {
                DesiredKind::Spouse => spouse += created,
                DesiredKind::ParentChild => parent += created,
            },
            Err(_) => {
                failed = true;
                break;
            }
        }
    }

    if !failed && RelationshipSet::new(candidate.clone()).is_ok() {
        *rows = candidate;
        report.spouse_created = spouse;
        report.parent_created = parent;
        return report;
    }

    // A pathological project (for example an existing cycle) must not block
    // the whole backfill: apply one pair at a time and keep what validates.
    let mut candidate = original;
    for (key, sources) in &desired {
        let before = candidate.clone();
        match reconcile_pair(&mut candidate, *key, sources, &people) {
            Ok((created, _)) if RelationshipSet::new(candidate.clone()).is_ok() => match key.kind {
                DesiredKind::Spouse => spouse += created,
                DesiredKind::ParentChild => parent += created,
            },
            _ => {
                candidate = before;
                report.ambiguous_skipped += 1;
            }
        }
    }
    *rows = candidate;
    report.spouse_created = spouse;
    report.parent_created = parent;
    report
}

/// Role slots of a birth event's participants: father first, mother second.
/// The stored list is compact, so a lone parent always sits at index 0.
const FATHER_SLOT: usize = 0;
const MOTHER_SLOT: usize = 1;
const MAX_BIRTH_PARENTS: usize = 2;

fn event_date_order(left: &Event, right: &Event) -> Ordering {
    match (left.date.start, right.date.start) {
        (Some(a), Some(b)) => a.cmp(&b).then_with(|| left.id.cmp(&right.id)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.id.cmp(&right.id),
    }
}

/// Birth events of `child_id`, earliest first; undated events come last.
fn birth_indices_earliest_first(events: &[Event], child_id: Uuid) -> Vec<usize> {
    let mut indices: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.event_type == EventType::Birth && event.person_id == child_id)
        .map(|(index, _)| index)
        .collect();
    indices.sort_by(|left, right| event_date_order(&events[*left], &events[*right]));
    indices
}

/// Mirror a biological parent relation into the child's birth event.
///
/// Only the caller-decided `PARENT_CHILD` edge reaches this function; adoptive
/// edges are never mirrored. The parent is added once, to the earliest birth
/// event that still has a free parent slot. A birth whose two slots are taken
/// by other people is left untouched, and the relation is still created by the
/// caller. Returns whether any event changed.
pub fn add_parent_to_birth_events(events: &mut [Event], child_id: Uuid, parent: &Person) -> bool {
    if parent.id.is_nil() || parent.id == child_id {
        return false;
    }
    let births = birth_indices_earliest_first(events, child_id);
    if births.is_empty() {
        return false;
    }
    // A parent already asserted by any birth event makes the reverse sync a
    // no-op, so two birth events never duplicate the same parent.
    if births
        .iter()
        .any(|index| events[*index].participant_ids.contains(&parent.id))
    {
        return false;
    }
    let Some(index) = births
        .into_iter()
        .find(|index| events[*index].participant_ids.len() < MAX_BIRTH_PARENTS)
    else {
        return false;
    };
    let participants = &mut events[index].participant_ids;
    let slot = match parent.gender {
        Gender::Male => FATHER_SLOT,
        Gender::Female => MOTHER_SLOT,
        Gender::Unknown => participants.len(),
    };
    // The list has no nil placeholders: a role slot past the end is the next
    // free position. Inserting a father before a lone mother keeps fathers
    // first; a lone mother (or unknown parent) is the only element.
    let position = slot.min(participants.len());
    participants.insert(position, parent.id);
    true
}

/// Mirror the deletion of a biological parent relation into the child's birth
/// events. Every birth event of the child drops that participant; an event
/// without parents stays valid. Returns whether any event changed.
pub fn remove_parent_from_birth_events(
    events: &mut [Event],
    child_id: Uuid,
    parent_id: Uuid,
) -> bool {
    if parent_id.is_nil() {
        return false;
    }
    let mut changed = false;
    for event in events
        .iter_mut()
        .filter(|event| event.event_type == EventType::Birth && event.person_id == child_id)
    {
        let before = event.participant_ids.len();
        event.participant_ids.retain(|id| *id != parent_id);
        changed |= event.participant_ids.len() != before;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::DateValue;
    use crate::person::Person;

    fn person(id: Uuid, birth: DateValue) -> Person {
        let mut person = Person::new(Vec::new()).unwrap();
        person.id = id;
        person.birth = birth;
        person
    }

    fn gendered(id: Uuid, birth: DateValue, gender: Gender) -> Person {
        let mut person = person(id, birth);
        person.gender = gender;
        person
    }

    fn marriage(a: Uuid, b: Uuid) -> Event {
        let mut event = Event::new(a, EventType::Marriage);
        event.participant_ids = vec![b];
        event
    }

    fn birth(child: Uuid, parents: &[Uuid]) -> Event {
        let mut event = Event::new(child, EventType::Birth);
        event.participant_ids = parents.to_vec();
        event
    }

    fn spouse_row(rows: &[Relationship], a: Uuid, b: Uuid) -> Option<&Relationship> {
        rows.iter()
            .find(|row| row.rel_type == RelationshipType::Spouse && same_unordered_pair(row, a, b))
    }

    #[test]
    fn marriage_creates_one_canonical_spouse_row() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let people = vec![
            person(Uuid::nil(), DateValue::default()),
            person(Uuid::nil(), DateValue::default()),
        ];
        let mut rows = Vec::new();
        let report = derive_event_relations(&marriage(a, b), &people, &mut rows).unwrap();
        assert_eq!(report.created, 1);
        let row = spouse_row(&rows, a, b).unwrap();
        assert_eq!(row.origin, RelationOrigin::Event);
        assert_eq!(row.source_event_ids.len(), 1);
        assert!(row.person_id < row.related_person_id);
    }

    #[test]
    fn marriage_is_idempotent_and_annotates_a_second_event() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let people = vec![
            person(Uuid::nil(), DateValue::default()),
            person(Uuid::nil(), DateValue::default()),
        ];
        let mut rows = Vec::new();
        let first = marriage(a, b);
        derive_event_relations(&first, &people, &mut rows).unwrap();
        let second = marriage(b, a);
        let report = derive_event_relations(&second, &people, &mut rows).unwrap();
        assert_eq!(report.created, 0);
        assert_eq!(report.annotated, 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_event_ids.len(), 2);
    }

    #[test]
    fn manual_partner_satisfies_a_marriage() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let people = vec![
            person(Uuid::nil(), DateValue::default()),
            person(Uuid::nil(), DateValue::default()),
        ];
        let mut rows = vec![Relationship::new(RelationshipType::Partner, a, b).unwrap()];
        let report = derive_event_relations(&marriage(a, b), &people, &mut rows).unwrap();
        assert_eq!(report.created, 0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rel_type, RelationshipType::Partner);
    }

    #[test]
    fn birth_creates_parent_rows_and_never_spouses() {
        let child = Uuid::now_v7();
        let parent = Uuid::now_v7();
        let people = vec![
            person(parent, DateValue::exact_year(1980)),
            person(child, DateValue::exact_year(2005)),
        ];
        let mut rows = Vec::new();
        let report = derive_event_relations(&birth(child, &[parent]), &people, &mut rows).unwrap();
        assert_eq!(report.created, 1);
        assert_eq!(rows[0].rel_type, RelationshipType::ParentChild);
        assert_eq!(rows[0].person_id, parent);
        assert_eq!(rows[0].related_person_id, child);
        assert!(spouse_row(&rows, parent, child).is_none());
    }

    #[test]
    fn too_young_parent_is_rejected() {
        let child = Uuid::now_v7();
        let parent = Uuid::now_v7();
        let people = vec![
            person(parent, DateValue::exact_year(2000)),
            person(child, DateValue::exact_year(2005)),
        ];
        let mut rows = Vec::new();
        let err = derive_event_relations(&birth(child, &[parent]), &people, &mut rows).unwrap_err();
        assert_eq!(err.code, crate::validation::PARENT_CHILD_AGE_GAP);
        assert!(rows.is_empty());
    }

    #[test]
    fn removing_a_parent_retracts_only_that_row() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let people = vec![
            person(father, DateValue::exact_year(1970)),
            person(mother, DateValue::exact_year(1972)),
            person(child, DateValue::exact_year(2000)),
        ];
        let mut rows = Vec::new();
        let mut event = birth(child, &[father, mother]);
        derive_event_relations(&event, &people, &mut rows).unwrap();
        assert_eq!(rows.len(), 2);
        event.participant_ids = vec![mother];
        derive_event_relations(&event, &people, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].person_id, mother);
    }

    #[test]
    fn two_events_keep_the_row_until_both_are_deleted() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let people = vec![
            person(Uuid::nil(), DateValue::default()),
            person(Uuid::nil(), DateValue::default()),
        ];
        let mut rows = Vec::new();
        let first = marriage(a, b);
        let second = marriage(a, b);
        derive_event_relations(&first, &people, &mut rows).unwrap();
        derive_event_relations(&second, &people, &mut rows).unwrap();
        assert_eq!(retract_event_relations(first.id, &mut rows), 0);
        assert_eq!(rows.len(), 1);
        assert_eq!(retract_event_relations(second.id, &mut rows), 1);
        assert!(rows.is_empty());
    }

    #[test]
    fn a_derived_parent_cycle_is_rejected() {
        let grandparent = Uuid::now_v7();
        let parent = Uuid::now_v7();
        let people = vec![
            person(grandparent, DateValue::default()),
            person(parent, DateValue::default()),
        ];
        let mut rows =
            vec![Relationship::new(RelationshipType::ParentChild, grandparent, parent).unwrap()];
        let before = rows.clone();
        let err =
            derive_event_relations(&birth(grandparent, &[parent]), &people, &mut rows).unwrap_err();
        assert_eq!(err.code, crate::codes::RELATIONSHIP_CYCLE);
        assert_eq!(rows, before);
    }

    #[test]
    fn backfill_is_idempotent_and_skips_ambiguous_casts() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let c = Uuid::now_v7();
        let child = Uuid::now_v7();
        let parent = Uuid::now_v7();
        let people = vec![
            person(a, DateValue::exact_year(1970)),
            person(b, DateValue::exact_year(1972)),
            person(c, DateValue::exact_year(1974)),
            person(child, DateValue::exact_year(2000)),
            person(parent, DateValue::exact_year(1975)),
        ];
        let mut big = marriage(a, b);
        big.participant_ids = vec![b, c];
        let events = vec![marriage(a, b), big, birth(child, &[parent])];
        let mut rows = Vec::new();
        let first = backfill_relations(&events, &people, &mut rows, true);
        assert_eq!(first.spouse_created, 1);
        assert_eq!(first.parent_created, 1);
        assert_eq!(first.ambiguous_skipped, 1);
        let snapshot = rows.clone();
        let second = backfill_relations(&events, &people, &mut rows, true);
        assert_eq!(second.spouse_created, 0);
        assert_eq!(second.parent_created, 0);
        assert_eq!(rows, snapshot);
    }

    #[test]
    fn backfill_leaves_a_read_only_project_untouched() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let events = vec![marriage(a, b)];
        let mut rows = Vec::new();
        let report = backfill_relations(&events, &[], &mut rows, false);
        assert!(report.read_only);
        assert!(rows.is_empty());
    }

    #[test]
    fn reverse_sync_adds_a_father_to_the_first_slot() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let father_person = gendered(father, DateValue::exact_year(1970), Gender::Male);
        let mut events = vec![birth(child, &[])];
        assert!(add_parent_to_birth_events(
            &mut events,
            child,
            &father_person
        ));
        assert_eq!(events[0].participant_ids, vec![father]);
    }

    #[test]
    fn reverse_sync_places_a_mother_after_the_father() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let mother_person = gendered(mother, DateValue::exact_year(1972), Gender::Female);
        let mut events = vec![birth(child, &[father])];
        assert!(add_parent_to_birth_events(
            &mut events,
            child,
            &mother_person
        ));
        assert_eq!(events[0].participant_ids, vec![father, mother]);
    }

    #[test]
    fn reverse_sync_keeps_a_lone_mother_compact() {
        let child = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let mother_person = gendered(mother, DateValue::exact_year(1972), Gender::Female);
        let mut events = vec![birth(child, &[])];
        assert!(add_parent_to_birth_events(
            &mut events,
            child,
            &mother_person
        ));
        assert_eq!(events[0].participant_ids, vec![mother]);

        let father = Uuid::now_v7();
        let father_person = gendered(father, DateValue::exact_year(1970), Gender::Male);
        assert!(add_parent_to_birth_events(
            &mut events,
            child,
            &father_person
        ));
        assert_eq!(events[0].participant_ids, vec![father, mother]);
    }

    #[test]
    fn reverse_sync_gives_an_unknown_parent_the_first_free_slot() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let unknown = Uuid::now_v7();
        let unknown_person = gendered(unknown, DateValue::exact_year(1971), Gender::Unknown);
        let mut events = vec![birth(child, &[father])];
        assert!(add_parent_to_birth_events(
            &mut events,
            child,
            &unknown_person
        ));
        assert_eq!(events[0].participant_ids, vec![father, unknown]);
    }

    #[test]
    fn reverse_sync_leaves_fully_occupied_slots_untouched() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let other = Uuid::now_v7();
        let other_person = gendered(other, DateValue::exact_year(1968), Gender::Male);
        let mut events = vec![birth(child, &[father, mother])];
        assert!(!add_parent_to_birth_events(
            &mut events,
            child,
            &other_person
        ));
        assert_eq!(events[0].participant_ids, vec![father, mother]);
    }

    #[test]
    fn reverse_sync_is_idempotent_for_the_same_parent() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let father_person = gendered(father, DateValue::exact_year(1970), Gender::Male);
        let mut events = vec![birth(child, &[father])];
        assert!(!add_parent_to_birth_events(
            &mut events,
            child,
            &father_person
        ));
        assert_eq!(events[0].participant_ids, vec![father]);
    }

    #[test]
    fn reverse_sync_updates_the_earliest_birth_with_a_free_slot() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let later_parent = Uuid::now_v7();
        let later_person = gendered(later_parent, DateValue::exact_year(1975), Gender::Male);

        let mut occupied = birth(child, &[father, mother]);
        occupied.date = DateValue::exact_year(1900);
        let mut free = birth(child, &[]);
        free.date = DateValue::exact_year(1905);
        let mut events = vec![free, occupied];
        assert!(add_parent_to_birth_events(
            &mut events,
            child,
            &later_person
        ));
        // The undated/earliest slot search sorts by date, not by input order.
        assert_eq!(events[1].participant_ids, vec![father, mother]);
        assert_eq!(events[0].participant_ids, vec![later_parent]);
    }

    #[test]
    fn reverse_sync_removes_a_parent_from_every_birth_event() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let mut events = vec![birth(child, &[father, mother]), birth(child, &[father])];
        assert!(remove_parent_from_birth_events(&mut events, child, father));
        assert_eq!(events[0].participant_ids, vec![mother]);
        assert_eq!(events[1].participant_ids, Vec::<Uuid>::new());
        assert!(!remove_parent_from_birth_events(&mut events, child, father));
    }

    #[test]
    fn reverse_sync_does_not_duplicate_or_recreate_relations() {
        let child = Uuid::now_v7();
        let father = Uuid::now_v7();
        let father_person = gendered(father, DateValue::exact_year(1970), Gender::Male);
        let child_person = gendered(child, DateValue::exact_year(2000), Gender::Unknown);
        let persons = vec![father_person.clone(), child_person];
        let mut events = vec![birth(child, &[])];
        add_parent_to_birth_events(&mut events, child, &father_person);
        let mut rows = Vec::new();

        // Saving the event after the reverse sync derives the same single row
        // and repeated saves stay stable.
        derive_event_relations(&events[0], &persons, &mut rows).unwrap();
        derive_event_relations(&events[0], &persons, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);

        // Deleting the relation also removes the participant, so the next
        // event save does not recreate it.
        rows.clear();
        remove_parent_from_birth_events(&mut events, child, father);
        derive_event_relations(&events[0], &persons, &mut rows).unwrap();
        assert!(rows.is_empty());
    }
}
