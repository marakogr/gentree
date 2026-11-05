# Proposal

## Why

A marriage event and a birth event currently store people but do not create kinship: a marriage with two participants leaves no `SPOUSE` row, and a birth never creates `PARENT_CHILD`. The archive therefore knows that two people appear in the same event but not how they are related. In the kinship view this surfaces as a wrong answer: without a spouse edge, the only route between two parents is through their shared child, so a user sees a co-parent described through the child instead of seeing a spouse.

Deriving relations from the events that already record them removes duplicate manual work and makes the kinship graph agree with the archive's own evidence. Issue #80 asks for this; issue #79 supplies the parent-age validation that derived parent edges must also honour.

## What Changes

- A saved `MARRIAGE` event with exactly two distinct participants creates one `SPOUSE` relation between them when no spouse/partner pair exists yet. The row is created inside the same project mutation as the event, not by a second user action.
- A `BIRTH` event lets the user choose zero, one or two parents. Saving creates `PARENT_CHILD` rows with the chosen person as parent and the event's owner as child.
- Derivation is idempotent: re-saving the same event, reopening it, or re-running the derivation produces no duplicate rows and no error. Existing manual rows win: derivation never overwrites, upgrades, re-types or deletes a user-created relation.
- Derivation validates the shared relation rules: no self-link, no duplicate pair, no parent cycle, and a parent at least 9 years older than the child when both dates are known (issue #79). A conflicting parent selection rejects the event save with a stable error; clearing the parents lets the same event save.
- Editing or deleting a life event retracts only relations that the application itself derived from that event. Manual relations are never cascade-deleted. The exact retraction rule and its storage consequence are recorded in `design.md`; the provenance field it may require is an open HITL decision.
- Spouse resolution uses `SPOUSE`/`PARTNER` rows only. A shared child never makes two people spouses: when a spouse row exists the kinship view shows husband/wife/partner, and when it does not the two people remain connected only through their child.
- The event form gains parent pickers for a birth and shows that a relation was created automatically; the person card shows the derived relation with its automatic origin and warns before a delete that the next save of the source event will recreate it.
- New UI copy is added in `ru`, `uk` and `en`; errors keep stable codes localized in the UI.
- Contract and regression tests cover creation, idempotency, manual-row precedence, edit/delete retraction, self-link, duplicate, cycle and parent-age rejection, and spouse-versus-co-parent display.

Out of scope: importing or backfilling relations for already stored events (a separate migration decision), deriving relations from any event type other than `MARRIAGE` and `BIRTH`, sibling edges (still derived, never stored), and changes to the project format beyond the provenance question below.

## Capabilities

### New Capabilities

- `relationships`: how life events create, keep and retract kinship rows; idempotency, manual-row precedence, validation and the error contract; and how spouse display resolves from `SPOUSE`/`PARTNER` rather than from a co-parent.

### Modified Capabilities

None. No accepted capability currently describes relations or kinship.

## Impact

- `desktop/crates/core`: relation construction and validation reuse (`Relationship`, `RelationshipSet`), a pure derivation function over events and existing rows, and the parent-age check shared with #79.
- `desktop/crates/storage`: one command mutation that validates both collections and writes events then relationships; `relationships.jsonl` gains provenance only if the HITL decision approves it.
- `desktop/apps/desktop`: `event_create`, `event_update` and `event_delete` invoke derivation and retraction; no new IPC command is required.
- `desktop/ui`: `EventForm` parent pickers for `BIRTH`, automatic-origin state on the person card, spouse/kinship display, API types, and `event`/`relationship`/`person` copy in `ru`, `uk`, `en`.
- Tests: core unit tests and storage/command-level regression tests; UI tests for the birth parent selection and spouse resolution.
- Not affected: search, import/re-import behaviour, media, adoptions, sibling edges, and the `.lock`/checksum rules. Export, merge and the read-only chat DTOs only gain the new origin fields, with no behavior change for manual rows.

HITL: this change alters the relation model and is requested by the user. `design.md` records the options, consequences and recommendation for relation provenance and retraction, and for the parent-age error code shared with #79. Adding an optional provenance field to `relationships.jsonl` would be a project-format change and needs explicit approval; the alternative that keeps the format unchanged is described there. `AGENTS.md` invariants are not changed by this proposal.
