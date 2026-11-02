---
type: workflow
title: GEDCOM and AT5 export/interchange
description: The four exchange formats - AT5 and GEDCOM archives, media-free JSON and full project ZIP - how they are written atomically, which losses are reported, and which safety limits apply on import.
tags: [import, export, gedcom, at5, interchange]
sources:
  - id: openwiki-source-f148243fa8986f2d805e9238
    resource: repo://desktop/crates/import/src/at5_export.rs
  - id: openwiki-source-e0dd3814a02ddb89231baa9f
    resource: repo://desktop/crates/import/src/exchange.rs
  - id: openwiki-source-e3aedbf0b785c04cde356e1d
    resource: repo://desktop/crates/import/src/export.rs
  - id: openwiki-source-2660cdbbe1d4eab8ab6392b3
    resource: repo://desktop/crates/import/src/gedcom.rs
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# GEDCOM and AT5 export/interchange

A project is the source of truth; every exchange format is derived output. Gentree supports four:

| Format | Contains | Media |
| --- | --- | --- |
| `<stem>.zip` with `.at5` | Gentree-readable AT5 EAV subset | `<stem>.files/` sibling folder |
| `<stem>.zip` with `.ged` | GEDCOM 5.5.1 or 7.0 UTF-8 | `<stem>.files/` sibling folder |
| `.gentree.json` | all collections, media **metadata only** | none |
| `.gentree.zip` | full project in the documented backup layout | `media/**` + `checksums.sha256` |

## Archive export

`export_archive(project_dir, format, target)` opens the project **read-only**, writes the data file into a staging folder next to the target, copies available media into `<stem>.files`, zips the staging folder and moves the archive into place only after the ZIP is complete. A failed export never leaves a partial target.

Media handling is deliberately conservative: file names are kept, a numeric suffix is added only when two different files share one name, and missing files are skipped with a warning that reports only a count — never an absolute path or a file name. If the project has sources or citations, every archive export adds a warning that they are not included in this format.

## AT5 export

The AT5 writer produces a small EAV database that the read-only importer understands: `Persons`, `Events`, `EventTypes`, `EventDetails`, `ValuesStr`, `ValuesDates`, `Documents`, `DocumentDetails`, `Fields` and `Global`. It is explicitly a *Gentree exchange* subset, not a full AT5 database: the application has no verified writer for the remaining tables, indexes and triggers.

Relationships are encoded the way the importer derives them: a `BIRT` event lists the child and the parents, a `MARR` event lists both spouses. Anything the subset cannot represent becomes an `ExportReport` warning without repeating field values.

## GEDCOM

**Export** writes GEDCOM 5.5.1 UTF-8 with CRLF line endings by default, and GEDCOM 7.0 when explicitly requested, line by line rather than through the parser crate, because the format cannot represent every domain field and every loss has to surface as a warning: patronymics, relationship notes, adoptive parentage, extra event participants and relations to people outside the export. The 7.0 writer declares `GEDC.VERS 7.0.18`, omits `CHAR`/`GEDC.FORM`, never wraps lines, and also writes sources and citations; the 5.5.1 output keeps its historical shape. Dates are written only from real bounds — no invented day and no invented header date — so the same project always produces the same bytes. `export_full` allows an unnamed person and reports it; the legacy `export` refuses one.

**Import** detects the version from the header, delegates parsing to `ged_io` and maps `INDI`/`FAM` structures. A `7.x` declaration is treated as 7.0, a `5.5.x` declaration as 5.5.1, and a missing version falls back to 5.5.1:

- encoding comes from `HEAD.CHAR` (UTF-8, ANSEL, ASCII, ISO-8859); an unknown charset is an error instead of mojibake;
- `BIRT`/`DEAT` become `Person::birth`/`death` with the same `DateValue` rules as AT5;
- each `FAM` produces `SPOUSE` edges for the husband/wife pair and `PARENT_CHILD` edges for every parent/child pair;
- `INDI` events and `OCCU`/`EDUC`/`RESI` facts become `Event`s; `FAM` events attach to the first spouse and the lost participant is warned once;
- unknown tags keep their GEDCOM tag in `Event::original_type` and map to `EventType::Other` with one warning per tag;
- media `OBJE.FILE` paths are searched in `<file>.files` and `<stem>.files` next to the GEDCOM file, then in extra folders; absolute paths, drive letters, `..` and NUL are refused, entries are deduplicated by `(checksum, fileName)`, and missing files are reported and skipped.

### Event details and addresses

Type-specific `Event::details` round-trip through GEDCOM in two ways:

- keys with a standard tag are written as real child tags, so other applications still see them: `hospital`/`cemetery`/residence `address` as `ADDR`, `cause`/`reason` as `CAUS`, `officiant`/`court`/`employer` as `AGNC`, marriage `marriage_rite` as `TYPE`, and occupation `position` / education `qualification` as the fact's own value;
- everything left is serialized as one `NOTE` prefixed `[gentree:details]` with a JSON object payload. On import that note is parsed back into `details`, and the remaining note text becomes the description; an invalid payload is kept as plain description with a warning instead of being dropped.

Import fills the same keys from GEDCOM structures: a birth or burial `ADDR` becomes `hospital`/`cemetery`, a residence `ADDR` or `RESI` value becomes `address`, `CAUS`, `AGNC`, `TYPE` and occupation/education values map to their keys. Structured addresses are joined with `", "`, and every key/value is sanitized against the generic detail limits before it is stored, so an oversized or invalid GEDCOM value is reported and skipped rather than written. Address suggestions are a UI convenience only: the text the user accepts is stored like any other value, and a confirmed point is not exported by GEDCOM.

Errors carry the GEDCOM file name and line, never an absolute path.

## JSON and ZIP exchange

`.gentree.json` is the media-free document: metadata for every collection plus `formatVersion` and `exportedAt`. `exportedAt` is supplied by the caller instead of read from the clock, and the document carries no project id or name, so the same snapshot produces identical bytes.

`.gentree.zip` is simply the project in the backup layout, written by `ProjectStore::backup`; hashing and packing are not duplicated in the import crate.

Both importers validate everything before writing:

- `formatVersion` must be within the supported range;
- every person, event, source, citation and media row is validated;
- media file names must pass the storage path rules;
- the whole relationship list must pass `RelationshipSet`, so cycles, duplicates and self-links are refused.

Only then is a **new** project materialized. Import never merges into an existing project.

## ZIP safety limits

`inspect_archive` runs before extraction and enforces:

- at most 2 GiB uncompressed payload (also as a compression-ratio check, max 100×);
- at most 10 000 entries and a 2 MiB `checksums.sha256`;
- no zip-slip names, absolute paths or symlink entries;
- `manifest.json` and `checksums.sha256` must exist, and the checksum list must cover all six data files.

After that, `ProjectStore::restore` verifies every declared checksum and assigns a fresh project id, so a restored archive can never overwrite an existing project.

## Duplicate handling

`dedupe_persons` is the shared idempotency helper for merging incoming people into an existing set, matching `(source, externalId)` first and normalized name plus birth/death starts second. Archive imports create new projects, so they rely on validation rather than dedupe; the helper is used where an import is compared against an existing project. Details are in [AT5 import pipeline](at5.md).

## Related pages

- [AT5 import pipeline](at5.md)
- [People, events and validation](../domain/persons-and-events.md)
- [Project folder format and write discipline](../architecture/project-format.md)
- [Contract test map](../testing/contracts.md)
