//! `timeline.list` command: project events split into dated and undated
//! buckets, each enriched with the owning person's display name.
//! Contract: design.md §11 and the desktop-ui timeline requirement.
//!
//! Filters are `personId`, event `types`, the half-open interval `[from, to)`
//! and a `scope` that resolves a person set:
//!
//! - `all` — every person (a `personId` still narrows the result);
//! - `person` — the focus person only;
//! - `ancestors` / `descendants` — BFS over parent edges up to `generations`
//!   levels (root included, capped at [`MAX_SCOPE_PERSONS`] people);
//! - `place` — case-insensitive substring over `event.place`.
//!
//! Undated events have no bounds at all, so an interval filter keeps them in
//! the "undated" bucket instead of dropping them silently.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use gentree_core::date::CivilDate;
use gentree_core::record::{Event, EventType};
use gentree_core::relationship::RelationshipSet;
use gentree_core::{AppError, AppResult};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use super::event::date_matches;
use super::{display_names, parse_date_bound, parse_event_type, parse_uuid, with_store};
use crate::AppState;

/// Upper bound for one response; the UI shows a truncation notice when hit.
pub const MAX_TIMELINE_ENTRIES: usize = 5000;

/// Upper bound for one resolved scope person set (ancestors/descendants).
pub const MAX_SCOPE_PERSONS: usize = 5000;

/// Default depth of the ancestors/descendants walk.
pub const DEFAULT_SCOPE_GENERATIONS: u32 = 10;

/// Hard cap for the requested walk depth.
pub const MAX_SCOPE_GENERATIONS: u32 = 50;

/// Focus of the timeline (parity with the old web `/timeline-line`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineScope {
    All,
    Person,
    Ancestors,
    Descendants,
    Place,
}

impl TimelineScope {
    fn is_ancestors(self) -> bool {
        matches!(self, Self::Ancestors)
    }

    fn is_descendants(self) -> bool {
        matches!(self, Self::Descendants)
    }
}

/// Resolved filter for one request: a person set, a place needle or neither.
#[derive(Debug, Clone, Default)]
pub struct ScopeFilter {
    pub persons: Option<BTreeSet<Uuid>>,
    /// Lowercased, trimmed substring matched against `event.place`.
    pub place: Option<String>,
    /// The scope walk hit [`MAX_SCOPE_PERSONS`]; the UI must say so.
    pub truncated: bool,
}

impl ScopeFilter {
    fn matches(&self, event: &Event) -> bool {
        if self
            .persons
            .as_ref()
            .is_some_and(|persons| !event.involves_any(persons))
        {
            return false;
        }
        if let Some(needle) = &self.place {
            let matches = event
                .place
                .as_deref()
                .is_some_and(|place| place.to_lowercase().contains(needle));
            if !matches {
                return false;
            }
        }
        true
    }
}

/// One timeline row: the event plus the resolved person display name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub event: Event,
    pub person_name: String,
}

/// Dated rows are ordered by date, undated rows follow them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResult {
    pub dated: Vec<TimelineEntry>,
    pub undated: Vec<TimelineEntry>,
    pub truncated: bool,
    /// `true` when the scope person walk exceeded [`MAX_SCOPE_PERSONS`].
    pub scope_truncated: bool,
}

/// An unknown date never invents bounds (ADR-0010).
fn is_undated(event: &Event) -> bool {
    event.date.start.is_none() && event.date.end.is_none()
}

/// Position of a dated event: `start`, or `end` for a `BEFORE` qualifier
/// that has no start. Undated events are never passed here.
fn timeline_position(entry: &TimelineEntry) -> Option<CivilDate> {
    entry.event.date.start.or(entry.event.date.end)
}

fn entry_order(left: &TimelineEntry, right: &TimelineEntry) -> Ordering {
    match (timeline_position(left), timeline_position(right)) {
        (Some(a), Some(b)) => a.cmp(&b).then_with(|| left.event.id.cmp(&right.event.id)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.event.id.cmp(&right.event.id),
    }
}

/// Applies filters, orders rows and caps the combined result.
fn build_timeline(
    events: impl IntoIterator<Item = Event>,
    person_names: &HashMap<Uuid, String>,
    scope: &ScopeFilter,
    types: Option<&[EventType]>,
    from: Option<CivilDate>,
    to: Option<CivilDate>,
) -> TimelineResult {
    let mut dated = Vec::new();
    let mut undated = Vec::new();

    for event in events {
        if !scope.matches(&event) {
            continue;
        }
        if types.is_some_and(|list| !list.is_empty() && !list.contains(&event.event_type)) {
            continue;
        }

        let undated_event = is_undated(&event);
        if !undated_event && !date_matches(&event.date, from, to) {
            continue;
        }

        let person_name = person_names
            .get(&event.person_id)
            .cloned()
            .unwrap_or_else(|| event.person_id.to_string());
        let entry = TimelineEntry { event, person_name };
        if undated_event {
            undated.push(entry);
        } else {
            dated.push(entry);
        }
    }

    dated.sort_by(entry_order);
    undated.sort_by_key(|left| left.event.id);
    finalize(dated, undated, MAX_TIMELINE_ENTRIES, scope.truncated)
}

fn finalize(
    mut dated: Vec<TimelineEntry>,
    mut undated: Vec<TimelineEntry>,
    limit: usize,
    scope_truncated: bool,
) -> TimelineResult {
    let total = dated.len() + undated.len();
    let truncated = total > limit;
    if dated.len() > limit {
        dated.truncate(limit);
    }
    let remaining = limit.saturating_sub(dated.len());
    undated.truncate(remaining);
    TimelineResult {
        dated,
        undated,
        truncated,
        scope_truncated,
    }
}

/// `generations` defaults to [`DEFAULT_SCOPE_GENERATIONS`] and is capped at
/// [`MAX_SCOPE_GENERATIONS`]; the request never widens the walk silently.
pub fn normalize_generations(raw: Option<u32>) -> u32 {
    raw.unwrap_or(DEFAULT_SCOPE_GENERATIONS)
        .min(MAX_SCOPE_GENERATIONS)
}

/// BFS over parent edges (`towards_parents`) or child edges. The root is always
/// included and counts towards `cap`; the returned flag reports a cap hit.
fn directional_persons(
    root: Uuid,
    generations: u32,
    cap: usize,
    towards_parents: bool,
    relationships: &RelationshipSet,
) -> (BTreeSet<Uuid>, bool) {
    let mut seen = BTreeSet::from([root]);
    let mut frontier = vec![root];

    for _ in 0..generations {
        let mut next = Vec::new();
        for person in frontier {
            let neighbours: Vec<Uuid> = if towards_parents {
                relationships
                    .parents_of(person)
                    .into_iter()
                    .map(|(parent, _)| parent)
                    .collect()
            } else {
                relationships.children_of(person)
            };
            for neighbour in neighbours {
                if seen.insert(neighbour) {
                    next.push(neighbour);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }

    let truncated = seen.len() > cap;
    let kept = seen.into_iter().take(cap).collect();
    (kept, truncated)
}

fn require_person(person_id: Option<Uuid>) -> AppResult<Uuid> {
    person_id.ok_or_else(|| AppError::validation("personId", "required"))
}

/// Resolves `all` / `person` / `place`; the tree walks are handled separately
/// because they need the relationship set.
fn resolve_simple_scope(
    scope: TimelineScope,
    person_id: Option<Uuid>,
    place: Option<&str>,
) -> AppResult<ScopeFilter> {
    let persons = match scope {
        TimelineScope::Person => Some(BTreeSet::from([require_person(person_id)?])),
        // `all` introduces no restriction; an explicit personId still narrows.
        _ => person_id.map(|id| BTreeSet::from([id])),
    };

    let place = if scope == TimelineScope::Place {
        let needle = place.unwrap_or("").trim().to_lowercase();
        if needle.is_empty() {
            return Err(AppError::validation("place", "required"));
        }
        Some(needle)
    } else {
        None
    };

    Ok(ScopeFilter {
        persons,
        place,
        truncated: false,
    })
}

/// Timeline's own error decoration for an unknown `types` value.
fn event_type_or_error(raw: &str) -> AppResult<EventType> {
    parse_event_type(raw)
        .ok_or_else(|| AppError::validation("types", "unknown").with_param("value", raw))
}

fn parse_scope(raw: &str) -> AppResult<TimelineScope> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "all" => Ok(TimelineScope::All),
        "person" => Ok(TimelineScope::Person),
        "ancestors" => Ok(TimelineScope::Ancestors),
        "descendants" => Ok(TimelineScope::Descendants),
        "place" => Ok(TimelineScope::Place),
        _ => Err(AppError::validation("scope", "unknown").with_param("value", raw)),
    }
}

/// Project-wide timeline for the desktop UI. No localized strings leave Rust;
/// the UI formats event types and dates (ADR-0014).
///
/// Tauri commands receive flat arguments, so the filter set stays flat; the
/// frontend contract is `timeline_list` with camelCase names.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn timeline_list(
    state: State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
    person_id: Option<String>,
    types: Option<Vec<String>>,
    scope: Option<String>,
    generations: Option<u32>,
    place: Option<String>,
) -> Result<TimelineResult, AppError> {
    let from = parse_date_bound("from", from.as_deref())?;
    let to = parse_date_bound("to", to.as_deref())?;
    let person_id = person_id
        .as_deref()
        .map(|raw| parse_uuid("personId", raw))
        .transpose()?;
    let types = types
        .as_deref()
        .map(|values| {
            values
                .iter()
                .map(|value| event_type_or_error(value))
                .collect::<AppResult<Vec<_>>>()
        })
        .transpose()?;
    let scope = scope
        .as_deref()
        .map(parse_scope)
        .transpose()?
        .unwrap_or(TimelineScope::All);
    let generations = normalize_generations(generations);

    with_store(&state, |store| {
        let person_names = display_names(&store.persons()?);

        let filter = if scope.is_ancestors() || scope.is_descendants() {
            let root = require_person(person_id)?;
            let relationships = store.relationship_set()?;
            let (persons, truncated) = directional_persons(
                root,
                generations,
                MAX_SCOPE_PERSONS,
                scope.is_ancestors(),
                &relationships,
            );
            ScopeFilter {
                persons: Some(persons),
                place: None,
                truncated,
            }
        } else {
            resolve_simple_scope(scope, person_id, place.as_deref())?
        };

        Ok(build_timeline(
            store.events()?,
            &person_names,
            &filter,
            types.as_deref(),
            from,
            to,
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::date::DateValue;
    use gentree_core::relationship::{Relationship, RelationshipType};

    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    fn event(seed: u128, person: Uuid, event_type: EventType) -> Event {
        let mut event = Event::new(person, event_type);
        event.id = id(seed);
        event
    }

    fn year(seed: u128, person: Uuid, value: i32) -> Event {
        let mut event = event(seed, person, EventType::Birth);
        event.date = DateValue::exact_year(value);
        event
    }

    fn names(person: Uuid) -> HashMap<Uuid, String> {
        HashMap::from([(person, "Test Person".to_owned())])
    }

    fn edge(set: &mut RelationshipSet, parent: Uuid, child: Uuid) {
        set.push(Relationship::new(RelationshipType::ParentChild, parent, child).unwrap())
            .unwrap();
    }

    fn ids(values: &BTreeSet<Uuid>) -> Vec<Uuid> {
        values.iter().copied().collect()
    }

    #[test]
    fn orders_dated_rows_and_puts_undated_last() {
        let person = id(1);
        let result = build_timeline(
            vec![
                year(10, person, 1970),
                year(11, person, 1950),
                event(12, person, EventType::Other),
            ],
            &names(person),
            &ScopeFilter::default(),
            None,
            None,
            None,
        );

        let ids: Vec<Uuid> = result.dated.iter().map(|row| row.event.id).collect();
        assert_eq!(ids, vec![id(11), id(10)]);
        assert_eq!(result.undated.len(), 1);
        assert_eq!(result.undated[0].event.id, id(12));
        assert_eq!(result.undated[0].person_name, "Test Person");
        assert!(!result.truncated);
        assert!(!result.scope_truncated);
    }

    #[test]
    fn filters_by_person_type_and_half_open_range() {
        let first = id(1);
        let second = id(2);
        let mut marriage = year(20, first, 1980);
        marriage.event_type = EventType::Marriage;
        let events = vec![year(21, first, 1950), marriage, year(22, second, 1960)];
        let mut all_names = names(first);
        all_names.insert(second, "Other Person".to_owned());

        let first_only = ScopeFilter {
            persons: Some(BTreeSet::from([first])),
            ..ScopeFilter::default()
        };
        let by_person = build_timeline(events.clone(), &all_names, &first_only, None, None, None);
        assert_eq!(by_person.dated.len(), 2);

        let by_type = build_timeline(
            events.clone(),
            &all_names,
            &ScopeFilter::default(),
            Some(&[EventType::Marriage]),
            None,
            None,
        );
        assert_eq!(by_type.dated.len(), 1);
        assert_eq!(by_type.dated[0].event.id, id(20));

        let no_types = build_timeline(
            events.clone(),
            &all_names,
            &ScopeFilter::default(),
            Some(&[]),
            None,
            None,
        );
        assert_eq!(no_types.dated.len(), 3);

        let from = CivilDate::parse("1960-01-01").unwrap();
        let to = CivilDate::parse("1980-01-01").unwrap();
        let by_range = build_timeline(
            events,
            &all_names,
            &ScopeFilter::default(),
            None,
            Some(from),
            Some(to),
        );
        assert_eq!(
            by_range
                .dated
                .iter()
                .map(|row| row.event.id)
                .collect::<Vec<_>>(),
            vec![id(22)]
        );
    }

    #[test]
    fn place_scope_matches_case_insensitive_substring() {
        let person = id(1);
        let mut moscow = year(30, person, 1950);
        moscow.place = Some("Москва, Россия".to_owned());
        let mut other = year(31, person, 1960);
        other.place = Some("Казань".to_owned());
        let no_place = year(32, person, 1970);

        let filter = ScopeFilter {
            place: Some("моск".to_owned()),
            ..ScopeFilter::default()
        };
        let result = build_timeline(
            vec![moscow, other, no_place],
            &names(person),
            &filter,
            None,
            None,
            None,
        );
        assert_eq!(result.dated.len(), 1);
        assert_eq!(result.dated[0].event.id, id(30));
    }

    #[test]
    fn keeps_undated_rows_when_a_range_is_set() {
        let person = id(1);
        let unknown = event(30, person, EventType::Other);
        let mut before = event(31, person, EventType::Death);
        before.date = DateValue::before(CivilDate::parse("2000-01-01").unwrap());

        let from = CivilDate::parse("1950-01-01").unwrap();
        let result = build_timeline(
            vec![unknown, before],
            &names(person),
            &ScopeFilter::default(),
            None,
            Some(from),
            None,
        );

        assert_eq!(result.dated.len(), 1);
        assert_eq!(result.dated[0].event.id, id(31));
        assert_eq!(result.undated.len(), 1);
        assert_eq!(result.undated[0].event.id, id(30));
    }

    #[test]
    fn caps_the_combined_result() {
        let person = id(1);
        let dated: Vec<TimelineEntry> = (0..2)
            .map(|seed| TimelineEntry {
                event: year(seed, person, 1950 + seed as i32),
                person_name: "Test Person".to_owned(),
            })
            .collect();
        let undated = vec![TimelineEntry {
            event: event(9, person, EventType::Other),
            person_name: "Test Person".to_owned(),
        }];

        let result = finalize(dated, undated, 2, false);
        assert!(result.truncated);
        assert_eq!(result.dated.len(), 2);
        assert!(result.undated.is_empty());

        let room = finalize(
            vec![TimelineEntry {
                event: year(1, person, 1950),
                person_name: "Test Person".to_owned(),
            }],
            vec![TimelineEntry {
                event: event(2, person, EventType::Other),
                person_name: "Test Person".to_owned(),
            }],
            2,
            true,
        );
        assert!(!room.truncated);
        assert_eq!(room.undated.len(), 1);
        assert!(room.scope_truncated);
    }

    #[test]
    fn ancestors_walk_stops_at_requested_depth() {
        let (root, parent, grand, great) = (id(1), id(2), id(3), id(4));
        let mut set = RelationshipSet::default();
        edge(&mut set, parent, root);
        edge(&mut set, grand, parent);
        edge(&mut set, great, grand);

        let (walked, truncated) = directional_persons(root, 2, MAX_SCOPE_PERSONS, true, &set);
        assert!(!truncated);
        assert_eq!(ids(&walked), vec![root, parent, grand]);

        let (all, _) = directional_persons(root, 10, MAX_SCOPE_PERSONS, true, &set);
        assert_eq!(ids(&all), vec![root, parent, grand, great]);
    }

    #[test]
    fn descendants_walk_follows_child_edges_only() {
        let (root, child, grandchild) = (id(1), id(2), id(3));
        let sibling = id(9);
        let mut set = RelationshipSet::default();
        edge(&mut set, root, child);
        edge(&mut set, child, grandchild);
        edge(&mut set, id(8), sibling);

        let (walked, truncated) = directional_persons(root, 10, MAX_SCOPE_PERSONS, false, &set);
        assert!(!truncated);
        assert_eq!(ids(&walked), vec![root, child, grandchild]);
    }

    #[test]
    fn person_cap_marks_the_scope_truncated() {
        let (root, parent, grand) = (id(1), id(2), id(3));
        let mut set = RelationshipSet::default();
        edge(&mut set, parent, root);
        edge(&mut set, grand, parent);

        let (walked, truncated) = directional_persons(root, 10, 2, true, &set);
        assert!(truncated);
        assert_eq!(walked.len(), 2);
        assert!(walked.contains(&root));
    }

    #[test]
    fn generations_default_and_cap() {
        assert_eq!(normalize_generations(None), 10);
        assert_eq!(normalize_generations(Some(2)), 2);
        assert_eq!(normalize_generations(Some(0)), 0);
        assert_eq!(normalize_generations(Some(500)), 50);
    }

    #[test]
    fn simple_scope_requires_person_and_place_values() {
        let person = id(1);
        let filter = resolve_simple_scope(TimelineScope::Person, Some(person), None).unwrap();
        assert_eq!(filter.persons, Some(BTreeSet::from([person])));
        assert!(filter.place.is_none());

        let missing = resolve_simple_scope(TimelineScope::Person, None, None).unwrap_err();
        assert_eq!(
            missing.params.get("field").map(String::as_str),
            Some("personId")
        );

        let place = resolve_simple_scope(TimelineScope::Place, None, Some("  Москва ")).unwrap();
        assert_eq!(place.place.as_deref(), Some("москва"));

        let blank = resolve_simple_scope(TimelineScope::Place, None, Some("  ")).unwrap_err();
        assert_eq!(blank.params.get("field").map(String::as_str), Some("place"));

        let all = resolve_simple_scope(TimelineScope::All, None, Some("ignored")).unwrap();
        assert!(all.persons.is_none());
        assert!(all.place.is_none());
    }

    #[test]
    fn person_scope_without_place_ignores_place_input() {
        let person = id(1);
        let filter =
            resolve_simple_scope(TimelineScope::Person, Some(person), Some("Москва")).unwrap();
        assert!(filter.place.is_none());
    }

    #[test]
    fn parses_scopes_and_rejects_unknown_values() {
        assert_eq!(parse_scope(" all ").unwrap(), TimelineScope::All);
        assert_eq!(parse_scope("Person").unwrap(), TimelineScope::Person);
        assert_eq!(parse_scope("ANCESTORS").unwrap(), TimelineScope::Ancestors);
        assert_eq!(
            parse_scope("descendants").unwrap(),
            TimelineScope::Descendants
        );
        assert_eq!(parse_scope("place").unwrap(), TimelineScope::Place);

        let error = parse_scope("friends").unwrap_err();
        assert_eq!(error.code, gentree_core::error::codes::VALIDATION_ERROR);
        assert_eq!(error.params.get("field").map(String::as_str), Some("scope"));
    }

    #[test]
    fn parses_event_types_and_rejects_unknown_values() {
        assert_eq!(parse_event_type(" birth "), Some(EventType::Birth));
        assert_eq!(parse_event_type("OCCUPATION"), Some(EventType::Occupation));
        let error = event_type_or_error("christening").unwrap_err();
        assert_eq!(error.code, gentree_core::error::codes::VALIDATION_ERROR);
        assert_eq!(error.params.get("field").map(String::as_str), Some("types"));
        assert_eq!(
            error.params.get("value").map(String::as_str),
            Some("christening")
        );
    }

    #[test]
    fn malformed_ids_and_dates_are_validation_errors() {
        let id_error = parse_uuid("personId", "not-a-uuid").unwrap_err();
        assert_eq!(
            id_error.params.get("field").map(String::as_str),
            Some("personId")
        );

        let date_error = parse_date_bound("from", Some("1950-13-01")).unwrap_err();
        assert_eq!(
            date_error.params.get("field").map(String::as_str),
            Some("from")
        );
        assert!(parse_date_bound("to", Some("1950-05-01"))
            .unwrap()
            .is_some());
    }
}
