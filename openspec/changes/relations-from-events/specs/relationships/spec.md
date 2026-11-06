# Spec Delta

## Purpose

Defines how life events assert kinship: which relations are created from a marriage or birth, how existing events are reconciled when a project opens, how repeated saves and manual rows are reconciled, which validation protects the graph, and how a spouse is resolved without falling back to a co-parent.

## ADDED Requirements

### Requirement: A marriage event asserts a spouse relation

Saving a `MARRIAGE` event whose owner and participants contain exactly two distinct people SHALL ensure one `SPOUSE` relation between them. The relation SHALL be created inside the same project mutation as the event and SHALL use the canonical spouse order.

#### Scenario: Two participants become spouses

- **WHEN** a marriage event is saved with one owner and one distinct co-participant and no spouse or partner relation exists between them
- **THEN** a `SPOUSE` relation between the two people is stored
- **AND** both person cards list each other as spouse
- **AND** kinship between them resolves to husband or wife by gender

#### Scenario: An incomplete marriage creates nothing

- **WHEN** a marriage event is saved with no co-participant
- **THEN** no spouse relation is created
- **AND** the event itself is saved

#### Scenario: A marriage with an ambiguous cast creates nothing

- **WHEN** a marriage event is saved with more than two distinct people
- **THEN** no spouse relation is created or changed
- **AND** the event save is not rejected for that reason

#### Scenario: An existing partner pair is not overwritten

- **WHEN** a marriage event is saved for two people who already have a `PARTNER` relation
- **THEN** the `PARTNER` relation is kept unchanged
- **AND** no second spouse-type relation is added
- **AND** the pair counts as linked for later saves

### Requirement: A birth event asserts parent relations

A `BIRTH` event SHALL let the user select zero, one or two parents. On save, each selected parent SHALL produce a `PARENT_CHILD` relation whose parent endpoint is the selected person and whose child endpoint is the event owner. A birth saved without parents SHALL create no parent relation.

#### Scenario: One selected parent

- **WHEN** a birth event for a child is saved with one selected parent
- **THEN** one `PARENT_CHILD` relation from that parent to the child is stored
- **AND** the child card lists that person as a parent

#### Scenario: Two selected parents

- **WHEN** a birth event is saved with two distinct selected parents
- **THEN** two `PARENT_CHILD` relations are stored with the child as the shared endpoint
- **AND** the two parents are not made spouses by this event

#### Scenario: A birth without parents still saves

- **WHEN** a birth event is saved with no selected parent
- **THEN** the event is stored
- **AND** no parent relation is created

#### Scenario: An ambiguous birth cast creates nothing

- **WHEN** a birth event is saved with more than two distinct co-participants
- **THEN** no parent relation is created or changed
- **AND** the event save is not rejected for that reason

#### Scenario: The child cannot be its own parent

- **WHEN** a birth event selects its owner as a parent
- **THEN** the save is rejected with `VALIDATION_ERROR` and `params.field = participantIds`
- **AND** the event is not stored

### Requirement: Derivation is idempotent

Re-saving, reopening or re-deriving the same event SHALL NOT create a second row for a pair that already has a compatible relation. Derivation SHALL treat an existing relation as satisfying the event instead of rewriting it.

#### Scenario: Re-saving the same marriage

- **WHEN** a marriage event is saved twice without changing its participants
- **THEN** exactly one spouse-type relation exists for the pair
- **AND** the second save reports success without a duplicate error

#### Scenario: Re-saving the same birth

- **WHEN** a birth event with two selected parents is saved twice
- **THEN** exactly two `PARENT_CHILD` rows exist, one per parent
- **AND** no row id changes on the second save

#### Scenario: A manual relation already covers the pair

- **WHEN** a birth event selects a parent who already has any parent-type relation to that child
- **THEN** the existing relation is kept, including its type and notes
- **AND** no second parent-type row is added

### Requirement: Manual relations take precedence

Relations created through the relationship commands, and relations loaded from projects that predate this change, SHALL be treated as manual. Derivation MUST NOT overwrite, re-type, re-order or delete a manual relation.

#### Scenario: Manual spouse survives a marriage save

- **WHEN** two people already have a manual spouse-type relation and a marriage event is saved for them
- **THEN** the manual relation keeps its id and notes
- **AND** no automatic relation is added

#### Scenario: Manual adoption is not replaced

- **WHEN** a child has an `ADOPTIVE_PARENT_CHILD` relation to the selected parent
- **THEN** the adoptive relation is kept
- **AND** no biological `PARENT_CHILD` row is added for the same pair

### Requirement: Existing events are backfilled on writable open

Opening a writable project SHALL reconcile stored events before the project is reported as open. A marriage with exactly two distinct people SHALL gain a spouse relation only when no spouse or partner pair exists. A birth with one or two participants SHALL gain the missing parent relations. A birth without participants SHALL be left alone.

#### Scenario: An existing marriage gains a spouse row

- **WHEN** a writable project containing a marriage with one owner and one distinct co-participant and no spouse pair is opened
- **THEN** a `SPOUSE` relation is stored for the pair
- **AND** the person cards and kinship show the spouse without a further save

#### Scenario: An existing birth gains parent rows

- **WHEN** a writable project containing a birth with one or two participants and no corresponding parent row is opened
- **THEN** the missing `PARENT_CHILD` rows are stored

#### Scenario: A birth without participants stays childless

- **WHEN** a writable project contains a birth with no participants
- **THEN** no parent relation is created
- **AND** no parent is inferred from a spouse relation or another event

#### Scenario: An ambiguous cast is skipped

- **WHEN** a stored marriage has fewer or more than two distinct people, or a stored birth has more than two participants
- **THEN** backfill creates no relation for that event
- **AND** the event remains readable and unchanged

### Requirement: Backfill is safe, repeatable and aggregated

Backfill MUST NOT overwrite, re-type or delete a manual relation, MUST NOT run for a read-only project, and MUST write nothing on a second open. It SHALL report only aggregate counts, without person ids, names, dates, places or paths.

#### Scenario: A second open is a no-op

- **WHEN** a project is opened again after a successful backfill
- **THEN** no relation row is added, changed or deleted
- **AND** the reported creation count is zero

#### Scenario: A manual relation is left untouched

- **WHEN** the pair already has a manual spouse, partner, biological parent or adoptive parent row
- **THEN** that row keeps its id, type and notes
- **AND** no automatic row is added for the pair

#### Scenario: A read-only project is unchanged

- **WHEN** a project is opened read-only
- **THEN** the relationship and event collections are byte-identical after the open
- **AND** no backfill report claims a change

#### Scenario: The report contains no personal data

- **WHEN** a backfill runs
- **THEN** the report contains only counts of created and skipped relations
- **AND** it contains no person ids, names, dates, places, event text or file paths

### Requirement: Derived relations validate the graph

Derivation SHALL enforce the relationship invariants: no self-link, no duplicate pair, and no parent cycle. A save that would violate them SHALL be rejected as a whole, and clearing the offending selection SHALL allow the event to save.

#### Scenario: A cycle is rejected

- **WHEN** selecting a parent would make the parent a descendant of the child through existing parent edges
- **THEN** the save fails with `RELATIONSHIP_CYCLE`
- **AND** neither the event change nor any relation is stored

#### Scenario: Clearing the parent resolves the error

- **WHEN** the same birth event is saved with the offending parent removed
- **THEN** the event is stored
- **AND** no relation is created for the removed person

### Requirement: Parent age is validated

A derived or manual `PARENT_CHILD` relation SHALL require the parent to be at least 11 years older than the child when both birth dates are known. The comparison SHALL use the start of each date's precision range and SHALL be skipped when either date is unknown, as specified by the date rules of issue #79. Exactly 11 years SHALL be accepted. Rejection SHALL use the canonical `PARENT_CHILD_AGE_GAP` code from #79.

#### Scenario: Less than eleven years is rejected

- **WHEN** both birth dates are known and the parent is less than 11 years older
- **THEN** the save fails with `PARENT_CHILD_AGE_GAP`
- **AND** `params.field` identifies the parent selection
- **AND** clearing the parents allows the event to save

#### Scenario: Exactly eleven years is accepted

- **WHEN** the parent is exactly 11 years older than the child by the available dates
- **THEN** the relation is created

#### Scenario: Unknown dates do not block the relation

- **WHEN** either birth date is unknown or has unknown precision
- **THEN** no age-based rejection occurs
- **AND** the relation is created

### Requirement: Derived relations are identifiable

Every stored relation SHALL record whether it was created by a user or derived from an event, and derived rows SHALL list the event or events that assert them. The relationship list, person card and chat-visible DTOs SHALL expose this origin without exposing event content.

#### Scenario: The person card marks an automatic relation

- **WHEN** a relation was derived from a marriage or birth event
- **THEN** the person card labels it as created automatically
- **AND** the row identifies at least one source event by type and date, not by free text
- **AND** when several events assert the pair, the row reports that it has several sources

#### Scenario: A manual relation is not labelled automatic

- **WHEN** a relation was created through the relationship commands or loaded as legacy data
- **THEN** it is reported as manual

#### Scenario: Deleting an automatic row is not durable

- **WHEN** the user deletes an automatic relation while its source event still asserts it
- **THEN** the row is removed and the backend accepts the delete
- **AND** the UI warns that the next save of a source event will recreate it

### Requirement: Editing or deleting an event retracts only its own derived rows

Saving an edited marriage or birth event SHALL remove that event from the provenance of automatic relations it previously asserted and no longer asserts, deleting a row only when no source event remains, then create the newly asserted rows. Deleting the event SHALL remove its provenance in the same way. Manual rows MUST NOT be cascade-deleted by an event edit or delete.

#### Scenario: Another event still asserts the pair

- **WHEN** two marriage events assert the same pair and one of them is deleted
- **THEN** the spouse row remains
- **AND** its provenance still names the surviving event

#### Scenario: Changing the marriage partner

- **WHEN** a marriage event's co-participant is replaced and saved
- **THEN** the old automatic spouse row is removed
- **AND** a spouse row for the new pair is created
- **AND** manual rows are unchanged

#### Scenario: Removing a birth parent

- **WHEN** a birth event is saved with one of its two parents removed
- **THEN** the automatic parent row for the removed person is deleted
- **AND** the row for the remaining parent is kept
- **AND** a manually added parent row is kept

#### Scenario: Deleting a marriage event

- **WHEN** a marriage event is deleted
- **THEN** the spouse row it created is removed
- **AND** a manual spouse row for the same pair survives
- **AND** other events of the two people survive

#### Scenario: Deleting a person keeps existing deletion rules

- **WHEN** a person is deleted
- **THEN** relations that involve that person are removed as today
- **AND** shared events are detached rather than deleted
- **AND** no relation is re-derived for the removed person

### Requirement: Event and relation writes tolerate interruption

The event and its derived relations SHALL be validated before either is written. A failure between the writes MUST NOT store a relation that references a missing person, and saving the event again SHALL complete the derivation without duplicates.

#### Scenario: Relation write fails after the event write

- **WHEN** the event is stored but writing its derived relations fails
- **THEN** the command reports `IO_ERROR`
- **AND** reopening the project shows the event without the missing relation
- **AND** saving the event again creates the relation once

#### Scenario: A rejected relation leaves the event untouched

- **WHEN** derivation rejects a self-link, cycle or age gap
- **THEN** the stored event keeps its previous value
- **AND** the stored relations are unchanged

### Requirement: A spouse is resolved from spouse relations only

Spouse display and kinship SHALL resolve from `SPOUSE` and `PARTNER` rows only. A shared child MUST NOT make two people spouses, and the system MUST NOT substitute a co-parent when no spouse row exists.

#### Scenario: Spouse row resolves to husband or wife

- **WHEN** two people are connected by a `SPOUSE` relation and also share a child
- **THEN** kinship between them resolves to husband, wife or partner by gender
- **AND** the displayed chain uses the spouse edge

#### Scenario: A co-parent is not a spouse

- **WHEN** two people share a child but have no spouse or partner relation
- **THEN** no husband, wife or partner term is produced for the pair
- **AND** any displayed chain goes through the child
- **AND** the graph does not draw a spouse line between them

### Requirement: The birth form exposes parent selection and localized state

The event form SHALL show zero to two optional parent pickers for a `BIRTH` event, excluding the child and already selected people. It SHALL show existing parent relations that are not part of the event as read-only hints. Automatic origin labels, parent-role labels, warnings and the new error code SHALL be localized in `ru`, `uk` and `en`.

#### Scenario: Selecting two parents in the form

- **WHEN** the user opens a new birth event and picks two different people as parents
- **THEN** both selections are visible before saving
- **AND** the saved event produces both parent relations

#### Scenario: A person cannot be picked twice

- **WHEN** one person is already selected as a parent
- **THEN** the other picker does not offer that person

#### Scenario: The child is not offered

- **WHEN** the parent picker is open
- **THEN** the event's owner is not in the list

#### Scenario: Errors and labels are localized

- **WHEN** a parent-age or cycle error is shown, or an automatic relation is labelled
- **THEN** the text appears in the active locale among `ru`, `uk` and `en`
- **AND** no user-facing string is hard-coded outside the locale files
