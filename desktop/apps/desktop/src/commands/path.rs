//! `path.*` and `kinship.get` commands. Contract: design.md §11, ADR-0011.
//! Both responses are domain structs serialized as camelCase; no localized
//! strings leave Rust, the UI formats the descriptor (ADR-0014).

use gentree_core::kinship::KinshipDescriptor;
use gentree_core::path::PathResult;
use gentree_core::person::{Gender, Person};
use gentree_core::{AppError, AppResult};
use tauri::State;
use uuid::Uuid;

use super::{gender_map, parse_uuid, person_not_found, with_store};
use crate::AppState;

/// Both ends must exist in the open project, otherwise `NOT_FOUND`.
fn ensure_persons(persons: &[Person], ids: [Uuid; 2]) -> AppResult<()> {
    for id in ids {
        if !persons.iter().any(|person| person.id == id) {
            return Err(person_not_found(id));
        }
    }
    Ok(())
}

/// Shortest path A → B over parent, child and spouse edges (ADR-0011 §path).
#[tauri::command]
pub fn path_find(
    state: State<'_, AppState>,
    from_person_id: String,
    to_person_id: String,
) -> Result<PathResult, AppError> {
    with_store(&state, |store| {
        let from = parse_uuid("fromPersonId", &from_person_id)?;
        let to = parse_uuid("toPersonId", &to_person_id)?;
        let persons = store.persons()?;
        ensure_persons(&persons, [from, to])?;
        Ok(store.relationship_set()?.find_path(from, to))
    })
}

/// Structural kinship descriptor; genders come from the project persons.
#[tauri::command]
pub fn kinship_get(
    state: State<'_, AppState>,
    from_person_id: String,
    to_person_id: String,
) -> Result<KinshipDescriptor, AppError> {
    with_store(&state, |store| {
        let from = parse_uuid("fromPersonId", &from_person_id)?;
        let to = parse_uuid("toPersonId", &to_person_id)?;
        let persons = store.persons()?;
        ensure_persons(&persons, [from, to])?;
        let genders = gender_map(&persons);
        let gender_of = |id: Uuid| genders.get(&id).copied().unwrap_or(Gender::Unknown);
        Ok(store.relationship_set()?.kinship(from, to, &gender_of))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::error::codes;
    use gentree_core::person::Name;
    use gentree_core::relationship::{Relationship, RelationshipSet, RelationshipType};

    fn person(gender: Gender) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some("Test".to_owned()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap();
        person.gender = gender;
        person
    }

    fn edge(set: &mut RelationshipSet, kind: RelationshipType, a: Uuid, b: Uuid) {
        set.push(Relationship::new(kind, a, b).unwrap()).unwrap();
    }

    #[test]
    fn invalid_ids_are_validation_errors() {
        let error = parse_uuid("fromPersonId", "not-a-uuid").unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("fromPersonId")
        );
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("invalidUuid")
        );

        let id = Uuid::now_v7();
        assert_eq!(parse_uuid("toPersonId", &format!(" {id} ")).unwrap(), id);
    }

    #[test]
    fn missing_person_is_not_found() {
        let known = person(Gender::Male);
        let missing = Uuid::now_v7();
        let error = ensure_persons(std::slice::from_ref(&known), [known.id, missing]).unwrap_err();
        assert_eq!(error.code, codes::NOT_FOUND);
        assert_eq!(error.params.get("id"), Some(&missing.to_string()));
        assert!(ensure_persons(std::slice::from_ref(&known), [known.id, known.id]).is_ok());
    }

    #[test]
    fn gender_map_reads_persons_and_defaults_to_unknown() {
        let father = person(Gender::Male);
        let child = person(Gender::Female);
        let genders = gender_map(&[father.clone(), child.clone()]);
        assert_eq!(genders.get(&father.id), Some(&Gender::Male));
        assert_eq!(genders.get(&child.id), Some(&Gender::Female));
        assert_eq!(genders.get(&Uuid::now_v7()).copied(), None);
    }

    #[test]
    fn path_and_kinship_use_the_same_edge_set() {
        let father = person(Gender::Male);
        let child = person(Gender::Female);
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, father.id, child.id);

        let path = set.find_path(child.id, father.id);
        assert!(path.found);
        assert_eq!(path.common_ancestor_id, Some(father.id));

        let genders = gender_map(&[father.clone(), child.clone()]);
        let gender_of = |id: Uuid| genders.get(&id).copied().unwrap_or(Gender::Unknown);
        let descriptor = set.kinship(child.id, father.id, &gender_of);
        assert_eq!(descriptor.kind, gentree_core::kinship::KinshipKind::Father);
    }

    #[test]
    fn descriptor_is_built_from_the_resolved_path() {
        let grandfather = person(Gender::Male);
        let father = person(Gender::Male);
        let child = person(Gender::Female);
        let mut set = RelationshipSet::default();
        edge(
            &mut set,
            RelationshipType::ParentChild,
            grandfather.id,
            father.id,
        );
        edge(&mut set, RelationshipType::ParentChild, father.id, child.id);

        let genders = gender_map(&[grandfather.clone(), father.clone(), child.clone()]);
        let gender_of = |id: Uuid| genders.get(&id).copied().unwrap_or(Gender::Unknown);
        let path = set.find_path(child.id, grandfather.id);
        let descriptor = set.kinship_from_path(child.id, grandfather.id, &path, &gender_of);

        let path_ids: Vec<Uuid> = path.path.iter().map(|step| step.person_id).collect();
        assert_eq!(
            descriptor.kind,
            gentree_core::kinship::KinshipKind::Grandfather
        );
        assert_eq!(descriptor.path, path_ids);
        assert_eq!(descriptor.edges.len() + 1, path.path.len());
        assert_eq!(
            descriptor.edges[0].kind,
            gentree_core::kinship::KinshipEdgeKind::Parent
        );
        assert_eq!(descriptor.common_ancestor_id, path.common_ancestor_id);
        assert_eq!(descriptor.source_gender, Gender::Female);
    }
}
