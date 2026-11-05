# Design

## Context

See `proposal.md` for motivation and `specs/data-validation/spec.md` for the behavior contract.

`DateValue` stores an inclusive `start`, an exclusive `end`, a `precision` and a `qualifier`.
`DateValue::validate` requires both bounds for `EXACT`, `APPROXIMATE` and `RANGE`, so an ongoing
residence cannot be expressed today. `ensure_event_within_lifespan` compares the event's `start`
with the birth `start` as if both were exact points, while project-level `lifespan_issues` already
compares `[start, end)` against the birth anchor. That split explains why the same data is accepted
in one path and rejected in another. The events screen has a separate client-side anomaly check
(`desktop/ui/src/features/events/anomalies.ts`) that already compares at the coarser of the two
precisions, so the backend change brings the write path in line with what the UI already shows.

Relationship rows are validated as a set by `ProjectStore` (self-link, duplicate, spouse order,
parent cycle) but storage does not load person dates in that path. The age rule needs both persons'
birth values, which the command layer and `validate_project` already have.

## Goals / Non-Goals

**Goals:**

- Let a residence be saved as an open-ended period without inventing a date.
- Reject overlapping residence periods, allow adjacency, skip unknown dates.
- Make birth ordering precision-aware in the write path and in project validation.
- Require at least nine calendar years between a parent and a child.
- Keep stable codes, localization and the existing project format.
- Leave imported and legacy data untouched.

**Non-Goals:**

- Changing the JSON shape of `DateValue`, the project format or the manifest.
- Adding a new qualifier, crate, dependency, IPC command or network call.
- Normalizing, repairing or deleting existing overlapping or implausible data.
- Constraining `ADOPTIVE_PARENT_CHILD`, spouse/partner or other relation types.
- Replacing the UI anomaly badge or the merge conflict model.
- Enforcing a maximum plausible age gap or a maximum lifespan.

## Decisions

### D1. Express the open end as a `RANGE` without `end`, scoped to residence

**Options**

1. Reuse `AFTER` with a start only. No validation change, but the form's period mode, the
   "from–to" display and the meaning of a residence period no longer match the stored qualifier.
   "After 1950" also means strictly after, not "from 1950 onwards".
2. Allow `RANGE` with `start` present and `end` absent. The JSON field already allows `null`, so
   the project format does not change. Readers must treat a missing end as infinity.
3. Add an `ONGOING` qualifier. Unambiguous, but it adds a serialized enum value and old builds fail
   to deserialize it, which is a project-format change.

**Recommendation:** option 2. Add a dedicated validation entry point for open-ended ranges and call
it only when the event type is `RESIDENCE`. Keep `DateValue::validate` strict for persons, birth,
death and every other event type, so the relaxation cannot leak into unrelated dates. A `RANGE`
without a start stays invalid, and `UNKNOWN` stays without bounds.

**Consequences:** a missing end is written as `end: null` and never replaced by today's date. Older
application builds can still read the file but will refuse to save that row until updated. Import
and export need no change because the shape is unchanged.

### D2. Reject overlaps on write, report them as findings in project validation

**Options**

1. Error in both the command path and `validate_project`. `merge.rs` aborts when
   `validation.is_valid()` is false, so any legacy or imported overlap would block a merge.
2. Error in the command path, warning in `validate_project`. Manual create/update is blocked;
   opening, export, re-import and merge keep working and the finding is visible.
3. Warning everywhere. The acceptance criterion "overlapping ranges give an error" would not hold.

**Recommendation:** option 2. The write path returns `RESIDENCE_RANGE_OVERLAP` as an error.
`validate_project` reports the same code as a warning, like the existing lifespan findings, so
legacy data is reported rather than retroactively rejected.

**Consequences:** the same code has two severities depending on the path; this is already the
pattern for `EVENT_OUT_OF_LIFESPAN` (hard error on write, warning in the report). Merge stays
backwards compatible.

### D3. Compare birth ordering by intervals, anchored at the start of the precision unit

A birth is anchored at the first day of its precision interval (year → 1 January, month → 1st, day
→ the day). An event is wholly before the birth when its known interval ends at or before that
anchor. A missing end means infinity, so it is never wholly before. The same comparison replaces
the point comparison in birth/death compatibility.

**Options**

1. Keep point comparison and special-case equal units. Fragile: month-precision birth and
   year-precision event still fail in one direction.
2. Interval comparison on `DateValue` bounds. Deterministic, reuses the existing half-open model,
   matches the UI anomaly logic.
3. Compare only whole years. Simple, but wrong at the nine-year boundary and for day precision.

**Recommendation:** option 2, implemented once in a pure helper used by lifespan, overlap and age
checks.

**Consequences:** a same-year or same-month event is accepted; an event whose whole interval precedes
the birth is still rejected. Unknown or bound-less dates skip the check instead of assuming a value.

### D4. Nine-year parent gap uses birth anchors and is conservative

The parent's birth anchor plus nine calendar years must not be later than the child's birth anchor.
A 29 February anchor is clamped to 28 February in a non-leap target year. The rule applies only to
`PARENT_CHILD`. It is skipped when either birth is unknown or has no start.

**Options**

1. Compare points as today. Rejects valid same-year data and depends on the accident of 1 January.
2. Compare anchors. Rejects only pairs that are too close under every reading consistent with the
   stored precision; may allow a pair whose true gap is under nine years when the data is coarse.
3. Compare the latest possible parent birth with the earliest possible child birth. Strictest, but
   would reject many plausible historical pairs and needs a second convention for ranges.

**Recommendation:** option 2. It is deterministic, needs no invented dates and honours "exactly nine
years is allowed".

**Consequences:** coarse data stays admissible when the gap is uncertain. The check lives in the
core as a pure function over two `DateValue` values and is called by `relationship_create`, where
both persons are already loaded, and by `validate_project`.

### D5. Codes, parameters and localization

- `RESIDENCE_RANGE_OVERLAP` with `personId`, `eventId`, `otherEventId`.
- `PARENT_CHILD_AGE_GAP` with `parentId`, `childId`, `minYears`.
- `EVENT_OUT_OF_LIFESPAN` is reused for birth ordering and keeps its `bound` parameter.

Parameters carry identifiers and the numeric bound only: no names, no formatted dates and no paths.
New keys go to every dictionary the i18n gate checks (`en`, `ru`, `uk`, `be`, `de`, `es`) because
`i18n:check` compares each locale against `en` in both directions. The product languages required
by `AGENTS.md` are `ru`, `uk` and `en`; the other three are kept in parity for the gate.

### D6. No format, storage or IPC change

`ProjectStore` keeps writing the same JSON. The new pure validators live in `core`; the command
layer adds the two write-path checks; project validation extends the existing report. No new Tauri
command, chat tool, dependency or migration is proposed.

## Risks / Trade-offs

- An open-ended `RANGE` is new behavior for every reader. Timeline, map filters and date formatting
  already tolerate a missing bound, but each read path must be checked for a silent assumption of
  `end`.
- Reporting overlaps as warnings means a legacy project can show a warning that the user can only
  fix by editing data. That is the intended non-destructive behavior.
- Anchor-based age comparison can accept a pair that is truly under nine years apart when both
  births are coarse. Rejecting instead would produce false errors on valid historical records.
- `ADOPTIVE_PARENT_CHILD` is deliberately exempt. If reviewers want a minimum adopter age, that is
  a separate decision.

## Migration and compatibility

No migration and no rewrite. Existing rows are read as they are; an existing `RANGE` with both
bounds is unchanged; a legacy `RANGE` already missing an end (if any) becomes valid rather than
being altered. Re-import remains idempotent because nothing in the import path calls the new write
checks.

## HITL record

This change alters date semantics and a relation constraint, so the PR must:

- link issue #79 and this change folder, and carry `Refs #79` (not `Closes`) until the rules are
  implemented and verified;
- record the chosen options for D1–D4 with their consequences and the recommendation above;
- state that `AGENTS.md` invariants and the `DateValue`/project format are unchanged, and that no
  invariant edit is part of this proposal;
- name the reviewer who approved the date semantics and the `PARENT_CHILD` age gap;
- note that `ADOPTIVE_PARENT_CHILD` is exempt and that unknown dates skip validation;
- if the decision becomes a durable rule, open a separate human-reviewed change to record it in
  `AGENTS.md`; do not edit that file here.

## Open questions for the reviewer

1. Is a warning in project validation acceptable for legacy overlaps, or must `validate_project`
   report an error and the merge path filter this code explicitly?
2. Should the nine-year gap later extend to `ADOPTIVE_PARENT_CHILD`, or stay biological-only?
3. Should the open end be offered for occupation and education periods too, which share the period
   UI, or only for residence in this change?
4. Should a maximum plausible parent age gap (for example 100 years) be a follow-up, or is that out
   of scope for this rule set?
