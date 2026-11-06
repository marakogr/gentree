# Proposal

## Why

A marriage event and a birth event currently store people but do not create kinship: a marriage with two participants leaves no `SPOUSE` row, and a birth never creates `PARENT_CHILD`. The archive therefore knows that two people appear in the same event but not how they are related. In the kinship view this surfaces as a wrong answer: without a spouse edge, the only route between two parents is through their shared child, so a user sees a co-parent described through the child instead of seeing a spouse.

Deriving relations from the events that already record them removes duplicate manual work and makes the kinship graph agree with the archive's own evidence. Issue #80 asks for this; issue #79 supplies the parent-age validation that derived parent edges must also honour.

## What Changes

- A saved `MARRIAGE` event with exactly two distinct participants creates one `SPOUSE` relation between them when no spouse/partner pair exists yet. The row is created inside the same project mutation as the event, not by a second user action.
- A `BIRTH` event lets the user choose zero, one or two parents. Saving creates `PARENT_CHILD` rows with the chosen person as parent and the event's owner as child.
- On opening a writable project, the app backfills missing relations from existing `MARRIAGE` events (owner plus exactly one distinct participant) and from existing `BIRTH` events that already carry one or two participants. Backfill is an idempotent reconciliation with the same rules as a save, skips read-only projects, never overwrites or deletes manual rows, and reports only aggregate counts.
- Derivation is idempotent: re-saving the same event, reopening it, or re-running the derivation produces no duplicate rows and no error. Existing manual rows win: derivation never overwrites, upgrades, re-types or deletes a user-created relation.
- Derivation validates the shared relation rules: no self-link, no duplicate pair, no parent cycle, and a parent at least 11 years older than the child when both dates are known (issue #79). A conflicting parent selection rejects the event save with a stable error; clearing the parents lets the same event save.
- Editing or deleting a life event retracts only relations that the application itself derived from that event. Manual relations are never cascade-deleted. The approved storage consequence is recorded in `design.md` and the PR: optional provenance fields on the relation row.
- Spouse resolution uses `SPOUSE`/`PARTNER` rows only. A shared child never makes two people spouses: when a spouse row exists the kinship view shows husband/wife/partner, and when it does not the two people remain connected only through their child.
- The event form gains parent pickers for a birth and shows that a relation was created automatically; the person card shows the derived relation with its automatic origin and warns before a delete that the next save of the source event will recreate it.
- New UI copy is added in `ru`, `uk` and `en`; errors keep stable codes localized in the UI.
- Contract and regression tests cover creation, idempotency, manual-row precedence, edit/delete retraction, self-link, duplicate, cycle and parent-age rejection, and spouse-versus-co-parent display.

Out of scope: importing relations from external sources, deriving relations from any event type other than `MARRIAGE` and `BIRTH`, inventing parents for a birth without participants, repairing an ambiguous event cast, sibling edges (still derived, never stored), and changes to the project format beyond the provenance fields below.

## Capabilities

### New Capabilities

- `relationships`: how life events create, keep and retract kinship rows; idempotency, manual-row precedence, validation and the error contract; and how spouse display resolves from `SPOUSE`/`PARTNER` rather than from a co-parent.

### Modified Capabilities

None. No accepted capability currently describes relations or kinship.

## Impact

- `desktop/crates/core`: relation construction and validation reuse (`Relationship`, `RelationshipSet`), a pure derivation function over events and existing rows, and the parent-age check shared with #79.
- `desktop/crates/storage`: one command mutation that validates both collections and writes events then relationships; `relationships.jsonl` gains the approved optional provenance fields.
- `desktop/apps/desktop`: `event_create`, `event_update` and `event_delete` invoke derivation and retraction; opening a writable project runs the backfill and returns an aggregate count for the UI notice. No new IPC command is required.
- `desktop/ui`: a one-time backfill notice with aggregate counts, `EventForm` parent pickers for `BIRTH`, automatic-origin state on the person card, spouse/kinship display, API types, and `event`/`relationship`/`person` copy in `ru`, `uk`, `en`.
- Tests: core unit tests and storage/command-level regression tests, including writable versus read-only open, second-open no-op, and no personal data in the backfill report; UI tests for the birth parent selection and spouse resolution.
- Not affected: search, import/re-import behaviour, media, adoptions, sibling edges, and the `.lock`/checksum rules. Export, merge and the read-only chat DTOs only gain the new origin fields, with no behavior change for manual rows.

HITL: this change alters the relation model and is requested by the user. The reviewer approved D1 option A on 2026-11-05: additive, optional provenance fields (`origin` and source event ids) in `relationships.jsonl`, ignored by older builds; legacy rows load as manual. The same approval records that a direct delete of an automatic row is UI-warning-only with no backend block, and that merge keeps one row with the earliest id and unions provenance. Proposal, spec, design and tasks are updated accordingly; the approval and its consequences must also be recorded in PR #89 before implementation. `AGENTS.md` invariants are not changed by this proposal.
