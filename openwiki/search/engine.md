---
type: architecture
title: Search index and retrieval
description: How the derived Tantivy index is built, why it indexes both Russian and English analyzers, how prefix matching and relevance work, and how results are grouped and snippet-highlighted.
tags: [search, tantivy, stemming, indexing]
sources:
  - id: openwiki-source-5ea58748fcaea8f2bbe6c93a
    resource: repo://desktop/apps/desktop/src/commands/search.rs
  - id: openwiki-source-9c8855e169dc2fef2d17912f
    resource: repo://desktop/crates/search/src/analyzer.rs
  - id: openwiki-source-1a34dda69247809be4a494e4
    resource: repo://desktop/crates/search/src/lib.rs
  - id: openwiki-source-9ab8f95f1d0707e00a8d5361
    resource: repo://desktop/crates/search/src/snippet.rs
generated: { by: "opencode", at: "2026-10-24T14:34:58.929Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# Search index and retrieval

Search is derived data. `gentree-search` builds a Tantivy index from project content; losing or corrupting it costs a rebuild, never project data. The index directory is chosen by the caller and lives at `<app_data>/indexes/<projectId>`, outside the project folder and outside its backups.

## Documents

`IndexDoc` is the generic unit: `entity_type` (`person`, `event`, `source`), `entity_id`, `name`, `place`, `text` and an optional `year`. `build_index_docs` in the desktop shell flattens the project:

- persons contribute their display name, notes and every event place;
- events contribute type/person, description and place;
- sources contribute title and metadata.

One rebuild is capped at 50 000 documents, a query at 100 characters and 10 tokens, and a result limit between 1 and 50 (default 20).

## Schema

| Field | Type | Purpose |
| --- | --- | --- |
| `entity_type`, `entity_id` | keyword, stored | grouping and result identity |
| `name_ru`, `name_en` | stemmed text, stored | primary label |
| `name_exact` | keyword | boosted exact-name match |
| `place_ru`, `place_en` | stemmed text, stored | places |
| `text_ru`, `text_en` | stemmed text, stored | notes, descriptions, metadata |
| `year` | i64, fast + stored | numeric filtering |

The same value is indexed into both the Russian and English fields, so a query typed in either alphabet finds the same document. `name_exact` stores a lowercased, whitespace-normalized copy of the name.

## Analyzers

`analyzer.rs` implements lowercasing plus Snowball stemming as a custom Tantivy `TokenFilter` backed by `rust_stemmers`, so the crate does not depend on Tantivy's optional stemmer features. Both the index-time filter and query-time preparation stem to a **fixed point** (at most 5 passes), because Snowball is not idempotent: `петров → петр`, but `петрова → петров`. Without the fixed point, searching a female surname would miss the male form of the same family name.

Tokenizers are not persisted with the schema, so `register_tokenizers` runs for both indexing and searching.

## Query construction

`build_query` produces a `BooleanQuery` of `Should` clauses:

1. a boosted exact term on `name_exact` (`NAME_EXACT_BOOST = 4.0`);
2. for every query term, the Russian and English stemmed terms against name, place and text fields (six clauses per term);
3. for each distinct stem of at least `MIN_PREFIX_CHARS = 3`, a prefix `RegexQuery` `<escaped stem>.*` against the same six fields.

Prefixes go through `escape_regex`, so user input never becomes a raw pattern. Exact stem matches score through BM25 while prefix matches use the constant regex scorer, which keeps a full word ranked above a partial one.

An empty or token-less query returns three empty groups, never an error. The legacy `search` entry point caps hits at 50; `query` returns the richer grouped response.

## Staleness

`is_stale(dir, contentHash, schemaVersion)` is true when `meta.json` is missing, `index-meta.json` cannot be read or parsed, or the stored `schemaVersion`/`contentHash` differ from the current project manifest. The desktop `search_project` checks staleness before every query and rebuilds synchronously when needed, then queries and attaches event owners to event hits.

Rebuilds remove the old files, create the index with the contract schema, add all documents and commit once; `index-meta.json` is written only after the commit succeeds.

## Grouped results

`SearchResponse` always contains three groups in the order `person`, `event`, `source`, each with items sorted by relevance. `count` is the size of the returned page, `matchCount` counts unique collapsed items plus matches beyond the page, and `truncated` reports that more documents exist.

Identical snippets after `normalize_text` (lowercase, collapsed whitespace) collapse into one item with `similarCount`. This is what stops repeated GEDCOM notes from filling a group with five copies of the same line. The UI shows `similarCount - 1` as hidden duplicates.

## Snippets

`snippet::build` returns plain text of at most 240 characters plus **character** offsets, never HTML. It tries candidates in order (text, name, place), keeps 60 characters of leading context, starts and ends on word/whitespace boundaries, and rebases highlight offsets into the returned excerpt. If nothing matches, it returns the first non-empty candidate truncated, without highlights.

## Related pages

<!-- openwiki: broken internal link [/openwiki/desktop/ipc-and-state.md] link "/openwiki/desktop/ipc-and-state.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Tauri shell, IPC commands and app state](/openwiki/desktop/ipc-and-state.md)
<!-- openwiki: broken internal link [/openwiki/testing/contracts.md] link "/openwiki/testing/contracts.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Contract test map](/openwiki/testing/contracts.md)
