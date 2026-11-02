//! `graph.*` commands. Contract: design.md §11, ADR-0011.
//! The response is the domain [`AncestorGraph`]; placeholders stay `null`
//! person ids and are never domain persons.

use std::collections::{BTreeMap, BTreeSet};

use gentree_core::error::codes;
use gentree_core::graph::{AncestorGraph, DescendantGraph, DEFAULT_GENERATIONS};
use gentree_core::kinship::KinshipDescriptor;
use gentree_core::person::{Gender, Person};
use gentree_core::relationship::RelationshipSet;
use gentree_core::{AppError, AppResult};
use gentree_storage::ProjectStore;
use tauri::State;
use uuid::Uuid;

use super::{gender_map, parse_uuid, person_not_found, with_store};
use crate::AppState;

/// Root plus up to `generations` ancestor levels. Without `rootPersonId` the
/// manifest home person is used, then the earliest birth, then the smallest id.
#[tauri::command]
pub fn graph_ancestors(
    state: State<'_, AppState>,
    root_person_id: Option<String>,
    generations: Option<u32>,
) -> Result<AncestorGraph, AppError> {
    with_store(&state, |store| {
        let persons = store.persons()?;
        let root = match root_person_id.as_deref() {
            Some(raw) => {
                let id = parse_uuid("rootPersonId", raw)?;
                if !persons.iter().any(|person| person.id == id) {
                    return Err(person_not_found(id));
                }
                id
            }
            None => default_root(store, &persons)?,
        };

        let genders = gender_map(&persons);
        let set = store.relationship_set()?;
        Ok(
            set.ancestors_with_gender(root, generations.unwrap_or(DEFAULT_GENERATIONS), |id| {
                genders.get(&id).copied().unwrap_or(Gender::Unknown)
            }),
        )
    })
}

/// Root plus up to `generations` descendant levels. Without `rootPersonId` the
/// manifest home person is used, then the earliest birth, then the smallest id.
#[tauri::command]
pub fn graph_descendants(
    state: State<'_, AppState>,
    root_person_id: Option<String>,
    generations: Option<u32>,
) -> Result<DescendantGraph, AppError> {
    with_store(&state, |store| {
        let persons = store.persons()?;
        let root = match root_person_id.as_deref() {
            Some(raw) => {
                let id = parse_uuid("rootPersonId", raw)?;
                if !persons.iter().any(|person| person.id == id) {
                    return Err(person_not_found(id));
                }
                id
            }
            None => default_root(store, &persons)?,
        };

        let genders = gender_map(&persons);
        let set = store.relationship_set()?;
        Ok(
            set.descendants_with_gender(root, generations.unwrap_or(DEFAULT_GENERATIONS), |id| {
                genders.get(&id).copied().unwrap_or(Gender::Unknown)
            }),
        )
    })
}

/// Kinship descriptors relative to one root for every requested graph node.
/// One call per loaded graph keeps the tree labels consistent and avoids an
/// IPC round-trip per node. Unknown ids are skipped; malformed ids are a
/// validation error.
#[tauri::command]
pub fn graph_kinship(
    state: State<'_, AppState>,
    root_person_id: String,
    target_person_ids: Vec<String>,
) -> Result<BTreeMap<String, KinshipDescriptor>, AppError> {
    with_store(&state, |store| {
        let root = parse_uuid("rootPersonId", &root_person_id)?;
        let persons = store.persons()?;
        if !persons.iter().any(|person| person.id == root) {
            return Err(person_not_found(root));
        }
        let known: BTreeSet<Uuid> = persons.iter().map(|person| person.id).collect();
        let mut targets = BTreeSet::new();
        for raw in target_person_ids {
            let id = parse_uuid("targetPersonIds", &raw)?;
            if known.contains(&id) {
                targets.insert(id);
            }
        }
        let genders = gender_map(&persons);
        let set = store.relationship_set()?;
        Ok(kinship_map(&set, root, &targets, &|id| {
            genders.get(&id).copied().unwrap_or(Gender::Unknown)
        }))
    })
}

fn kinship_map(
    set: &RelationshipSet,
    root: Uuid,
    targets: &BTreeSet<Uuid>,
    gender_of: &dyn Fn(Uuid) -> Gender,
) -> BTreeMap<String, KinshipDescriptor> {
    targets
        .iter()
        .map(|target| (target.to_string(), set.kinship(root, *target, gender_of)))
        .collect()
}

/// `homePersonId` when it still points at an existing person, otherwise the
/// earliest known birth and then the smallest id (ADR-0011, open question 2).
fn default_root(store: &ProjectStore, persons: &[Person]) -> AppResult<Uuid> {
    if let Some(home) = store.manifest().home_person_id {
        if persons.iter().any(|person| person.id == home) {
            return Ok(home);
        }
    }
    persons
        .iter()
        .min_by(|left, right| birth_order(left, right))
        .map(|person| person.id)
        .ok_or_else(|| AppError::new(codes::NOT_FOUND, "Project has no persons"))
}

/// Known births first, then by id; unknown births sort last.
fn birth_order(left: &Person, right: &Person) -> std::cmp::Ordering {
    let by_birth = match (left.birth.start, right.birth.start) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    };
    by_birth.then_with(|| left.id.cmp(&right.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::date::{CivilDate, DatePrecision, DateQualifier, DateValue};
    use gentree_core::person::{Name, NameType};

    fn person(id: Uuid, year: Option<i32>) -> Person {
        Person {
            id,
            gender: Gender::Unknown,
            names: vec![Name {
                given: Some("Test".to_owned()),
                name_type: NameType::Birth,
                is_primary: true,
                ..Name::default()
            }],
            birth: match year {
                Some(year) => DateValue {
                    start: CivilDate::new(year, 1, 1).ok(),
                    end: CivilDate::new(year + 1, 1, 1).ok(),
                    precision: DatePrecision::Year,
                    qualifier: DateQualifier::Exact,
                    original: None,
                },
                None => DateValue::default(),
            },
            death: DateValue::default(),
            notes: None,
            external_ids: Vec::new(),
        }
    }

    #[test]
    fn kinship_map_describes_each_target_relative_to_the_root() {
        use gentree_core::kinship::KinshipKind;
        use gentree_core::relationship::{Relationship, RelationshipSet, RelationshipType};

        let root = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let grandpa = Uuid::now_v7();
        let grandma = Uuid::now_v7();
        let sibling = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        for (parent, child) in [
            (grandpa, father),
            (grandma, father),
            (father, root),
            (mother, root),
            (father, sibling),
            (mother, sibling),
        ] {
            set.push(Relationship::new(RelationshipType::ParentChild, parent, child).unwrap())
                .unwrap();
        }
        let targets = BTreeSet::from([father, grandpa, sibling]);
        let gender_of = |id: Uuid| {
            if id == father || id == grandpa {
                Gender::Male
            } else if id == mother || id == grandma || id == sibling {
                Gender::Female
            } else {
                Gender::Unknown
            }
        };
        let map = kinship_map(&set, root, &targets, &gender_of);
        assert_eq!(
            map.get(&father.to_string()).map(|row| row.kind),
            Some(KinshipKind::Father)
        );
        assert_eq!(
            map.get(&grandpa.to_string()).map(|row| row.kind),
            Some(KinshipKind::Grandfather)
        );
        assert_eq!(
            map.get(&sibling.to_string()).map(|row| row.kind),
            Some(KinshipKind::Sister)
        );
    }

    #[test]
    fn birth_order_prefers_known_dates_then_id() {
        let newer = person(Uuid::from_u128(1), Some(1970));
        let older = person(Uuid::from_u128(3), Some(1950));
        let unknown = person(Uuid::from_u128(2), None);
        let mut rows = [newer.clone(), unknown.clone(), older.clone()];
        rows.sort_by(birth_order);
        let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
        assert_eq!(ids, vec![older.id, newer.id, unknown.id]);

        let first = person(Uuid::from_u128(5), None);
        let second = person(Uuid::from_u128(4), None);
        let mut undated = [first.clone(), second.clone()];
        undated.sort_by(birth_order);
        assert_eq!(undated[0].id, second.id);
    }
}
