---
type: workflow
title: AT5 import pipeline
description: How Gentree reads an AT5 SQLite database without modifying it, maps EAV or person-table shapes into core records, reports what it could not understand, and keeps re-imports idempotent.
tags: [import, at5, sqlite, idempotency, privacy]
sources:
  - id: openwiki-source-8899867ea99d5b26ce3aa8f8
    resource: repo://desktop/apps/desktop/src/commands/import.rs
  - id: openwiki-source-f35619aa85b2acc8cae9a133
    resource: repo://desktop/crates/import/src/at5.rs
  - id: openwiki-source-1e416c1f4d71f2fbc9621457
    resource: repo://desktop/crates/import/src/dedupe.rs
  - id: openwiki-source-cc1a4aa865c38022fae05951
    resource: repo://desktop/crates/import/src/report.rs
  - id: openwiki-source-2b838c869260844f02b9b8fe
    resource: repo://desktop/crates/import/tests/at5_eav_contract.rs
generated: { by: "opencode", at: "2026-10-24T14:34:58.929Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# AT5 import pipeline

AT5 is the project format of the Drevo Zhizni desktop genealogy program, a legacy application Gentree can import from. Its data lives in a SQLite file, sometimes with a sibling `.files` folder for media. The importer treats that file as an untrusted, read-only source: it opens it with `SQLITE_OPEN_READ_ONLY`, never writes, and maps only what it can prove.

## Read path

`read_at5_bundle(path)` is the single read path; everything else wraps it:

- `read_at5_bundle_with_media_dirs(path, dirs)` also searches extra media folders;
- `plan_at5` / `plan_at5_with_media_dirs` return only the `ImportReport` and create, modify or lock nothing — this is what the preview command calls;
- `read_at5` is a deprecated persons-only wrapper.

The result is an `At5Bundle` with `persons`, `relationships`, `events`, `media`, a parallel `media_files` list carrying each resolved source path or database blob, and the `ImportReport`.

## Two supported shapes

The importer does not assume a fixed schema. It lists tables and columns, then:

1. **Real EAV export** — detected by `Fields` + `ValuesStr` + a `Persons` table without name columns. The `at5::eav` module maps `ValuesStr`, `ValuesDates`, `EventDetails` and `Documents` into names, dates, events and media.
2. **Simplified person table** — any table with recognizable name/date columns. Column roles are resolved through alias lists (`ALIASES`, `RELATION_*_ALIASES`, `EVENT_*_ALIASES`, `MEDIA_*_ALIASES`), so localized or renamed columns still work.

A table the importer recognizes is not reported as unknown. Every other table and column becomes a warning in the report.

## Failure policy

Structural failures abort the import: a missing file, an unreadable database, no tables, or no person-like table. Errors carry the file name, never an absolute path.

<!-- openwiki: broken internal link [/openwiki/domain/dates.md] link "/openwiki/domain/dates.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Problems inside a row never abort: an unparsable date, an unnamed person, an unknown link target or a missing media file become `report.issues` entries, and the remaining rows are still imported. Dates go through `at5::parse_date`, which keeps the source text in `DateValue.original` and sets precision `UNKNOWN` when it cannot parse (see [Date values](/openwiki/domain/dates.md)).

## Relationships, events and media

- Relationships are detected from parent/child or pair tables, with explicit mapping to `PARENT_CHILD`, `ADOPTIVE_PARENT_CHILD`, `SPOUSE` or `PARTNER`. The result is validated by `RelationshipSet`, so a self-link, duplicate or parent cycle from the source is rejected rather than stored.
- Events map an owner, type, date, place, description and source references; unknown types keep `original_type`.
- Media rows are hashed with sha256. Bytes come from the `.files` folder next to the database or from a blob column; a referenced file is looked up by its sanitized base name in `.files`, then in the user-supplied media directories in order.

The `import_at5` command copies resolved media bytes into the new project with `store_media_file` / `store_media_bytes`, so the project owns its files. If a file changed between preview and import, the stored copy wins and an issue is added.

## New project, never a merge

The desktop import commands always create a brand-new project. They never open an existing project for writing and never modify the source file. On any failure after creation, the new folder is moved to `.trash`, so a half-written project never appears in the project list.

The chat-side `import_project` path materializes a project from the same bundle and records `MEDIA_NOT_IMPORTED` as a warning, because it does not copy media bytes.

## Idempotency

`dedupe_persons(existing, incoming)` is the idempotency helper shared by importers:

1. match by `(external source, external id)` — the AT5 importer stores `ExternalId { source: "AT5", value }`;
2. otherwise match by `(normalized display name, birth.start, death.start)`.

Matched people are removed from the `new` list and reported as `Conflict { incomingIndex, existingId, reason }`. A repeated import therefore never duplicates records, and the report never repeats names, dates or external id values. `At5Bundle.report.conflicts` is empty by design: conflicts only make sense against a target project.

## Privacy

All tests use synthetic fixtures. The one diagnostic against a real baseline is `#[ignore]`, requires `GENTREE_AT5_BASELINE`, and prints aggregate counts only — never names, places, paths or values. The report itself is designed to be loggable: counts, schema warnings, issue messages and stable reason codes.

## Related pages

<!-- openwiki: broken internal link [/openwiki/import/interchange.md] link "/openwiki/import/interchange.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [GEDCOM and AT5 export/interchange](/openwiki/import/interchange.md)
<!-- openwiki: broken internal link [/openwiki/domain/dates.md] link "/openwiki/domain/dates.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Date values, precision and qualifiers](/openwiki/domain/dates.md)
