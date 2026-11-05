# Tasks

## 1. Decision gate

- [ ] 1.1 Record the D1–D4 decisions and the open questions from `design.md` in the PR body, and get reviewer approval for date semantics and the parent age rule; verify the PR states that `AGENTS.md` and the project format are unchanged.
- [ ] 1.2 Resolve the open question about overlap severity (write error + validation warning vs error everywhere); verify the chosen severity is written in the PR and reflected in 3.4.

## 2. Core date primitives

- [ ] 2.1 Add a shared interval helper over `DateValue` that returns the known `[start, end)` bounds, treats a missing end as infinity, and yields "not comparable" for `UNKNOWN` or a missing start; verify unit tests cover year, month, day, open end, `BEFORE`, and `UNKNOWN` in `desktop/crates/core/src/date.rs`.
- [ ] 2.2 Add the open-ended `RANGE` validation entry point used only by residence events, leaving `DateValue::validate` strict; verify unit tests accept `start` with no `end`, reject no-bounds, and still reject open ranges used for birth, death and person dates.
- [ ] 2.3 Document the open-end meaning on the `DateValue`/`RANGE` API docs; verify `cargo doc` or the doc comment states that a missing end is infinity and is never substituted.

## 3. Core validation rules

- [ ] 3.1 Replace the point comparisons in `ensure_event_within_lifespan`, `ensure_life_events_compatible` and `lifespan_issues` with the interval helper; verify tests for same-year, same-month, exact day, earlier year, open-ended event, and unknown date in `desktop/crates/core/src/validation.rs`.
- [ ] 3.2 Add residence overlap detection per person using the same helper, allowing adjacency and skipping unknown dates; verify tests cover overlap, adjacency, open end, open start, and unknown date.
- [ ] 3.3 Add the `PARENT_CHILD` nine-year check as a pure function over two birth values, excluding `ADOPTIVE_PARENT_CHILD`, clamping 29 February; verify tests cover 8 years, exactly 9 years, older parent, unknown birth, range birth, and an adoptive edge.
- [ ] 3.4 Add the stable constants `RESIDENCE_RANGE_OVERLAP` and `PARENT_CHILD_AGE_GAP`, wire them into `validate_project` with the reviewed severity, and keep id-only parameters; verify a report test asserts the codes, severity and parameter keys.
- [ ] 3.5 Add a contract test file `desktop/crates/core/tests/date_validation_contract.rs` with synthetic fixtures for every scenario in `specs/data-validation/spec.md`; verify `cargo test -p gentree-core` passes.
- [ ] 3.6 Confirm the merge contract still passes, including a merge whose output contains a legacy overlap; verify `cargo test -p gentree-core --test merge_contract` passes and no existing fixture expects an error for these codes.

## 4. Command layer

- [ ] 4.1 Call the residence overlap check in `event_create` and `event_update` after the date is validated and before saving; verify a core-level test proves the same guard rejects the second overlapping row.
- [ ] 4.2 Call the parent age check in `relationship_create` using the stored persons, after `ensure_persons` and before saving; verify a test proves a too-young parent is rejected and exactly nine years is accepted.
- [ ] 4.3 Verify the import and merge paths do not call the new checks, so re-import stays idempotent and legacy data is untouched; verify by code inspection plus the existing import and merge tests.

## 5. UI

- [ ] 5.1 Add an explicit "still ongoing" affordance to the residence period inputs that stores a `RANGE` with no end, and show an open range as "from X to present"; verify component/unit tests and that reopening the form keeps the open end.
- [ ] 5.2 Display `RESIDENCE_RANGE_OVERLAP` and `PARENT_CHILD_AGE_GAP` in the validation summary and the save error path; verify a test maps each code to a localized message.
- [ ] 5.3 Add the new keys to every dictionary under `desktop/ui/src/i18n/locales` (`en`, `ru`, `uk`, `be`, `de`, `es`); verify `npm --prefix desktop/ui run i18n:check` passes.
- [ ] 5.4 Verify no new hardcoded Cyrillic or absolute path appears in `desktop/ui/src`; verify the i18n check reports no leaks.

## 6. Integration verification

- [ ] 6.1 Run `make check` and confirm fmt, clippy, Rust tests, UI typecheck, UI tests, build and i18n are green.
- [ ] 6.2 Manually exercise a synthetic project: save an ongoing residence, reject an overlap, accept adjacent periods, accept a same-year event, reject an exact date before birth, and reject a parent eight years older; verify each result matches the spec scenarios.
- [ ] 6.3 Confirm no existing project file, backup or export is rewritten by the change and that opening a legacy project only reports findings; verify by diffing a synthetic project folder before and after open/validate.

## Workflow follow-up

- Archive this change with `openspec archive` only after the rule set is implemented, reviewed and merged.
- If the date-semantics decision becomes a durable invariant, open a separate human-reviewed change for `AGENTS.md`; do not edit it as part of this change.
