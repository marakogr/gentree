# Design

## Context

See `proposal.md` for motivation and `specs/relationships/spec.md` for the behavior contract.

Current state that shapes the approach:

- `Relationship` stores optional `origin` (`MANUAL`/`EVENT`) and `sourceEventIds`. Event saves derive rows from `MARRIAGE` and `BIRTH` participants; relation commands write manual rows.
- `Event.participant_ids` is an untyped list. For a `BIRTH` event the list doubles as the selected parents, and the UI presents index 0 as "Father" and index 1 as "Mother". The list is compact: `Event::validate` rejects nil ids, so there are no placeholders.
- `relationship_create` and `relationship_delete` currently touch only `relationships.jsonl`. `event_update` already writes events first, then relationships, and treats the event as the source of truth for derivation.
- The person card is the only surface that exposes `origin` and `sourceEventIds`; chat DTOs keep the fields but do not label rows.

## Goals / Non-Goals

**Goals:**

- One shared, testable rule for mirroring a biological parent edge into a child's birth events.
- Both directions converge on the same state and preserve the existing derivation contract.
- Keep the project format and provenance intact.
- Make the card's family table honest about the kinship only.

**Non-Goals:**

- A typed participant-role model that separates parents from witnesses.
- Mirroring spouse/partner edges or adoption edges into events.
- Changing deletion, merge, import or the parent-age threshold.
- Recomputing historical data beyond the idempotent on-open backfill described below.

## Decisions

### D1. Provenance stays, presentation does not

`origin` and `sourceEventIds` remain in `relationships.jsonl` and in `relationship_list`/`person_get` because event edits still need to retract only their own automatic rows. The person card simply stops rendering the badge and the source label; ordering, labels and actions are identical for manual and automatic rows. The automatic-delete confirmation is kept: it is a destructive-action warning, not row decoration. No API or format change is needed.

Alternative: drop the fields entirely. Rejected because it would break retraction and the accepted provenance decision.

### D2. Birth participant slots

`participant_ids` is compact and ordered father-first. The mirroring rule is:

- If the parent already appears in any `BIRTH` event of the child, do nothing.
- Consider the child's birth events earliest-first by `date.start`; undated events sort last and ties break by id.
- Pick the first event with fewer than two participants.
- Insert the parent at the role position: male at 0, female at 1, unknown at the current length (first free). The position is clamped to the list length, so a male added after a lone mother is inserted before her, while a lone mother stays the only element. No nil placeholder is written because `Event::validate` rejects nil participants.
- If every birth event already has two participants, leave them untouched. The relation is still created.

Alternative: always append. Rejected because it would store a mother in the father slot after a lone mother. Alternative: write nil placeholders to preserve fixed indexes. Rejected because nil participants are invalid and would pollute export and validation.

### D3. Delete clears every birth event of the child

Deleting a biological parent relation removes that person from every `BIRTH` event owned by the child. Leaving another event unchanged would let the next save of that event re-derive the row the user just deleted. An event with zero participants remains valid; no relation and no event is invented.

### D4. Command integration and write ordering

`relationship_create` and `relationship_delete` become thin Tauri wrappers over `create_relationship`/`delete_relationship`, which take `&mut ProjectStore` and are unit-testable without Tauri state.

Create:

1. Validate persons, the age rule, and the complete future relationship set before any write (a duplicate or cycle leaves both collections untouched).
2. Load events; mirror only a `PARENT_CHILD` edge with `person_id` as parent and `related_person_id` as child.
3. Save events when they changed, then save relationships and return the new version.

Delete:

1. Check the expected relationship version.
2. Load the row and the events; for `PARENT_CHILD`, remove the parent from the child's birth events.
3. Save events when they changed, save citations, then save relationships.

Events go first in both directions because event participants are the derivation source: a failed relationship write after an event write is repaired by the next event save, while the opposite order could recreate a deleted row or leave a birth event pointing at a removed relation.

### D5. Idempotency and derivation

The mirror never calls `derive_event_relations`; it only edits participants. Event save still derives missing rows. When `relationship_create` stores a manual row and then the event is saved, derivation finds the matching manual row and leaves it alone. When `relationship_delete` removes the participant before the row, the next save has nothing to derive. Repeating either command is a no-op at the event level and is rejected by the relationship set for a duplicate create.

### D6. Tests

Core tests cover father/mother/unknown slots, a lone parent, fully occupied slots, idempotent add, earliest free birth among several, removal from every birth, and the event-save round trip. Command tests cover create and delete through a synthetic `ProjectStore`, adoptive exclusion, duplicate rejection before an event write, fully occupied slots, multiple births, and no recreation after delete. Parent and child birth years are at least 25 years apart so the tests do not depend on the threshold changed by issue #101.

### D7. One idempotent backfill on writable open

`commands/backfill.rs::backfill_on_open` runs after the legacy marriage repair on `project_open` and `project_restore_backup`:

1. **Life events.** A single pass indexes the owners of stored `BIRTH`/`DEATH` events, then creates the missing event for every person with a known date. This is the batch form of `sync_life_events(events, person, None)`: an owned event of that type suppresses creation even when its date differs, and a blank date creates nothing. Indexing once keeps a large import linear; the per-person helper would rescan the event list for every person.
2. **Relations.** The existing `backfill_relations_on_open` runs unchanged, so previously stored marriages and births still gain missing rows.
3. **Parents.** For every biological `PARENT_CHILD` relation, `add_parent_to_birth_events` adds the parent to the child's earliest birth event with a free slot. The relation rows may be manual or were just derived in step 2; a parent already listed is a no-op.

The steps write events at most twice and reuse the same core rule as `relationship_create`, so the migration and the commands cannot disagree. A read-only store returns early with `readOnly = true` and zero counts without writing. The report carries counts only. The second open sees the created events and participants, so all counts are zero.

Alternative: call `sync_life_events` per person. Rejected because it is O(persons × events) and would stall opening a large imported tree.

## Migration Plan

Opening a writable project backfills it once; no file format changes. Read-only projects are untouched. Rollback is safe: older builds ignore the created events and the new report fields, and the pass can be repeated after any failed write because it is idempotent.

## Risks / Trade-offs

- **Ambiguous sex data.** A birth with a same-sex pair still stores positions 0/1; the role label may not match. The card shows the relation label, not the slot, and the algorithm never drops a parent. A typed role model is a later change.
- **Two files are not a transaction.** A failed second write is possible. The chosen ordering makes the failure repairable by the next event save; the command still reports the write error and never claims atomicity.
- **Legacy lone mothers.** Historical data may store a lone mother at index 0. Adding a father inserts him at 0 and shifts her to 1, which is the intended role order but changes her array position; no data is lost.
- **Direct delete warning.** The existing automatic-delete warning remains; after this change a biological parent delete also clears the event, so the warning may overstate recreation. It is kept for spouse rows and is out of scope for #100.

## Open Questions

- Separating birth witnesses from parents with typed participant roles. This does not change the current spec.
