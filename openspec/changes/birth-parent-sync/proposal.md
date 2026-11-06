# Proposal

## Why

A relation derived from a life event is currently marked in the person card with an "Automatic" badge and a source-event label. The user wants automatic relations to look exactly like manual ones: the archive should present the kinship it knows, not how the row was produced. Provenance (`origin`, `sourceEventIds`) stays in the stored data so event edits can still retract their own rows, but the card must not expose it.

The reverse direction is also missing. Creating a biological parent relation by hand leaves the child's birth event unchanged, and deleting the relation leaves the parent in `participant_ids`. The two representations of the same fact drift apart, and a later event save can re-derive a relation the user just deleted.

Issue #100 asks for both changes. This is a relation-model change requested by the user, recorded as a HITL decision (see the last section). It does not change the project format.

## What Changes

- The person card renders every relation row the same way. The "Automatic" badge and the source-event type/date label are removed; the automatic-delete confirmation stays. `origin` and `sourceEventIds` remain stored and are still returned by the API.
- Creating a biological `PARENT_CHILD` relation through `relationship_create` adds the parent to the child's `BIRTH` event `participant_ids` when the parent is not already listed. Role slots are positional: father at index 0, mother at index 1, unknown gender in the first free slot. A birth whose two slots are occupied by other people is left untouched and the relation is still stored.
- Deleting a biological `PARENT_CHILD` relation removes that parent from the child's `BIRTH` events. A birth event with no parents stays valid.
- Only `PARENT_CHILD` is mirrored. `ADOPTIVE_PARENT_CHILD` never touches a birth event, and no spouse or partner edge is affected.
- When a child has several `BIRTH` events, the earliest dated one with a free parent slot is updated; undated events sort last, ties break by id. A parent already asserted by any birth event of that child makes the sync a no-op.
- The reverse sync is idempotent: it creates no second relation, never re-adds a parent after the relation is deleted, and event save still derives missing relations from participants without duplicating existing manual rows.
- Localized copy for the removed labels is removed from every shipped locale; no new user-facing string is required.

Out of scope: the parent-age threshold (issue #101 changes it to 11 years separately), adoption semantics, person deletion/merge behavior, marriage/spouse reverse sync, a typed participant-role model, and any change to the project format or the stored provenance fields.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None accepted yet. The delta adds requirements to `relationships`: automatic rows are no longer visually distinguished, and the biological parent relation and the child's birth event are kept in sync in both directions.

`relationships` is introduced by the active `relations-from-events` change, so the accepted spec does not exist yet and OpenSpec allows only added requirements here. The added "Automatic relations are presented like manual relations" requirement supersedes the badge/label part of that change's "Derived relations are identifiable" requirement; the provenance and retraction parts stay in force. When `relations-from-events` is archived, its presentation requirement should be dropped in favour of this one.

## Impact

- `desktop/crates/core`: two pure functions in `relation_derivation.rs` that add/remove a birth participant, with unit tests for slots, multiple births, idempotency and event-save interaction.
- `desktop/apps/desktop`: `relationship_create` and `relationship_delete` delegate to testable helpers that update the relation and the child's birth events in one command; command tests use a synthetic project store.
- `desktop/ui`: `PersonCard` drops the badge and source label; `persons.css` drops their classes; `ru`, `uk`, `en`, `be`, `de`, `es` relationship dictionaries drop the now-unused keys.
- Storage format, checksums, IPC surface, search, import and media are unchanged. No new tool is exposed to the chat model.

## HITL

This changes relation behavior, which `AGENTS.md` reserves for a human decision. The user requested it directly in issue #100 on 2026-11-06 and asked for it to be implemented in this change; the approval covers:

- automatic relations look manual in the card while provenance stays stored;
- reverse sync of biological parent relations into birth events, in both directions;
- no project-format change, so `origin` and `sourceEventIds` remain additive and optional.

The parent-age change is explicitly not part of this approval and is handled by issue #101.
