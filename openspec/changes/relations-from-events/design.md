# Design

## Context

See `proposal.md` for motivation and `specs/relationships/spec.md` for the behavior contract.

Current state that shapes the approach:

- `Relationship` is a flat row: `id`, `type`, `person_id`, `related_person_id`, `notes`. There is no origin or source field, and there is no relationship update command; users create and delete rows.
- `RelationshipSet` already enforces no self-link, no duplicate type/pair, canonical spouse order and no parent cycle. `Relationship::new` and storage reload both validate rows.
- `Event` is one owner plus `participant_ids`. A marriage is owned by one spouse and lists the other. A birth has no participant UI today; import writes participants only for marriage.
- Kinship and path search use stored edges only (`parents_of`, `children_of`, `spouses_of`). A pair without a spouse row has no spouse edge, so any route goes through a shared child. The graph already pairs co-parents into one block only when a `SPOUSE`/`PARTNER` row exists.
- `event_create`, `event_update` and `event_delete` each mutate one collection through `ProjectStore`; each file write is atomic, but there is no cross-file transaction.
- `relationships.jsonl` is part of the project format. The optional provenance fields below were approved on 2026-11-05 as an additive change.

## Goals / Non-Goals

**Goals:**

- One recognizable, testable derivation function shared by event create/update and the project-open backfill.
- Safe reconciliation with manual rows and with legacy projects.
- A precise, localized error contract for rejected derivations.
- No ambiguity about which row is automatic, so event edits and deletes cannot destroy manual work.

**Non-Goals:**

- Repairing ambiguous event casts: a marriage with fewer or more than two people, or a birth with more than two participants, is left untouched by backfill.
- A general event-participant role model beyond marriage and birth.
- Storing sibling edges, changing adoption semantics, or changing person deletion.
- Reworking the graph or kinship algorithms; only the spouse-source rule and a regression test are added.

## Decisions

### D1. Relation provenance and retraction (approved: option A)

The reviewer approved option A on 2026-11-05, at the user's request; the approval and its consequences are recorded in PR #89.

`Relationship` gains two optional fields: `origin` (`MANUAL` or `EVENT`) and `sourceEventIds` (a list, empty for manual rows). Rows without the fields, and all rows created through `relationship_create`, load as `MANUAL`. Derived rows carry `origin = EVENT` and every event id that currently asserts the pair. The list, rather than a single id, is needed so that deleting one of two marriage events that assert the same pair does not remove the row.

- Edit or delete: remove this event id from `sourceEventIds`; delete the row only when `origin = EVENT` and the list becomes empty. A manual row is never retracted.
- Direct delete of an automatic row is accepted by the backend and only warned about in the UI; the next save of a source event recreates it.
- Merge keeps one row with the earliest id, unions `sourceEventIds`, and sets `origin = MANUAL` if either side is manual.
- The fields are additive and optional; older builds ignore them, and legacy projects load with all rows manual.

Alternatives considered: deterministic derived ids with no new field (implicit coupling, fragile under merge and restore) and never retracting (leaves wrong spouses and parents after edits). Both were rejected in the review.

### D2. Event fields carry the assertions; no new event format

- Marriage: owner plus exactly one distinct co-participant. Existing `backfill_marriage_participants` already treats the single spouse link as the co-participant, so it is compatible.
- Birth: `participant_ids` are the selected parents. This reserves birth co-participants for parents; witnesses are not modelled. The current UI never writes birth participants, and import writes participants only for marriage, so the practical conflict is limited to hand-edited or future data.
- Backfill: opening a writable project treats existing birth participants as parents and derives the missing rows (D9). No parent is invented for a birth without participants.

Alternative: a new `parent_ids` event field or typed participant roles. It is cleaner long term but adds a second project-format change, duplicates the participant concept, and is not needed for #80.

### D3. Desired-set reconciliation

Derivation is a pure function over `(event, persons, existing rows, birth dates)` that returns rows to create, rows to attach and row ids to retract.

1. Build the desired pairs: one canonical spouse pair for a marriage with two people, or up to two `(parent, child)` pairs for a birth.
2. For each desired pair, look for an existing parent-type or spouse-type row:
   - exact type and pair: satisfied; add this event id to `sourceEventIds` when the row is automatic and the id is absent;
   - compatible type (`PARTNER` for a spouse pair, `ADOPTIVE_PARENT_CHILD` for a parent pair): satisfied, no re-type; a manual row is never annotated;
   - none: create an `EVENT` row with this event id.
3. For an update, collect `EVENT` rows that contain this event id and are no longer desired: remove the id and delete the row only when no source event remains.
4. Never retract a row whose origin is manual or unknown.

This makes repeated saves and repeated opens idempotent, and makes manual precedence a property of the lookup, not a special case per event type.

### D4. Validation and error contract

Validation runs before any write and uses the same core checks as the relationship commands:

- self-link: `VALIDATION_ERROR`, `params.field = participantIds`, `params.rule = selfLink`; the event owner is never selectable.
- duplicate: not an error; the pair is already satisfied (D3).
- cycle: `RELATIONSHIP_CYCLE` with the two person ids.
- parent age: the canonical `PARENT_CHILD_AGE_GAP` from #79, `params.field = participantIds`, `params.years` with the smallest observed gap. Exactly 9 years passes; unknown or unknown-precision dates skip the check.

The age check consumes the date-precision boundaries defined by #79 (the start of a year/month range). The check must run for both derived and manual parent relations; otherwise the same edge could be created through two paths.

### D5. Write ordering and repair

Both collections are validated in memory first. The event is written first, then the relations, because a relation row is harmless without its event only if it is retracted later; an event without its relation is visible and repairable. On a relation-write failure the command returns `IO_ERROR`; the event remains, the derivation is incomplete, and re-saving the event completes it idempotently. The reverse order would leave relation rows for a nonexistent event if the event write failed, which is worse.

`ProjectStore` gains one helper that writes events and relationships in that order; it is not a cross-file transaction and must not claim to be one. Tests assert the two repair directions: a failed relation write then a successful re-save, and a rejected validation leaving both files unchanged.

### D6. Spouse resolution and co-parents

No new lookup is introduced. `spouses_of` already reads only spouse/partner rows, and the graph pairs co-parents only when `spousePairs` contains the pair. The change is:

- keep the rule explicit in the spec and in code comments;
- add a regression test where two people share a child, have no spouse row, and kinship must not return husband/wife/partner;
- add the mirrored test where the spouse row exists and the term is husband/wife even while the same shared child exists.

No fallback to the second parent is added anywhere. If a caller needs "the other parent", it must ask the parent collection, not the spouse collection.

### D7. UI shape

- `EventForm` for `BIRTH`: two optional parent pickers below the child field, using the existing combobox pattern; filter out the child and the other selection; show a small "will create a parent relation" note. Existing parent relations not present in the event appear as read-only hints so the user understands why the picker is empty.
- `PersonCard`: the family table marks an automatic row with a subtle badge and the source event type and date, or reports several sources; the row menu warns before deleting an automatic row. No new screen.
- Project open: when backfill created rows, a one-time notice reports aggregate counts; it is informational and dismissible, with no names or ids.
- `KinshipPanel`: unchanged rendering; it benefits from the correct edges. The spouse term still comes from `KinshipDescriptor`.
- The birth form never invents parents from a spouse relation; prefill comes only from the event's own participants.

### D8. Error and copy surface

`PARENT_CHILD_AGE_GAP` is added to `desktop/crates/core/src/error.rs` and to `common.json` `errors` in `ru`, `uk` and `en` (and the other locales currently shipped, to keep the dictionaries complete). New keys: parent role/placeholder, add/remove parent, automatic-origin badge, delete warning, age-gap message, and the backfill notice. All text stays in locale files.

### D9. Backfill on writable project open

Existing projects already contain marriages and births, so shipping derivation only for future saves would leave the reported symptom in place. The project-open path therefore runs one reconciliation pass:

1. Acquire the writable project store as today. If the project is opened read-only, skip the pass and report `read_only = true` without touching either collection.
2. Load persons, events and relationships once. For each `MARRIAGE` with exactly two distinct people and each `BIRTH` with one or two participants, run the same pure desired-set derivation from D3. Events with fewer or more than two people are counted as ambiguous and skipped.
3. Validate the complete resulting set before writing. If anything is invalid, skip that event and count it; never invent a parent, never repair an ambiguous cast.
4. If rows were created or annotated, write `relationships.jsonl` once through the atomic collection write. Events are not rewritten. A second open finds the rows satisfied and writes nothing.
5. Return `{ spouseCreated, parentCreated, ambiguousSkipped, readOnly }` to the UI. The UI shows a one-time notice with counts only; no ids, names, dates, places, event text or paths are logged or displayed.

Failure handling: because only one collection is written, a failed write leaves the project unchanged and the open fails with `IO_ERROR`; the next open retries the same idempotent pass.

## Risks / Trade-offs

- **Legacy birth participants become parents on the first writable open.** Mitigation: the form hint lists existing participants as parents, the backfill notice reports the count, and a release note explains the rule. A future typed-role model can separate witnesses.
- **Provenance adds a project-format field.** Approved as additive and optional; older builds ignore it and legacy rows read as manual. Export, merge and restore must preserve it.
- **Merge and export can duplicate or drop origin.** Mitigation: merge keeps the earliest id, unions `sourceEventIds`, and sets manual if either side is manual; round-trip tests cover both.
- **Two file writes are not atomic for a save.** Mitigation: validate first, event first, idempotent repair, and tests for interruption in both directions. Do not present the save as all-or-nothing.
- **Backfill writes during open.** Mitigation: one atomic relationship write, read-only skip, idempotent second open, aggregate-only reporting, and a failure that leaves the project unchanged.
- **A direct delete of an automatic row is undone by the next event save.** Approved as UI-warning-only; the source of truth is the event.
- **Age validation may reject plausible historical data.** Mitigation: apply only when both dates are known with usable precision, exactly 9 years passes, and clearing parents always allows the event to save.

## Migration Plan

1. Land #79's date boundaries and parent-age rule first, or land this change behind the same helper; do not implement two age checks.
2. Ship the provenance fields as optional. Projects without them load with all rows manual.
3. On the first writable open after upgrade, backfill missing spouse and parent rows once from existing events; skip read-only projects and ambiguous casts. No event row is rewritten.
4. Rollback: older builds ignore the new fields and treat the rows as ordinary relations. Automatic rows are not lost, but an older build will not retract them on event edit or delete until the new build runs again.
5. A project written by the new build still opens in the old build.

## Open Questions

- When to separate birth witnesses from birth parents with a typed participant role. This does not change the current spec and can be a later change.
