---
type: architecture
title: "Project merge: preview, decisions and apply"
description: How two projects are merged into a new one - deterministic person and event matching, confidence and warnings, per-pair decisions and field policies, id remapping, media and citation handling, and why the sources stay untouched.
tags: [merge, matching, project-format, migration, privacy]
sources:
  - id: openwiki-source-72e9b1afd93e83913dec856a
    resource: repo://desktop/crates/core/src/merge.rs
  - id: openwiki-source-652b594f0a99d5c5858f82f4
    resource: repo://desktop/crates/core/src/validation.rs
  - id: openwiki-source-5b563cafb6e8e6e2f970414f
    resource: repo://desktop/ui/src/features/projects/merge.ts
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# Project merge: preview, decisions and apply

A merge combines two existing projects into a **third, new project**. It exists because a family archive grows in halves: spouses keep separate projects, a researcher keeps one file per branch, or the same people were entered twice. Import is not a merge - every import writes fresh UUIDs and keeps no identity map - so identity has to be resolved explicitly, with the user reviewing each suggestion.

The work is split into a pure core (`desktop/crates/core/src/merge.rs`) and a thin Tauri command (`desktop/apps/desktop/src/commands/merge.rs`) that turns the core output into a new project folder.

## Entry points

| Layer | Function | Writes |
| --- | --- | --- |
| core | `merge_preview(left, right) -> MergePreview` | nothing |
| core | `apply_merge(left, right, decisions) -> MergeOutput` | nothing |
| desktop | `merge_preview` command | nothing |
| desktop | `merge_apply_into` / `merge_apply` command | a new project folder |
| UI | `ProjectMergeDialog` + `features/projects/merge.ts` | nothing until the final click |

Both sides are `ProjectSnapshot` values: borrowed slices of persons, events, relationships, sources, citations and media. The core never reads files, so preview and apply are deterministic functions of their inputs.

## Matching people

`merge_preview` scores **every left person against every right person** and then assigns pairs one-to-one. A suggestion is made only when the pair has evidence:

- **same UUID** - the same row, always a match (score 100), even if a gender differs (which is reported as a warning);
- **scoped external id** - a shared `(source, value)` is strong evidence but never treated as a global id; AT5/GEDCOM identifiers stay local to their source;
- **names** - normalized (trim, collapse whitespace, lowercase, `ё -> е`) and compared across every name variant of both people;
- **dates** - birth and death are compared as `DateValue` intervals, never by `start` alone.

Names are compared as **token sequences**, not as three fixed fields: the `given` and `patronymic` tokens are concatenated, so a project that stores `given = "Мария Петровна"` with an empty patronymic still matches another that stores `given = "Мария"` and `patronymic = "Петровна"`. A surname mismatch (including one side having none) prevents a full-name match. For the weaker "same name parts" evidence the first given token is used, so a differing patronymic becomes a partial match rather than no evidence.

Hard rejections happen before scoring:

- a known `MALE`/`FEMALE` conflict;
- a birth or death year known on both sides and more than one year apart (`DATE_CONFLICT`).

Scores and confidence:

| Evidence | Score |
| --- | --- |
| shared external id | 100 |
| full name + compatible birth | 80 |
| full name, unknown dates | 50 |
| same surname + given, another name part differs, compatible birth | 60 |
| same name parts, unknown dates | 40 |
| shared relative already matched (bonus) | +10 |

`confidence_for` maps 80+ to `High`, 60+ to `Medium`, everything else to `Ambiguous`. Assignment is greedy by score with a deterministic tie-break; when an unassigned candidate with the same endpoint scores within `AMBIGUITY_DELTA` (10) of the chosen pair, the suggestion becomes `Ambiguous` and an `AMBIGUOUS_CANDIDATES` warning is emitted instead of silently picking one person.

`unmatched_right` lists right people with no suggestion. They are not dropped: `apply_merge` copies them as new people.

Duplicates that already exist **inside one source project** are not detected here - matching is cross-project only, so such rows are copied as-is. Cleaning them is a separate person-merge problem, not this pipeline.

## Matching events

Events are matched only inside an accepted person pair. Two events are candidates when they have the same type, a non-conflicting date, and no conflicting place or description. Scores are exact 100, compatible date 60, unknown date 40, with a +10 bonus for the same place. Events are assigned one-to-one with the same ambiguity rule, and each suggestion carries field differences for `date`, `place`, `description` and every `details.<key>`.

Participant ids are deliberately excluded from exactness, because cross-project person ids are not comparable before the person map exists; apply unions them afterwards.

## Decisions

The preview is a suggestion list; nothing is applied without a decision. For each person pair the user chooses `Merge` or `KeepBoth`, a base card (`Left` by default), and optional per-field policies:

- names and external ids are always unioned - the base primary name wins, the other side is kept as a variant;
- empty scalar fields are filled from the other side;
- conflicting non-empty birth/death dates require an explicit `Left`/`Right` policy, otherwise apply fails with `MERGE_CONFLICT` (`birthConflict` / `deathConflict`);
- notes default to `Both` only when both sides have text; otherwise the base side wins.

The same model applies to events (date, place, description, each detail key), but **event decisions exist only under a person pair whose action is `Merge`** - folding a right person's events into a left person that stays separate would silently move them.

The UI is deliberately conservative: `defaultPersonChoice` and `defaultEventChoice` pre-select `Merge` only for `High` confidence and `KeepBoth` for everything else. A `KeepBoth` person keeps its own events, and that is recorded as `PERSON_KEPT_BOTH` in the report.

## Apply

`apply_merge` keeps **every left row** and processes right rows:

1. **People** - a `Merge` decision folds the right person into the left id via `merge_person_fields`; any other decision copies the right person with a new id. `person_map` records where each right id went.
2. **Sources** - copied unless an equal source key already exists, in which case the right id maps to the existing left source.
3. **Events** - confirmed pairs merge into the left event; the rest are copied with the owner and participants remapped through `person_map`. A confirmed place point follows the chosen `place` policy, so it is never attached to text from the other side.
4. **Relationships** - endpoints are remapped, spouse order canonicalized, identical pairs deduped. A different type on the same pair keeps the left edge and reports `RELATIONSHIP_CONFLICT`; an edge that collapses to a self-link is dropped with `RELATIONSHIP_COLLAPSED`. The rebuilt `RelationshipSet` rejects cycles (`RELATIONSHIP_CYCLE`).
5. **Media** - links remapped; rows dedupe only on identical metadata, and a dropped person/source becomes `REFERENCE_DROPPED` rather than a dangling link.
6. **Citations** - copied last, with source and target remapped; anything that would dangle is skipped with a `CITATION_TARGET_DROPPED` warning.

Ids are never reused by accident: `claim_id` keeps an input id when it is still free, otherwise it derives a deterministic UUID v8 from the row kind and id, so the same snapshots and decisions always produce the same output rows.

The merged snapshot is validated with `validate_project`. **Errors block the merge**; warnings do not, so a merged project may legitimately contain duplicate birth/death events inherited from its sources (those are warnings in validation, and the write commands' `LIFE_EVENT_ALREADY_EXISTS` guard does not run during merge).

## Writing the new project

The command layer opens both sources read-only, calls `apply_merge`, creates a new project folder and writes persons, sources, events, media, relationships and citations in that order, copying media bytes before their rows. Any validation error or write failure moves the half-written folder to `.trash`; the sources are never modified. See [Project folder format and write discipline](project-format.md) for the folder and manifest rules.

The project name is the one typed in the dialog; a blank name falls back to `"<left name> + <right name>"`. Merging a project with itself is rejected before anything is opened.

## Report, warnings and limits

The preview carries `counts` (input people/events, matched people/events, ambiguous people) and a list of stable-coded warnings. Apply returns a `MergeReport` with `mergedPeople`, `keptBothPeople`, `unmatchedRightPeople`, `mergedEvents`, `keptBothEvents` and the accumulated warnings. Codes are localized by the UI; values appear only in the local dialog.

Out of scope for the MVP: in-place merge into an existing project, manual pairing of people the matcher did not suggest, repeated-merge idempotency, archive (`.at5`/`.ged`) merge, and persisted provenance (`mergedFrom`, per-field origins) - the report is returned to the caller but not stored in the project. Privacy is local-only: no names, dates, places or media leave the machine, and reports use counts and codes.

## Related pages

- [Project folder format and write discipline](project-format.md) for the destination folder and manifest.
- [People, events and validation](../domain/persons-and-events.md) for the records being merged and the duplicate-life-event rule.
- [Relationships, graph invariants and kinship](../domain/relationships-and-kinship.md) for edge invariants preserved by the merge.
- [Tauri shell, IPC commands and app state](../desktop/ipc-and-state.md) for the command surface.
- [Contract test map](../testing/contracts.md) for the merge contract suite.
