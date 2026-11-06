# Tasks

## 1. Decision gate

- [x] 1.1 Record the 2026-11-05 approval, the approved D1–D6 decisions and the resolved questions from `design.md` in the PR body; verify the PR states that `AGENTS.md` and the project format are unchanged.
- [x] 1.2 Confirm the approved scope before coding: warning severity for legacy overlaps, biological-only age gap, residence-only open end, no maximum age gap; verify each task below matches that scope.

## 2. Core date primitives

- [x] 2.1 Add a shared helper over `DateValue` that returns the known `[start, end)` bounds for overlap and birth/death checks, treats a missing end as infinity, and yields "not comparable" for `UNKNOWN` or a missing start; verify unit tests cover year, month, day, open end, `BEFORE`, and `UNKNOWN` in `desktop/crates/core/src/date.rs`.
- [x] 2.2 Add a start-unit helper that returns `S_end`, the next day, first of the next month or 1 January of the next year for the event's start and precision; verify unit tests cover year, month, day and a missing start.
- [x] 2.3 Add the open-ended `RANGE` validation entry point used only by residence events, leaving `DateValue::validate` strict; verify unit tests accept `start` with no `end`, reject no-bounds, and still reject open ranges used for birth, death and person dates.
- [x] 2.4 Document the open-end meaning on the `DateValue`/`RANGE` API docs; verify `cargo doc` or the doc comment states that a missing end is infinity and is never substituted.

## 3. Core validation rules

- [x] 3.1 Change `ensure_event_within_lifespan` and `lifespan_issues` to the start-unit rule: reject only when `S_end <= birth anchor`, and skip events with no start; verify tests for same-year, same-month, exact day, earlier year, open-ended start before birth (rejected), open-ended start unit containing birth (accepted), ranged start before birth (rejected), and unknown date.
- [x] 3.2 Keep `ensure_life_events_compatible` on the whole-interval comparison and reuse the interval helper for the birth/death order; verify same-year birth and death are accepted and a birth wholly after the death interval is rejected.
- [x] 3.3 Add residence overlap detection per person using the interval helper, allowing adjacency and skipping unknown dates; verify tests cover overlap, adjacency, open end, open start, and unknown date.
- [x] 3.4 Add the `PARENT_CHILD` eleven-year check as a pure function over two birth values, excluding `ADOPTIVE_PARENT_CHILD`, clamping 29 February, with the canonical code `PARENT_CHILD_AGE_GAP`; verify tests cover 10 years 364 days, exactly 11 years, older parent, unknown birth, range birth, and an adoptive edge.
- [x] 3.5 Add the stable constants `RESIDENCE_RANGE_OVERLAP` and `PARENT_CHILD_AGE_GAP`, wire them into `validate_project` with the approved warning severity for legacy overlaps, and keep id-only parameters; verify a report test asserts the codes, severity and parameter keys.
- [x] 3.6 Add a contract test file `desktop/crates/core/tests/date_validation_contract.rs` with synthetic fixtures for every scenario in `specs/data-validation/spec.md`; verify `cargo test -p gentree-core` passes.
- [x] 3.7 Confirm the merge contract still passes, including a merge whose output contains a legacy overlap; verify `cargo test -p gentree-core --test merge_contract` passes and no existing fixture expects an error for these codes.

## 4. Command layer

- [x] 4.1 Call the residence overlap check in `event_create` and `event_update` after the date is validated and before saving; verify a core-level test proves the same guard rejects the second overlapping row.
- [x] 4.2 Call the parent age check in `relationship_create` using the stored persons, after `ensure_persons` and before saving; verify a test proves a too-young parent is rejected and exactly eleven years is accepted.
- [x] 4.3 Verify the import and merge paths do not call the new checks, so re-import stays idempotent and legacy data is untouched; verify by code inspection plus the existing import and merge tests.

## 5. UI

- [x] 5.1 Add an explicit "still ongoing" affordance to the residence period inputs that stores a `RANGE` with no end, and show an open range as "from X to present"; verify component/unit tests and that reopening the form keeps the open end.
- [x] 5.2 Display `RESIDENCE_RANGE_OVERLAP` and `PARENT_CHILD_AGE_GAP` in the validation summary and the save error path; verify a test maps each code to a localized message.
- [x] 5.3 Add the new keys to every dictionary under `desktop/ui/src/i18n/locales` (`en`, `ru`, `uk`, `be`, `de`, `es`); verify `npm --prefix desktop/ui run i18n:check` passes.
- [x] 5.4 Verify the UI anomaly logic in `desktop/ui/src/features/events/anomalies.ts` matches the start-unit rule (open-ended or ranged event starting before birth is flagged, start unit containing the birth is not); align it and its tests if it diverges.
- [x] 5.5 Verify no new hardcoded Cyrillic or absolute path appears in `desktop/ui/src`; verify the i18n check reports no leaks.

## 6. Integration verification

- [x] 6.1 Run `make check` and confirm fmt, clippy, Rust tests, UI typecheck, UI tests, build and i18n are green.
- [x] 6.2 Manually exercise a synthetic project: save an ongoing residence, reject an overlap, accept adjacent periods, accept a same-year event, reject an exact date before birth, reject an open-ended residence starting before birth, accept an open-ended residence whose start unit contains the birth, and reject a parent eight years older; verify each result matches the spec scenarios.
- [x] 6.3 Confirm no existing project file, backup or export is rewritten by the change and that opening a legacy project only reports findings; verify by diffing a synthetic project folder before and after open/validate.

## Workflow follow-up

- Archive this change with `openspec archive` only after the rule set is implemented, reviewed and merged.
- If the date-semantics decision becomes a durable invariant, open a separate human-reviewed change for `AGENTS.md`; do not edit it as part of this change.
