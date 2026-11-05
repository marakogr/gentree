# Tasks

## 1. HITL record and failing tests

- [ ] 1.1 Record the approved D1 option A (2026-11-05) in the PR and a `hitl` issue: additive optional provenance fields, legacy rows manual, direct delete warn-only, merge earliest id with unioned sources. Verify the record names the project-format consequence and the approver.
- [ ] 1.2 Add core unit tests for the desired-set derivation with synthetic people: marriage pair, birth with one and two parents, no participants, ambiguous casts, existing `PARTNER`, existing `ADOPTIVE_PARENT_CHILD`. Verify the tests fail for the missing behavior and encode D3.
- [ ] 1.3 Add core unit tests for self-link, duplicate idempotency, parent cycle and the 9-year boundary (8 years 364 days rejects, exactly 9 years passes, unknown date skips). Verify each test asserts `PARENT_CHILD_AGE_GAP` and its `params`.

## 2. Core relation model and derivation

- [ ] 2.1 Add the optional `origin` and `sourceEventIds` fields to `Relationship` with serde defaults so legacy rows read as manual; reject a derived row without a source event. Verify round-trip unit tests keep old JSON byte-compatible and new JSON camelCase fields stable.
- [ ] 2.2 Implement one pure derivation function over event, persons, existing rows and birth dates that returns rows to create, rows to annotate and row ids to retract, following D3. Verify tests cover every branch from 1.2 and that the function performs no I/O.
- [ ] 2.3 Implement the parent-age check against #79 date boundaries, or call the shared helper when it lands; accept exactly 9 years and skip unknown dates. Verify tests cover year, month and exact-date precision plus unknown precision.
- [ ] 2.4 Add `PARENT_CHILD_AGE_GAP` to the core error codes and document its params in the code comment. Verify the new code is exported and existing error tests still pass.
- [ ] 2.5 Add the spouse-versus-co-parent regression tests: shared child without a spouse row yields no husband/wife/partner; a spouse row plus shared child yields the spouse term and a spouse edge. Verify both directions.

## 3. Storage and project format

- [ ] 3.1 Persist the approved optional provenance fields in `relationships.jsonl`; verify a project written before the change loads with all rows manual and a project with derived rows round-trips.
- [ ] 3.2 Add the storage helper that validates both collections and writes events first, then relationships, per D5. Verify a simulated relation-write failure leaves the event readable and a second save repairs it without duplicates.
- [ ] 3.3 Update merge and export/import round-trips: keep the earliest row id, union `sourceEventIds`, set manual when either side is manual. Verify round-trip and merge tests never drop or duplicate a manual row.
- [ ] 3.4 Add a storage regression test that a failed validation writes neither collection, and that a person deletion still removes relations and detaches shared events without re-deriving anything.

## 4. Commands and IPC

- [ ] 4.1 Invoke derivation in `event_create` and `event_update` and retraction in `event_update` and `event_delete` inside the same command mutation. Verify command tests cover marriage create, birth create, edit partner/parent, delete event, and manual-row survival.
- [ ] 4.2 Map derivation failures to the stable error contract from D4 without leaking ids in messages, and keep `expectedVersion` behavior unchanged. Verify a stale-version save changes no relation and returns `STALE_WRITE`.
- [ ] 4.3 Expose relation origin and source events in `relationship_list`, `person_get` and the read-only chat DTOs without exposing event text. Verify command and chat-tool snapshot tests show the new fields.
- [ ] 4.4 Implement direct deletion of an automatic row as warn-only: the backend accepts the delete and the next event save recreates the row. Verify a command test covers the delete and the recreation, and that a manual row is unaffected.

## 5. Backfill on writable project open

- [ ] 5.1 Run one backfill pass after the writable project store is acquired and before the project is reported open: marriages with exactly two distinct people and births with one or two participants, using the same derivation as a save. Verify an existing marriage gains a spouse row on open and an existing birth with participants gains parent rows.
- [ ] 5.2 Skip events with fewer or more than two distinct people, births without participants, and births with more than two participants; never invent a parent. Verify the skipped events keep their stored participants and produce no relation.
- [ ] 5.3 Make the pass idempotent: a second open adds, changes and deletes nothing, and manual rows keep their id, type and notes. Verify the second-open test and a manual-row fixture.
- [ ] 5.4 Skip read-only projects without acquiring a write lock or writing either collection. Verify the event and relationship files are byte-identical after opening read-only.
- [ ] 5.5 Return an aggregate report (`spouseCreated`, `parentCreated`, `ambiguousSkipped`, `readOnly`) from the open path. Verify the DTO and logs contain no person ids, names, dates, places, event text or paths.
- [ ] 5.6 Handle a failed relationship write during backfill: leave the project unchanged, return `IO_ERROR`, and succeed once on the next open. Verify with a simulated write failure.

## 6. UI

- [ ] 6.1 Add two optional parent pickers to the `BIRTH` event form, excluding the child and the other selection, and preserve the existing two-spouse form for `MARRIAGE`/`DIVORCE`. Verify component tests cover selection, clearing and save payload.
- [ ] 6.2 Prefill the pickers from the event's own participants and show other existing parent relations as read-only hints. Verify a reopened birth event shows the same selection and saving does not change manual rows.
- [ ] 6.3 Mark automatic rows in the person card with origin and source event or several sources, and add the delete warning. Verify component tests cover the badge, the source summary and the warning path.
- [ ] 6.4 Show the backfill notice after an open that created rows, with aggregate counts only, dismissible and localized. Verify the notice renders for each locale and contains no names or ids.
- [ ] 6.5 Verify kinship and graph rendering for the shared-child cases with no spouse row and with one. Verify no spouse line or spouse term appears for co-parents only.

## 7. Localization and docs

- [ ] 7.1 Add the new `event` and `relationship` keys in `ru`, `uk` and `en`, plus `PARENT_CHILD_AGE_GAP` in `common` `errors` and the backfill notice; update the other shipped locales to keep dictionaries complete. Verify `npm --prefix desktop/ui run i18n:check` passes and `make i18n` finds no Cyrillic outside locales.
- [ ] 7.2 Document in `desktop/docs` how event-derived relations, the on-open backfill, manual precedence, retraction, merge provenance and the birth participant rule work. Verify the documented behavior matches the spec scenarios.

## 8. Integration verification

- [ ] 8.1 Run the targeted Rust tests for core, storage and commands, then `make check`. Verify the full gate is green and report any unrelated failure separately.
- [ ] 8.2 Re-read the diff for privacy: no real personal data, no absolute local paths, no secrets, synthetic fixtures only. Verify `git diff --check` passes.
- [ ] 8.3 Walk the acceptance criteria of #80 against automated tests and record the mapping in the PR. Verify every checkbox has a named test or a manual step.

## Workflow follow-up

- Archive the change after approval and merge.
- Close #80 with the merge, and keep #79 linked for the shared age rule.
