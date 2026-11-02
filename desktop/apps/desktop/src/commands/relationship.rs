//! `relationship.*` commands. Rows are validated as a set by storage, so
//! self-links, duplicates, spouse order and parent cycles are rejected there.

use gentree_core::record::CitationTarget;
use gentree_core::relationship::{Relationship, RelationshipType};
use gentree_core::{AppError, AppResult};
use gentree_storage::{ProjectStore, RELATIONSHIP_FILE};
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use super::{citations_without, entity_version, require_version, versioned, with_store, Versioned};
use crate::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipInput {
    #[serde(rename = "type")]
    pub rel_type: RelationshipType,
    pub person_id: Uuid,
    pub related_person_id: Uuid,
    #[serde(default)]
    pub notes: Option<String>,
}

fn ensure_persons(store: &mut ProjectStore, a: Uuid, b: Uuid) -> AppResult<()> {
    let persons = store.persons()?;
    for id in [a, b] {
        if !persons.iter().any(|person| person.id == id) {
            return Err(
                AppError::validation("personId", "notFound").with_param("id", id.to_string())
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn relationship_list(
    state: State<'_, AppState>,
    person_id: Option<Uuid>,
) -> Result<Vec<Versioned<Relationship>>, AppError> {
    with_store(&state, |store| {
        let versions = store.collection_versions(RELATIONSHIP_FILE)?;
        let mut rows: Vec<Relationship> = store
            .relationships()?
            .into_iter()
            .filter(|row| {
                person_id.is_none_or(|id| row.person_id == id || row.related_person_id == id)
            })
            .collect();
        rows.sort_by(|left, right| {
            left.person_id
                .cmp(&right.person_id)
                .then_with(|| left.related_person_id.cmp(&right.related_person_id))
                .then_with(|| left.id.cmp(&right.id))
        });
        versioned(rows, &versions, |row| row.id)
    })
}

#[tauri::command]
pub fn relationship_create(
    state: State<'_, AppState>,
    relationship: RelationshipInput,
) -> Result<Versioned<Relationship>, AppError> {
    with_store(&state, |store| {
        ensure_persons(
            store,
            relationship.person_id,
            relationship.related_person_id,
        )?;
        let mut entity = Relationship::new(
            relationship.rel_type,
            relationship.person_id,
            relationship.related_person_id,
        )?;
        entity.notes = relationship
            .notes
            .map(|notes| notes.trim().to_owned())
            .filter(|notes| !notes.is_empty());

        let mut rows = store.relationships()?;
        rows.push(entity.clone());
        store.save_relationships(&rows)?;
        let version = entity_version(store, RELATIONSHIP_FILE, entity.id)?;
        Ok(Versioned { entity, version })
    })
}

#[tauri::command]
pub fn relationship_delete(
    state: State<'_, AppState>,
    id: Uuid,
    expected_version: String,
) -> Result<(), AppError> {
    with_store(&state, |store| {
        require_version(store, RELATIONSHIP_FILE, id, &expected_version)?;

        let rows: Vec<Relationship> = store
            .relationships()?
            .into_iter()
            .filter(|row| row.id != id)
            .collect();
        let citations = citations_without(store, CitationTarget::Relationship, id)?;

        store.save_citations(&citations)?;
        store.save_relationships(&rows)?;
        Ok(())
    })
}
