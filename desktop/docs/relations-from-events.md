# Relations derived from life events

A marriage and a birth are the only events that assert kinship.

- A `MARRIAGE` event with exactly two distinct people ensures one `SPOUSE` relation. A `PARTNER` row already covering the pair satisfies it and is never re-typed. Fewer or more than two people derive nothing.
- A `BIRTH` event uses `participant_ids` as zero, one or two selected parents. Each parent becomes a `PARENT_CHILD` row with the parent on `person_id` and the child (the event owner) on `related_person_id`. No parent is inferred from a spouse relation.
- Existing manual rows win: derivation never overwrites, re-types or deletes them. An existing `PARTNER` or `ADOPTIVE_PARENT_CHILD` row for the pair counts as satisfied.
- Saving the same event again is idempotent. A parent must be at least 11 years older than the child when both birth dates are known; exactly 11 years is accepted and unknown dates skip the check (`PARENT_CHILD_AGE_GAP`).

## Provenance

Derived rows carry `origin: "EVENT"` and `sourceEventIds`. Manual rows omit both fields, so legacy projects and older builds read them as manual. An event edit or delete removes its id from `sourceEventIds`; the row is deleted only when no source event remains. A manual row is never cascade-deleted. Deleting a derived row directly is allowed: the next save of a source event recreates it.

Merge keeps the earliest relationship id, unions `sourceEventIds`, and makes the row manual when either side is manual.

## Backfill

Opening a writable project reconciles stored events once:

- marriages with exactly two distinct people gain a missing spouse row;
- births with one or two participants gain missing parent rows;
- manual rows are untouched, births without participants are left alone, and casts with too many people are skipped as ambiguous.

The report (`spouseCreated`, `parentCreated`, `ambiguousSkipped`, `readOnly`) contains counts only. Read-only projects are not written. A failed write leaves the project unchanged and the next open retries the same idempotent pass.

## Spouse display

Kinship and the graph resolve a spouse only from `SPOUSE`/`PARTNER` rows. Two people who share a child are co-parents, never spouses, unless a spouse row exists.
