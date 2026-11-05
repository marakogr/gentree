//! Project merge: deterministic suggestions and a pure apply (ADR-0017).
//!
//! The module is pure: it reads two [`ProjectSnapshot`]s, never writes files
//! and never touches media bytes. [`merge_preview`] proposes person and event
//! candidates with stable evidence codes; [`apply_merge`] turns the user's
//! [`MergeDecisions`] into new collections, an ID map and a report. Copying
//! media files and creating the target project belong to the desktop layer.
//!
//! # Matching
//!
//! Suggestions are deterministic and explainable, never probabilistic:
//!
//! - a shared scoped external id `(source, value)` is strong evidence and is
//!   always reported as scoped; AT5/GEDCOM identifiers are never global;
//! - names are compared after trimming, collapsing whitespace, lowercasing and
//!   mapping `ё` to `е`, across every name variant of both people. Given name
//!   and patronymic are compared as token sequences, so a patronymic typed into
//!   the given-name field still matches the same patronymic stored separately;
//! - a known `MALE`/`FEMALE` conflict rejects the pair;
//! - dates are compared as [`DateValue`] intervals, never by `start` alone.
//!   `UNKNOWN` is not a bound. A birth or death year known on both sides and
//!   more than one year apart rejects the pair;
//! - assignment is one-to-one and greedy by score. Several plausible
//!   candidates within [`AMBIGUITY_DELTA`] of the chosen one mark the
//!   suggestion `Ambiguous` instead of silently choosing a different person.
//!
//! # Apply
//!
//! [`apply_merge`] never deletes a right entity without a left row to merge
//! into. Left people are always kept; every right person is either folded into
//! a left person (`Merge`) or copied with its own id (`KeepBoth` or no
//! decision). The same holds for events. Relationships, sources, citations and
//! media are remapped and deduplicated, and the output is rejected when
//! [`validate_project`] would report an error.
//!
//! # Determinism
//!
//! Output rows keep their input ids whenever that id is still free. A copied
//! right row whose id collides with an already used id gets a fresh UUID
//! derived deterministically from the row id and its collection, so the same
//! snapshots and decisions always produce byte-identical rows. These derived
//! ids are custom (RFC 9562 version 8) UUIDs; they are identity labels, not
//! random values and not a security token.
//!
//! # Codes
//!
//! [`codes`] holds the stable evidence and warning codes. They are English
//! identifiers; the UI localizes them. Values such as names, dates and places
//! are never formatted for display here.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::date::DateValue;
use crate::error::{codes as error_codes, AppError, AppResult};
use crate::geo::PlaceGeo;
use crate::person::{ExternalId, Gender, Name, NameType, Person};
use crate::record::{Citation, CitationTarget, Event, EventType, Media, Source};
use crate::relationship::{RelationOrigin, Relationship, RelationshipSet};
use crate::validation::{validate_project, ProjectSnapshot, Severity};

/// Stable evidence and warning codes returned by this module.
pub mod codes {
    // Evidence.
    /// Both sides carry the same UUID (the same project merged with itself).
    pub const SAME_UUID: &str = "SAME_UUID";
    /// A scoped external id `(source, value)` is shared. Params: `source`,
    /// `value`, `scoped`.
    pub const EXTERNAL_ID: &str = "EXTERNAL_ID";
    /// A normalized full name (given, patronymic, surname) is shared.
    pub const SAME_FULL_NAME: &str = "SAME_FULL_NAME";
    /// The normalized surname and given name are shared, but another part of
    /// the name differs.
    pub const SAME_NAME_PARTS: &str = "SAME_NAME_PARTS";
    /// Both birth years are known and equal. Params: `year`.
    pub const SAME_BIRTH_YEAR: &str = "SAME_BIRTH_YEAR";
    /// Both death years are known and equal. Params: `year`.
    pub const SAME_DEATH_YEAR: &str = "SAME_DEATH_YEAR";
    /// Dates are compatible without being equal. Params: `field`.
    pub const COMPATIBLE_DATES: &str = "COMPATIBLE_DATES";
    /// A relative is already matched across the two snapshots. Params: `count`.
    pub const SHARED_RELATIVE: &str = "SHARED_RELATIVE";
    /// Several candidates are equally plausible. Params: `count`.
    pub const AMBIGUOUS_CANDIDATES: &str = "AMBIGUOUS_CANDIDATES";
    /// Event dates are equal.
    pub const SAME_EVENT_DATE: &str = "SAME_EVENT_DATE";
    /// Event dates are compatible without being equal.
    pub const COMPATIBLE_EVENT_DATE: &str = "COMPATIBLE_EVENT_DATE";
    /// Event places are equal.
    pub const SAME_PLACE: &str = "SAME_PLACE";
    /// Event descriptions are equal.
    pub const SAME_DESCRIPTION: &str = "SAME_DESCRIPTION";

    // Warnings.
    /// A same-name candidate was rejected because the genders conflict.
    pub const GENDER_CONFLICT: &str = "GENDER_CONFLICT";
    /// A same-name candidate was rejected because the dates conflict.
    pub const DATE_CONFLICT: &str = "DATE_CONFLICT";
    /// A right person has no suggestion and is copied as-is. Params: `rightId`.
    pub const UNMATCHED_RIGHT_PERSON: &str = "UNMATCHED_RIGHT_PERSON";
    /// The user chose KeepBoth. Params: `leftId`, `rightId`.
    pub const PERSON_KEPT_BOTH: &str = "PERSON_KEPT_BOTH";
    /// The user chose KeepBoth for an event. Params: `leftEventId`,
    /// `rightEventId`.
    pub const EVENT_KEPT_BOTH: &str = "EVENT_KEPT_BOTH";
    /// The same pair already has an edge of another type in its family; the
    /// existing edge was kept. Params: `personId`, `relatedPersonId`, `kept`,
    /// `dropped`.
    pub const RELATIONSHIP_CONFLICT: &str = "RELATIONSHIP_CONFLICT";
    /// A right edge collapsed into a self-link after mapping and was dropped.
    /// Params: `personId`, `type`.
    pub const RELATIONSHIP_COLLAPSED: &str = "RELATIONSHIP_COLLAPSED";
    /// A citation was skipped because its source or target no longer exists.
    /// Params: `citationId`, `field`.
    pub const CITATION_TARGET_DROPPED: &str = "CITATION_TARGET_DROPPED";
    /// A reference inside a copied row could not be mapped and was dropped.
    /// Params: `entityId`, `field`, `count`.
    pub const REFERENCE_DROPPED: &str = "REFERENCE_DROPPED";
    /// A media file must be checked by the desktop layer; the core never reads
    /// bytes. Emitted by the caller, documented here for the UI contract.
    pub const MEDIA_MISSING: &str = "MEDIA_MISSING";
}

/// Score distance at which an alternative candidate makes a suggestion
/// ambiguous.
pub const AMBIGUITY_DELTA: u16 = 10;

const SCORE_EXTERNAL_ID: u16 = 100;
const SCORE_FULL_NAME_COMPATIBLE: u16 = 80;
const SCORE_FULL_NAME_UNKNOWN_DATE: u16 = 50;
const SCORE_NAME_PARTS_COMPATIBLE: u16 = 60;
const SCORE_NAME_PARTS_UNKNOWN_DATE: u16 = 40;
const SHARED_RELATIVE_BONUS: u16 = 10;

const EVENT_SCORE_EXACT: u16 = 100;
const EVENT_SCORE_COMPATIBLE_DATE: u16 = 60;
const EVENT_SCORE_UNKNOWN_DATE: u16 = 40;
const EVENT_SCORE_PLACE_BONUS: u16 = 10;

/// How sure the matcher is that two rows describe the same person or event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchConfidence {
    High,
    Medium,
    Ambiguous,
}

/// What the user decided for a suggested pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MergeAction {
    /// Fold the right row into the left row.
    Merge,
    /// Reject the suggestion; keep both rows.
    KeepBoth,
}

/// Which side of a pair a value is taken from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Left,
    Right,
}

/// How one field is resolved when two rows are merged.
///
/// `Both` keeps both texts joined with `\n\n` (notes, description, detail
/// values, place). For scalar single-value fields (`gender`, `birth`, `death`,
/// event `date`) `Both` behaves like the chosen base side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FieldPolicy {
    Left,
    Right,
    Both,
}

/// A person as the preview presents it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePerson {
    pub id: Uuid,
    pub names: Vec<Name>,
    pub gender: Gender,
    pub birth: DateValue,
    pub death: DateValue,
    pub notes: Option<String>,
    pub external_ids: Vec<ExternalId>,
}

impl From<&Person> for MergePerson {
    fn from(person: &Person) -> Self {
        Self {
            id: person.id,
            names: person.names.clone(),
            gender: person.gender,
            birth: person.birth.clone(),
            death: person.death.clone(),
            notes: person.notes.clone(),
            external_ids: person.external_ids.clone(),
        }
    }
}

/// An event as the preview presents it. The owner is omitted on purpose: the
/// preview groups events under the person pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeEvent {
    pub id: Uuid,
    /// Serialized as `type`, like [`Event`], so existing event UI code reads it
    /// unchanged.
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub date: DateValue,
    pub place: Option<String>,
    /// Confirmed map point for `place` (ADR-0020). Follows the chosen place
    /// side; two equal texts with different points are a `placeGeo` diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place_geo: Option<PlaceGeo>,
    pub description: Option<String>,
    pub details: BTreeMap<String, String>,
    pub participant_ids: Vec<Uuid>,
    pub source_ids: Vec<Uuid>,
    pub original_type: Option<String>,
}

impl From<&Event> for MergeEvent {
    fn from(event: &Event) -> Self {
        Self {
            id: event.id,
            event_type: event.event_type,
            date: event.date.clone(),
            place: event.place.clone(),
            place_geo: event.place_geo.clone(),
            description: event.description.clone(),
            details: event.details.clone(),
            participant_ids: event.participant_ids.clone(),
            source_ids: event.source_ids.clone(),
            original_type: event.original_type.clone(),
        }
    }
}

/// One piece of evidence behind a suggestion. `code` is stable; `params` carry
/// identifiers and raw values, never localized text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchEvidence {
    pub code: String,
    pub params: BTreeMap<String, String>,
}

/// A non-blocking observation produced by the preview or the apply step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeWarning {
    pub code: String,
    pub params: BTreeMap<String, String>,
}

/// One suggested event pair inside a matched person pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMatch {
    /// Stable suggestion id: `<left_event_uuid>:<right_event_uuid>`.
    pub id: String,
    pub left: MergeEvent,
    pub right: MergeEvent,
    pub confidence: MatchConfidence,
    pub evidence: Vec<MatchEvidence>,
    /// Fields whose values differ: `date`, `place`, `description`, then
    /// `details.<key>` for every key present on either side, in that order.
    pub field_diffs: Vec<String>,
}

/// One suggested person pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonMatch {
    /// Stable suggestion id: `<left_uuid>:<right_uuid>`.
    pub id: String,
    pub left: MergePerson,
    pub right: MergePerson,
    pub confidence: MatchConfidence,
    pub evidence: Vec<MatchEvidence>,
    /// Events owned by the left person, in input order.
    pub left_events: Vec<MergeEvent>,
    /// Events owned by the right person, in input order.
    pub right_events: Vec<MergeEvent>,
    pub event_matches: Vec<EventMatch>,
    /// Differing person fields in a fixed order: `gender`, `birth`, `death`,
    /// `notes`. Values are compared exactly, except notes, where a
    /// whitespace-only text counts as empty.
    pub field_diffs: Vec<String>,
}

/// Input sizes and suggestion counts for the preview header.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewCounts {
    pub left_people: usize,
    pub right_people: usize,
    pub left_events: usize,
    pub right_events: usize,
    pub matched_people: usize,
    pub matched_events: usize,
    pub ambiguous_people: usize,
}

/// Suggestions for merging `right` into `left`. Nothing is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// One-to-one person suggestions, in left input order.
    pub matches: Vec<PersonMatch>,
    /// Right people with no suggestion, in right input order. They are copied
    /// by [`apply_merge`].
    pub unmatched_right: Vec<MergePerson>,
    pub warnings: Vec<MergeWarning>,
    pub counts: MergePreviewCounts,
}

/// The user's decisions. A missing decision keeps both rows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDecisions {
    pub persons: Vec<PersonDecision>,
    pub events: Vec<EventDecision>,
}

/// Decision for one suggested person pair.
///
/// `fields` accepts `gender`, `birth`, `death` and `notes`. Unknown keys are
/// ignored so an older core can read a newer UI request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDecision {
    pub left_id: Uuid,
    pub right_id: Uuid,
    pub action: MergeAction,
    /// Base card for the merged row; `Left` is the default in the UI.
    pub base: Side,
    pub fields: BTreeMap<String, FieldPolicy>,
}

/// Decision for one suggested event pair.
///
/// `fields` accepts `date`, `place`, `description` and `details.<key>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDecision {
    pub left_event_id: Uuid,
    pub right_event_id: Uuid,
    pub action: MergeAction,
    pub base: Side,
    pub fields: BTreeMap<String, FieldPolicy>,
}

/// Counts and warnings of an applied merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// Right people folded into a left person.
    pub merged_people: usize,
    /// Right people kept side by side (an explicit `KeepBoth` decision).
    pub kept_both_people: usize,
    /// Right people with no decision; copied as-is.
    pub unmatched_right_people: usize,
    /// Right events folded into a left event.
    pub merged_events: usize,
    /// Right events copied, whether the decision was `KeepBoth` or missing.
    pub kept_both_events: usize,
    pub warnings: Vec<MergeWarning>,
}

/// Merged collections plus the maps the caller needs to write them.
///
/// `person_map`, `event_map`, `source_map`, `relationship_map` and `media_map`
/// each map a right input id to the row that represents it in the output,
/// including rows that were deduplicated into an existing left row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutput {
    pub persons: Vec<Person>,
    pub events: Vec<Event>,
    pub relationships: Vec<Relationship>,
    pub sources: Vec<Source>,
    pub citations: Vec<Citation>,
    pub media: Vec<Media>,
    pub report: MergeReport,
    pub person_map: BTreeMap<Uuid, Uuid>,
    pub event_map: BTreeMap<Uuid, Uuid>,
    pub source_map: BTreeMap<Uuid, Uuid>,
    pub relationship_map: BTreeMap<Uuid, Uuid>,
    pub media_map: BTreeMap<Uuid, Uuid>,
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Build deterministic person and event suggestions for `left` + `right`.
///
/// The result is a preview only; no row is changed and no file is read.
pub fn merge_preview(left: ProjectSnapshot<'_>, right: ProjectSnapshot<'_>) -> MergePreview {
    let mut warnings: Vec<MergeWarning> = Vec::new();
    let mut candidates: Vec<ScoredPair> = Vec::new();

    for (left_index, left_person) in left.persons.iter().enumerate() {
        for (right_index, right_person) in right.persons.iter().enumerate() {
            match evaluate_person_pair(left_person, right_person) {
                PersonVerdict::Match { score, evidence } => candidates.push(ScoredPair {
                    left: left_index,
                    right: right_index,
                    score,
                    evidence,
                }),
                PersonVerdict::GenderConflict { named } => {
                    if named {
                        warnings.push(warning(
                            codes::GENDER_CONFLICT,
                            &[
                                ("leftId", left_person.id.to_string()),
                                ("rightId", right_person.id.to_string()),
                            ],
                        ));
                    }
                }
                PersonVerdict::DateConflict {
                    field,
                    named,
                    external,
                } => {
                    if named || external {
                        warnings.push(warning(
                            codes::DATE_CONFLICT,
                            &[
                                ("leftId", left_person.id.to_string()),
                                ("rightId", right_person.id.to_string()),
                                ("field", field.to_owned()),
                            ],
                        ));
                    }
                }
                PersonVerdict::NoEvidence => {}
            }
        }
    }

    apply_shared_relative_bonus(left, right, &mut candidates);

    let chosen = assign_one_to_one(&candidates);
    let alternatives = alternative_counts(&candidates, &chosen);
    let mut matches = Vec::new();
    let mut matched_events = 0usize;
    let mut ambiguous_people = 0usize;

    for &index in &chosen {
        let candidate = &candidates[index];
        let left_person = &left.persons[candidate.left];
        let right_person = &right.persons[candidate.right];
        let mut confidence = confidence_for(candidate.score);
        let mut evidence = candidate.evidence.clone();

        if let Some(count) = alternatives.get(&index).copied().filter(|count| *count > 0) {
            confidence = MatchConfidence::Ambiguous;
            evidence.push(evidence_with(
                codes::AMBIGUOUS_CANDIDATES,
                &[("count", count.to_string())],
            ));
            warnings.push(warning(
                codes::AMBIGUOUS_CANDIDATES,
                &[
                    ("leftId", left_person.id.to_string()),
                    ("rightId", right_person.id.to_string()),
                    ("count", count.to_string()),
                ],
            ));
        }
        if left_person.id == right_person.id
            && gender_conflict(left_person.gender, right_person.gender)
        {
            warnings.push(warning(
                codes::GENDER_CONFLICT,
                &[
                    ("leftId", left_person.id.to_string()),
                    ("rightId", right_person.id.to_string()),
                ],
            ));
        }
        if confidence == MatchConfidence::Ambiguous {
            ambiguous_people += 1;
        }

        let left_owned = owned_events(left.events, left_person.id);
        let right_owned = owned_events(right.events, right_person.id);
        let event_matches = match_events(&left_owned, &right_owned, &mut warnings);
        matched_events += event_matches.len();

        matches.push(PersonMatch {
            id: format!("{}:{}", left_person.id, right_person.id),
            left: MergePerson::from(left_person),
            right: MergePerson::from(right_person),
            confidence,
            evidence,
            left_events: left_owned
                .iter()
                .map(|event| MergeEvent::from(*event))
                .collect(),
            right_events: right_owned
                .iter()
                .map(|event| MergeEvent::from(*event))
                .collect(),
            event_matches,
            field_diffs: person_field_diffs(left_person, right_person),
        });
    }

    let matched_right: HashSet<usize> = chosen
        .iter()
        .map(|&index| candidates[index].right)
        .collect();
    let unmatched_right = right
        .persons
        .iter()
        .enumerate()
        .filter(|(index, _)| !matched_right.contains(index))
        .map(|(_, person)| MergePerson::from(person))
        .collect();

    MergePreview {
        counts: MergePreviewCounts {
            left_people: left.persons.len(),
            right_people: right.persons.len(),
            left_events: left.events.len(),
            right_events: right.events.len(),
            matched_people: matches.len(),
            matched_events,
            ambiguous_people,
        },
        matches,
        unmatched_right,
        warnings,
    }
}

/// Apply the user's decisions and return merged rows, the id maps and a report.
///
/// The function is pure. It fails with [`error_codes::MERGE_CONFLICT`] when a
/// decision refers to an unknown row, when a non-empty scalar field conflicts
/// without an explicit policy, or when the result would not validate. A
/// relationship cycle keeps the stable `RELATIONSHIP_CYCLE` code.
pub fn apply_merge(
    left: ProjectSnapshot<'_>,
    right: ProjectSnapshot<'_>,
    decisions: &MergeDecisions,
) -> AppResult<MergeOutput> {
    let mut warnings: Vec<MergeWarning> = Vec::new();
    let person_decisions = index_person_decisions(left, right, decisions)?;
    let event_decisions = index_event_decisions(left, right, decisions)?;

    let mut used: HashSet<Uuid> = HashSet::new();
    for person in left.persons {
        used.insert(person.id);
    }
    for event in left.events {
        used.insert(event.id);
    }
    for relationship in left.relationships {
        used.insert(relationship.id);
    }
    for source in left.sources {
        used.insert(source.id);
    }
    for citation in left.citations {
        used.insert(citation.id);
    }
    for media in left.media {
        used.insert(media.id);
    }

    let left_people: BTreeMap<Uuid, &Person> = left
        .persons
        .iter()
        .map(|person| (person.id, person))
        .collect();

    // People: every left row survives; each right row is merged or copied.
    let mut person_map: BTreeMap<Uuid, Uuid> = BTreeMap::new();
    let mut merged_people: BTreeMap<Uuid, Person> = BTreeMap::new();
    let mut copied_people: Vec<Person> = Vec::new();
    for right_person in right.persons {
        match person_decisions.get(&right_person.id) {
            Some(decision) if decision.action == MergeAction::Merge => {
                let Some(left_person) = left_people.get(&decision.left_id) else {
                    return Err(conflict("unknownPersonDecision")
                        .with_param("leftId", decision.left_id.to_string()));
                };
                let merged = merge_person_fields(left_person, right_person, decision)?;
                person_map.insert(right_person.id, left_person.id);
                merged_people.insert(left_person.id, merged);
            }
            decision => {
                match decision {
                    Some(decision) => warnings.push(warning(
                        codes::PERSON_KEPT_BOTH,
                        &[
                            ("leftId", decision.left_id.to_string()),
                            ("rightId", right_person.id.to_string()),
                        ],
                    )),
                    None => warnings.push(warning(
                        codes::UNMATCHED_RIGHT_PERSON,
                        &[("rightId", right_person.id.to_string())],
                    )),
                }
                let mut copy = right_person.clone();
                copy.id = claim_id(right_person.id, "person", &mut used);
                person_map.insert(right_person.id, copy.id);
                copied_people.push(copy);
            }
        }
    }

    let mut persons: Vec<Person> = left
        .persons
        .iter()
        .map(|person| {
            merged_people
                .get(&person.id)
                .cloned()
                .unwrap_or_else(|| person.clone())
        })
        .collect();
    persons.extend(copied_people);

    // Sources first: events, media and citations reference them.
    let mut source_map: BTreeMap<Uuid, Uuid> = BTreeMap::new();
    let mut sources: Vec<Source> = left.sources.to_vec();
    let mut source_keys: BTreeMap<SourceKey, Uuid> = BTreeMap::new();
    for source in &sources {
        source_keys
            .entry(SourceKey::from(source))
            .or_insert(source.id);
    }
    for right_source in right.sources {
        let key = SourceKey::from(right_source);
        if let Some(existing) = source_keys.get(&key) {
            source_map.insert(right_source.id, *existing);
            continue;
        }
        let mut copy = right_source.clone();
        copy.id = claim_id(right_source.id, "source", &mut used);
        source_keys.insert(key, copy.id);
        source_map.insert(right_source.id, copy.id);
        sources.push(copy);
    }

    // Events: left rows are kept, right rows are merged into one or copied.
    let left_events: BTreeMap<Uuid, &Event> =
        left.events.iter().map(|event| (event.id, event)).collect();
    let mut event_map: BTreeMap<Uuid, Uuid> = BTreeMap::new();
    let mut merged_events: BTreeMap<Uuid, Event> = BTreeMap::new();
    let mut copied_events: Vec<Event> = Vec::new();
    for right_event in right.events {
        match event_decisions.get(&right_event.id) {
            Some(decision) if decision.action == MergeAction::Merge => {
                let Some(left_event) = left_events.get(&decision.left_event_id) else {
                    return Err(conflict("unknownEventDecision")
                        .with_param("leftEventId", decision.left_event_id.to_string()));
                };
                let merged = merge_event_fields(
                    left_event,
                    right_event,
                    decision,
                    &person_map,
                    &source_map,
                    &mut warnings,
                )?;
                event_map.insert(right_event.id, left_event.id);
                merged_events.insert(left_event.id, merged);
            }
            decision => {
                if let Some(decision) = decision {
                    warnings.push(warning(
                        codes::EVENT_KEPT_BOTH,
                        &[
                            ("leftEventId", decision.left_event_id.to_string()),
                            ("rightEventId", right_event.id.to_string()),
                        ],
                    ));
                }
                let Some(owner) = person_map.get(&right_event.person_id).copied() else {
                    return Err(conflict("danglingEventOwner")
                        .with_param("eventId", right_event.id.to_string()));
                };
                let mut copy = right_event.clone();
                copy.id = claim_id(right_event.id, "event", &mut used);
                copy.person_id = owner;
                copy.source_ids = merge_source_ids(
                    &[],
                    &right_event.source_ids,
                    &source_map,
                    &mut warnings,
                    right_event.id,
                );
                copy.participant_ids = merge_participant_ids(
                    &[],
                    &right_event.participant_ids,
                    &person_map,
                    owner,
                    &mut warnings,
                    right_event.id,
                );
                event_map.insert(right_event.id, copy.id);
                copied_events.push(copy);
            }
        }
    }

    let mut events: Vec<Event> = left
        .events
        .iter()
        .map(|event| {
            merged_events
                .get(&event.id)
                .cloned()
                .unwrap_or_else(|| event.clone())
        })
        .collect();
    events.extend(copied_events);

    // Relationships: remap endpoints, dedupe, keep the left type on conflicts.
    let mut relationships: Vec<Relationship> = left.relationships.to_vec();
    let mut relationship_map: BTreeMap<Uuid, Uuid> = BTreeMap::new();
    for right_row in right.relationships {
        let (Some(&a), Some(&b)) = (
            person_map.get(&right_row.person_id),
            person_map.get(&right_row.related_person_id),
        ) else {
            warnings.push(warning(
                codes::REFERENCE_DROPPED,
                &[
                    ("entityId", right_row.id.to_string()),
                    ("field", "relationship".to_owned()),
                    ("count", "1".to_owned()),
                ],
            ));
            continue;
        };
        if a == b {
            warnings.push(warning(
                codes::RELATIONSHIP_COLLAPSED,
                &[
                    ("personId", a.to_string()),
                    (
                        "type",
                        relationship_type_code(right_row.rel_type).to_owned(),
                    ),
                ],
            ));
            continue;
        }
        let mut row = right_row.clone();
        row.person_id = a;
        row.related_person_id = b;
        row.canonicalize_spouse_order();

        if let Some(existing) = relationships
            .iter_mut()
            .find(|existing| same_relationship_pair(existing, &row))
        {
            if existing.rel_type != row.rel_type {
                warnings.push(warning(
                    codes::RELATIONSHIP_CONFLICT,
                    &[
                        ("personId", row.person_id.to_string()),
                        ("relatedPersonId", row.related_person_id.to_string()),
                        ("kept", relationship_type_code(existing.rel_type).to_owned()),
                        ("dropped", relationship_type_code(row.rel_type).to_owned()),
                    ],
                ));
            }
            // Keep the earliest row id, union the provenance, and let a manual
            // row on either side win so a later event edit cannot retract it.
            let manual =
                existing.origin == RelationOrigin::Manual || row.origin == RelationOrigin::Manual;
            let mut sources = existing.source_event_ids.clone();
            for event_id in &row.source_event_ids {
                if !sources.contains(event_id) {
                    sources.push(*event_id);
                }
            }
            sources.sort_unstable();
            existing.origin = if manual {
                RelationOrigin::Manual
            } else {
                RelationOrigin::Event
            };
            existing.source_event_ids = sources;
            relationship_map.insert(right_row.id, existing.id);
            continue;
        }

        row.id = claim_id(row.id, "relationship", &mut used);
        relationship_map.insert(right_row.id, row.id);
        relationships.push(row);
    }
    let relationships = RelationshipSet::new(relationships)
        .map_err(map_relationship_error)?
        .rows()
        .to_vec();

    // Media: remap links, dedupe only identical metadata.
    let mut media: Vec<Media> = left.media.to_vec();
    let mut media_map: BTreeMap<Uuid, Uuid> = BTreeMap::new();
    for right_media in right.media {
        let mut copy = right_media.clone();
        copy.person_id = match right_media.person_id {
            Some(id) => match person_map.get(&id).copied() {
                Some(mapped) => Some(mapped),
                None => {
                    warnings.push(warning(
                        codes::REFERENCE_DROPPED,
                        &[
                            ("entityId", right_media.id.to_string()),
                            ("field", "personId".to_owned()),
                            ("count", "1".to_owned()),
                        ],
                    ));
                    None
                }
            },
            None => None,
        };
        copy.source_id = match right_media.source_id {
            Some(id) => match source_map.get(&id).copied() {
                Some(mapped) => Some(mapped),
                None => {
                    warnings.push(warning(
                        codes::REFERENCE_DROPPED,
                        &[
                            ("entityId", right_media.id.to_string()),
                            ("field", "sourceId".to_owned()),
                            ("count", "1".to_owned()),
                        ],
                    ));
                    None
                }
            },
            None => None,
        };
        // Event links follow the same rule as person links: an event that was
        // merged into a left row points at that row; an unknown event is dropped
        // with a warning so the merged project never keeps a dangling link.
        copy.event_id = match right_media.event_id {
            Some(id) => match event_map.get(&id).copied() {
                Some(mapped) => Some(mapped),
                None => {
                    warnings.push(warning(
                        codes::REFERENCE_DROPPED,
                        &[
                            ("entityId", right_media.id.to_string()),
                            ("field", "eventId".to_owned()),
                            ("count", "1".to_owned()),
                        ],
                    ));
                    None
                }
            },
            None => None,
        };
        let key = MediaKey::from(&copy);
        if let Some(existing) = media.iter().find(|row| MediaKey::from(*row) == key) {
            media_map.insert(right_media.id, existing.id);
            continue;
        }
        copy.id = claim_id(right_media.id, "media", &mut used);
        media_map.insert(right_media.id, copy.id);
        media.push(copy);
    }

    // Citations last: they point at every other collection.
    let mut citations: Vec<Citation> = left.citations.to_vec();
    for right_citation in right.citations {
        let Some(&source_id) = source_map.get(&right_citation.source_id) else {
            warnings.push(warning(
                codes::CITATION_TARGET_DROPPED,
                &[
                    ("citationId", right_citation.id.to_string()),
                    ("field", "sourceId".to_owned()),
                ],
            ));
            continue;
        };
        let target = match right_citation.target_type {
            CitationTarget::Person => person_map.get(&right_citation.target_id).copied(),
            CitationTarget::Event => event_map.get(&right_citation.target_id).copied(),
            CitationTarget::Relationship => {
                relationship_map.get(&right_citation.target_id).copied()
            }
            CitationTarget::Media => media_map.get(&right_citation.target_id).copied(),
        };
        let Some(target_id) = target else {
            warnings.push(warning(
                codes::CITATION_TARGET_DROPPED,
                &[
                    ("citationId", right_citation.id.to_string()),
                    ("field", "targetId".to_owned()),
                ],
            ));
            continue;
        };
        let mut copy = right_citation.clone();
        copy.source_id = source_id;
        copy.target_id = target_id;
        if citations
            .iter()
            .any(|existing| citation_identical(existing, &copy))
        {
            continue;
        }
        copy.id = claim_id(right_citation.id, "citation", &mut used);
        citations.push(copy);
    }

    let merged_people = person_decisions
        .values()
        .filter(|decision| decision.action == MergeAction::Merge)
        .count();
    let kept_both_people = person_decisions
        .values()
        .filter(|decision| decision.action == MergeAction::KeepBoth)
        .count();
    let merged_events = event_decisions
        .values()
        .filter(|decision| decision.action == MergeAction::Merge)
        .count();

    let report = MergeReport {
        merged_people,
        kept_both_people,
        unmatched_right_people: right
            .persons
            .len()
            .saturating_sub(merged_people + kept_both_people),
        merged_events,
        kept_both_events: right.events.len().saturating_sub(merged_events),
        warnings,
    };

    let validation = validate_project(ProjectSnapshot {
        persons: &persons,
        events: &events,
        relationships: &relationships,
        sources: &sources,
        citations: &citations,
        media: &media,
    });
    if !validation.is_valid() {
        let mut error =
            conflict("invalidOutput").with_param("errors", validation.counts.error.to_string());
        if let Some(issue) = validation
            .issues
            .iter()
            .find(|issue| issue.severity == Severity::Error)
        {
            error = error.with_param("issue", issue.code.clone());
        }
        return Err(error);
    }

    Ok(MergeOutput {
        persons,
        events,
        relationships,
        sources,
        citations,
        media,
        report,
        person_map,
        event_map,
        source_map,
        relationship_map,
        media_map,
    })
}

// ---------------------------------------------------------------------------
// Person matching
// ---------------------------------------------------------------------------

/// A scored pair before one-to-one assignment.
#[derive(Debug, Clone)]
struct ScoredPair {
    left: usize,
    right: usize,
    score: u16,
    evidence: Vec<MatchEvidence>,
}

enum PersonVerdict {
    Match {
        score: u16,
        evidence: Vec<MatchEvidence>,
    },
    GenderConflict {
        named: bool,
    },
    DateConflict {
        field: &'static str,
        named: bool,
        external: bool,
    },
    NoEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DateRelation {
    Same,
    Compatible,
    Unknown,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NameMatch {
    Full,
    Parts,
}

fn evaluate_person_pair(left: &Person, right: &Person) -> PersonVerdict {
    // The same UUID means the same row, so it is always a match; a gender
    // difference there is reported as a warning instead of hiding the row.
    if left.id == right.id {
        return PersonVerdict::Match {
            score: SCORE_EXTERNAL_ID,
            evidence: vec![evidence(codes::SAME_UUID)],
        };
    }

    let named = names_match(left, right).is_some();
    let external = shared_external_id(left, right);

    if gender_conflict(left.gender, right.gender) {
        return PersonVerdict::GenderConflict { named };
    }
    // A birth/death year known on both sides and more than one year apart is a
    // rejection for every kind of evidence, including a scoped external id:
    // the pair is reported as DATE_CONFLICT and the user can KeepBoth.
    if person_date_relation(&left.birth, &right.birth) == DateRelation::Conflict {
        return PersonVerdict::DateConflict {
            field: "birth",
            named,
            external: external.is_some(),
        };
    }
    if person_date_relation(&left.death, &right.death) == DateRelation::Conflict {
        return PersonVerdict::DateConflict {
            field: "death",
            named,
            external: external.is_some(),
        };
    }
    if !named && external.is_none() {
        return PersonVerdict::NoEvidence;
    }

    let birth = person_date_relation(&left.birth, &right.birth);
    let death = person_date_relation(&left.death, &right.death);
    let birth_compatible = matches!(birth, DateRelation::Same | DateRelation::Compatible);

    let mut score = 0u16;
    let mut evidence_rows: Vec<MatchEvidence> = Vec::new();

    if let Some(external_id) = external {
        score = SCORE_EXTERNAL_ID;
        evidence_rows.push(evidence_with(
            codes::EXTERNAL_ID,
            &[
                ("source", external_id.source.clone()),
                ("value", external_id.value.clone()),
                ("scoped", "true".to_owned()),
            ],
        ));
    }

    match names_match(left, right) {
        Some(NameMatch::Full) => {
            if score < SCORE_FULL_NAME_COMPATIBLE {
                score = if birth_compatible {
                    SCORE_FULL_NAME_COMPATIBLE
                } else {
                    SCORE_FULL_NAME_UNKNOWN_DATE
                };
            }
            evidence_rows.push(evidence(codes::SAME_FULL_NAME));
        }
        Some(NameMatch::Parts) => {
            if score < SCORE_NAME_PARTS_COMPATIBLE {
                score = if birth_compatible {
                    SCORE_NAME_PARTS_COMPATIBLE
                } else {
                    SCORE_NAME_PARTS_UNKNOWN_DATE
                };
            }
            evidence_rows.push(evidence(codes::SAME_NAME_PARTS));
        }
        None => {}
    }

    match birth {
        DateRelation::Same => {
            if let Some(year) = shared_year(&left.birth, &right.birth) {
                evidence_rows.push(evidence_with(
                    codes::SAME_BIRTH_YEAR,
                    &[("year", year.to_string())],
                ));
            }
        }
        DateRelation::Compatible => evidence_rows.push(evidence_with(
            codes::COMPATIBLE_DATES,
            &[("field", "birth".to_owned())],
        )),
        _ => {}
    }
    match death {
        DateRelation::Same => {
            if let Some(year) = shared_year(&left.death, &right.death) {
                evidence_rows.push(evidence_with(
                    codes::SAME_DEATH_YEAR,
                    &[("year", year.to_string())],
                ));
            }
        }
        DateRelation::Compatible => evidence_rows.push(evidence_with(
            codes::COMPATIBLE_DATES,
            &[("field", "death".to_owned())],
        )),
        _ => {}
    }

    PersonVerdict::Match {
        score,
        evidence: evidence_rows,
    }
}

fn gender_conflict(left: Gender, right: Gender) -> bool {
    matches!(
        (left, right),
        (Gender::Male, Gender::Female) | (Gender::Female, Gender::Male)
    )
}

fn names_match(left: &Person, right: &Person) -> Option<NameMatch> {
    if full_names_match(left, right) {
        return Some(NameMatch::Full);
    }

    let left_parts: Vec<(String, String)> = left.names.iter().filter_map(name_parts).collect();
    let right_parts: Vec<(String, String)> = right.names.iter().filter_map(name_parts).collect();
    if left_parts.iter().any(|name| right_parts.contains(name)) {
        return Some(NameMatch::Parts);
    }
    None
}

/// Compares every name of both people as `surname` plus the token sequence of
/// `given` and `patronymic` together.
///
/// The fields are split differently depending on where a record came from: one
/// project may store `given = "Мария Петровна"` with an empty patronymic while
/// the other stores `given = "Мария"` and `patronymic = "Петровна"`. Both hold
/// the same three tokens, so they are the same full name. Surnames must match
/// exactly (including both being absent); a name without any given/patronymic
/// token carries no identity evidence.
fn full_names_match(left: &Person, right: &Person) -> bool {
    let left_names: Vec<NameTokens> = left.names.iter().filter_map(name_tokens).collect();
    let right_names: Vec<NameTokens> = right.names.iter().filter_map(name_tokens).collect();
    left_names.iter().any(|candidate| {
        right_names
            .iter()
            .any(|other| candidate.surname == other.surname && candidate.tokens == other.tokens)
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NameTokens {
    surname: Option<String>,
    /// Normalized `given` followed by normalized `patronymic` tokens.
    tokens: Vec<String>,
}

fn name_tokens(name: &Name) -> Option<NameTokens> {
    let mut tokens = split_tokens(&name.given);
    tokens.extend(split_tokens(&name.patronymic));
    let surname = normalized_opt(&name.surname);
    if tokens.is_empty() && surname.is_none() {
        return None;
    }
    Some(NameTokens { surname, tokens })
}

fn split_tokens(value: &Option<String>) -> Vec<String> {
    value
        .as_deref()
        .map(|text| {
            text.split_whitespace()
                .map(normalize)
                .filter(|token| !token.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn shared_external_id<'a>(left: &'a Person, right: &'a Person) -> Option<&'a ExternalId> {
    left.external_ids.iter().find(|id| {
        right
            .external_ids
            .iter()
            .any(|other| external_key(other) == external_key(id))
    })
}

fn external_key(id: &ExternalId) -> (String, String) {
    (normalize(&id.source), id.value.trim().to_owned())
}

/// Surname plus the first token of the given field. A record that keeps the
/// patronymic inside `given` still compares by the actual given name, so a
/// differing patronymic stays a partial match instead of no evidence at all.
fn name_parts(name: &Name) -> Option<(String, String)> {
    let given = normalized_opt(&name.given)?;
    let surname = normalized_opt(&name.surname)?;
    let given = given.split(' ').next()?.to_owned();
    Some((surname, given))
}

fn person_date_relation(left: &DateValue, right: &DateValue) -> DateRelation {
    if date_unknown(left) || date_unknown(right) {
        return DateRelation::Unknown;
    }
    if left == right {
        return DateRelation::Same;
    }
    if intervals_intersect(left, right) {
        return DateRelation::Compatible;
    }
    match (known_year(left), known_year(right)) {
        (Some(a), Some(b)) if (a - b).abs() <= 1 => DateRelation::Compatible,
        _ => DateRelation::Conflict,
    }
}

fn event_date_relation(left: &DateValue, right: &DateValue) -> DateRelation {
    if date_unknown(left) || date_unknown(right) {
        return DateRelation::Unknown;
    }
    if left == right {
        return DateRelation::Same;
    }
    if intervals_intersect(left, right) {
        DateRelation::Compatible
    } else {
        DateRelation::Conflict
    }
}

fn date_unknown(date: &DateValue) -> bool {
    date.start.is_none() && date.end.is_none()
}

fn known_year(date: &DateValue) -> Option<i32> {
    date.start
        .map(|value| value.year)
        .or_else(|| date.end.map(|value| value.year))
}

fn shared_year(left: &DateValue, right: &DateValue) -> Option<i32> {
    match (known_year(left), known_year(right)) {
        (Some(a), Some(b)) if a == b => Some(a),
        _ => None,
    }
}

/// `true` when the two half-open `[start, end)` intervals overlap. An absent
/// bound is open, so `UNKNOWN` never invents one.
fn intervals_intersect(left: &DateValue, right: &DateValue) -> bool {
    let start = match (left.start, right.start) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let end = match (left.end, right.end) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    match (start, end) {
        (Some(start), Some(end)) => start < end,
        _ => true,
    }
}

fn confidence_for(score: u16) -> MatchConfidence {
    if score >= SCORE_FULL_NAME_COMPATIBLE {
        MatchConfidence::High
    } else if score >= SCORE_NAME_PARTS_COMPATIBLE {
        MatchConfidence::Medium
    } else {
        MatchConfidence::Ambiguous
    }
}

/// One-to-one greedy assignment, highest score first. Ties break on the left
/// index and then the right index, so the chosen pair never depends on hash
/// order.
fn assign_one_to_one(pairs: &[ScoredPair]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..pairs.len()).collect();
    order.sort_by(|&a, &b| {
        pairs[b]
            .score
            .cmp(&pairs[a].score)
            .then(pairs[a].left.cmp(&pairs[b].left))
            .then(pairs[a].right.cmp(&pairs[b].right))
    });

    let mut left_taken: HashSet<usize> = HashSet::new();
    let mut right_taken: HashSet<usize> = HashSet::new();
    let mut chosen = Vec::new();
    for index in order {
        let pair = &pairs[index];
        if left_taken.contains(&pair.left) || right_taken.contains(&pair.right) {
            continue;
        }
        left_taken.insert(pair.left);
        right_taken.insert(pair.right);
        chosen.push(index);
    }
    chosen.sort_by_key(|&index| pairs[index].left);
    chosen
}

/// Number of unassigned candidates that share an endpoint and score within
/// [`AMBIGUITY_DELTA`] of the chosen pair.
fn alternative_counts(pairs: &[ScoredPair], chosen: &[usize]) -> BTreeMap<usize, usize> {
    let chosen_set: HashSet<usize> = chosen.iter().copied().collect();
    let mut counts = BTreeMap::new();
    for &index in chosen {
        let pair = &pairs[index];
        let threshold = pair.score.saturating_sub(AMBIGUITY_DELTA);
        let count = pairs
            .iter()
            .enumerate()
            .filter(|(other, candidate)| {
                *other != index
                    && !chosen_set.contains(other)
                    && candidate.score >= threshold
                    && candidate.score > 0
                    && (candidate.left == pair.left || candidate.right == pair.right)
            })
            .count();
        counts.insert(index, count);
    }
    counts
}

/// Adds the shared-relative bonus after a preliminary assignment makes the
/// confirmed relatives known.
fn apply_shared_relative_bonus(
    left: ProjectSnapshot<'_>,
    right: ProjectSnapshot<'_>,
    candidates: &mut [ScoredPair],
) {
    if candidates.is_empty() {
        return;
    }
    let preliminary = assign_one_to_one(candidates);
    let preliminary_map: BTreeMap<Uuid, Uuid> = preliminary
        .iter()
        .map(|&index| {
            (
                left.persons[candidates[index].left].id,
                right.persons[candidates[index].right].id,
            )
        })
        .collect();
    if preliminary_map.is_empty() {
        return;
    }

    for candidate in candidates.iter_mut() {
        let left_relatives = relatives(left.relationships, left.persons[candidate.left].id);
        if left_relatives.is_empty() {
            continue;
        }
        let right_relatives = relatives(right.relationships, right.persons[candidate.right].id);
        let count = left_relatives
            .iter()
            .filter_map(|id| preliminary_map.get(id))
            .filter(|mapped| right_relatives.contains(mapped))
            .count();
        if count > 0 && candidate.score > 0 {
            candidate.score = candidate.score.saturating_add(SHARED_RELATIVE_BONUS);
            candidate.evidence.push(evidence_with(
                codes::SHARED_RELATIVE,
                &[("count", count.to_string())],
            ));
        }
    }
}

fn relatives(relationships: &[Relationship], person_id: Uuid) -> BTreeSet<Uuid> {
    relationships
        .iter()
        .filter_map(|row| {
            if row.person_id == person_id {
                Some(row.related_person_id)
            } else if row.related_person_id == person_id {
                Some(row.person_id)
            } else {
                None
            }
        })
        .collect()
}

fn owned_events(events: &[Event], person_id: Uuid) -> Vec<&Event> {
    events
        .iter()
        .filter(|event| event.person_id == person_id)
        .collect()
}

fn person_field_diffs(left: &Person, right: &Person) -> Vec<String> {
    let mut out = Vec::new();
    if left.gender != right.gender {
        out.push("gender".to_owned());
    }
    if left.birth != right.birth {
        out.push("birth".to_owned());
    }
    if left.death != right.death {
        out.push("death".to_owned());
    }
    if notes_key(left.notes.as_deref()) != notes_key(right.notes.as_deref()) {
        out.push("notes".to_owned());
    }
    out
}

fn notes_key(value: Option<&str>) -> Option<String> {
    non_empty(value).map(|text| text.trim().to_owned())
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

fn match_events(
    left_events: &[&Event],
    right_events: &[&Event],
    warnings: &mut Vec<MergeWarning>,
) -> Vec<EventMatch> {
    let mut candidates: Vec<ScoredPair> = Vec::new();
    for (left_index, left_event) in left_events.iter().enumerate() {
        for (right_index, right_event) in right_events.iter().enumerate() {
            if let Some((score, evidence)) = evaluate_event_pair(left_event, right_event) {
                candidates.push(ScoredPair {
                    left: left_index,
                    right: right_index,
                    score,
                    evidence,
                });
            }
        }
    }

    let chosen = assign_one_to_one(&candidates);
    let alternatives = alternative_counts(&candidates, &chosen);
    let mut matches = Vec::new();
    for &index in &chosen {
        let candidate = &candidates[index];
        let left_event = left_events[candidate.left];
        let right_event = right_events[candidate.right];
        let mut confidence = confidence_for(candidate.score);
        let mut evidence = candidate.evidence.clone();
        if let Some(count) = alternatives.get(&index).copied().filter(|count| *count > 0) {
            confidence = MatchConfidence::Ambiguous;
            evidence.push(evidence_with(
                codes::AMBIGUOUS_CANDIDATES,
                &[("count", count.to_string())],
            ));
            warnings.push(warning(
                codes::AMBIGUOUS_CANDIDATES,
                &[
                    ("leftEventId", left_event.id.to_string()),
                    ("rightEventId", right_event.id.to_string()),
                    ("count", count.to_string()),
                ],
            ));
        }
        matches.push(EventMatch {
            id: format!("{}:{}", left_event.id, right_event.id),
            left: MergeEvent::from(left_event),
            right: MergeEvent::from(right_event),
            confidence,
            evidence,
            field_diffs: event_field_diffs(left_event, right_event),
        });
    }
    matches
}

fn evaluate_event_pair(left: &Event, right: &Event) -> Option<(u16, Vec<MatchEvidence>)> {
    if left.event_type != right.event_type {
        return None;
    }
    let place = text_relation(left.place.as_deref(), right.place.as_deref());
    if place == TextRelation::Different {
        return None;
    }
    let description = text_relation(left.description.as_deref(), right.description.as_deref());
    if description == TextRelation::Different {
        return None;
    }
    let date = event_date_relation(&left.date, &right.date);
    if date == DateRelation::Conflict {
        return None;
    }

    let text_equal =
        |relation: TextRelation| matches!(relation, TextRelation::Same | TextRelation::BothMissing);
    // Participant ids are not part of the exactness test: cross-project ids are
    // not comparable before a person map exists. Apply unions them instead.
    let exact = left.date == right.date
        && text_equal(place)
        && text_equal(description)
        && left.details == right.details;

    let mut score = if exact {
        EVENT_SCORE_EXACT
    } else if matches!(date, DateRelation::Same | DateRelation::Compatible) {
        EVENT_SCORE_COMPATIBLE_DATE
    } else {
        EVENT_SCORE_UNKNOWN_DATE
    };
    if !exact && place == TextRelation::Same {
        score = score.saturating_add(EVENT_SCORE_PLACE_BONUS);
    }

    let mut evidence_rows = Vec::new();
    match date {
        DateRelation::Same => evidence_rows.push(evidence(codes::SAME_EVENT_DATE)),
        DateRelation::Compatible => evidence_rows.push(evidence(codes::COMPATIBLE_EVENT_DATE)),
        _ => {}
    }
    if place == TextRelation::Same {
        evidence_rows.push(evidence(codes::SAME_PLACE));
    }
    if description == TextRelation::Same {
        evidence_rows.push(evidence(codes::SAME_DESCRIPTION));
    }

    Some((score, evidence_rows))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextRelation {
    Same,
    OneMissing,
    Different,
    BothMissing,
}

fn text_relation(left: Option<&str>, right: Option<&str>) -> TextRelation {
    match (non_empty(left), non_empty(right)) {
        (None, None) => TextRelation::BothMissing,
        (Some(_), None) | (None, Some(_)) => TextRelation::OneMissing,
        (Some(a), Some(b)) => {
            if normalize(a) == normalize(b) {
                TextRelation::Same
            } else {
                TextRelation::Different
            }
        }
    }
}

/// Map-level identity: four decimals is about 11 m, so two providers returning
/// the same village do not create a false conflict.
fn same_place_point(left: &PlaceGeo, right: &PlaceGeo) -> bool {
    (left.lat - right.lat).abs() <= 1e-4 && (left.lon - right.lon).abs() <= 1e-4
}

fn event_field_diffs(left: &Event, right: &Event) -> Vec<String> {
    let mut out = Vec::new();
    if left.date != right.date {
        out.push("date".to_owned());
    }
    if text_relation(left.place.as_deref(), right.place.as_deref()) == TextRelation::Different {
        out.push("place".to_owned());
    } else if let (Some(left_point), Some(right_point)) = (&left.place_geo, &right.place_geo) {
        // Same text, different villages: the point needs an explicit choice.
        if !same_place_point(left_point, right_point) {
            out.push("placeGeo".to_owned());
        }
    }
    if text_relation(left.description.as_deref(), right.description.as_deref())
        == TextRelation::Different
    {
        out.push("description".to_owned());
    }
    let keys: BTreeSet<&String> = left.details.keys().chain(right.details.keys()).collect();
    for key in keys {
        if left.details.get(key) != right.details.get(key) {
            out.push(format!("details.{key}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Person merge
// ---------------------------------------------------------------------------

fn merge_person_fields(
    left: &Person,
    right: &Person,
    decision: &PersonDecision,
) -> AppResult<Person> {
    let base = if decision.base == Side::Right {
        right
    } else {
        left
    };
    let person = Person {
        id: left.id,
        gender: match decision.fields.get("gender") {
            Some(FieldPolicy::Left) => left.gender,
            Some(FieldPolicy::Right) => right.gender,
            _ => base.gender,
        },
        names: merge_names(left, right, decision.base),
        birth: choose_person_date(
            &left.birth,
            &right.birth,
            decision.fields.get("birth").copied(),
            decision.base,
            "birthConflict",
        )?,
        death: choose_person_date(
            &left.death,
            &right.death,
            decision.fields.get("death").copied(),
            decision.base,
            "deathConflict",
        )?,
        notes: merge_notes(
            left.notes.as_deref(),
            right.notes.as_deref(),
            decision.fields.get("notes").copied(),
            decision.base,
        ),
        external_ids: merge_external_ids(left, right),
    };
    person.validate().map_err(|error| {
        conflict("personInvalid")
            .with_param("leftId", left.id.to_string())
            .with_param("rightId", right.id.to_string())
            .with_param(
                "field",
                error.params.get("field").cloned().unwrap_or_default(),
            )
    })?;
    Ok(person)
}

fn choose_person_date(
    left: &DateValue,
    right: &DateValue,
    policy: Option<FieldPolicy>,
    base: Side,
    rule: &str,
) -> AppResult<DateValue> {
    match policy {
        Some(FieldPolicy::Left) => return Ok(left.clone()),
        Some(FieldPolicy::Right) => return Ok(right.clone()),
        _ => {}
    }
    let (base_date, other_date) = if base == Side::Right {
        (right, left)
    } else {
        (left, right)
    };
    if date_unknown(base_date) {
        return Ok(other_date.clone());
    }
    if !date_unknown(other_date)
        && person_date_relation(base_date, other_date) == DateRelation::Conflict
    {
        return Err(conflict(rule));
    }
    Ok(base_date.clone())
}

fn merge_names(left: &Person, right: &Person, base: Side) -> Vec<Name> {
    let (first, second) = if base == Side::Right {
        (right, left)
    } else {
        (left, right)
    };
    let mut rows: Vec<Name> = Vec::new();
    for person in [first, second] {
        for name in &person.names {
            let key = NameKey::from(name);
            match rows
                .iter()
                .position(|existing| NameKey::from(existing) == key)
            {
                Some(index) => rows[index].is_primary |= name.is_primary,
                None => rows.push(name.clone()),
            }
        }
    }
    // Base names were pushed first, so the first primary is the base primary;
    // it falls back to the other side's primary automatically.
    let primary = rows.iter().position(|name| name.is_primary);
    for (index, name) in rows.iter_mut().enumerate() {
        name.is_primary = Some(index) == primary;
    }
    rows
}

fn merge_external_ids(left: &Person, right: &Person) -> Vec<ExternalId> {
    let mut out: Vec<ExternalId> = Vec::new();
    for id in left.external_ids.iter().chain(&right.external_ids) {
        let key = external_key(id);
        if !out.iter().any(|existing| external_key(existing) == key) {
            out.push(id.clone());
        }
    }
    out
}

fn merge_notes(
    left: Option<&str>,
    right: Option<&str>,
    policy: Option<FieldPolicy>,
    base: Side,
) -> Option<String> {
    let (base_value, other_value) = if base == Side::Right {
        (right, left)
    } else {
        (left, right)
    };
    match policy {
        Some(FieldPolicy::Left) => non_empty(left).or(non_empty(right)).map(str::to_owned),
        Some(FieldPolicy::Right) => non_empty(right).or(non_empty(left)).map(str::to_owned),
        Some(FieldPolicy::Both) => join_text(base_value, other_value),
        None => {
            let both_differ = match (non_empty(left), non_empty(right)) {
                (Some(a), Some(b)) => a != b,
                _ => false,
            };
            if both_differ {
                join_text(base_value, other_value)
            } else {
                non_empty(base_value)
                    .or(non_empty(other_value))
                    .map(str::to_owned)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct NameKey {
    given: Option<String>,
    patronymic: Option<String>,
    surname: Option<String>,
    prefix: Option<String>,
    suffix: Option<String>,
    name_type: u8,
}

impl From<&Name> for NameKey {
    fn from(name: &Name) -> Self {
        Self {
            given: normalized_opt(&name.given),
            patronymic: normalized_opt(&name.patronymic),
            surname: normalized_opt(&name.surname),
            prefix: normalized_opt(&name.prefix),
            suffix: normalized_opt(&name.suffix),
            name_type: match name.name_type {
                NameType::Birth => 0,
                NameType::Married => 1,
                NameType::Religious => 2,
                NameType::Other => 3,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Event merge
// ---------------------------------------------------------------------------

/// The point follows the chosen place text. When the texts are equal, a
/// `placeGeo` decision picks between different points; a missing one keeps the
/// base side. A point is never borrowed across different place texts.
fn merge_event_place_geo(
    left: &Event,
    right: &Event,
    resolved_place: Option<&str>,
    decision: &EventDecision,
) -> Option<PlaceGeo> {
    resolved_place?;
    let base_point = if decision.base == Side::Right {
        &right.place_geo
    } else {
        &left.place_geo
    };
    let same_text =
        text_relation(left.place.as_deref(), right.place.as_deref()) == TextRelation::Same;
    if same_text {
        return match decision.fields.get("placeGeo").copied() {
            Some(FieldPolicy::Right) => right.place_geo.clone().or_else(|| left.place_geo.clone()),
            Some(FieldPolicy::Left) => left.place_geo.clone().or_else(|| right.place_geo.clone()),
            _ => match (&left.place_geo, &right.place_geo) {
                (Some(a), Some(b)) if same_place_point(a, b) => Some(a.clone()),
                (Some(_), Some(_)) => base_point.clone(),
                (Some(a), None) => Some(a.clone()),
                (None, Some(b)) => Some(b.clone()),
                (None, None) => None,
            },
        };
    }
    match decision.fields.get("place").copied() {
        Some(FieldPolicy::Right) => right.place_geo.clone(),
        Some(FieldPolicy::Left) => left.place_geo.clone(),
        _ => base_point.clone(),
    }
}

fn merge_event_fields(
    left: &Event,
    right: &Event,
    decision: &EventDecision,
    person_map: &BTreeMap<Uuid, Uuid>,
    source_map: &BTreeMap<Uuid, Uuid>,
    warnings: &mut Vec<MergeWarning>,
) -> AppResult<Event> {
    let base = if decision.base == Side::Right {
        right
    } else {
        left
    };
    let date = choose_event_date(left, right, decision)?;
    let place = merge_scalar_text(
        left.place.as_deref(),
        right.place.as_deref(),
        decision.fields.get("place").copied(),
        decision.base,
    );
    let place_geo = merge_event_place_geo(left, right, place.as_deref(), decision);
    let description = merge_scalar_text(
        left.description.as_deref(),
        right.description.as_deref(),
        decision.fields.get("description").copied(),
        decision.base,
    );
    let details = merge_details(
        &left.details,
        &right.details,
        &decision.fields,
        decision.base,
    );
    let mut participant_ids = merge_participant_ids(
        &left.participant_ids,
        &right.participant_ids,
        person_map,
        left.person_id,
        warnings,
        left.id,
    );
    if participant_ids.contains(&left.person_id) {
        participant_ids.retain(|id| *id != left.person_id);
    }
    let source_ids = merge_source_ids(
        &left.source_ids,
        &right.source_ids,
        source_map,
        warnings,
        left.id,
    );

    let event = Event {
        id: left.id,
        person_id: left.person_id,
        event_type: base.event_type,
        date,
        place,
        place_geo,
        description,
        source_ids,
        original_type: base.original_type.clone(),
        participant_ids,
        details,
    };
    event.validate().map_err(|error| {
        conflict("eventInvalid")
            .with_param("leftEventId", left.id.to_string())
            .with_param("rightEventId", right.id.to_string())
            .with_param(
                "field",
                error.params.get("field").cloned().unwrap_or_default(),
            )
            .with_param(
                "rule",
                error.params.get("rule").cloned().unwrap_or_default(),
            )
    })?;
    Ok(event)
}

fn choose_event_date(
    left: &Event,
    right: &Event,
    decision: &EventDecision,
) -> AppResult<DateValue> {
    match decision.fields.get("date").copied() {
        Some(FieldPolicy::Left) => return Ok(left.date.clone()),
        Some(FieldPolicy::Right) => return Ok(right.date.clone()),
        _ => {}
    }
    let (base_date, other_date) = if decision.base == Side::Right {
        (&right.date, &left.date)
    } else {
        (&left.date, &right.date)
    };
    if date_unknown(base_date) {
        return Ok(other_date.clone());
    }
    if !date_unknown(other_date)
        && event_date_relation(base_date, other_date) == DateRelation::Conflict
    {
        return Err(conflict("dateConflict")
            .with_param("leftEventId", left.id.to_string())
            .with_param("rightEventId", right.id.to_string()));
    }
    Ok(base_date.clone())
}

/// Scalar text merge: an explicit policy wins, otherwise the base value is
/// kept and an empty base is filled from the other side. `Both` joins the two
/// texts with `\n\n` when they differ.
fn merge_scalar_text(
    left: Option<&str>,
    right: Option<&str>,
    policy: Option<FieldPolicy>,
    base: Side,
) -> Option<String> {
    let (base_value, other_value) = if base == Side::Right {
        (right, left)
    } else {
        (left, right)
    };
    match policy {
        Some(FieldPolicy::Left) => non_empty(left).or(non_empty(right)).map(str::to_owned),
        Some(FieldPolicy::Right) => non_empty(right).or(non_empty(left)).map(str::to_owned),
        Some(FieldPolicy::Both) => join_text(base_value, other_value),
        None => non_empty(base_value)
            .or(non_empty(other_value))
            .map(str::to_owned),
    }
}

fn merge_details(
    left: &BTreeMap<String, String>,
    right: &BTreeMap<String, String>,
    fields: &BTreeMap<String, FieldPolicy>,
    base: Side,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let keys: BTreeSet<&String> = left.keys().chain(right.keys()).collect();
    for key in keys {
        let left_value = non_empty(left.get(key).map(String::as_str)).map(str::to_owned);
        let right_value = non_empty(right.get(key).map(String::as_str)).map(str::to_owned);
        let (base_value, other_value) = if base == Side::Right {
            (&right_value, &left_value)
        } else {
            (&left_value, &right_value)
        };
        let value = match fields.get(&format!("details.{key}")).copied() {
            Some(FieldPolicy::Left) => left_value.clone().or_else(|| right_value.clone()),
            Some(FieldPolicy::Right) => right_value.clone().or_else(|| left_value.clone()),
            Some(FieldPolicy::Both) => join_text(base_value.as_deref(), other_value.as_deref()),
            None => base_value.clone().or_else(|| other_value.clone()),
        };
        if let Some(value) = value {
            out.insert(key.clone(), value);
        }
    }
    out
}

fn merge_participant_ids(
    left: &[Uuid],
    right: &[Uuid],
    person_map: &BTreeMap<Uuid, Uuid>,
    owner: Uuid,
    warnings: &mut Vec<MergeWarning>,
    entity_id: Uuid,
) -> Vec<Uuid> {
    let mut out: Vec<Uuid> = Vec::new();
    for id in left {
        if *id != owner && !out.contains(id) {
            out.push(*id);
        }
    }
    let mut dropped = 0usize;
    for id in right {
        match person_map.get(id) {
            Some(mapped) => {
                if *mapped != owner && !out.contains(mapped) {
                    out.push(*mapped);
                }
            }
            None => dropped += 1,
        }
    }
    if dropped > 0 {
        warnings.push(warning(
            codes::REFERENCE_DROPPED,
            &[
                ("entityId", entity_id.to_string()),
                ("field", "participantIds".to_owned()),
                ("count", dropped.to_string()),
            ],
        ));
    }
    out
}

fn merge_source_ids(
    left: &[Uuid],
    right: &[Uuid],
    source_map: &BTreeMap<Uuid, Uuid>,
    warnings: &mut Vec<MergeWarning>,
    entity_id: Uuid,
) -> Vec<Uuid> {
    let mut out: Vec<Uuid> = Vec::new();
    for id in left {
        if !out.contains(id) {
            out.push(*id);
        }
    }
    let mut dropped = 0usize;
    for id in right {
        match source_map.get(id) {
            Some(mapped) => {
                if !out.contains(mapped) {
                    out.push(*mapped);
                }
            }
            None => dropped += 1,
        }
    }
    if dropped > 0 {
        warnings.push(warning(
            codes::REFERENCE_DROPPED,
            &[
                ("entityId", entity_id.to_string()),
                ("field", "sourceIds".to_owned()),
                ("count", dropped.to_string()),
            ],
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Decisions and relationships
// ---------------------------------------------------------------------------

fn index_person_decisions(
    left: ProjectSnapshot<'_>,
    right: ProjectSnapshot<'_>,
    decisions: &MergeDecisions,
) -> AppResult<BTreeMap<Uuid, PersonDecision>> {
    let left_ids: HashSet<Uuid> = left.persons.iter().map(|person| person.id).collect();
    let right_ids: HashSet<Uuid> = right.persons.iter().map(|person| person.id).collect();
    let mut indexed: BTreeMap<Uuid, PersonDecision> = BTreeMap::new();
    let mut used_left: HashSet<Uuid> = HashSet::new();
    for decision in &decisions.persons {
        if !left_ids.contains(&decision.left_id) || !right_ids.contains(&decision.right_id) {
            return Err(conflict("unknownPersonDecision")
                .with_param("leftId", decision.left_id.to_string())
                .with_param("rightId", decision.right_id.to_string()));
        }
        if indexed
            .insert(decision.right_id, decision.clone())
            .is_some()
        {
            return Err(conflict("duplicateRightPerson")
                .with_param("rightId", decision.right_id.to_string()));
        }
        if !used_left.insert(decision.left_id) {
            return Err(
                conflict("duplicateLeftPerson").with_param("leftId", decision.left_id.to_string())
            );
        }
    }
    Ok(indexed)
}

fn index_event_decisions(
    left: ProjectSnapshot<'_>,
    right: ProjectSnapshot<'_>,
    decisions: &MergeDecisions,
) -> AppResult<BTreeMap<Uuid, EventDecision>> {
    let left_ids: HashSet<Uuid> = left.events.iter().map(|event| event.id).collect();
    let right_ids: HashSet<Uuid> = right.events.iter().map(|event| event.id).collect();
    let mut indexed: BTreeMap<Uuid, EventDecision> = BTreeMap::new();
    let mut used_left: HashSet<Uuid> = HashSet::new();
    for decision in &decisions.events {
        if !left_ids.contains(&decision.left_event_id)
            || !right_ids.contains(&decision.right_event_id)
        {
            return Err(conflict("unknownEventDecision")
                .with_param("leftEventId", decision.left_event_id.to_string())
                .with_param("rightEventId", decision.right_event_id.to_string()));
        }
        if indexed
            .insert(decision.right_event_id, decision.clone())
            .is_some()
        {
            return Err(conflict("duplicateRightEvent")
                .with_param("rightEventId", decision.right_event_id.to_string()));
        }
        if !used_left.insert(decision.left_event_id) {
            return Err(conflict("duplicateLeftEvent")
                .with_param("leftEventId", decision.left_event_id.to_string()));
        }
    }
    Ok(indexed)
}

/// `true` when both rows describe the same pair in the same relationship
/// family: spouse/partner are unordered, parent/adoptive are ordered.
fn same_relationship_pair(a: &Relationship, b: &Relationship) -> bool {
    if a.rel_type.is_spouse() && b.rel_type.is_spouse() {
        let (a_low, a_high) = ordered_pair(a.person_id, a.related_person_id);
        let (b_low, b_high) = ordered_pair(b.person_id, b.related_person_id);
        return a_low == b_low && a_high == b_high;
    }
    a.rel_type.is_parent()
        && b.rel_type.is_parent()
        && a.person_id == b.person_id
        && a.related_person_id == b.related_person_id
}

fn ordered_pair(a: Uuid, b: Uuid) -> (Uuid, Uuid) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

fn relationship_type_code(rel_type: crate::relationship::RelationshipType) -> &'static str {
    use crate::relationship::RelationshipType;
    match rel_type {
        RelationshipType::ParentChild => "PARENT_CHILD",
        RelationshipType::AdoptiveParentChild => "ADOPTIVE_PARENT_CHILD",
        RelationshipType::Spouse => "SPOUSE",
        RelationshipType::Partner => "PARTNER",
    }
}

fn map_relationship_error(error: AppError) -> AppError {
    if error.code == error_codes::RELATIONSHIP_CYCLE
        || error.code == error_codes::DUPLICATE_RELATIONSHIP
    {
        error
    } else {
        conflict("relationship").with_param("code", error.code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SourceKey {
    title: String,
    author: String,
    publication: String,
    repository: String,
    url: String,
}

impl From<&Source> for SourceKey {
    fn from(source: &Source) -> Self {
        // Notes are deliberately excluded: two rows describing the same source
        // may carry different free-form notes.
        Self {
            title: normalize(&source.title),
            author: normalized_text(source.author.as_deref()),
            publication: normalized_text(source.publication.as_deref()),
            repository: normalized_text(source.repository.as_deref()),
            url: normalized_text(source.url.as_deref()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct MediaKey {
    checksum: String,
    file_name: String,
    person_id: Option<Uuid>,
    event_id: Option<Uuid>,
    source_id: Option<Uuid>,
    caption: Option<String>,
    primary: bool,
}

impl From<&Media> for MediaKey {
    fn from(media: &Media) -> Self {
        Self {
            checksum: media.checksum.clone(),
            file_name: media.file_name.clone(),
            person_id: media.person_id,
            event_id: media.event_id,
            source_id: media.source_id,
            caption: media.caption.clone(),
            primary: media.primary,
        }
    }
}

fn citation_identical(a: &Citation, b: &Citation) -> bool {
    a.source_id == b.source_id
        && a.target_type == b.target_type
        && a.target_id == b.target_id
        && a.page == b.page
        && a.confidence == b.confidence
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn conflict(rule: &str) -> AppError {
    AppError::new(error_codes::MERGE_CONFLICT, "Merge conflict").with_param("rule", rule)
}

fn evidence(code: &str) -> MatchEvidence {
    MatchEvidence {
        code: code.to_owned(),
        params: BTreeMap::new(),
    }
}

fn evidence_with(code: &str, pairs: &[(&str, String)]) -> MatchEvidence {
    MatchEvidence {
        code: code.to_owned(),
        params: kv(pairs),
    }
}

fn warning(code: &str, pairs: &[(&str, String)]) -> MergeWarning {
    MergeWarning {
        code: code.to_owned(),
        params: kv(pairs),
    }
}

fn kv(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

/// Trims, collapses whitespace, lowercases and maps `ё` to `е`.
fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for word in value.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        for character in word.chars().flat_map(char::to_lowercase) {
            out.push(if character == 'ё' { 'е' } else { character });
        }
    }
    out
}

fn normalized_text(value: Option<&str>) -> String {
    value.map(normalize).unwrap_or_default()
}

fn normalized_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(normalize)
        .filter(|text| !text.is_empty())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.trim().is_empty())
}

fn join_text(first: Option<&str>, second: Option<&str>) -> Option<String> {
    match (non_empty(first), non_empty(second)) {
        (Some(a), Some(b)) if a == b => Some(a.to_owned()),
        (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
        (Some(a), None) => Some(a.to_owned()),
        (None, Some(b)) => Some(b.to_owned()),
        (None, None) => None,
    }
}

/// Claims `candidate` when it is still free, otherwise derives a deterministic
/// UUID for `kind` + `candidate`. Every returned id is inserted into `used`.
fn claim_id(candidate: Uuid, kind: &str, used: &mut HashSet<Uuid>) -> Uuid {
    if used.insert(candidate) {
        return candidate;
    }
    let mut salt = 0u32;
    loop {
        let seed = if salt == 0 {
            format!("gentree-merge:{kind}:{candidate}")
        } else {
            format!("gentree-merge:{kind}:{candidate}:{salt}")
        };
        let derived = derive_uuid(&seed);
        if used.insert(derived) {
            return derived;
        }
        salt += 1;
    }
}

/// Deterministic UUID version 8 (RFC 9562 custom) from a seed string.
fn derive_uuid(seed: &str) -> Uuid {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&fnv1a64(seed.as_bytes(), 0xcbf2_9ce4_8422_2325).to_be_bytes());
    bytes[8..].copy_from_slice(&fnv1a64(seed.as_bytes(), 0x9e37_79b9_7f4a_7c15).to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn fnv1a64(bytes: &[u8], basis: u64) -> u64 {
    let mut hash = basis;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_case_and_yo() {
        assert_eq!(normalize("  Пётр   ИЛЬИЧ "), "петр ильич");
        assert_eq!(normalize("Ёлка"), "елка");
        assert_eq!(normalize("  "), "");
        assert_eq!(normalize("Ann  Marie"), "ann marie");
    }

    #[test]
    fn derived_ids_are_deterministic_and_custom_version() {
        let first = derive_uuid("gentree-merge:person:abc");
        let second = derive_uuid("gentree-merge:person:abc");
        assert_eq!(first, second);
        assert_eq!(first.get_version_num(), 8);
        assert_ne!(first, derive_uuid("gentree-merge:person:abd"));
    }

    #[test]
    fn year_inside_a_year_interval_is_compatible() {
        let year = DateValue::exact_year(1950);
        let day = DateValue::exact_day(crate::date::CivilDate::new(1950, 6, 1).unwrap());
        assert_eq!(person_date_relation(&year, &day), DateRelation::Compatible);
        assert_eq!(event_date_relation(&year, &day), DateRelation::Compatible);
    }

    #[test]
    fn unknown_dates_are_not_bounds() {
        let year = DateValue::exact_year(1950);
        assert_eq!(
            person_date_relation(&year, &DateValue::default()),
            DateRelation::Unknown
        );
        assert_eq!(
            event_date_relation(&DateValue::default(), &DateValue::default()),
            DateRelation::Unknown
        );
    }

    #[test]
    fn one_year_gap_is_compatible_for_people_but_not_events() {
        let a = DateValue::exact_year(1950);
        let b = DateValue::exact_year(1951);
        assert_eq!(person_date_relation(&a, &b), DateRelation::Compatible);
        assert_eq!(event_date_relation(&a, &b), DateRelation::Conflict);
    }

    #[test]
    fn claim_id_derives_a_free_uuid_on_collision() {
        let candidate = Uuid::from_u128(42);
        let mut used: HashSet<Uuid> = HashSet::new();
        assert_eq!(claim_id(candidate, "person", &mut used), candidate);
        let derived = claim_id(candidate, "person", &mut used);
        assert_ne!(derived, candidate);
        // The derived id is now taken too, so a second claim moves on.
        let next = claim_id(candidate, "person", &mut used);
        assert_ne!(next, candidate);
        assert_ne!(next, derived);
    }
}
