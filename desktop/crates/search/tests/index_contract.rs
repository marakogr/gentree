//! Contract tests for the Tantivy index (design.md §6).

use std::path::Path;

use gentree_search::{rebuild_index, search, PersonDoc, SearchHit};
use tempfile::TempDir;

fn doc(id: &str, name: &str, place: &str, text: &str, year: Option<i64>) -> PersonDoc {
    PersonDoc {
        id: id.to_owned(),
        name: name.to_owned(),
        place: place.to_owned(),
        text: text.to_owned(),
        year,
    }
}

/// Indexes `docs` into a fresh temporary directory.
fn index(docs: &[PersonDoc]) -> TempDir {
    let dir = TempDir::new().expect("temp dir");
    rebuild_index(dir.path(), docs).expect("index rebuild");
    dir
}

fn ids(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.entity_id.as_str()).collect()
}

#[test]
fn russian_query_finds_cyrillic_name() {
    let dir = index(&[doc("p1", "Иван Петров", "Москва", "", Some(1890))]);
    let hits = search(dir.path(), "петров").expect("search");
    assert_eq!(ids(&hits), vec!["p1"]);
    assert!(hits[0].snippet.contains("Петров"));
}

#[test]
fn russian_stemming_matches_inflected_forms() {
    let dir = index(&[doc("p1", "Иван Петров", "", "", None)]);
    let hits = search(dir.path(), "Петрова").expect("search");
    assert_eq!(ids(&hits), vec!["p1"]);
}

#[test]
fn latin_query_finds_the_same_document_via_english_field() {
    let dir = index(&[doc("p1", "Иван Петров (Ivan Petrov)", "", "", None)]);
    let hits = search(dir.path(), "petrov").expect("search");
    assert_eq!(ids(&hits), vec!["p1"]);
}

#[test]
fn exact_name_match_ranks_first() {
    // Both documents match the same two stemmed terms with identical BM25
    // statistics, so without the `name_exact` boost the tie would be broken by
    // document order (`reordered` was indexed first). The boost must win.
    let dir = index(&[
        doc("reordered", "Петров Иван", "", "", None),
        doc("exact", "Иван Петров", "", "", None),
    ]);
    let hits = search(dir.path(), "Иван Петров").expect("search");
    assert_eq!(ids(&hits), vec!["exact", "reordered"]);
}

#[test]
fn snippet_is_plain_text_and_at_most_240_chars() {
    let long_text = format!(
        "{}Петров Иван вернулся из экспедиции.",
        "Длинная биография без разметки. ".repeat(80)
    );
    let dir = index(&[doc("p1", "Иван Петров", "Москва", &long_text, Some(1890))]);
    let hits = search(dir.path(), "петров").expect("search");
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert!(
        hit.snippet.chars().count() <= 240,
        "snippet has {} chars",
        hit.snippet.chars().count()
    );
    assert!(!hit.snippet.contains('<'), "snippet must not contain HTML");
    assert!(!hit.snippet.contains('>'), "snippet must not contain HTML");
    assert!(!hit.highlights.is_empty(), "matches must be highlighted");
    let chars: Vec<char> = hit.snippet.chars().collect();
    for &(from, to) in &hit.highlights {
        assert!(from < to, "empty highlight");
        assert!(to <= chars.len(), "highlight outside the snippet");
        let word: String = chars[from..to].iter().collect();
        assert_eq!(word.to_lowercase(), "петров");
    }
}

#[test]
fn cyrillic_query_matches_even_if_ui_locale_is_english() {
    // Nothing in the query path is locale-dependent: an English UI still sends
    // the raw Cyrillic query, which must hit the Cyrillic document.
    let dir = index(&[doc("p1", "Иван Петров", "Санкт-Петербург", "", None)]);
    let hits = search(dir.path(), "ПЕТРОВ").expect("search");
    assert_eq!(ids(&hits), vec!["p1"]);
}

#[test]
fn empty_query_returns_no_hits() {
    let dir = index(&[doc("p1", "Иван Петров", "", "", None)]);
    assert!(search(dir.path(), "   ").expect("search").is_empty());
    assert!(search(dir.path(), "!!!").expect("search").is_empty());
}

#[test]
fn rebuild_replaces_previous_documents() {
    let dir = TempDir::new().expect("temp dir");
    rebuild_index(
        dir.path(),
        &[
            doc("p1", "Иван Петров", "", "", None),
            doc("p2", "Мария Сидорова", "", "", None),
        ],
    )
    .expect("first rebuild");
    rebuild_index(dir.path(), &[doc("p3", "Пётр Смирнов", "", "", None)]).expect("second rebuild");

    assert!(search(dir.path(), "петров").expect("search").is_empty());
    assert_eq!(
        ids(&search(dir.path(), "смирнов").expect("search")),
        vec!["p3"]
    );
}

#[test]
fn missing_index_is_reported_as_an_error() {
    let dir = TempDir::new().expect("temp dir");
    let missing = dir.path().join("no-index");
    let error = search(&missing, "петров").expect_err("search must fail");
    assert!(!error.is_empty());
}

#[test]
fn rebuild_creates_the_index_directory() {
    let dir = TempDir::new().expect("temp dir");
    let nested = dir.path().join("nested").join("index");
    rebuild_index(&nested, &[doc("p1", "Иван Петров", "", "", None)]).expect("rebuild");
    assert!(Path::new(&nested).join("meta.json").is_file());
}

#[test]
fn place_query_finds_person_without_a_name_match() {
    let dir = index(&[
        doc("p1", "Иван Петров", "Москва", "", None),
        doc("p2", "Мария Иванова", "Казань", "", None),
    ]);
    let hits = search(dir.path(), "Москва").expect("search");
    assert_eq!(ids(&hits), vec!["p1"]);
}
