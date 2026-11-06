# Relations derived from life events

A marriage and a birth are the only events that assert kinship.

- A `MARRIAGE` event with exactly two distinct people ensures one `SPOUSE` relation. A `PARTNER` row already covering the pair satisfies it and is never re-typed. Fewer or more than two people derive nothing.
- A `BIRTH` event uses `participant_ids` as zero, one or two selected parents. Each parent becomes a `PARENT_CHILD` row with the parent on `person_id` and the child (the event owner) on `related_person_id`. No parent is inferred from a spouse relation.
- Existing manual rows win: derivation never overwrites, re-types or deletes them. An existing `PARTNER` or `ADOPTIVE_PARENT_CHILD` row for the pair counts as satisfied.
- Saving the same event again is idempotent. A parent must be at least 11 years older than the child when both birth dates are known; exactly 11 years is accepted and unknown dates skip the check (`PARENT_CHILD_AGE_GAP`).

## Provenance

Derived rows carry `origin: "EVENT"` and `sourceEventIds`. Manual rows omit both fields, so legacy projects and older builds read them as manual. An event edit or delete removes its id from `sourceEventIds`; the row is deleted only when no source event remains. A manual row is never cascade-deleted. The person card renders an automatic row exactly like a manual one: provenance is stored and returned by the API, but no badge or source-event label is shown.

Deleting an automatic spouse row directly is allowed and the next save of a source event recreates it. A biological parent row is different: deleting it also clears the parent from the child's birth event, so the next event save does not recreate it.

Merge keeps the earliest relationship id, unions `sourceEventIds`, and makes the row manual when either side is manual.

## Parent and birth-event sync

Creating or deleting a biological `PARENT_CHILD` relation keeps the child's `BIRTH` event in sync:

- create adds the parent to `participant_ids` once, in the earliest dated birth event that has a free parent slot; undated events sort last and ties break by event id;
- slots are positional and father-first: male at index 0, female at index 1, unknown gender in the first free slot; the list stays compact, so a lone parent is the only element;
- the stored index is only a hint. The UI resolves which picker holds a person from their gender, so deleting the father leaves a lone mother at index 0 and she still reads as the mother (and the reverse for a lone father);
- a birth whose two slots are occupied by other people is left untouched while the relation is still stored;
- delete removes the parent from every birth event of the child; an event with no parents stays valid;
- only `PARENT_CHILD` is mirrored. `ADOPTIVE_PARENT_CHILD` and spouse/partner edges never change an event.

Both directions are idempotent: a parent already present is never added twice, a deleted parent is not re-derived from a cleared event, and saving the event after either operation leaves the relation count unchanged.

## Backfill

Opening a writable project reconciles stored data once, in this order:

1. a person with a known birth or death date and no owned `BIRTH`/`DEATH` event gains the missing event from that date; an existing event with another date is never overwritten and a blank date creates nothing;
2. marriages with exactly two distinct people gain a missing spouse row, and births with one or two participants gain missing parent rows;
3. every biological `PARENT_CHILD` relation adds its parent to the child's earliest birth event with a free slot, using the same slot rules as a new relation;
4. a child with an empty primary patronymic and exactly one male biological father gains the patronymic derived from that father's given name, using the same rules as a new relation.

Manual rows and manual events are untouched, births without participants are left alone, and casts with too many people are skipped as ambiguous. A second open changes nothing. The report (`spouseCreated`, `parentCreated`, `ambiguousSkipped`, `lifeEventsCreated`, `parentsAdded`, `patronymicsFilled`, `readOnly`) contains counts only: no names, dates, ids, places or paths. Read-only projects are not written. A failed write leaves the project unchanged and the next open retries the same idempotent pass.

## Patronymic fill

When a biological father becomes known, an empty patronymic is derived from his given name:

- the fill runs when a `PARENT_CHILD` relation is created, when a `BIRTH` event that asserts the father is saved, when the person form is saved with the father already stored, and once for an already-stored father when a writable project opens;
- only the primary name is touched, and only when its patronymic is absent or whitespace-only; a non-empty or imported value is never replaced;
- exactly one male biological parent is required; zero, several, an adoptive-only parent or an unnamed father leaves the field empty without an error;
- Cyrillic names use the East Slavic suffix rules (Russian, Ukrainian or Belarusian by spelling); Latin and mixed-script names are a no-op;
- import and export never write a patronymic, the open pass reports only an aggregate count, and the project format is unchanged.

## Spouse display

Kinship and the graph resolve a spouse only from `SPOUSE`/`PARTNER` rows. Two people who share a child are co-parents, never spouses, unless a spouse row exists.
