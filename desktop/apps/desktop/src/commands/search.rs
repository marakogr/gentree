//! `search.*` commands: project-scoped Tantivy index, grouped results, rebuild.
//! Contract: search behavior and index metadata.
//!
//! The index lives in `<app_data>/indexes/<projectId>`, outside the project
//! folder and its backups. It is stale when the project `contentHash` or the
//! search `schemaVersion` differs from `index-meta.json`; a stale index is
//! rebuilt before the query runs (synchronous MVP, documents capped at
//! [`MAX_DOCS`]).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use gentree_core::error::codes;
use gentree_core::person::Name;
use gentree_core::record::Source;
use gentree_core::{AppError, AppResult};
use gentree_search::{
    is_stale, query as run_query, rebuild_docs_with_meta, IndexDoc, SearchResponse,
    DEFAULT_RESULT_LIMIT, ENTITY_TYPE_EVENT, ENTITY_TYPE_PERSON, ENTITY_TYPE_SOURCE,
    INDEX_SCHEMA_VERSION, MAX_RESULT_LIMIT,
};
use gentree_storage::ProjectStore;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::{display_names, event_type_name, parse_uuid, with_store};
use crate::AppState;

/// Upper bound for one rebuild (design.md §6 / WP-05b).
const MAX_DOCS: usize = 50_000;
/// Maximum query length in characters.
const MAX_QUERY_CHARS: usize = 100;
/// Maximum number of query tokens.
const MAX_QUERY_TOKENS: usize = 10;

/// Project id and `contentHash` from the manifest (cheap; no data files read).
fn manifest_info(state: &State<'_, AppState>) -> AppResult<(String, String)> {
    with_store(state, |store| {
        let manifest = store.manifest();
        Ok((
            manifest.project_id.to_string(),
            manifest.content_hash.clone(),
        ))
    })
}

fn build_docs(state: &State<'_, AppState>) -> AppResult<(Vec<IndexDoc>, HashMap<String, String>)> {
    with_store(state, |store| build_index_docs(store))
}

/// `eventId -> personId` without rebuilding documents on a fresh index.
fn load_event_persons(store: &ProjectStore) -> AppResult<HashMap<String, String>> {
    Ok(store
        .events()?
        .into_iter()
        .map(|event| (event.id.to_string(), event.person_id.to_string()))
        .collect())
}

/// Indexed search shared by the `search.query` command and the chat `search`
/// tool: the index is rebuilt when the project `contentHash` is newer than
/// `index-meta.json`, then queried and enriched with event owners.
pub(crate) fn search_project(
    store: &ProjectStore,
    dir: &Path,
    query: &str,
    limit: usize,
) -> AppResult<SearchResponse> {
    let content_hash = store.manifest().content_hash.clone();
    let event_persons = if is_stale(dir, &content_hash, INDEX_SCHEMA_VERSION) {
        let (docs, event_persons) = build_index_docs(store)?;
        rebuild(dir, &docs, &content_hash)?;
        event_persons
    } else {
        load_event_persons(store)?
    };
    let mut response = run_query(dir, query, limit)
        .map_err(|_| AppError::new(codes::IO_ERROR, "Search index is unavailable"))?;
    attach_person_ids(&mut response, &event_persons);
    Ok(response)
}

fn index_dir(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new(codes::IO_ERROR, "Application data directory unavailable"))?
        .join("indexes")
        .join(project_id);
    std::fs::create_dir_all(&dir)
        .map_err(|_| AppError::new(codes::IO_ERROR, "Cannot create search index directory"))?;
    Ok(dir)
}

/// Builds generic documents for persons, events and sources. Data stays in the
/// project's language; the index itself is locale-independent.
pub(crate) fn build_index_docs(
    store: &ProjectStore,
) -> AppResult<(Vec<IndexDoc>, HashMap<String, String>)> {
    let persons = store.persons()?;
    let events = store.events()?;
    let sources = store.sources()?;

    let person_names = display_names(&persons);
    // One pass over events, so person places stay O(persons + events).
    let mut places_by_person: HashMap<Uuid, BTreeSet<&str>> = HashMap::new();
    for event in &events {
        if let Some(place) = event
            .place
            .as_deref()
            .map(str::trim)
            .filter(|place| !place.is_empty())
        {
            places_by_person
                .entry(event.person_id)
                .or_default()
                .insert(place);
        }
    }
    let mut docs = Vec::with_capacity(persons.len() + events.len() + sources.len());
    let mut event_persons = HashMap::new();

    for person in &persons {
        if docs.len() >= MAX_DOCS {
            break;
        }
        let name = person_names
            .get(&person.id)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| person.id.to_string());
        // Alternative names stay searchable through the text field while
        // `name` keeps the primary display name for the exact-match boost.
        let mut text_parts: Vec<String> = Vec::new();
        if let Some(notes) = person.notes.as_deref().map(str::trim) {
            if !notes.is_empty() {
                text_parts.push(notes.to_owned());
            }
        }
        for variant in person
            .names
            .iter()
            .map(Name::display)
            .filter(|value| !value.trim().is_empty() && *value != name)
        {
            text_parts.push(variant);
        }
        let place = places_by_person
            .get(&person.id)
            .map(|places| places.iter().copied().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        docs.push(IndexDoc {
            entity_type: ENTITY_TYPE_PERSON.to_owned(),
            entity_id: person.id.to_string(),
            name,
            place,
            text: text_parts.join(" "),
            year: person.birth.start.map(|date| i64::from(date.year)),
        });
    }

    for event in &events {
        if docs.len() >= MAX_DOCS {
            break;
        }
        let mut name = event_type_name(event.event_type).to_owned();
        if let Some(original) = event.original_type.as_deref() {
            let original = original.trim();
            if !original.is_empty() {
                name.push(' ');
                name.push_str(original);
            }
        }
        if let Some(person) = person_names.get(&event.person_id) {
            name.push(' ');
            name.push_str(person);
        }
        docs.push(IndexDoc {
            entity_type: ENTITY_TYPE_EVENT.to_owned(),
            entity_id: event.id.to_string(),
            name,
            place: event.place.clone().unwrap_or_default(),
            text: event.description.clone().unwrap_or_default(),
            year: event.date.start.map(|date| i64::from(date.year)),
        });
        event_persons.insert(event.id.to_string(), event.person_id.to_string());
    }

    for source in &sources {
        if docs.len() >= MAX_DOCS {
            break;
        }
        let text = [
            source.author.as_deref(),
            source.publication.as_deref(),
            source.repository.as_deref(),
            source.notes.as_deref(),
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        docs.push(IndexDoc {
            entity_type: ENTITY_TYPE_SOURCE.to_owned(),
            entity_id: source.id.to_string(),
            name: source.title.clone(),
            place: source.repository.clone().unwrap_or_default(),
            text,
            year: None,
        });
    }

    Ok((docs, event_persons))
}

fn rebuild(dir: &Path, docs: &[IndexDoc], content_hash: &str) -> AppResult<()> {
    rebuild_docs_with_meta(dir, docs, content_hash, INDEX_SCHEMA_VERSION)
        .map_err(|_| AppError::new(codes::IO_ERROR, "Search index rebuild failed"))
}

fn validate_query(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    let length = trimmed.chars().count();
    if !(2..=MAX_QUERY_CHARS).contains(&length) {
        return Err(AppError::validation("query", "length"));
    }
    let tokens = trimmed
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .count();
    if tokens == 0 {
        return Err(AppError::validation("query", "tokens"));
    }
    if tokens > MAX_QUERY_TOKENS {
        return Err(AppError::validation("query", "tooManyTokens"));
    }
    Ok(trimmed.to_owned())
}

fn validate_limit(limit: Option<usize>) -> AppResult<usize> {
    let limit = limit.unwrap_or(DEFAULT_RESULT_LIMIT);
    if !(1..=MAX_RESULT_LIMIT).contains(&limit) {
        return Err(AppError::validation("limit", "range"));
    }
    Ok(limit)
}

/// Indexed search over the open project. Rebuilds a stale/missing index first.
#[tauri::command]
pub fn search_query(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<SearchResponse, AppError> {
    let query = validate_query(&query)?;
    let limit = validate_limit(limit)?;
    let (project_id, _) = manifest_info(&state)?;
    let dir = index_dir(&app, &project_id)?;
    with_store(&state, |store| search_project(store, &dir, &query, limit))
}

/// Manual rebuild of the project index; returns the number of indexed docs.
#[tauri::command]
pub fn search_rebuild(app: AppHandle, state: State<'_, AppState>) -> Result<usize, AppError> {
    let (project_id, content_hash) = manifest_info(&state)?;
    let (docs, _) = build_docs(&state)?;
    let dir = index_dir(&app, &project_id)?;
    rebuild(&dir, &docs, &content_hash)?;
    Ok(docs.len())
}

/// Details panel payload for a `source` search result (no dead-end navigation:
/// the desktop UI has no sources tab).
#[tauri::command]
pub fn search_source_details(
    state: State<'_, AppState>,
    source_id: String,
) -> Result<Source, AppError> {
    let id = parse_uuid("sourceId", &source_id)?;
    with_store(&state, |store| {
        store
            .sources()?
            .into_iter()
            .find(|source| source.id == id)
            .ok_or_else(|| {
                AppError::new(codes::NOT_FOUND, "Source not found").with_param("id", id.to_string())
            })
    })
}

/// The index does not know the event owner; the project snapshot does.
fn attach_person_ids(response: &mut SearchResponse, event_persons: &HashMap<String, String>) {
    for group in &mut response.groups {
        if group.entity_type != ENTITY_TYPE_EVENT {
            continue;
        }
        for item in &mut group.items {
            if item.person_id.is_none() {
                item.person_id = event_persons.get(&item.entity_id).cloned();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::date::DateValue;
    use gentree_core::person::{Gender, Name, NameType, Person};
    use tempfile::TempDir;

    fn name(given: &str, surname: &str, primary: bool) -> Name {
        Name {
            given: Some(given.to_owned()),
            surname: Some(surname.to_owned()),
            name_type: NameType::Birth,
            is_primary: primary,
            ..Name::default()
        }
    }

    fn person(names: Vec<Name>, notes: Option<&str>) -> Person {
        Person {
            id: Uuid::now_v7(),
            gender: Gender::Unknown,
            names,
            birth: DateValue::default(),
            death: DateValue::default(),
            notes: notes.map(ToOwned::to_owned),
            external_ids: Vec::new(),
        }
    }

    fn project(dir: &TempDir, persons: &[Person]) -> ProjectStore {
        let mut store = ProjectStore::create(dir.path(), "Search").expect("project");
        store.save_persons(persons).expect("save persons");
        store
    }

    #[test]
    fn person_notes_and_alternative_names_reach_the_text_field() {
        let dir = TempDir::new().expect("temp dir");
        let person = person(
            vec![
                name("Иван", "Петров", true),
                name("Иван", "Севрюгов", false),
            ],
            Some("работал в онкологии"),
        );
        let store = project(&dir, std::slice::from_ref(&person));
        let (docs, _) = build_index_docs(&store).expect("documents");
        let doc = docs
            .iter()
            .find(|doc| doc.entity_id == person.id.to_string())
            .expect("person document");

        // The primary name stays in `name` (exact boost); everything else must
        // be searchable through `text`.
        assert_eq!(doc.name, "Петров Иван");
        assert_eq!(doc.place, "");
        assert!(
            doc.text.contains("онкологии"),
            "notes are indexed: {}",
            doc.text
        );
        assert!(
            doc.text.contains("Севрюгов"),
            "variants are indexed: {}",
            doc.text
        );
    }

    #[test]
    fn search_project_finds_a_person_by_a_partial_notes_and_name_prefix() {
        let dir = TempDir::new().expect("temp dir");
        let person = person(
            vec![
                name("Иван", "Петров", true),
                name("Иван", "Севрюгов", false),
            ],
            Some("работал в онкологии"),
        );
        let store = project(&dir, std::slice::from_ref(&person));
        let index_dir = dir.path().join("index");
        std::fs::create_dir_all(&index_dir).expect("index dir");

        for query in ["онколо", "онколог", "Севрюг"] {
            let response =
                search_project(&store, &index_dir, query, 20).expect("search must succeed");
            let ids: Vec<String> = response.groups[0]
                .items
                .iter()
                .map(|item| item.entity_id.clone())
                .collect();
            assert_eq!(ids, vec![person.id.to_string()], "query `{query}`");
        }
    }
}
