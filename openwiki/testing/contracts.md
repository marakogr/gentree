---
type: guide
title: Contract test map
description: Where behaviour is pinned by tests, what each contract suite protects, how synthetic fixtures are used, and how to run a single suite.
tags: [testing, contracts, fixtures, vitest]
sources:
  - id: openwiki-source-92ee3a60a9826201e8ce6fa7
    resource: repo://desktop/Cargo.toml
  - id: openwiki-source-75976fdd3c9768bb58267530
    resource: repo://desktop/crates/config/tests/config_contract.rs
  - id: openwiki-source-16f11610e9b1ef5f7e938c2a
    resource: repo://desktop/crates/core/tests/merge_contract.rs
  - id: openwiki-source-5585ead6f504375a536830ca
    resource: repo://desktop/crates/import/tests/at5_contract.rs
  - id: openwiki-source-2b838c869260844f02b9b8fe
    resource: repo://desktop/crates/import/tests/at5_eav_contract.rs
  - id: openwiki-source-aaa421b86718b953dee96c62
    resource: repo://desktop/crates/import/tests/exchange_contract.rs
  - id: openwiki-source-8e2990f409fd0c2ffce46566
    resource: repo://desktop/crates/import/tests/gedcom_contract.rs
  - id: openwiki-source-43a6c88791004fe43c9b4299
    resource: repo://desktop/crates/import/tests/gedcom7_contract.rs
  - id: openwiki-source-039e782c5de018a33d2af9a0
    resource: repo://desktop/crates/search/tests/groups_contract.rs
  - id: openwiki-source-373594ee7bf20badb160ee6f
    resource: repo://desktop/crates/search/tests/index_contract.rs
  - id: openwiki-source-bfa2cfe541c5885a3e8be19e
    resource: repo://desktop/crates/search/tests/prefix_contract.rs
  - id: openwiki-source-ba67a2844f3cdb93304b3fae
    resource: repo://desktop/crates/storage/src/lib.rs
  - id: openwiki-source-fb9602341b89c516f9c15ec6
    resource: repo://desktop/ui/e2e/README.md
  - id: openwiki-source-521dba66491bc60efe25ff97
    resource: repo://desktop/ui/package.json
generated: { by: "opencode", at: "2026-11-03T10:50:52.373Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-03T10:50:52.373Z
---

# Contract test map

Behavior is pinned twice: inline unit tests next to the code, and integration "contract" suites under `crates/*/tests/` that exercise a whole layer through its public API. Contract tests are the second source of truth after `AGENTS.md`; if implementation and contract disagree, stop and ask before changing either.

## Layout

- `desktop/crates/**/src/*.rs` — `#[cfg(test)] mod tests` for pure rules: dates, validation, graph, kinship, path, storage, analyzers, snippets, skills, prompt.
- `desktop/crates/*/tests/*.rs` — contract suites for config, import/export, search, merge and the chat prompt snapshot.
- `desktop/ui/src/**/*.test.ts` — Vitest suites next to the pure modules they cover; the UI gate runs `vitest run`.
- `desktop/ui/e2e` — an optional WebdriverIO review harness (not part of the gate) that drives the built desktop app and writes screenshot/DOM evidence.
- Fixtures are synthetic. Tests never read real AT5 data; the one baseline diagnostic is `#[ignore]` and prints aggregates.

## Storage and domain

`desktop/crates/storage/src/lib.rs` tests pin the folder contract:

- create → write → reopen, lost `homePersonId`, round-trip of all six collections;
- a second writer is locked; a corrupt JSONL line is reported;
- an invalid entity is rejected before anything is written;
- relationship invariants are enforced on save;
- `list_projects` skips corrupt folders;
- backups round-trip media, pruning keeps the newest N, delete moves to trash and refuses while locked;
- media file names cannot traverse, and `validate_layout` reports repair issues.

Core tests in `person.rs`, `date.rs`, `record.rs`, `relationship.rs`, `validation.rs`, `graph.rs`, `path.rs` and `kinship.rs` cover the domain invariants described in the domain pages: half-open dates, precision alignment, death before birth, self-links, cycles, sibling derivation, ancestor placeholders, descendant truncation and collapse, event-detail limits, single-life-event rejection, path tie-breaks and kinship classification.

## Merge contract

`desktop/crates/core/tests/merge_contract.rs` pins the merge MVP end to end on synthetic snapshots:

- deterministic one-to-one assignment, name variants and the patronymic-inside-given case, gender/date conflicts, ambiguity, shared-relative evidence and unmatched right people;
- defaults and explicit decisions: merge versus keep both, base card and per-field policies, conflicting dates rejected without a policy;
- id claiming and derived UUIDs, relationship remapping/dedup/type conflicts/cycles, media and citation remapping, deterministic re-apply and a merged project that passes `validate_project`.

## Import and export contracts

| Suite | Protects |
| --- | --- |
| `config_contract.rs` (+ `event_types_contract.rs`) | YAML/JSON parity, default sections, layer precedence, `~` expansion, relative-path rejection, unknown-key warnings, patch merge, atomic update, recoverable broken file, app-data defaults |
| `at5_contract.rs` | persons/relationships/events/media reading, missing media reported and skipped, `.files` before extra folders, preview counts identical to import, dedupe by external id and FIO+dates |
| `at5_eav_contract.rs` | real EAV shape, document details, unknown/JULIAN/partial dates staying unknown, one warning per unmapped field, blob previews without `.files`, ignored baseline diagnostic |
| `exchange_contract.rs` | JSON and ZIP round trips, tampered entry fails checksum, missing checksum coverage rejected, zip-slip/absolute/drive-letter entries rejected, unsupported `formatVersion`, media metadata without bytes, deterministic JSON |
| `gedcom_contract.rs` | Cyrillic family round trip, year stays year and month stays month, ANSEL/Latin-1 decoding, unsupported encoding rejected instead of mojibake, custom tags warned, married-name handling, stable export→parse→export |
| `gedcom7_contract.rs` | GEDCOM 7.0 header detection, UTF-8-only writing, sources and citations, and 5.5.1/7.0 interoperability |
| `gedcom_details_contract.rs` | type-specific event details and structured addresses through a GEDCOM round trip |
| `export_contract.rs` | exchange archive layout, media naming and count-only loss warnings |
| `gedcom_bundle.rs` | full bundle parsing with media hashes and source resolution |
| `config_contract.rs` (map/geocoder/historical/event-field suites) | `map.basemap`/`tile_url`, Photon/DaData settings, Wikidata historical settings and `event_fields.custom` validation |

## Search contracts

| Suite | Protects |
| --- | --- |
| `index_contract.rs` | Russian stemming and inflection, Latin query through the English field, exact-name rank, 240-character plain snippets, locale-independent Cyrillic search, empty query, rebuild replaces documents, place-only matches |
| `prefix_contract.rs` | partial surname/notes/place matches, Latin prefixes, and short garbage not matching |
| `groups_contract.rs` | three always-present groups, counts/truncation, empty query, limit validation, character highlights, stale detection by hash and schema version, missing metadata |

## Chat and UI

`prompt_snapshot.rs` is a golden test of the assembled system prompt; `skills.rs` tests the deterministic router and catalog invariants; `chat/src/tests.rs` covers transport, streaming, cancellation and error mapping without a network.

UI suites cover pure logic rather than DOM: navigation, theme/style/contrast, dates, errors, view state, table columns, graph layout plus combined/forest/parents/root modes, path layout, timeline line/view/gender adapters, map grouping/projection/range/unresolved places, event anomalies, place points and event files, import/export/backup helpers, chat stream/format/links/confirm, and the kinship/plural i18n rules.

### Optional UI review harness

The WebdriverIO specs under `desktop/ui/e2e/specs` are review tooling, not assertions: `01-smoke.js` checks that the window and a section render, `02-shell-audit.js` records interactive controls, hit targets, contrast candidates, overflow, untranslated keys and focus order, `03-project-tour.js` visits the project sections with a synthetic project, `04-events-filters.js` exercises the shared filter header (person, relation scope, type, year) and the jump to the timeline, `05-occupation.js` checks the person-card occupation fact, `06-data-check.js` opens the data-check popup, and `07-event-card.js` opens the read-only event card. They need a desktop session, `tauri-driver` and `msedgedriver`, run only on Windows, and are never part of `make check`; see [Build, quality gates and release](../operations/build-test-release.md).

## Running checks

```powershell
make check                                  # fmt, clippy, Rust tests, UI typecheck/test/build/i18n
make test                                   # cargo test --workspace
cd desktop && cargo test -p gentree-storage # one crate
cd desktop && cargo test -p gentree-import --test at5_eav_contract
npm --prefix desktop/ui run test -- src/features/timeline/view.test.ts
```

The baseline diagnostic is opt-in and local-only:

```powershell
$env:GENTREE_AT5_BASELINE = "<local path>"
cd desktop; cargo test -p gentree-import --test at5_eav_contract -- --ignored --nocapture
```

It prints counts and distributions, never names, dates, places, paths or field values.

## Related pages

- [Build, quality gates and release](../operations/build-test-release.md)
- [Project merge: preview, decisions and apply](../architecture/project-merge.md)
- [People, events and validation](../domain/persons-and-events.md)
- [AT5 import pipeline](../import/at5.md)
