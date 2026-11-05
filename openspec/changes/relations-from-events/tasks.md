# Tasks

## 1. HITL gate and failing tests

- [ ] 1.1 Record the D1 decision in a `hitl` issue and in the PR: provenance field versus no-retraction. Verify the decision names the chosen option and the project-format consequence; if option C is chosen, amend `specs/relationships/spec.md` before any code task.
- [ ] 1.2 Add core unit tests for the desired-set derivation with synthetic people: marriage pair, birth with one and two parents, no participants, three participants, existing `PARTNER`, existing `ADOPTIVE_PARENT_CHILD`. Verify the tests fail for the missing behavior and encode D3.
- [ ] 1.3 Add core unit tests for self-link, duplicate idempotency, parent cycle and the 9-year boundary (8 years 364 days rejects, exactly 9 years passes, unknown date skips). Verify each test asserts the stable code and `params`.

## 2. Core relation model and derivation

- [ ] 2.1 Add the origin and source-event fields to `Relationship` with serde defaults so legacy rows read as manual; reject a derived row without a source event. Verify round-trip unit tests keep old JSON byte-compatible and new JSON camelCase fields stable.
- [ ] 2.2 Implement one pure derivation function over event, persons, existing rows and birth dates that returns rows to create and row ids to retract, following D3. Verify tests cover every branch from 1.2 and that the function performs no I/O.
- [ ] 2.3 Implement the parent-age check against #79 date boundaries, or call the shared helper when it lands; accept exactly 9 years and skip unknown dates. Verify tests cover year, month and exact-date precision plus unknown precision.
- [ ] 2.4 Add `PARENT_AGE_GAP` to the core error codes and document its params in the code comment. Verify the new code is exported and existing error tests still pass.
- [ ] 2.5 Add the spouse-versus-co-parent regression tests: shared child without a spouse row yields no husband/wife/partner; a spouse row plus shared child yields the spouse term and a spouse edge. Verify both directions.

## 3. Storage and project format

- [ ] 3.1 If D1 option A is approved, persist the new optional fields in `relationships.jsonl`; verify a project written before the change loads with all rows manual and a project with derived rows round-trips.
- [ ] 3.2 Add the storage helper that validates both collections and writes events first, then relationships, per D5. Verify a simulated relation-write failure leaves the event readable and a second save repairs it without duplicates.
- [ ] 3.3 Update merge and export/import round-trips to preserve origin and source event, or to downgrade to manual when the provenance is ambiguous. Verify round-trip and merge tests never drop or duplicate a manual row.
- [ ] 3.4 Add a storage regression test that a failed validation writes neither collection, and that a person deletion still removes relations and detaches shared events without re-deriving anything.

## 4. Commands and IPC

- [ ] 4.1 Invoke derivation in `event_create` and `event_update` and retraction in `event_update` and `event_delete` inside the same command mutation. Verify command tests cover marriage create, birth create, edit partner/parent, delete event, and manual-row survival.
- [ ] 4.2 Map derivation failures to the stable error contract from D4 without leaking ids in messages, and keep `expectedVersion` behavior unchanged. Verify a stale-version save changes no relation and returns `STALE_WRITE`.
- [ ] 4.3 Expose relation origin and source event in `relationship_list`, `person_get` and the read-only chat DTOs without exposing event text. Verify command and chat-tool snapshot tests show the new fields.
- [ ] 4.4 Add command tests for the open question about direct deletion of an automatic row. Verify the chosen behavior (warn-only or backend rejection) matches the amended spec.

## 5. UI

- [ ] 5.1 Add two optional parent pickers to the `BIRTH` event form, excluding the child and the other selection, and preserve the existing two-spouse form for `MARRIAGE`/`DIVORCE`. Verify component tests cover selection, clearing and save payload.
- [ ] 5.2 Prefill the pickers from the event's own participants and show other existing parent relations as read-only hints. Verify a reopened birth event shows the same selection and saving does not change manual rows.
- [ ] 5.3 Mark automatic rows in the person card with origin and source event, and add the delete warning. Verify component tests cover the badge and the warning path.
- [ ] 5.4 Verify kinship and graph rendering for the shared-child cases with no spouse row and with one. Verify no spouse line or spouse term appears for co-parents only.

## 6. Localization and docs

- [ ] 6.1 Add the new `event` and `relationship` keys in `ru`, `uk` and `en`, plus `PARENT_AGE_GAP` in `common` `errors`; update the other shipped locales to keep dictionaries complete. Verify `npm --prefix desktop/ui run i18n:check` passes and `make i18n` finds no Cyrillic outside locales.
- [ ] 6.2 Document in `desktop/docs` how event-derived relations, manual precedence, retraction and the birth participant rule work. Verify the documented behavior matches the spec scenarios.

## 7. Integration verification

- [ ] 7.1 Run the targeted Rust tests for core, storage and commands, then `make check`. Verify the full gate is green and report any unrelated failure separately.
- [ ] 7.2 Re-read the diff for privacy: no real personal data, no absolute local paths, no secrets, synthetic fixtures only. Verify `git diff --check` passes.
- [ ] 7.3 Walk the acceptance criteria of #80 against automated tests and record the mapping in the PR. Verify every checkbox has a named test or a manual step.

## Workflow follow-up

- Archive the change after approval and merge.
- Close #80 with the merge, and keep #79 linked for the shared age rule.
