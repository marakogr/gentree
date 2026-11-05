# Design

## Context

See `proposal.md` for motivation and `specs/relationships/spec.md` for the behavior contract.

Current state that shapes the approach:

- `Relationship` is a flat row: `id`, `type`, `person_id`, `related_person_id`, `notes`. There is no origin or source field, and there is no relationship update command; users create and delete rows.
- `RelationshipSet` already enforces no self-link, no duplicate type/pair, canonical spouse order and no parent cycle. `Relationship::new` and storage reload both validate rows.
- `Event` is one owner plus `participant_ids`. A marriage is owned by one spouse and lists the other. A birth has no participant UI today; import writes participants only for marriage.
- Kinship and path search use stored edges only (`parents_of`, `children_of`, `spouses_of`). A pair without a spouse row has no spouse edge, so any route goes through a shared child. The graph already pairs co-parents into one block only when a `SPOUSE`/`PARTNER` row exists.
- `event_create`, `event_update` and `event_delete` each mutate one collection through `ProjectStore`; each file write is atomic, but there is no cross-file transaction.
- `relationships.jsonl` is part of the project format. Adding a field to it is a HITL change.

## Goals / Non-Goals

**Goals:**

- One recognizable, testable derivation function shared by event create/update and by later repair.
- Safe reconciliation with manual rows and with legacy projects.
- A precise, localized error contract for rejected derivations.
- No ambiguity about which row is automatic, so event edits and deletes cannot destroy manual work.

**Non-Goals:**

- Backfilling relations for events that already exist. That is a separate, explicit migration.
- A general event-participant role model beyond marriage and birth.
- Storing sibling edges, changing adoption semantics, or changing person deletion.
- Reworking the graph or kinship algorithms; only the spouse-source rule and a regression test are added.

## Decisions

### D1. Relation provenance and retraction (HITL, requires approval)

The spec requires automatic rows to be identifiable and retractable without touching manual rows. The options:

**A. Add provenance to the relation row (recommended).** `Relationship` gains an optional `origin` (`MANUAL` or `EVENT`) and an optional `sourceEventId`. Rows without the field, and all rows created through `relationship_create`, are `MANUAL`. Derived rows are written with `origin = EVENT` and the event id. An event edit deletes only rows with `origin = EVENT` and that event id, then writes the new set. A direct relationship delete still works; the next save of the source event recreates the row, which the UI warns about.

- Consequences: one additive field pair in `relationships.jsonl`; older builds reading a newer project ignore unknown fields, and newer builds treat missing fields as manual. Export, merge and import must preserve the field; merge conflict handling for two automatic rows of the same pair needs a rule (keep the older row id, union origins).
- Cost: project-format change, so this is the open HITL decision. Approval must be recorded in the PR before implementation.

**B. Deterministic derived ids, no new field.** A derived row's id is a deterministic UUID derived from the event id and the person pair; a manual row keeps a random id. Retraction recomputes the ids for the old event snapshot and deletes only those. `origin` is computed by recomputing the event's id set when rows are listed.

- Consequences: no format change, but the relation id silently encodes its source. Merge, restore and manual edits can break the identity; listing needs the event collection; the rule is hard to explain and to test against legacy data.
- Rejected as the primary option because the coupling is implicit and fragile.

**C. Never retract; keep every derived row.** Event edits and deletes leave relations behind; the user deletes stale rows manually.

- Consequences: no format change and the smallest change, but changing a marriage partner leaves a wrong spouse, and deleting a birth leaves parent edges. It contradicts the spec requirement that an edit retracts what the event no longer asserts.
- Only acceptable as a temporary fallback if A is rejected and B is not wanted; then the spec must be amended before implementation.

**Recommendation: A**, with legacy rows treated as manual. If the answer is "no format change", stop and amend the spec to option C or approve B explicitly.

### D2. Event fields carry the assertions; no new event format

- Marriage: owner plus exactly one distinct co-participant. Existing `backfill_marriage_participants` already treats the single spouse link as the co-participant, so it is compatible.
- Birth: `participant_ids` are the selected parents. This reserves birth co-participants for parents; witnesses are not modelled. The current UI never writes birth participants, and import writes participants only for marriage, so the practical conflict is limited to hand-edited or future data.
- No backfill: opening a legacy birth with participants does not create rows until the user saves it. When it is saved, those participants become parents, which is the explicit cost of reusing the field.

Alternative: a new `parent_ids` event field or typed participant roles. It is cleaner long term but adds a second project-format change, duplicates the participant concept, and is not needed for #80.

### D3. Desired-set reconciliation

Derivation is a pure function over `(event, persons, existing rows, birth dates)` that returns rows to create and row ids to retract.

1. Build the desired pairs: one canonical spouse pair for a marriage with two people, or up to two `(parent, child)` pairs for a birth.
2. For each desired pair, look for an existing parent-type or spouse-type row:
   - exact type and pair: satisfied, no write;
   - compatible type (`PARTNER` for a spouse pair, `ADOPTIVE_PARENT_CHILD` for a parent pair): satisfied, no write, never re-type;
   - none: create.
3. For an update, collect rows with `origin = EVENT` and `sourceEventId = this event` that are not in the desired set and delete them after the validation of the new set succeeds.
4. Never retract a row whose origin is manual or unknown.

This makes repeated saves idempotent and makes manual precedence a property of the lookup, not a special case per event type.

### D4. Validation and error contract

Validation runs before any write and uses the same core checks as the relationship commands:

- self-link: `VALIDATION_ERROR`, `params.field = participantIds`, `params.rule = selfLink`; the event owner is never selectable.
- duplicate: not an error; the pair is already satisfied (D3).
- cycle: `RELATIONSHIP_CYCLE` with the two person ids.
- parent age: new stable `PARENT_AGE_GAP`, `params.field = participantIds`, `params.years` with the smallest observed gap. Exactly 9 years passes; unknown or unknown-precision dates skip the check.

The age check consumes the date-precision boundaries defined by #79 (the start of a year/month range). If #79 lands with a different code, reuse its code and update this spec's error name in one place. The check must run for both derived and manual parent relations; otherwise the same edge could be created through two paths.

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
- `PersonCard`: the family table marks an automatic row with a subtle badge and the source event type and date; the row menu warns before deleting an automatic row. No new screen.
- `KinshipPanel`: unchanged rendering; it benefits from the correct edges. The spouse term still comes from `KinshipDescriptor`.
- The birth form never invents parents from a spouse relation; prefill comes only from the event's own participants.

### D8. Error and copy surface

`PARENT_AGE_GAP` is added to `desktop/crates/core/src/error.rs` and to `common.json` `errors` in `ru`, `uk` and `en` (and the other locales currently shipped, to keep the dictionaries complete). New keys: parent role/placeholder, add/remove parent, automatic-origin badge, delete warning, age-gap message. All text stays in locale files.

## Risks / Trade-offs

- **Legacy birth participants become parents on the next save.** Mitigation: no backfill, a form hint listing existing participants as parents, and a release note. A future typed-role model can separate witnesses.
- **Provenance adds a project-format field.** Mitigation: optional field, older builds ignore it, legacy rows read as manual; explicit HITL approval before implementation.
- **Merge and export can duplicate or drop origin.** Mitigation: add merge/export round-trip tasks; automatic rows of the same pair merge into one manual-safe row and never delete a manual row.
- **Two file writes are not atomic.** Mitigation: validate first, event first, idempotent repair, and tests for interruption in both directions. Do not present the save as all-or-nothing.
- **A direct delete of an automatic row is undone by the next event save.** Mitigation: UI warning and a stable explanation; the source of truth is the event.
- **Age validation may reject plausible historical data.** Mitigation: apply only when both dates are known with usable precision, exactly 9 years passes, and clearing parents always allows the event to save.

## Migration Plan

1. Land #79's date boundaries and parent-age rule first, or land this change behind the same helper; do not implement two age checks.
2. Ship the provenance field as optional. Existing projects load unchanged; no rewrite on open.
3. Do not backfill events. Provide a separate, explicit opt-in later if users want existing events materialized.
4. Rollback: older builds ignore the new fields; automatic rows remain ordinary rows, so no data is lost. A project written by the new build still opens in the old build.

## Open Questions

- HITL approval of D1 option A (project-format field) versus option C (no retraction). This changes the spec, so it must be resolved before implementation.
- Whether `PARENT_AGE_GAP` is introduced here or taken from #79. If #79 chooses another code, reuse it and rename only the spec reference.
- Whether a direct delete of an automatic relation should be blocked in the backend rather than only warned in the UI.
- Whether merge treats two automatic rows for the same pair as one row with the earliest id, or reports a conflict. The safer default is one row with the earliest id; confirm during implementation.
