//! `person.*` commands: list/get/create/update/delete with `expectedVersion`.
//! Deletion follows [`gentree_core::removal_plan`]; see design.md §4 and §7.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use gentree_core::date::CivilDate;
use gentree_core::person::{ExternalId, Gender, Name, Person};
use gentree_core::record::{Citation, Event, EventType, Media};
use gentree_core::relationship::Relationship;
use gentree_core::validation::{removal_plan, RemovalPlan};
use gentree_core::{fill_patronymic, unique_father_given_name, AppError, AppResult, DateValue};
use gentree_storage::{ProjectStore, EVENT_FILE, PERSON_FILE, RELATIONSHIP_FILE};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use super::{
    entity_version, parse_uuid, person_not_found, require_version, versioned, with_store, Page,
    Versioned,
};
use crate::AppState;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;

/// Create/update payload; `id` is generated on create when absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonInput {
    #[serde(default)]
    pub id: Option<Uuid>,
    #[serde(default)]
    pub gender: Gender,
    #[serde(default)]
    pub names: Vec<Name>,
    #[serde(default)]
    pub birth: DateValue,
    #[serde(default)]
    pub death: DateValue,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub external_ids: Vec<ExternalId>,
}

impl PersonInput {
    fn into_person(self) -> Person {
        Person {
            id: self.id.unwrap_or_else(Uuid::now_v7),
            gender: self.gender,
            names: self.names,
            birth: self.birth,
            death: self.death,
            notes: self.notes,
            external_ids: self.external_ids,
        }
    }

    fn require_id(&self) -> AppResult<Uuid> {
        self.id
            .ok_or_else(|| AppError::validation("id", "required"))
    }
}

/// Person card payload: events and relationships that touch the person.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDetail {
    pub person: Versioned<Person>,
    pub events: Vec<Versioned<Event>>,
    pub relationships: Vec<Versioned<Relationship>>,
    /// Both ends of `relationships`, so the card never has to resolve ids.
    pub related_persons: Vec<Versioned<Person>>,
}

/// Compact parent row for the persons list (`person_parents` batch command).
/// Kept separate from [`PersonDetail`] so `person_list` keeps its shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentRef {
    pub id: String,
    /// `Фамилия Имя Отчество` from the primary name; empty when unnamed.
    pub name: String,
    pub gender: Gender,
}

/// Parents of every requested person, keyed by the requested id as a string.
///
/// Edges considered: `PARENT_CHILD` and `ADOPTIVE_PARENT_CHILD`, where
/// `person_id` is the parent. Requested ids that are not persons are absent
/// from the map; a known person without parents maps to an empty list.
fn parent_refs(
    requested: &[Uuid],
    persons: &[Person],
    relationships: &[Relationship],
) -> HashMap<String, Vec<ParentRef>> {
    let by_id: HashMap<Uuid, &Person> = persons.iter().map(|person| (person.id, person)).collect();
    let mut out: HashMap<String, Vec<ParentRef>> = HashMap::new();
    for id in requested {
        if by_id.contains_key(id) {
            out.entry(id.to_string()).or_default();
        }
    }
    if out.is_empty() {
        return out;
    }

    for row in relationships {
        if !row.rel_type.is_parent() {
            continue;
        }
        let Some(entry) = out.get_mut(&row.related_person_id.to_string()) else {
            continue;
        };
        let Some(parent) = by_id.get(&row.person_id) else {
            continue;
        };
        let parent_ref = ParentRef {
            id: parent.id.to_string(),
            name: parent.display_name(),
            gender: parent.gender,
        };
        // A person may be linked both as a parent and as an adoptive parent;
        // the descriptor carries no adoption flag, so one row is enough.
        if !entry.contains(&parent_ref) {
            entry.push(parent_ref);
        }
    }

    for parents in out.values_mut() {
        parents.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    out
}

/// A date carries no information when it has no bounds and no original text.
fn is_blank_date(date: &DateValue) -> bool {
    date.start.is_none() && date.end.is_none() && date.original.as_deref().is_none_or(str::is_empty)
}

/// Keeps the automatic `BIRTH`/`DEATH` events of one person in step with the
/// person's life dates. Returns `true` when `events` changed.
///
/// Only the event matching the person's *previous* date is updated, i.e. the
/// event that was created from the person card. A `BIRTH`/`DEATH` event with a
/// different date was entered by hand or came from an import: overwriting it
/// would silently destroy user data, so it is left untouched and no duplicate
/// is created next to it.
pub(crate) fn sync_life_events(
    events: &mut Vec<Event>,
    person: &Person,
    previous: Option<&Person>,
) -> bool {
    let mut changed = false;
    for (event_type, date, previous_date) in [
        (
            EventType::Birth,
            &person.birth,
            previous.map(|row| &row.birth),
        ),
        (
            EventType::Death,
            &person.death,
            previous.map(|row| &row.death),
        ),
    ] {
        changed |= sync_life_event(events, person.id, event_type, date, previous_date);
    }
    changed
}

fn sync_life_event(
    events: &mut Vec<Event>,
    person_id: Uuid,
    event_type: EventType,
    date: &DateValue,
    previous_date: Option<&DateValue>,
) -> bool {
    let owned: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.person_id == person_id && event.event_type == event_type)
        .map(|(index, _)| index)
        .collect();

    if let Some(previous_date) = previous_date {
        if !is_blank_date(previous_date) {
            if let Some(position) = owned
                .iter()
                .copied()
                .find(|index| events[*index].date == *previous_date)
            {
                if is_blank_date(date) {
                    events.remove(position);
                    return true;
                }
                if events[position].date == *date {
                    return false;
                }
                // Only the date follows the person card; place, description,
                // sources and co-participants stay as the user left them.
                events[position].date = date.clone();
                return true;
            }
        }
    }

    if owned.is_empty() && !is_blank_date(date) {
        let mut event = Event::new(person_id, event_type);
        event.date = date.clone();
        events.push(event);
        return true;
    }
    false
}

fn versioned_persons(store: &ProjectStore) -> AppResult<Vec<Versioned<Person>>> {
    let versions = store.collection_versions(PERSON_FILE)?;
    versioned(store.persons()?, &versions, |person| person.id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PersonSort {
    Name,
    Birth,
    Death,
}

impl PersonSort {
    /// Unknown or missing values keep the historical default (name ascending).
    fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("birth") => Self::Birth,
            Some("death") => Self::Death,
            _ => Self::Name,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    fn parse(raw: Option<&str>) -> Self {
        if raw.map(str::trim) == Some("desc") {
            Self::Desc
        } else {
            Self::Asc
        }
    }

    fn apply(self, ordering: Ordering) -> Ordering {
        match self {
            Self::Asc => ordering,
            Self::Desc => ordering.reverse(),
        }
    }
}

fn name_order(left: &Person, right: &Person) -> Ordering {
    left.display_name()
        .to_lowercase()
        .cmp(&right.display_name().to_lowercase())
        .then_with(|| left.id.cmp(&right.id))
}

/// Dated rows first (the direction flips only the date comparison); undated
/// rows stay last for both directions. Ties fall back to name, then id.
fn date_order(
    left: Option<CivilDate>,
    right: Option<CivilDate>,
    direction: SortDirection,
) -> Ordering {
    match (left, right) {
        (Some(a), Some(b)) => direction.apply(a.cmp(&b)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn sort_persons(persons: &mut [Person], sort: PersonSort, direction: SortDirection) {
    persons.sort_by(|left, right| match sort {
        PersonSort::Name => direction.apply(name_order(left, right)),
        PersonSort::Birth => date_order(left.birth.start, right.birth.start, direction)
            .then_with(|| name_order(left, right)),
        PersonSort::Death => date_order(left.death.start, right.death.start, direction)
            .then_with(|| name_order(left, right)),
    });
}

fn matches_query(person: &Person, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    person
        .names
        .iter()
        .map(Name::display)
        .chain(std::iter::once(person.display_name()))
        .any(|name| name.to_lowercase().contains(needle))
}

#[tauri::command]
pub fn person_list(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    sort: Option<String>,
    direction: Option<String>,
) -> Result<Page<Versioned<Person>>, AppError> {
    with_store(&state, |store| {
        let needle = query.unwrap_or_default().trim().to_lowercase();
        let mut persons: Vec<Person> = store
            .persons()?
            .into_iter()
            .filter(|person| matches_query(person, &needle))
            .collect();
        sort_persons(
            &mut persons,
            PersonSort::parse(sort.as_deref()),
            SortDirection::parse(direction.as_deref()),
        );

        let total = persons.len();
        let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let offset = offset.unwrap_or(0);
        let versions = store.collection_versions(PERSON_FILE)?;
        let items = versioned(
            persons.into_iter().skip(offset).take(limit),
            &versions,
            |person| person.id,
        )?;
        Ok(Page { items, total })
    })
}

/// Batch parent lookup for the persons list. Ids that are not persons are
/// omitted; an empty input yields an empty map. `person_list` is unchanged.
#[tauri::command]
pub fn person_parents(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<HashMap<String, Vec<ParentRef>>, AppError> {
    with_store(&state, |store| {
        let requested: Vec<Uuid> = ids
            .iter()
            .filter_map(|raw| Uuid::parse_str(raw.trim()).ok())
            .collect();
        if requested.is_empty() {
            return Ok(HashMap::new());
        }
        let persons = store.persons()?;
        let relationships = store.relationships()?;
        Ok(parent_refs(&requested, &persons, &relationships))
    })
}

#[tauri::command]
pub fn person_get(state: State<'_, AppState>, id: Uuid) -> Result<PersonDetail, AppError> {
    with_store(&state, |store| {
        let persons = versioned_persons(store)?;
        let person = persons
            .iter()
            .find(|item| item.entity.id == id)
            .cloned()
            .ok_or_else(|| person_not_found(id))?;

        let event_versions = store.collection_versions(EVENT_FILE)?;
        let events = versioned(
            store
                .events()?
                .into_iter()
                .filter(|event| event.involves(id)),
            &event_versions,
            |event| event.id,
        )?;

        let relationship_versions = store.collection_versions(RELATIONSHIP_FILE)?;
        let relationships = versioned(
            store
                .relationships()?
                .into_iter()
                .filter(|row| row.person_id == id || row.related_person_id == id),
            &relationship_versions,
            |row| row.id,
        )?;

        let related_ids: BTreeSet<Uuid> = relationships
            .iter()
            .flat_map(|row| [row.entity.person_id, row.entity.related_person_id])
            .filter(|related| *related != id)
            .collect();
        let related_persons = persons
            .into_iter()
            .filter(|item| related_ids.contains(&item.entity.id))
            .collect();

        Ok(PersonDetail {
            person,
            events,
            relationships,
            related_persons,
        })
    })
}

#[tauri::command]
pub fn person_set_home(state: State<'_, AppState>, person_id: String) -> Result<(), AppError> {
    with_store(&state, |store| {
        let id = parse_uuid("personId", &person_id)?;
        store.set_home_person(Some(id))
    })
}

#[tauri::command]
pub fn person_create(
    state: State<'_, AppState>,
    person: PersonInput,
) -> Result<Versioned<Person>, AppError> {
    with_store(&state, |store| {
        let entity = person.into_person();
        entity.validate()?;
        let mut persons = store.persons()?;
        if persons.iter().any(|existing| existing.id == entity.id) {
            return Err(AppError::validation("id", "duplicate"));
        }
        persons.push(entity.clone());
        store.save_persons(&persons)?;
        let mut events = store.events()?;
        if sync_life_events(&mut events, &entity, None) {
            store.save_events(&events)?;
        }
        let version = entity_version(store, PERSON_FILE, entity.id)?;
        Ok(Versioned { entity, version })
    })
}

#[tauri::command]
pub fn person_update(
    state: State<'_, AppState>,
    person: PersonInput,
    expected_version: String,
) -> Result<Versioned<Person>, AppError> {
    with_store(&state, |store| {
        let id = person.require_id()?;
        let mut entity = person.into_person();
        entity.validate()?;
        require_version(store, PERSON_FILE, id, &expected_version)?;

        let mut persons = store.persons()?;
        let index = persons
            .iter()
            .position(|existing| existing.id == id)
            .ok_or_else(|| person_not_found(id))?;
        let previous = persons[index].clone();
        // Saving the form fills an empty patronymic from the stored biological
        // father. A non-empty value from the form or from an import is kept.
        let relationships = store.relationships()?;
        if let Some(father_given) = unique_father_given_name(&persons, &relationships, id) {
            fill_patronymic(&mut entity, &father_given);
        }
        persons[index] = entity.clone();
        store.save_persons(&persons)?;
        let mut events = store.events()?;
        if sync_life_events(&mut events, &entity, Some(&previous)) {
            store.save_events(&events)?;
        }
        let version = entity_version(store, PERSON_FILE, id)?;
        Ok(Versioned { entity, version })
    })
}

/// One person removal, read and planned before the first write. `dryRun` paths
/// report the plan and stop; the apply step is the same for IPC and chat.
pub(crate) struct Removal {
    id: Uuid,
    plan: RemovalPlan,
    persons: Vec<Person>,
    events: Vec<Event>,
    relationships: Vec<Relationship>,
    citations: Vec<Citation>,
    /// Only present when an attachment lost its event link.
    media: Option<Vec<Media>>,
}

/// Reads the project and computes which rows the deletion touches.
pub(crate) fn plan_removal(store: &ProjectStore, id: Uuid) -> AppResult<Removal> {
    let persons = store.persons()?;
    if !persons.iter().any(|person| person.id == id) {
        return Err(person_not_found(id));
    }
    let events = store.events()?;
    let relationships = store.relationships()?;
    let citations = store.citations()?;
    let plan = removal_plan(id, &persons, &events, &relationships, &citations);

    let persons = persons
        .into_iter()
        .filter(|person| person.id != id)
        .collect();
    let events = events
        .into_iter()
        .filter_map(|mut event| {
            if plan.removed_event_ids.contains(&event.id) {
                return None;
            }
            if event.involves(id) {
                // Shared events survive; the caller detaches the person and
                // promotes a remaining co-participant.
                event.detach_person(id);
            }
            Some(event)
        })
        .collect();
    let relationships = relationships
        .into_iter()
        .filter(|row| !plan.removed_relationship_ids.contains(&row.id))
        .collect();
    let citations = citations
        .into_iter()
        .filter(|row| !plan.removed_citation_ids.contains(&row.id))
        .collect();

    // An event that disappears with its only participant must not leave an
    // attachment pointing at it. The row and the file stay (ADR-0009), only the
    // link is cleared; other event attachments are untouched.
    let mut media = store.media()?;
    let mut media_changed = false;
    for row in media.iter_mut() {
        if row
            .event_id
            .is_some_and(|event_id| plan.removed_event_ids.contains(&event_id))
        {
            row.event_id = None;
            media_changed = true;
        }
    }

    Ok(Removal {
        id,
        plan,
        persons,
        events,
        relationships,
        citations,
        media: media_changed.then_some(media),
    })
}

/// Writes a planned removal. Dependent collections go first, so a crash
/// between writes never leaves an event pointing at a removed person.
pub(crate) fn apply_removal(store: &mut ProjectStore, removal: Removal) -> AppResult<RemovalPlan> {
    let Removal {
        id,
        plan,
        persons,
        events,
        relationships,
        citations,
        media,
    } = removal;
    if let Some(media) = media {
        store.save_media(&media)?;
    }
    store.save_citations(&citations)?;
    store.save_events(&events)?;
    store.save_relationships(&relationships)?;
    store.save_persons(&persons)?;
    if store.manifest().home_person_id == Some(id) {
        store.set_home_person(None)?;
    }
    Ok(plan)
}

#[tauri::command]
pub fn person_delete(
    state: State<'_, AppState>,
    id: Uuid,
    expected_version: String,
) -> Result<RemovalPlan, AppError> {
    with_store(&state, |store| {
        let removal = plan_removal(store, id)?;
        require_version(store, PERSON_FILE, id, &expected_version)?;
        apply_removal(store, removal)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::date::{DatePrecision, DateQualifier, DateValue};
    use gentree_core::person::{Name, NameType};
    use gentree_core::relationship::RelationshipType;

    fn date(year: i32) -> DateValue {
        DateValue {
            start: CivilDate::new(year, 1, 1).ok(),
            end: CivilDate::new(year + 1, 1, 1).ok(),
            precision: DatePrecision::Year,
            qualifier: DateQualifier::Exact,
            original: None,
        }
    }

    fn person(id: u128, surname: &str, birth: Option<i32>, death: Option<i32>) -> Person {
        Person {
            id: Uuid::from_u128(id),
            gender: Gender::Unknown,
            names: vec![Name {
                given: Some("Test".to_owned()),
                surname: Some(surname.to_owned()),
                name_type: NameType::Birth,
                is_primary: true,
                ..Name::default()
            }],
            birth: birth.map(date).unwrap_or_default(),
            death: death.map(date).unwrap_or_default(),
            notes: None,
            external_ids: Vec::new(),
        }
    }

    fn sorted_ids(persons: Vec<Person>, sort: PersonSort, direction: SortDirection) -> Vec<u128> {
        let mut persons = persons;
        sort_persons(&mut persons, sort, direction);
        persons.iter().map(|person| person.id.as_u128()).collect()
    }

    fn sample() -> Vec<Person> {
        vec![
            person(1, "Petrov", Some(1970), Some(2000)),
            person(2, "Sidorov", Some(1950), Some(1990)),
            person(3, "Ananov", None, None),
            person(4, "Zaytsev", Some(1950), None),
        ]
    }

    #[test]
    fn birth_ascending_puts_undated_last() {
        let ids = sorted_ids(sample(), PersonSort::Birth, SortDirection::Asc);
        assert_eq!(ids, vec![2, 4, 1, 3]);
    }

    #[test]
    fn birth_descending_keeps_undated_last() {
        let ids = sorted_ids(sample(), PersonSort::Birth, SortDirection::Desc);
        assert_eq!(ids, vec![1, 2, 4, 3]);
    }

    #[test]
    fn death_ascending_sorts_dated_then_undated() {
        let ids = sorted_ids(sample(), PersonSort::Death, SortDirection::Asc);
        // Zaytsev and Ananov have no death date: name order, undated last.
        assert_eq!(ids, vec![2, 1, 3, 4]);
    }

    #[test]
    fn death_descending_keeps_undated_last() {
        let ids = sorted_ids(sample(), PersonSort::Death, SortDirection::Desc);
        assert_eq!(ids, vec![1, 2, 3, 4]);
    }

    #[test]
    fn name_uses_the_requested_direction() {
        assert_eq!(
            sorted_ids(sample(), PersonSort::Name, SortDirection::Asc),
            vec![3, 1, 2, 4]
        );
        assert_eq!(
            sorted_ids(sample(), PersonSort::Name, SortDirection::Desc),
            vec![4, 2, 1, 3]
        );
    }

    #[test]
    fn unknown_values_fall_back_to_name_ascending() {
        assert_eq!(PersonSort::parse(None), PersonSort::Name);
        assert_eq!(PersonSort::parse(Some("birth")), PersonSort::Birth);
        assert_eq!(PersonSort::parse(Some("death")), PersonSort::Death);
        assert_eq!(PersonSort::parse(Some("unknown")), PersonSort::Name);
        assert_eq!(SortDirection::parse(None), SortDirection::Asc);
        assert_eq!(SortDirection::parse(Some("desc")), SortDirection::Desc);
        assert_eq!(SortDirection::parse(Some("sideways")), SortDirection::Asc);
    }

    fn named_person(
        id: u128,
        surname: &str,
        given: &str,
        patronymic: Option<&str>,
        gender: Gender,
    ) -> Person {
        Person {
            id: Uuid::from_u128(id),
            gender,
            names: vec![Name {
                given: Some(given.to_owned()),
                patronymic: patronymic.map(str::to_owned),
                surname: Some(surname.to_owned()),
                is_primary: true,
                ..Name::default()
            }],
            birth: DateValue::default(),
            death: DateValue::default(),
            notes: None,
            external_ids: Vec::new(),
        }
    }

    fn parent_edge(parent: Uuid, child: Uuid, rel_type: RelationshipType) -> Relationship {
        Relationship::new(rel_type, parent, child).unwrap()
    }

    #[test]
    fn parents_returns_both_biological_parents_by_full_name() {
        let child = named_person(10, "Иванов", "Илья", None, Gender::Male);
        let father = named_person(11, "Иванов", "Пётр", None, Gender::Male);
        let mother = named_person(12, "Иванова", "Анна", Some("Петровна"), Gender::Female);
        let rows = vec![
            parent_edge(father.id, child.id, RelationshipType::ParentChild),
            parent_edge(mother.id, child.id, RelationshipType::ParentChild),
        ];

        let map = parent_refs(&[child.id], &[child.clone(), father, mother], &rows);
        let parents = map.get(&child.id.to_string()).expect("child key");

        // Deterministic order: name (case-insensitive), then id.
        let names: Vec<&str> = parents.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, vec!["Иванов Пётр", "Иванова Анна Петровна"]);
        assert_eq!(parents[0].gender, Gender::Male);
        assert_eq!(parents[1].gender, Gender::Female);
        assert_eq!(parents[1].id, Uuid::from_u128(12).to_string());
    }

    #[test]
    fn parents_includes_adoptive_parents() {
        let child = named_person(20, "Сидоров", "Олег", None, Gender::Male);
        let adoptive = named_person(21, "Сидорова", "Мария", None, Gender::Female);
        let rows = vec![parent_edge(
            adoptive.id,
            child.id,
            RelationshipType::AdoptiveParentChild,
        )];

        let map = parent_refs(&[child.id], &[child.clone(), adoptive], &rows);
        let parents = map.get(&child.id.to_string()).expect("child key");
        assert_eq!(parents.len(), 1);
        assert_eq!(parents[0].name, "Сидорова Мария");
    }

    #[test]
    fn the_same_parent_on_two_edges_is_listed_once() {
        let child = named_person(30, "Иванов", "Олег", None, Gender::Male);
        let parent = named_person(31, "Иванов", "Иван", None, Gender::Male);
        let rows = vec![
            parent_edge(parent.id, child.id, RelationshipType::ParentChild),
            parent_edge(parent.id, child.id, RelationshipType::AdoptiveParentChild),
        ];

        let map = parent_refs(&[child.id], &[child.clone(), parent], &rows);
        assert_eq!(map[&child.id.to_string()].len(), 1);
    }

    #[test]
    fn unknown_ids_are_absent_from_the_map() {
        let child = named_person(40, "Иванов", "Олег", None, Gender::Male);
        let parent = named_person(41, "Иванов", "Иван", None, Gender::Male);
        let unknown = Uuid::from_u128(999);
        let rows = vec![parent_edge(
            parent.id,
            child.id,
            RelationshipType::ParentChild,
        )];

        let map = parent_refs(&[child.id, unknown], &[child.clone(), parent], &rows);
        assert!(map.contains_key(&child.id.to_string()));
        assert!(!map.contains_key(&unknown.to_string()));
    }

    #[test]
    fn empty_input_gives_an_empty_map() {
        let map = parent_refs(&[], &[], &[]);
        assert!(map.is_empty());
    }

    #[test]
    fn a_person_without_parents_still_gets_an_empty_list() {
        let person_row = named_person(51, "Петров", "Пётр", None, Gender::Male);
        let map = parent_refs(&[person_row.id], std::slice::from_ref(&person_row), &[]);
        assert_eq!(map.get(&person_row.id.to_string()), Some(&Vec::new()));
    }

    #[test]
    fn an_unnamed_parent_is_kept_with_an_empty_name() {
        let child = named_person(60, "Иванов", "Олег", None, Gender::Male);
        let mut parent = named_person(61, "Иванов", "Иван", None, Gender::Unknown);
        parent.names.clear();
        let rows = vec![parent_edge(
            parent.id,
            child.id,
            RelationshipType::ParentChild,
        )];

        let map = parent_refs(&[child.id], &[child.clone(), parent], &rows);
        let parents = map.get(&child.id.to_string()).expect("child key");
        assert_eq!(parents.len(), 1);
        assert_eq!(parents[0].name, "");
        assert_eq!(parents[0].gender, Gender::Unknown);
    }

    #[test]
    fn spouse_edges_are_not_parents() {
        let a = named_person(70, "А", "А", None, Gender::Male);
        let b = named_person(71, "Б", "Б", None, Gender::Female);
        let rows = vec![parent_edge(a.id, b.id, RelationshipType::Spouse)];
        let map = parent_refs(&[b.id], &[a, b.clone()], &rows);
        assert!(map[&b.id.to_string()].is_empty());
    }

    #[test]
    fn parent_ref_keeps_the_ui_contract() {
        let row = ParentRef {
            id: Uuid::from_u128(80).to_string(),
            name: "Иванов Иван Иванович".to_owned(),
            gender: Gender::Male,
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["id"], row.id);
        assert_eq!(json["name"], "Иванов Иван Иванович");
        assert_eq!(json["gender"], "MALE");
        assert!(json.get("isAdoptive").is_none());
    }

    fn life_events<'a>(
        events: &'a [Event],
        person: &Person,
        event_type: EventType,
    ) -> Vec<&'a Event> {
        events
            .iter()
            .filter(|event| event.person_id == person.id && event.event_type == event_type)
            .collect()
    }

    #[test]
    fn create_makes_birth_and_death_events_from_person_dates() {
        let person = person(100, "Иванов", Some(1900), Some(1970));
        let mut events = Vec::new();

        assert!(sync_life_events(&mut events, &person, None));

        assert_eq!(events.len(), 2);
        let birth = life_events(&events, &person, EventType::Birth);
        let death = life_events(&events, &person, EventType::Death);
        assert_eq!(birth.len(), 1);
        assert_eq!(death.len(), 1);
        assert_eq!(birth[0].date, person.birth);
        assert_eq!(death[0].date, person.death);
    }

    #[test]
    fn update_moves_the_existing_birth_event_without_duplicating_it() {
        let person = person(101, "Петров", Some(1900), None);
        let mut events = Vec::new();
        sync_life_events(&mut events, &person, None);
        let birth_id = events[0].id;

        let mut updated = person.clone();
        updated.birth = date(1901);
        assert!(sync_life_events(&mut events, &updated, Some(&person)));

        let birth = life_events(&events, &updated, EventType::Birth);
        assert_eq!(birth.len(), 1);
        assert_eq!(birth[0].id, birth_id);
        assert_eq!(birth[0].date, updated.birth);
    }

    #[test]
    fn clearing_the_death_date_removes_the_automatic_event() {
        let person = person(102, "Сидоров", None, Some(1980));
        let mut events = Vec::new();
        sync_life_events(&mut events, &person, None);
        assert_eq!(life_events(&events, &person, EventType::Death).len(), 1);

        let mut updated = person.clone();
        updated.death = DateValue::default();
        assert!(sync_life_events(&mut events, &updated, Some(&person)));
        assert!(events.is_empty());
    }

    #[test]
    fn a_manual_birth_event_with_another_date_is_left_alone() {
        let person = person(103, "Зайцев", Some(1900), None);
        let mut manual = Event::new(person.id, EventType::Birth);
        manual.date = date(1888);
        let mut events = vec![manual.clone()];

        // Create: the person already has a BIRTH event, so nothing is added.
        assert!(!sync_life_events(&mut events, &person, None));
        assert_eq!(events, vec![manual.clone()]);

        // Update: previous date matches no event, and the manual one stays.
        let mut updated = person.clone();
        updated.birth = date(1901);
        assert!(!sync_life_events(&mut events, &updated, Some(&person)));
        assert_eq!(events, vec![manual]);
    }

    #[test]
    fn a_blank_date_on_create_makes_no_event() {
        let person = person(104, "Ананов", None, None);
        let mut events = Vec::new();

        assert!(!sync_life_events(&mut events, &person, None));
        assert!(events.is_empty());
    }

    #[test]
    fn updating_the_date_keeps_place_description_and_participants() {
        let person = person(105, "Иванова", Some(1900), None);
        let mut birth = Event::new(person.id, EventType::Birth);
        birth.date = person.birth.clone();
        birth.place = Some("Москва".to_owned());
        birth.description = Some("Метрическая запись".to_owned());
        birth.source_ids = vec![Uuid::from_u128(700)];
        birth.participant_ids = vec![Uuid::from_u128(701)];
        birth.original_type = Some("BIRT".to_owned());
        let mut events = vec![birth.clone()];

        let mut updated = person.clone();
        updated.birth = date(1901);
        assert!(sync_life_events(&mut events, &updated, Some(&person)));

        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.date, updated.birth);
        assert_eq!(event.place, birth.place);
        assert_eq!(event.description, birth.description);
        assert_eq!(event.source_ids, birth.source_ids);
        assert_eq!(event.participant_ids, birth.participant_ids);
        assert_eq!(event.original_type, birth.original_type);
    }
}
