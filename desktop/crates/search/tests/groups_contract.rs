//! Grouped-search and index-staleness contract tests (design.md §6).

use std::fs;
use std::path::Path;

use gentree_search::{
    is_stale, query, rebuild_docs, rebuild_docs_with_meta, IndexDoc, SearchItem, SearchResponse,
    ENTITY_TYPE_EVENT, ENTITY_TYPE_PERSON, ENTITY_TYPE_SOURCE, INDEX_META_FILE,
    INDEX_SCHEMA_VERSION,
};
use tempfile::TempDir;

fn doc(
    entity_type: &str,
    id: &str,
    name: &str,
    place: &str,
    text: &str,
    year: Option<i64>,
) -> IndexDoc {
    IndexDoc {
        entity_type: entity_type.to_owned(),
        entity_id: id.to_owned(),
        name: name.to_owned(),
        place: place.to_owned(),
        text: text.to_owned(),
        year,
    }
}

fn index(docs: &[IndexDoc], hash: &str) -> TempDir {
    let dir = TempDir::new().expect("temp dir");
    rebuild_docs_with_meta(dir.path(), docs, hash, INDEX_SCHEMA_VERSION).expect("index rebuild");
    dir
}

fn items<'a>(response: &'a SearchResponse, entity_type: &str) -> &'a [SearchItem] {
    &response
        .groups
        .iter()
        .find(|group| group.entity_type == entity_type)
        .unwrap_or_else(|| panic!("missing group {entity_type}"))
        .items
}

#[test]
fn groups_include_person_event_and_source_with_counts() {
    let dir = index(
        &[
            doc(
                ENTITY_TYPE_PERSON,
                "p1",
                "Иван Петров",
                "Москва",
                "Родился в семье мещан",
                Some(1890),
            ),
            doc(
                ENTITY_TYPE_EVENT,
                "e1",
                "birth Иван Петров",
                "Москва",
                "запись о рождении",
                Some(1890),
            ),
            doc(
                ENTITY_TYPE_SOURCE,
                "s1",
                "Метрическая книга",
                "Архив",
                "Петров Иван, Москва",
                None,
            ),
        ],
        "hash-a",
    );

    let response = query(dir.path(), "петров", 20).expect("search");
    assert_eq!(response.match_count, 3);
    assert!(!response.truncated);
    assert_eq!(
        response
            .groups
            .iter()
            .map(|group| group.entity_type.as_str())
            .collect::<Vec<_>>(),
        vec![ENTITY_TYPE_PERSON, ENTITY_TYPE_EVENT, ENTITY_TYPE_SOURCE]
    );
    for group in &response.groups {
        assert_eq!(group.count, group.items.len());
        assert_eq!(group.count, 1, "group {} is not empty", group.entity_type);
        assert_eq!(group.items[0].entity_type, group.entity_type);
    }
    assert_eq!(items(&response, ENTITY_TYPE_PERSON)[0].entity_id, "p1");
    assert_eq!(items(&response, ENTITY_TYPE_EVENT)[0].entity_id, "e1");
    assert_eq!(items(&response, ENTITY_TYPE_SOURCE)[0].entity_id, "s1");
    // A person is its own owner; an event owner is filled by the app layer.
    assert_eq!(
        items(&response, ENTITY_TYPE_PERSON)[0].person_id.as_deref(),
        Some("p1")
    );
    assert!(items(&response, ENTITY_TYPE_EVENT)[0].person_id.is_none());

    // Wire shape used by the UI: camelCase fields and highlight objects.
    let wire = serde_json::to_value(&response).expect("serialize response");
    assert!(wire.get("matchCount").is_some());
    assert_eq!(wire["groups"][0]["entityType"], ENTITY_TYPE_PERSON);
    assert!(wire["groups"][0]["items"][0].get("entityId").is_some());
    assert!(wire["groups"][0]["items"][0].get("highlights").is_some());
}

#[test]
fn counts_and_truncation_respect_the_limit() {
    let docs = [
        doc(ENTITY_TYPE_PERSON, "p1", "Иван Петров", "", "", None),
        doc(ENTITY_TYPE_PERSON, "p2", "Пётр Петров", "", "", None),
        doc(ENTITY_TYPE_PERSON, "p3", "Мария Петрова", "", "", None),
    ];
    let dir = index(&docs, "hash-a");

    let page = query(dir.path(), "петров", 2).expect("first page");
    assert_eq!(page.match_count, 3);
    assert!(page.truncated);
    let returned: usize = page.groups.iter().map(|group| group.count).sum();
    assert_eq!(returned, 2);
    assert_eq!(page.groups[0].count, 2);

    let full = query(dir.path(), "петров", 3).expect("full page");
    assert_eq!(full.match_count, 3);
    assert!(!full.truncated);
    assert_eq!(full.groups[0].count, 3);
}

#[test]
fn empty_query_returns_three_empty_groups() {
    let dir = index(
        &[doc(ENTITY_TYPE_PERSON, "p1", "Иван Петров", "", "", None)],
        "h",
    );
    for query_text in ["", "   ", "!!!"] {
        let response = query(dir.path(), query_text, 20).expect("empty search");
        assert_eq!(response.match_count, 0);
        assert!(!response.truncated);
        assert_eq!(response.groups.len(), 3);
        assert!(response.groups.iter().all(|group| group.count == 0));
    }
}

#[test]
fn limit_must_be_between_one_and_fifty() {
    let dir = index(
        &[doc(ENTITY_TYPE_PERSON, "p1", "Иван Петров", "", "", None)],
        "h",
    );
    assert!(query(dir.path(), "петров", 0).is_err());
    assert!(query(dir.path(), "петров", 51).is_err());
}

#[test]
fn snippets_are_plain_text_with_character_highlights() {
    let text = format!(
        "{}<script>alert(1)</script> свадьба Петрова",
        "описание ".repeat(40)
    );
    let dir = index(
        &[doc(
            ENTITY_TYPE_EVENT,
            "e1",
            "marriage",
            "",
            &text,
            Some(1910),
        )],
        "h",
    );
    let response = query(dir.path(), "петрова", 20).expect("search");
    let item = &items(&response, ENTITY_TYPE_EVENT)[0];
    assert!(item.snippet.chars().count() <= 240);
    // Angle brackets from user data stay literal characters; the UI renders the
    // snippet as text nodes, so nothing is interpreted as markup.
    assert!(item.snippet.contains("свадьба"));
    assert!(!item.highlights.is_empty());

    let chars: Vec<char> = item.snippet.chars().collect();
    for highlight in &item.highlights {
        assert!(highlight.start < highlight.end);
        assert!(highlight.end <= chars.len());
        let word: String = chars[highlight.start..highlight.end].iter().collect();
        assert_eq!(word.to_lowercase(), "петрова");
    }
}

#[test]
fn stale_detection_compares_hash_and_schema_version() {
    let dir = TempDir::new().expect("temp dir");
    assert!(is_stale(dir.path(), "hash-a", INDEX_SCHEMA_VERSION));

    rebuild_docs_with_meta(
        dir.path(),
        &[doc(ENTITY_TYPE_PERSON, "p1", "Иван Петров", "", "", None)],
        "hash-a",
        INDEX_SCHEMA_VERSION,
    )
    .expect("rebuild");

    assert!(!is_stale(dir.path(), "hash-a", INDEX_SCHEMA_VERSION));
    assert!(is_stale(dir.path(), "hash-b", INDEX_SCHEMA_VERSION));
    assert!(is_stale(dir.path(), "hash-a", INDEX_SCHEMA_VERSION + 1));

    let meta = fs::read_to_string(dir.path().join(INDEX_META_FILE)).expect("index meta");
    assert!(meta.contains("\"schemaVersion\""));
    assert!(meta.contains("\"contentHash\""));
    assert!(meta.contains("\"builtAt\""));
    assert!(meta.contains("hash-a"));
}

#[test]
fn missing_index_metadata_makes_the_index_stale() {
    let dir = index(
        &[doc(ENTITY_TYPE_PERSON, "p1", "Иван Петров", "", "", None)],
        "h",
    );
    fs::remove_file(dir.path().join(INDEX_META_FILE)).expect("remove meta");
    assert!(is_stale(dir.path(), "h", INDEX_SCHEMA_VERSION));
}

#[test]
fn rebuild_without_meta_records_an_empty_hash() {
    let dir = TempDir::new().expect("temp dir");
    rebuild_docs(
        dir.path(),
        &[doc(ENTITY_TYPE_PERSON, "p1", "Иван Петров", "", "", None)],
    )
    .expect("rebuild");
    assert!(!is_stale(dir.path(), "", INDEX_SCHEMA_VERSION));
    assert!(is_stale(dir.path(), "project-hash", INDEX_SCHEMA_VERSION));
    assert!(Path::new(dir.path()).join(INDEX_META_FILE).is_file());
}
