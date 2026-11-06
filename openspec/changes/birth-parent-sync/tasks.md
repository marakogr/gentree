# Tasks

## 1. HITL and failing tests

- [x] 1.1 Record the user-requested relation change in the proposal, design and PR: card parity for automatic rows, biological parent reverse sync, provenance kept, no project-format change. Note that issue #101 owns the parent-age threshold.
- [x] 1.2 Add core tests for adding a father, a mother, an unknown-gender parent, a lone mother, fully occupied slots, idempotent add, earliest free birth among several, removal from every birth, and the event-save round trip. Verify they fail before the implementation.
- [x] 1.3 Add command tests for create/delete sync, adoptive exclusion, duplicate rejection, fully occupied slots, multiple births, and no recreation after delete. Verify synthetic data only and birth years comfortably above the age threshold.

## 2. Core reverse sync

- [x] 2.1 Add `add_parent_to_birth_events`: skip a parent already asserted by any birth event, sort birth events earliest-first with undated last, pick the first with a free slot, and place the parent in the role slot. Verify the slot tests.
- [x] 2.2 Add `remove_parent_from_birth_events`: remove the parent from every birth event of the child and leave an empty event valid. Verify the removal tests.
- [x] 2.3 Export both functions from the core crate. Verify no new dependency and no I/O.

## 3. Command integration

- [x] 3.1 Refactor `relationship_create` into a testable `create_relationship` that validates the future set before writing, mirrors only `PARENT_CHILD`, writes events first, then relationships, and returns the versioned row.
- [x] 3.2 Refactor `relationship_delete` into a testable `delete_relationship` that checks the version, removes a biological parent from the child's birth events, writes events first, then citations and relationships.
- [x] 3.3 Verify adoption is untouched, a duplicate create leaves both collections unchanged, and a delete cannot be recreated by the next event save.

## 4. Person card

- [x] 4.1 Remove the automatic-origin badge and the source-event label from `PersonCard`; keep `origin`/`sourceEventIds` in the API types.
- [x] 4.2 Remove the now-unused `person-relation-origin` and `person-relation-source` CSS rules.
- [x] 4.3 Remove the unused `automatic` and `automaticSeveralSources` keys from every shipped locale; keep the delete warning. Verify `npm --prefix desktop/ui run i18n:check`.

## 5. Verification

- [x] 5.1 Run the targeted core and desktop command tests.
- [x] 5.2 Run `make check` (or report the exact unavailable target) and `git diff --check`.
- [x] 5.3 Re-read the diff for privacy and scope: synthetic fixtures only, no real personal data, no absolute paths, no format or IPC change.
