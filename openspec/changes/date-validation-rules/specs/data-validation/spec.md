# Spec Delta

## Purpose

Defines which dates and parent/child relations a family archive accepts, using date precision
instead of invented exact dates, so valid historical records are not rejected and impossible ones
are reported with stable, localized codes.

## ADDED Requirements

### Requirement: Residence period may omit its end

A residence event SHALL be saveable with a start bound and no end bound. The missing end SHALL mean
that the period is ongoing and SHALL be stored as an absent bound, never replaced by the current
date, a sentinel or another invented value. Reopening, editing and exporting the project SHALL keep
the end absent.

#### Scenario: Ongoing residence saves and round-trips

- **WHEN** a residence event is saved with a start date and no end date
- **THEN** the event is stored and can be read back with the same start and no end
- **AND** no date is written in place of the missing end

#### Scenario: Residence with both bounds is unchanged

- **WHEN** a residence event is saved with a start and an end
- **THEN** it is stored as a closed period exactly as before this change

#### Scenario: Unknown residence date is still allowed

- **WHEN** a residence event is saved with an unknown date and no bounds
- **THEN** it is accepted and remains unknown

### Requirement: Residence periods of one person must not overlap

Two residence periods of the same person SHALL NOT overlap. Periods are half-open: `end` is
exclusive, so a period ending exactly when the next one starts is allowed. A missing end extends the
period to infinity; a missing start extends it to negative infinity. A period with an unknown date
is not compared. A manual create or update that would create an overlap SHALL be rejected with the
stable code `RESIDENCE_RANGE_OVERLAP`.

#### Scenario: Overlapping periods are rejected

- **WHEN** a person already has a residence period covering 1950–1960 and a second period covering
  1955–1965 is saved
- **THEN** the save is rejected with `RESIDENCE_RANGE_OVERLAP`

#### Scenario: Adjacent periods are allowed

- **WHEN** a person has a residence period ending in 1960 and a second period starting in 1960
- **THEN** both periods are accepted

#### Scenario: Open-ended period overlaps a later period

- **WHEN** a person has an open-ended residence period starting in 1970 and a period starting in
  1980 is saved
- **THEN** the save is rejected with `RESIDENCE_RANGE_OVERLAP`

#### Scenario: Unknown residence dates are not compared

- **WHEN** one of the two residence events has an unknown date
- **THEN** no overlap is reported

### Requirement: Birth ordering is precision-aware

Birth SHALL be anchored at the first day of its precision interval: 1 January for a year, the first
day of the month for a month, and the exact day for a day. An event SHALL be reported as before the
birth only when the whole known interval of the event lies before that anchor. An event in the same
year or month as the birth SHALL NOT be reported. An event with an open end SHALL NOT be reported as
before the birth.

#### Scenario: Birth year and event in the same year

- **WHEN** a person is born in 1900 (year precision) and an event is dated 1900 (year precision)
- **THEN** the event is not reported as before the birth

#### Scenario: Birth month and event in the same month

- **WHEN** a person is born in May 1900 (month precision) and an event is dated May 1900
- **THEN** the event is not reported as before the birth

#### Scenario: Event in an earlier year is rejected

- **WHEN** a person is born in 1900 (year precision) and an event is dated 1899
- **THEN** the event is reported as before the birth with `EVENT_OUT_OF_LIFESPAN`

#### Scenario: Exact event before an exact birth is rejected

- **WHEN** a person is born on 10 May 1900 and an event is dated 9 May 1900
- **THEN** the event is reported as before the birth with `EVENT_OUT_OF_LIFESPAN`

#### Scenario: Event on the birth day is accepted

- **WHEN** a person is born on 10 May 1900 and an event is dated 10 May 1900
- **THEN** the event is not reported as before the birth

#### Scenario: Event with an open end is not before birth

- **WHEN** an event starts before the birth anchor and has no end bound
- **THEN** it is not reported as before the birth

### Requirement: Birth and death ordering use the same interval comparison

A birth SHALL be reported as contradicting a death only when the birth anchor is after the whole
known interval of the death. A death SHALL be reported as contradicting a birth only when the death
anchor is before the whole known interval of the birth. Dates in the same year or month SHALL NOT
be reported as contradictory.

#### Scenario: Same-year birth and death are not contradictory

- **WHEN** a person has a birth and a death in the same year at year precision
- **THEN** no contradiction is reported

#### Scenario: Birth after a closed death interval is contradictory

- **WHEN** the death is dated 1900 (year precision) and the birth is dated 1901
- **THEN** the birth is reported as outside the lifespan with `EVENT_OUT_OF_LIFESPAN`

### Requirement: Unknown dates skip date validation

A date with `UNKNOWN` precision, or a comparison that lacks the required bound, SHALL skip the
check. The validator SHALL NOT assume a day, month or year and SHALL NOT block the save because a
date is unknown.

#### Scenario: Unknown event date is not validated

- **WHEN** an event with an unknown date belongs to a person with a known birth date
- **THEN** the event is accepted and no lifespan issue is produced

#### Scenario: Unknown birth date disables age checks

- **WHEN** a parent or child has an unknown birth date
- **THEN** the parent/child age check is skipped

### Requirement: Parent must be at least nine years older than the child

A `PARENT_CHILD` relation SHALL be rejected when the parent's birth anchor plus nine calendar years
is later than the child's birth anchor. Exactly nine years SHALL be accepted. The check SHALL apply
to `PARENT_CHILD` only, not to `ADOPTIVE_PARENT_CHILD`. A manual create SHALL be rejected with the
stable code `PARENT_CHILD_AGE_GAP`.

#### Scenario: Parent younger by less than nine years is rejected

- **WHEN** the parent is born in 1900 and the child in 1908
- **THEN** the relation is rejected with `PARENT_CHILD_AGE_GAP`

#### Scenario: Exactly nine years is accepted

- **WHEN** the parent is born on 1 January 1900 and the child on 1 January 1909
- **THEN** the relation is accepted

#### Scenario: Older parent is accepted

- **WHEN** the parent is born in 1880 and the child in 1910
- **THEN** the relation is accepted

#### Scenario: Adoptive parent is not subject to the age gap

- **WHEN** an `ADOPTIVE_PARENT_CHILD` relation is created with less than nine years between the
  births
- **THEN** the relation is accepted

### Requirement: Violations use stable, localized codes

Every violation introduced by these rules SHALL carry a stable upper-snake-case code and
machine-readable parameters containing entity identifiers and the violated bound, never personal
names or resolved dates in prose. The UI SHALL localize the codes in English, Russian and Ukrainian,
and every dictionary checked by the i18n gate SHALL keep key parity. Source code SHALL contain no
Cyrillic outside the locale dictionaries and no absolute paths.

#### Scenario: Overlap error is localized

- **WHEN** a residence overlap is rejected in a Russian, Ukrainian or English UI
- **THEN** the message is shown in that language for `RESIDENCE_RANGE_OVERLAP`

#### Scenario: Age-gap error is localized

- **WHEN** a parent/child age gap is rejected in a Russian, Ukrainian or English UI
- **THEN** the message is shown in that language for `PARENT_CHILD_AGE_GAP`

#### Scenario: Unknown codes fall back safely

- **WHEN** the UI receives a validation code without a translation
- **THEN** it shows a generic localized fallback and does not display raw parameters

### Requirement: No retroactive normalization of existing data

These rules SHALL gate manual create and update only. Opening, reading, searching, exporting,
re-importing or merging a project SHALL NOT rewrite, drop or normalize existing dates, residence
periods or relations. Project validation SHALL report violations as findings without preventing the
project from being opened or merged, and imports SHALL still report unparsed data instead of
silently changing it.

#### Scenario: Legacy overlapping data stays readable

- **WHEN** a project with two overlapping residence periods is opened
- **THEN** both events are still present and unmodified
- **AND** validation reports the overlap without blocking the project

#### Scenario: Re-import does not rewrite dates

- **WHEN** the same source file is imported again into a project with these rules
- **THEN** existing rows and their dates are unchanged
- **AND** the import remains idempotent

#### Scenario: Merge is not blocked by legacy findings

- **WHEN** two projects are merged and the result contains a legacy residence overlap
- **THEN** the merge completes and reports the finding instead of failing
