//! Prefix-search contract: a partially typed word must find a document whose
//! stem only continues the prefix (`онколо` → `онкологии`).
//!
//! Snowball stems `онкологии` to `онколог`, so an exact term lookup for
//! `онколо` finds nothing while the full word does. The index therefore answers
//! every term with both a term query and a prefix query (escaped stem + `.*`).

use gentree_search::{query, rebuild_docs, IndexDoc, SearchResponse, ENTITY_TYPE_PERSON};

fn doc(id: &str, name: &str, place: &str, text: &str, year: Option<i64>) -> IndexDoc {
    IndexDoc {
        entity_type: ENTITY_TYPE_PERSON.to_owned(),
        entity_id: id.to_owned(),
        name: name.to_owned(),
        place: place.to_owned(),
        text: text.to_owned(),
        year,
    }
}

/// Indexes `docs` and returns the server plus a caller-owned directory.
fn index(docs: &[IndexDoc]) -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("temp dir");
    rebuild_docs(dir.path(), docs).expect("index rebuild");
    dir
}

fn person_ids(response: &SearchResponse) -> Vec<String> {
    response
        .groups
        .iter()
        .filter(|group| group.entity_type == ENTITY_TYPE_PERSON)
        .flat_map(|group| group.items.iter())
        .map(|item| item.entity_id.clone())
        .collect()
}

fn search(dir: &tempfile::TempDir, text: &str) -> SearchResponse {
    query(dir.path(), text, 20).expect("search")
}

#[test]
fn partial_and_full_biography_word_both_match() {
    // "онкологии" stems to "онколог"; the query prefix is one character short.
    let dir = index(&[doc("p1", "Иван Петров", "", "работал в онкологии", None)]);

    assert_eq!(person_ids(&search(&dir, "онколо")), vec!["p1"]);
    assert_eq!(person_ids(&search(&dir, "онколог")), vec!["p1"]);
}

#[test]
fn partial_surname_prefix_finds_a_name() {
    // "Петров" stems to "петр", which is exactly the stem of the query too.
    let dir = index(&[doc("p1", "Иван Петров", "", "", None)]);
    assert_eq!(person_ids(&search(&dir, "Петро")), vec!["p1"]);
}

#[test]
fn partial_rare_surname_prefix_finds_a_name() {
    let dir = index(&[
        doc("p1", "Анна Севрюгова", "", "", None),
        doc("p2", "Иван Петров", "", "", None),
    ]);
    assert_eq!(person_ids(&search(&dir, "Севрюг")), vec!["p1"]);
}

#[test]
fn notes_only_match_is_found_by_prefix_and_full_term() {
    // The word appears nowhere in the name or the place, only in the indexed
    // notes/biography (`text`).
    let dir = index(&[doc(
        "p1",
        "Иван Петров",
        "Москва",
        "увлекался ботаникой и гербариями",
        None,
    )]);

    assert_eq!(person_ids(&search(&dir, "ботаник")), vec!["p1"]);
    assert_eq!(person_ids(&search(&dir, "ботанико")), vec!["p1"]);
    let response = search(&dir, "ботаник");
    assert!(
        !response.groups[0].items[0].highlights.is_empty(),
        "a notes match must be highlighted in the snippet"
    );
}

#[test]
fn alternative_name_is_searchable_through_the_text_field() {
    let dir = index(&[doc("p1", "Иван Петров", "", "Петров-Водкин", None)]);
    assert_eq!(person_ids(&search(&dir, "Водкин")), vec!["p1"]);
}

#[test]
fn partial_prefix_matches_places_too() {
    let dir = index(&[doc("p1", "Иван Петров", "Санкт-Петербург", "", None)]);
    assert_eq!(person_ids(&search(&dir, "Петербу")), vec!["p1"]);
}

#[test]
fn partial_latin_name_prefix_matches_via_the_english_field() {
    let dir = index(&[doc("p1", "Иван Петров (Ivan Petrov)", "", "", None)]);
    assert_eq!(person_ids(&search(&dir, "Petro")), vec!["p1"]);
}

#[test]
fn short_garbage_does_not_match() {
    let dir = index(&[doc(
        "p1",
        "Иван Петров",
        "Москва",
        "работал в онкологии",
        None,
    )]);
    assert!(person_ids(&search(&dir, "zzzzq")).is_empty());
    assert!(person_ids(&search(&dir, "ъъъъ")).is_empty());
}
