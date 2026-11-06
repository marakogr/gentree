# Spec Delta

## Purpose

Keeps a biological parent relation and the child's birth event in sync in both directions, and makes an event-derived relation indistinguishable from a manual one in the person card while retaining provenance for retraction.

## ADDED Requirements

### Requirement: Automatic relations are presented like manual relations

The person card SHALL render an event-derived relation exactly like a manual relation: no origin badge, no source-event label, and no different ordering or action. `origin` and `sourceEventIds` SHALL remain stored and exposed by the API so event edits can still retract their own rows; they SHALL NOT affect presentation.

#### Scenario: An automatic row looks manual

- **WHEN** a relation was derived from a marriage or birth event
- **THEN** the person card shows the same relation label, person link and actions as for a manual row
- **AND** no "Automatic" badge and no source-event type or date is shown

#### Scenario: Provenance is retained for retraction

- **WHEN** an automatic relation is displayed without its origin
- **THEN** `origin` and `sourceEventIds` are still stored and returned by the API
- **AND** editing or deleting its source event still retracts it

#### Scenario: A manual relation looks the same

- **WHEN** a relation was created through the relationship commands or loaded as legacy data
- **THEN** it is presented exactly like an automatic row

#### Scenario: Deleting an automatic row is not durable

- **WHEN** the user deletes an automatic relation while its source event still asserts it
- **THEN** the row is removed and the backend accepts the delete
- **AND** the UI warns that the next save of a source event can recreate it

### Requirement: Creating a biological parent relation fills the birth event

Creating a `PARENT_CHILD` relation SHALL add the parent to the child's `BIRTH` event `participant_ids` when the parent is not already listed. `person_id` SHALL be the parent and `related_person_id` the child. The participant list SHALL stay compact, with no nil placeholder. The relation SHALL be stored even when the event is left untouched.

#### Scenario: A father is added to an empty birth

- **WHEN** a child has a birth event without participants and a male parent relation is created
- **THEN** the father is the first participant of that birth event
- **AND** the `PARENT_CHILD` relation is stored

#### Scenario: A mother follows the father

- **WHEN** a child's birth event already lists the father and a female parent relation is created
- **THEN** the mother is the second participant of that birth event

#### Scenario: A lone mother is compact

- **WHEN** a child has a birth event without participants and a female parent relation is created
- **THEN** she is the only participant of that event
- **AND** adding the father later puts him first and keeps her second

#### Scenario: An unknown gender takes the first free slot

- **WHEN** a parent with unknown gender is added to a birth event with zero or one participant
- **THEN** the parent is appended to the participant list

#### Scenario: Both slots are occupied

- **WHEN** the child's birth event already has two participants, neither of them the new parent
- **THEN** the event participants are not changed
- **AND** the `PARENT_CHILD` relation is still stored

#### Scenario: The parent is already listed

- **WHEN** the parent already appears in the child's birth event participants
- **THEN** no participant is added
- **AND** the relation is stored once

#### Scenario: An adoptive relation does not touch the event

- **WHEN** an `ADOPTIVE_PARENT_CHILD` relation is created
- **THEN** no birth event participant is added or removed

#### Scenario: Several birth events

- **WHEN** the child has several `BIRTH` events
- **THEN** the earliest dated event with a free parent slot is updated
- **AND** undated events sort after dated ones and ties break by event id
- **AND** the parent is not added to a second event

### Requirement: Deleting a biological parent relation clears the birth event

Deleting a `PARENT_CHILD` relation SHALL remove that parent from every `BIRTH` event owned by the child. A birth event that loses its last participant SHALL remain valid and SHALL NOT be deleted. `ADOPTIVE_PARENT_CHILD` deletion SHALL NOT change any event.

#### Scenario: One of two parents is removed

- **WHEN** a `PARENT_CHILD` relation is deleted while the child's birth event lists both parents
- **THEN** the deleted parent is removed from `participant_ids`
- **AND** the other parent stays listed
- **AND** the relation row is deleted

#### Scenario: The last parent is removed

- **WHEN** the deleted relation was the only parent in the child's birth event
- **THEN** the event keeps existing with an empty participant list
- **AND** the event remains valid

#### Scenario: Several birth events are cleared

- **WHEN** the child has several birth events that list the deleted parent
- **THEN** the parent is removed from each of them

#### Scenario: An adoptive relation is deleted

- **WHEN** an `ADOPTIVE_PARENT_CHILD` relation is deleted
- **THEN** birth event participants are unchanged

### Requirement: Parent and birth-event sync is idempotent

The reverse sync SHALL NOT create duplicate relations, SHALL NOT re-add a parent after the relation is deleted, and SHALL keep event save derivation stable. Saving the event after a create or delete SHALL neither duplicate the existing relation nor recreate the deleted one.

#### Scenario: Repeating a create

- **WHEN** the same parent relation is created twice
- **THEN** the second create is rejected by the relationship set
- **AND** the birth event participants are unchanged by the rejected call
- **AND** exactly one relation row exists

#### Scenario: Saving the event after a create

- **WHEN** the birth event is saved after the parent relation was created
- **THEN** derivation finds the matching row and adds nothing
- **AND** repeated saves leave the relation count unchanged

#### Scenario: Saving the event after a delete

- **WHEN** the birth event is saved after the parent relation was deleted
- **THEN** the event has no such participant and derivation creates no relation

#### Scenario: Two birth events never duplicate a parent

- **WHEN** the parent already appears in one birth event of the child
- **THEN** the reverse sync leaves all birth events unchanged
