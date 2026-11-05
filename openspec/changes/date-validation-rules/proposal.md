# Proposal

## Why

Date validation currently treats imprecise dates as exact points and requires a right bound on
every residence period. A year-only birth and an event in that same year are compared as if both
happened on 1 January, so valid data is rejected, and a residence that is still ongoing cannot be
saved at all. At the same time nothing rejects two overlapping residence periods for one person or
a parent linked to a child born a few months later.

The user asked for four related rules (issue #79): an optional residence end, no overlapping
residence periods, precision-aware birth ordering, and a minimum nine-year parent/child age gap.
Because they change date semantics and a relation constraint, they need a spec and a human
decision record even though the intent is already approved.

## What Changes

- **Open-ended residence.** A `RESIDENCE` event may be saved with a start and no end. The open end
  means "ongoing/until present". No end date is invented and no placeholder is written.
- **No overlapping residence periods.** Two `RESIDENCE` events of the same person must not overlap.
  Adjacent periods (`end == next start`, half-open) are allowed. An open end extends to infinity.
- **Precision-aware birth ordering.** Birth is anchored at the start of its precision interval
  (year → 1 January, month → 1st, day → exact day). An event is only "before birth" when its whole
  known interval lies before that anchor. Same year or same month as birth is accepted.
- **Unknown dates never block.** `UNKNOWN` dates and missing bounds skip the comparison instead of
  being filled with an assumed value.
- **Parent/child age gap.** A `PARENT_CHILD` edge is rejected when the parent's birth anchor is less
  than nine calendar years before the child's birth anchor. Exactly nine years is allowed. Either
  birth unknown → the check is skipped.
- **Stable error codes and localization.** New machine-readable codes with id parameters, localized
  in the UI dictionaries. No Cyrillic and no paths in source.
- **No retroactive changes.** Imported and existing data is not normalized, rewritten or rejected on
  load. The new rules gate manual create/update and are reported by project validation.
- **HITL.** Date semantics and a relation constraint change. Options, consequences and a
  recommendation are recorded in `design.md`; the PR must record the decision.

## Capabilities

### New Capabilities

- `data-validation`: project-level rules that decide whether a date range, an event date and a
  parent/child relation are acceptable, and the stable issue codes they report.

### Modified Capabilities

- None. The existing `chat-history`, `ui-conformance` and `ui-kit` capabilities are unaffected.

## Impact

- `desktop/crates/core`: `date.rs` (open-ended range validation), `validation.rs` (interval
  comparison, residence overlap, parent/child age gap, new codes), `record.rs` (event-level
  restriction of the open end to residence), `relationship.rs` or a new pure validator.
- `desktop/apps/desktop/src/commands`: `event.rs` (overlap check on create/update),
  `relationship.rs` (age-gap check on create).
- `desktop/crates/storage`: no format change; relationships are saved through the existing set
  validation.
- `desktop/ui`: event form residence period without an end, project validation list, localized
  messages in all six dictionaries (`en`, `ru`, `uk`, `be`, `de`, `es`; the i18n gate compares
  every locale against `en`).
- Docs: no change to `AGENTS.md` invariants; `DateValue` and the project format stay as they are
  (the `end` field already is optional in JSON).

No new crate, dependency, IPC command or network egress is proposed.
