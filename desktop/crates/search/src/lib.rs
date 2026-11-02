//! Full-text search over the local Tantivy index.
//!
//! Contract: search behavior and index format.
//!
//! * One value is indexed into both language fields (`name_ru`/`name_en`,
//!   `place_ru`/`place_en`, `text_ru`/`text_en`), so a query in either alphabet
//!   finds the same document.
//! * A query is a [`BooleanQuery`] of `Should` clauses over the six language
//!   fields plus a boosted exact term on the `name_exact` keyword field.
//! * Each term also contributes a prefix clause (escaped stem + `.*`,
//!   [`RegexQuery`]), so a partially typed word still matches: `онколо` finds
//!   a document indexed as `онкологии`, whose stem is `онколог`.
//! * Russian stemming uses a custom token filter backed by `rust_stemmers`
//!   (no Tantivy feature flags), English uses the same filter with the English
//!   Snowball algorithm.
//! * Snippets are plain text (≤ 240 characters, no HTML) with character-offset
//!   highlights; the UI renders them itself.
//! * The index is derived data. [`is_stale`] compares the stored
//!   `index-meta.json` (`schemaVersion`, `contentHash`) with the caller's
//!   project state; a stale index is rebuilt before searching.
//!
//! The index directory belongs to the caller (`<index_dir>/<projectId>`, kept
//! outside the project folder and its backups).

mod analyzer;
mod snippet;

use std::path::Path;

use gentree_core::now_rfc3339;
use rust_stemmers::Algorithm;
use serde::{Deserialize, Serialize};
use tantivy::collector::{Count, TopDocs};
use tantivy::query::{BooleanQuery, BoostQuery, Occur, Query, RegexQuery, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions, STORED,
    STRING,
};
use tantivy::{Index, TantivyDocument, Term};

/// Record type written for person documents (`person|event|source` groups).
pub const ENTITY_TYPE_PERSON: &str = "person";
/// Record type written for event documents.
pub const ENTITY_TYPE_EVENT: &str = "event";
/// Record type written for source documents.
pub const ENTITY_TYPE_SOURCE: &str = "source";

/// Version of the on-disk schema and document shape. Bump it when either
/// changes, so existing indexes are rebuilt before the next search.
pub const INDEX_SCHEMA_VERSION: u32 = 1;

/// Metadata file written next to the Tantivy index (`meta.json`).
pub const INDEX_META_FILE: &str = "index-meta.json";

/// Default page size for [`query`].
pub const DEFAULT_RESULT_LIMIT: usize = 20;
/// Maximum page size for [`query`] (design.md §6, search-query spec).
pub const MAX_RESULT_LIMIT: usize = 50;

/// Weight of the exact name match relative to the stemmed fields.
const NAME_EXACT_BOOST: f32 = 4.0;
/// Shortest stem that also gets a prefix clause. Shorter prefixes would match
/// a large part of the term dictionary; the UI never sends them.
const MIN_PREFIX_CHARS: usize = 3;
/// Maximum number of hits returned by the legacy [`search`] API.
const MAX_HITS: usize = MAX_RESULT_LIMIT;
/// Index writer heap budget (Tantivy requires at least 15 MB).
const WRITER_HEAP_BYTES: usize = 50 * 1024 * 1024;

/// A person projected into the search index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PersonDoc {
    /// Stable entity id (`PersonId` as string).
    pub id: String,
    /// Display name, indexed with both stemming analyzers.
    pub name: String,
    /// Place text, indexed with both stemming analyzers.
    pub place: String,
    /// Free text (notes, event descriptions), indexed with both analyzers.
    pub text: String,
    /// Optional year used for fast filtering.
    pub year: Option<i64>,
}

/// One document of any searchable entity type.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexDoc {
    /// `person`, `event` or `source` ([`ENTITY_TYPE_PERSON`] and friends).
    pub entity_type: String,
    /// Stable entity id as string (UUID).
    pub entity_id: String,
    /// Primary label: person name, event type/person, source title.
    pub name: String,
    /// Place text: person places, event place, source repository.
    pub place: String,
    /// Free text: person notes/bio, event description, source metadata.
    pub text: String,
    /// Optional year (person birth, event start) used for fast filtering.
    pub year: Option<i64>,
}

impl From<&PersonDoc> for IndexDoc {
    fn from(doc: &PersonDoc) -> Self {
        Self {
            entity_type: ENTITY_TYPE_PERSON.to_owned(),
            entity_id: doc.id.clone(),
            name: doc.name.clone(),
            place: doc.place.clone(),
            text: doc.text.clone(),
            year: doc.year,
        }
    }
}

/// One search result (legacy person-oriented shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// Entity id of the matched document.
    pub entity_id: String,
    /// Plain-text excerpt, at most 240 characters, never HTML.
    pub snippet: String,
    /// `(start, end)` character offsets into [`SearchHit::snippet`].
    pub highlights: Vec<(usize, usize)>,
}

/// `[start, end)` character offsets into a snippet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// Inclusive character offset.
    pub start: usize,
    /// Exclusive character offset.
    pub end: usize,
}

/// One item of a grouped search response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    /// Entity id of the matched document.
    pub entity_id: String,
    /// `person`, `event` or `source`.
    pub entity_type: String,
    /// Plain-text excerpt, at most 240 characters, never HTML.
    pub snippet: String,
    /// Sorted, non-overlapping character ranges into `snippet`.
    pub highlights: Vec<Highlight>,
    /// Owning person for `person`/`event`; `null` for `source`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    /// How many hits this item stands for: identical (normalized) snippets are
    /// collapsed inside a group, so several documents with the same text become
    /// one item. Always at least `1`; the UI shows the hidden `similar_count - 1`.
    #[serde(default)]
    pub similar_count: usize,
}

/// Results of one entity type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGroup {
    /// `person`, `event` or `source`.
    pub entity_type: String,
    /// Number of items in this group (the current page).
    pub count: usize,
    /// Items, ordered by relevance.
    pub items: Vec<SearchItem>,
}

/// Grouped search response. Empty query or no matches still returns the three
/// groups (with `count = 0`), so the UI never has to guess which types exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    /// Always ordered `person`, `event`, `source`.
    pub groups: Vec<SearchGroup>,
    /// Number of results: unique collapsed items in the returned page plus the
    /// matching documents that did not fit into the page (their snippets are
    /// unknown). Duplicate documents count once, so a page where every snippet
    /// repeats reports `matchCount == count` instead of the number of hits.
    pub match_count: usize,
    /// `true` when more matching documents exist beyond the returned page.
    pub truncated: bool,
}

impl SearchResponse {
    /// Response with three empty groups and `matchCount = 0`.
    pub fn empty() -> Self {
        Self {
            groups: [ENTITY_TYPE_PERSON, ENTITY_TYPE_EVENT, ENTITY_TYPE_SOURCE]
                .into_iter()
                .map(|entity_type| SearchGroup {
                    entity_type: entity_type.to_owned(),
                    count: 0,
                    items: Vec::new(),
                })
                .collect(),
            match_count: 0,
            truncated: false,
        }
    }
}

/// Contents of [`INDEX_META_FILE`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    /// Document/schema shape used to build the index.
    pub schema_version: u32,
    /// Project `contentHash` the index was built from.
    pub content_hash: String,
    /// RFC 3339 UTC timestamp of the last rebuild.
    pub built_at: String,
}

/// Tantivy fields of the contract schema.
struct Fields {
    entity_type: Field,
    entity_id: Field,
    name_ru: Field,
    name_en: Field,
    name_exact: Field,
    place_ru: Field,
    place_en: Field,
    text_ru: Field,
    text_en: Field,
    year: Field,
}

impl Fields {
    fn from_schema(schema: &Schema) -> Result<Self, String> {
        Ok(Self {
            entity_type: field(schema, "entity_type")?,
            entity_id: field(schema, "entity_id")?,
            name_ru: field(schema, "name_ru")?,
            name_en: field(schema, "name_en")?,
            name_exact: field(schema, "name_exact")?,
            place_ru: field(schema, "place_ru")?,
            place_en: field(schema, "place_en")?,
            text_ru: field(schema, "text_ru")?,
            text_en: field(schema, "text_en")?,
            year: field(schema, "year")?,
        })
    }
}

/// Rebuilds the index from scratch: stale files are removed, then `docs` are
/// written in a single commit. The legacy person-oriented entry point; prefer
/// [`rebuild_docs_with_meta`] so the index carries its project `contentHash`.
pub fn rebuild_index(dir: &Path, docs: &[PersonDoc]) -> Result<(), String> {
    let docs: Vec<IndexDoc> = docs.iter().map(IndexDoc::from).collect();
    rebuild_docs_with_meta(dir, &docs, "", INDEX_SCHEMA_VERSION)
}

/// Rebuilds the index from generic documents without a project content hash.
pub fn rebuild_docs(dir: &Path, docs: &[IndexDoc]) -> Result<(), String> {
    rebuild_docs_with_meta(dir, docs, "", INDEX_SCHEMA_VERSION)
}

/// Rebuilds the index and records `{schemaVersion, contentHash, builtAt}` in
/// [`INDEX_META_FILE`] after the Tantivy commit succeeds.
pub fn rebuild_docs_with_meta(
    dir: &Path,
    docs: &[IndexDoc],
    content_hash: &str,
    schema_version: u32,
) -> Result<(), String> {
    reset_index_dir(dir)?;
    let (schema, fields) = build_schema();
    let index = Index::create_in_dir(dir, schema)
        .map_err(|error| failure("cannot create search index", &error))?;
    register_tokenizers(&index);
    let mut writer: tantivy::IndexWriter = index
        .writer(WRITER_HEAP_BYTES)
        .map_err(|error| failure("cannot open search index writer", &error))?;
    for doc in docs {
        writer
            .add_document(build_document(&fields, doc))
            .map_err(|error| failure("cannot index document", &error))?;
    }
    writer
        .commit()
        .map_err(|error| failure("cannot commit search index", &error))?;
    drop(writer);
    write_meta(dir, content_hash, schema_version)
}

/// `true` when the index is missing, unreadable, built with another schema
/// version, or built from another project `contentHash` (design.md §6).
pub fn is_stale(dir: &Path, content_hash: &str, schema_version: u32) -> bool {
    if !dir.join("meta.json").is_file() {
        return true;
    }
    let raw = match std::fs::read_to_string(dir.join(INDEX_META_FILE)) {
        Ok(raw) => raw,
        Err(_) => return true,
    };
    match serde_json::from_str::<IndexMeta>(&raw) {
        Ok(meta) => meta.schema_version != schema_version || meta.content_hash != content_hash,
        Err(_) => true,
    }
}

/// Runs a grouped query against an index built by [`rebuild_docs`].
///
/// An empty query yields three empty groups, never an error. Results keep the
/// relevance order inside each group; `limit` is validated against
/// `1..=MAX_RESULT_LIMIT`. Hits whose snippets are identical after
/// `normalize_text` collapse into the first (best ranked) item, which counts
/// them in [`SearchItem::similar_count`]: shared GEDCOM notes used to fill a
/// group with five copies of the same line.
pub fn query(dir: &Path, query: &str, limit: usize) -> Result<SearchResponse, String> {
    if !(1..=MAX_RESULT_LIMIT).contains(&limit) {
        return Err(format!(
            "limit must be between 1 and {MAX_RESULT_LIMIT}, got {limit}"
        ));
    }
    let (mut hits, total) = search_raw(dir, query, limit)?;
    hits.truncate(limit);
    let scanned = hits.len();

    let mut response = SearchResponse::empty();
    for hit in &hits {
        let group = match response
            .groups
            .iter_mut()
            .find(|group| group.entity_type == hit.entity_type)
        {
            Some(group) => group,
            None => continue,
        };
        let snippet = normalize_text(&hit.snippet);
        // `search_raw` returns hits by descending relevance, so the first
        // occurrence of a snippet is the one worth keeping.
        if let Some(existing) = group
            .items
            .iter_mut()
            .find(|item| normalize_text(&item.snippet) == snippet)
        {
            existing.similar_count += 1;
            continue;
        }
        let person_id = if hit.entity_type == ENTITY_TYPE_PERSON {
            Some(hit.entity_id.clone())
        } else {
            None
        };
        group.items.push(SearchItem {
            entity_id: hit.entity_id.clone(),
            entity_type: hit.entity_type.clone(),
            snippet: hit.snippet.clone(),
            highlights: hit
                .highlights
                .iter()
                .map(|&(start, end)| Highlight { start, end })
                .collect(),
            person_id,
            similar_count: 1,
        });
    }
    for group in &mut response.groups {
        group.count = group.items.len();
    }
    let returned: usize = response.groups.iter().map(|group| group.count).sum();
    // Collapsed duplicates must not inflate the counters: `matchCount` counts
    // each visible item once and adds only the documents that did not fit into
    // the page, whose snippets were never compared.
    response.match_count = returned.saturating_add(total.saturating_sub(scanned));
    response.truncated = total > scanned;
    Ok(response)
}

/// Legacy flat search. Returns hits in relevance order across all types.
pub fn search(dir: &Path, query: &str) -> Result<Vec<SearchHit>, String> {
    let (hits, _total) = search_raw(dir, query, MAX_HITS)?;
    Ok(hits
        .into_iter()
        .map(|hit| SearchHit {
            entity_id: hit.entity_id,
            snippet: hit.snippet,
            highlights: hit.highlights,
        })
        .collect())
}

/// One hit before grouping; offsets stay in the flat tuple form used by the
/// snippet module.
struct RawHit {
    entity_type: String,
    entity_id: String,
    snippet: String,
    highlights: Vec<(usize, usize)>,
}

fn search_raw(dir: &Path, query: &str, limit: usize) -> Result<(Vec<RawHit>, usize), String> {
    let terms = query_terms(query);
    let normalized = normalize_exact(query);
    if normalized.is_empty() || terms.is_empty() {
        return Ok((Vec::new(), 0));
    }

    let index =
        Index::open_in_dir(dir).map_err(|error| failure("cannot open search index", &error))?;
    register_tokenizers(&index);
    let fields = Fields::from_schema(&index.schema())?;
    let reader = index
        .reader()
        .map_err(|error| failure("cannot open search index reader", &error))?;
    let searcher = reader.searcher();
    let query = build_query(&fields, &normalized, &terms)?;
    let cap = limit.saturating_add(1);
    let (top_docs, total) = searcher
        .search(&query, &(TopDocs::with_limit(cap), Count))
        .map_err(|error| failure("search query failed", &error))?;

    let mut hits = Vec::with_capacity(top_docs.len());
    for (_score, address) in top_docs {
        let document: TantivyDocument = searcher
            .doc(address)
            .map_err(|error| failure("cannot read search hit", &error))?;
        let entity_type = stored_text(&document, fields.entity_type).unwrap_or_default();
        let entity_id = stored_text(&document, fields.entity_id).unwrap_or_default();
        let name = stored_text(&document, fields.name_ru).unwrap_or_default();
        let place = stored_text(&document, fields.place_ru).unwrap_or_default();
        let text = stored_text(&document, fields.text_ru).unwrap_or_default();
        let (snippet, highlights) = snippet::build(&[&text, &name, &place], &terms);
        hits.push(RawHit {
            entity_type,
            entity_id,
            snippet,
            highlights,
        });
    }
    Ok((hits, total))
}

/// Creates the contract schema. Tokens for text fields are `LowerCaser` +
/// Snowball stems registered by [`register_tokenizers`].
fn build_schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let entity_type = builder.add_text_field("entity_type", STRING | STORED);
    let entity_id = builder.add_text_field("entity_id", STRING | STORED);
    let name_ru = builder.add_text_field("name_ru", text_options(analyzer::RU_STEM));
    let name_en = builder.add_text_field("name_en", text_options(analyzer::EN_STEM));
    let name_exact = builder.add_text_field("name_exact", STRING);
    let place_ru = builder.add_text_field("place_ru", text_options(analyzer::RU_STEM));
    let place_en = builder.add_text_field("place_en", text_options(analyzer::EN_STEM));
    let text_ru = builder.add_text_field("text_ru", text_options(analyzer::RU_STEM));
    let text_en = builder.add_text_field("text_en", text_options(analyzer::EN_STEM));
    let year = builder.add_i64_field("year", NumericOptions::default().set_fast().set_stored());
    let fields = Fields {
        entity_type,
        entity_id,
        name_ru,
        name_en,
        name_exact,
        place_ru,
        place_en,
        text_ru,
        text_en,
        year,
    };
    (builder.build(), fields)
}

fn text_options(tokenizer: &str) -> TextOptions {
    TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(tokenizer)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored()
}

/// Registers the `ru_stem`/`en_stem` analyzers on an index. Tokenizers are not
/// part of the persisted schema, so this runs for both indexing and search.
fn register_tokenizers(index: &Index) {
    index
        .tokenizers()
        .register(analyzer::RU_STEM, analyzer::analyzer(Algorithm::Russian));
    index
        .tokenizers()
        .register(analyzer::EN_STEM, analyzer::analyzer(Algorithm::English));
}

fn build_document(fields: &Fields, doc: &IndexDoc) -> TantivyDocument {
    let mut document = TantivyDocument::default();
    document.add_text(fields.entity_type, &doc.entity_type);
    document.add_text(fields.entity_id, &doc.entity_id);
    document.add_text(fields.name_ru, &doc.name);
    document.add_text(fields.name_en, &doc.name);
    document.add_text(fields.name_exact, normalize_exact(&doc.name));
    document.add_text(fields.place_ru, &doc.place);
    document.add_text(fields.place_en, &doc.place);
    document.add_text(fields.text_ru, &doc.text);
    document.add_text(fields.text_en, &doc.text);
    if let Some(year) = doc.year {
        document.add_i64(fields.year, year);
    }
    document
}

/// `Should` clauses over `name_ru|name_en|place_ru|place_en|text_ru|text_en`
/// plus a boosted exact `name_exact` term (design.md §6).
///
/// Every term contributes both a whole-term query and, for stems of at least
/// [`MIN_PREFIX_CHARS`] characters, a prefix query. Exact stemmed matches score
/// through BM25, prefix matches through the constant [`RegexQuery`] scorer, so
/// a full word still ranks above a partial one.
fn build_query(
    fields: &Fields,
    normalized: &str,
    terms: &[String],
) -> Result<BooleanQuery, String> {
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
    let exact = TermQuery::new(
        Term::from_field_text(fields.name_exact, normalized),
        IndexRecordOption::Basic,
    );
    clauses.push((
        Occur::Should,
        Box::new(BoostQuery::new(Box::new(exact), NAME_EXACT_BOOST)),
    ));
    for term in terms {
        let ru = analyzer::stem(Algorithm::Russian, term);
        let en = analyzer::stem(Algorithm::English, term);
        for (field, text) in [
            (fields.name_ru, &ru),
            (fields.name_en, &en),
            (fields.place_ru, &ru),
            (fields.place_en, &en),
            (fields.text_ru, &ru),
            (fields.text_en, &en),
        ] {
            let query = TermQuery::new(
                Term::from_field_text(field, text),
                IndexRecordOption::WithFreqs,
            );
            clauses.push((Occur::Should, Box::new(query)));
        }
        // One prefix clause per distinct stem; the Russian and English
        // stemmers usually agree on a Cyrillic term, so avoid duplicates.
        let mut prefix_stems: Vec<&str> = vec![&ru];
        if en != ru {
            prefix_stems.push(&en);
        }
        for stem in prefix_stems
            .into_iter()
            .filter(|stem| stem.chars().count() >= MIN_PREFIX_CHARS)
        {
            for field in [
                fields.name_ru,
                fields.name_en,
                fields.place_ru,
                fields.place_en,
                fields.text_ru,
                fields.text_en,
            ] {
                clauses.push((Occur::Should, Box::new(prefix_query(field, stem)?)));
            }
        }
    }
    Ok(BooleanQuery::new(clauses))
}

/// Prefix query over the stemmed term dictionary: `<escaped stem>.*`.
///
/// [`RegexQuery`] matches whole terms, so the `.*` suffix is what turns an
/// exact term lookup into a prefix lookup. User input never reaches the regex
/// unescaped.
fn prefix_query(field: Field, stem: &str) -> Result<RegexQuery, String> {
    let pattern = format!("{}.*", escape_regex(stem));
    RegexQuery::from_pattern(&pattern, field)
        .map_err(|error| failure("cannot build a prefix query", &error))
}

/// Escapes every regex metacharacter so a query term is matched literally.
fn escape_regex(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(
            c,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$'
        ) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// Lowercased, whitespace-normalized form stored in/queried against
/// `name_exact`. The UI locale is irrelevant: the query is never translated.
fn normalize_exact(value: &str) -> String {
    normalize_text(value)
}

/// Lowercases a value and collapses every whitespace run into one space,
/// trimming the ends. Used for `name_exact` and to compare snippets: shared
/// GEDCOM notes differ only in spacing/case across persons.
fn normalize_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Lowercased alphanumeric query tokens of at least two characters, deduped.
fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        if raw.chars().count() < 2 {
            continue;
        }
        let term = raw.to_lowercase();
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

fn field(schema: &Schema, name: &str) -> Result<Field, String> {
    schema
        .get_field(name)
        .map_err(|error| failure(&format!("index schema is missing `{name}`"), &error))
}

fn stored_text(document: &TantivyDocument, field: Field) -> Option<String> {
    use tantivy::schema::Value as _;
    document
        .get_first(field)
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn write_meta(dir: &Path, content_hash: &str, schema_version: u32) -> Result<(), String> {
    let meta = IndexMeta {
        schema_version,
        content_hash: content_hash.to_owned(),
        built_at: now_rfc3339(),
    };
    let bytes = serde_json::to_vec_pretty(&meta)
        .map_err(|error| failure("cannot encode index metadata", &error))?;
    std::fs::write(dir.join(INDEX_META_FILE), bytes)
        .map_err(|error| failure("cannot write index metadata", &error))
}

/// A rebuild owns its directory: an index left by a previous build is dropped,
/// anything else is left untouched (and makes `create_in_dir` fail loudly).
fn reset_index_dir(dir: &Path) -> Result<(), String> {
    if dir.join("meta.json").is_file() || dir.join(INDEX_META_FILE).is_file() {
        std::fs::remove_dir_all(dir)
            .map_err(|error| failure("cannot remove stale search index", &error))?;
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| failure("cannot create search index directory", &error))
}

fn failure(context: &str, error: &dyn std::fmt::Display) -> String {
    format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{
        escape_regex, normalize_text, prefix_query, query, rebuild_docs, IndexDoc, SearchGroup,
        SearchResponse, ENTITY_TYPE_EVENT, ENTITY_TYPE_PERSON,
    };

    #[test]
    fn regex_metacharacters_are_escaped() {
        // A user term can never become a wildcard/regex: every metacharacter
        // the prefix pattern cares about is escaped before it reaches Tantivy.
        assert_eq!(escape_regex("a.b*c"), "a\\.b\\*c");
        assert_eq!(escape_regex("x+y?z"), "x\\+y\\?z");
        assert_eq!(escape_regex("(a)|[b]{c}"), "\\(a\\)\\|\\[b\\]\\{c\\}");
        assert_eq!(escape_regex("^$\\"), "\\^\\$\\\\");
        assert_eq!(escape_regex("онколо"), "онколо");
    }

    #[test]
    fn prefix_pattern_accepts_a_cyrillic_stem() {
        let fields = super::build_schema().1;
        assert!(prefix_query(fields.name_ru, "онколо").is_ok());
        assert!(prefix_query(fields.text_ru, "петр").is_ok());
    }

    fn doc(entity_type: &str, id: &str, name: &str, text: &str) -> IndexDoc {
        IndexDoc {
            entity_type: entity_type.to_owned(),
            entity_id: id.to_owned(),
            name: name.to_owned(),
            place: String::new(),
            text: text.to_owned(),
            year: None,
        }
    }

    fn person_doc(id: &str, name: &str, text: &str) -> IndexDoc {
        doc(ENTITY_TYPE_PERSON, id, name, text)
    }

    fn index(docs: &[IndexDoc]) -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        rebuild_docs(dir.path(), docs).expect("index rebuild");
        dir
    }

    fn group<'a>(response: &'a SearchResponse, entity_type: &str) -> &'a SearchGroup {
        response
            .groups
            .iter()
            .find(|group| group.entity_type == entity_type)
            .expect("group is present")
    }

    #[test]
    fn snippet_normalization_ignores_case_and_whitespace() {
        assert_eq!(normalize_text("  Общая   Заметка "), "общая заметка");
        assert_eq!(normalize_text("общая\tзаметка\n"), "общая заметка");
        assert_eq!(normalize_text(""), "");
    }

    #[test]
    fn identical_snippets_collapse_into_one_item_with_a_count() {
        // Shared GEDCOM notes expand into the `text` of every person they are
        // attached to, so three documents carry the very same snippet.
        let dir = index(&[
            person_doc("p1", "Иван Петров", "общая заметка о семье"),
            person_doc("p2", "Пётр Сидоров", "общая заметка о семье"),
            person_doc("p3", "Анна Кузнецова", "общая заметка о семье"),
        ]);

        let response = query(dir.path(), "заметка", 20).expect("search");
        let persons = group(&response, ENTITY_TYPE_PERSON);

        assert_eq!(persons.count, 1);
        assert_eq!(persons.items.len(), 1);
        assert_eq!(persons.items[0].similar_count, 3);
        // The counters must describe the single visible row, not the three hits.
        assert_eq!(response.match_count, 1);
        assert!(!response.truncated);
    }

    #[test]
    fn different_snippets_are_kept_separately() {
        let dir = index(&[
            person_doc("p1", "Иван Петров", "заметка о первом"),
            person_doc("p2", "Пётр Сидоров", "заметка о втором"),
            person_doc("p3", "Анна Кузнецова", "заметка о третьем"),
        ]);

        let response = query(dir.path(), "заметка", 20).expect("search");
        let persons = group(&response, ENTITY_TYPE_PERSON);

        assert_eq!(persons.count, 3);
        assert_eq!(persons.items.len(), 3);
        assert!(persons.items.iter().all(|item| item.similar_count == 1));
        assert_eq!(response.match_count, 3);
        assert!(!response.truncated);
    }

    #[test]
    fn collapsing_stops_at_the_group_boundary() {
        // The same sentence in a person and an event is two results: the
        // collapse is scoped to one `entity_type`.
        let shared = "общая заметка о семье";
        let dir = index(&[
            person_doc("p1", "Иван Петров", shared),
            doc(ENTITY_TYPE_EVENT, "e1", "birth", shared),
        ]);

        let response = query(dir.path(), "заметка", 20).expect("search");

        assert_eq!(group(&response, ENTITY_TYPE_PERSON).count, 1);
        assert_eq!(group(&response, ENTITY_TYPE_EVENT).count, 1);
        assert_eq!(response.match_count, 2);
    }
}
