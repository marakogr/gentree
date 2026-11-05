# Design

## Context

See `proposal.md` for motivation and `specs/data-validation/spec.md` for the behavior contract.

`DateValue` stores an inclusive `start`, an exclusive `end`, a `precision` and a `qualifier`.
`DateValue::validate` requires both bounds for `EXACT`, `APPROXIMATE` and `RANGE`, so an ongoing
residence cannot be expressed today. `ensure_event_within_lifespan` compares the event's `start`
with the birth `start` as if both were exact points, while project-level `lifespan_issues` already
compares `[start, end)` against the birth anchor. That split explains why the same data is accepted
in one path and rejected in another. The events screen has a separate client-side anomaly check
(`desktop/ui/src/features/events/anomalies.ts`) that compares the event's start at the coarser of the
two precisions, which is the same question the corrected backend rule asks, so the write path must
match it rather than the other way round.

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
and export need no change because the shape is unchanged. Approved in review on 2026-11-05 as
residence-only.

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
backwards compatible. Approved in review on 2026-11-05 as warning severity for legacy overlaps.

### D3. Birth ordering compares the event's start precision unit

A birth is anchored at the first day of its precision interval (year → 1 January, month → 1st, day
→ the day). Let `S` be the event's start date and `S_end` the end of `S`'s own precision unit: the
next day for day precision, the first of the next month for month precision, and 1 January of the
next year for year precision. The event is before the birth when `S_end` is at or before the birth
anchor. An event with no start (unknown, or a `BEFORE`-style open start) skips the check.

Birth/death contradiction keeps the whole-interval question: a birth is contradictory only when it
lies entirely after the death interval, and a death only when it lies entirely before the birth
interval.

**Options**

1. Whole-interval comparison of the event date (earlier draft). Too permissive: an open-ended
   residence starting in 1940 with a 1950 birth would be accepted, although the user requires a
   residence to start after birth. The same hole exists for a long period that starts before birth
   and ends after it.
2. Compare the event's start precision unit against the birth anchor. Deterministic, matches the
   UI anomaly logic, rejects exact earlier dates, same-start-unit events remain accepted, and a
   period or open-ended event is rejected when its start unit lies entirely before birth.
3. Point comparison with an equality special case. Fragile: it depends on the accident of 1 January
   and still cannot express the unit boundary.

**Recommendation:** option 2. Implement the boundary arithmetic once in a pure helper and use it in
both the write-path check and project-level validation. Keep the whole-interval helper for
birth/death contradiction.

**Consequences:** same-year and same-month ambiguity stays accepted. An open-ended or ranged event
whose start unit is wholly before the birth anchor is rejected even when it extends past the birth.
A `BEFORE`-qualified event has no start and is not compared. The UI anomaly logic must be verified
against this rule and aligned if it diverges.

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
both persons are already loaded, and by `validate_project`. Approved in review on 2026-11-05 as
biological-only (`PARENT_CHILD`, not adoption) with no maximum age gap.

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

Approved by the orchestrator/reviewer on 2026-11-05 at the user's request; record in the PR.

The approval covers D1, D2, D4, D5 and D6 as written, the corrected D3 start-unit rule, warning
severity for legacy overlaps, a biological-only (`PARENT_CHILD`) age gap, a residence-only open end,
and no maximum age gap.

This change alters date semantics and a relation constraint, so the PR must:

- link issue #79 and this change folder, and carry `Refs #79` (not `Closes`) until the rules are
  implemented and verified;
- record the approved options for D1–D6 with their consequences;
- state that `AGENTS.md` invariants and the `DateValue`/project format are unchanged, and that no
  invariant edit is part of this proposal;
- record the 2026-11-05 approval and the reviewer statement above;
- note that `ADOPTIVE_PARENT_CHILD` is exempt and that unknown dates skip validation;
- if the decision becomes a durable rule, open a separate human-reviewed change to record it in
  `AGENTS.md`; do not edit that file here.

## Resolved by review (2026-11-05)

1. Legacy overlaps are reported as warnings in project validation; the write path stays an error.
2. The nine-year gap stays biological-only and does not extend to `ADOPTIVE_PARENT_CHILD`.
3. The open end is offered for residence only in this change, not for occupation or education.
4. No maximum plausible age gap is added; it is out of scope for this rule set.
