# Spec Delta

## Purpose

Defines how a child's patronymic is derived and filled from a biological father without overwriting stored names or guessing an unsupported form.

## ADDED Requirements

### Requirement: A Cyrillic father name derives a patronymic

The system SHALL derive a patronymic from the father's given name and the child's gender when the name is written in Cyrillic. The rule SHALL produce `Игоревич`/`Игоревна` for `Игорь`, `Андреевич`/`Андреевна` for `Андрей`, `Иванович`/`Ивановна` for `Иван` and `Никитич`/`Никитична` for `Никита`. It SHALL cover hard, soft and vowel endings and SHALL use Ukrainian or Belarusian suffixes when the spelling contains the distinct letters of those languages.

#### Scenario: A son and a daughter of the same father

- **WHEN** the father's given name is `Игорь` and the child is male
- **THEN** the derived patronymic is `Игоревич`
- **AND** for a female child it is `Игоревна`

#### Scenario: Other required common names

- **WHEN** the father's given name is `Андрей`, `Иван` or `Никита`
- **THEN** the derived forms are the expected `-евич`/`-евна` or `-ич`/`-ична` forms for each gender

#### Scenario: A Ukrainian or Belarusian spelling

- **WHEN** the father's given name is written with Ukrainian or Belarusian letters
- **THEN** the patronymic uses that language's suffix form
- **AND** a name carrying both sets of markers is left unresolved

### Requirement: The fill never overwrites a stored patronymic

The system SHALL write the derived patronymic only when the primary name's patronymic is absent or whitespace-only. It SHALL NOT replace a non-empty value, including an imported one. A person without names or with an unknown gender SHALL be left unchanged.

#### Scenario: An imported patronymic is kept

- **WHEN** a person already has a non-empty patronymic and gains a biological father
- **THEN** the stored patronymic is unchanged

#### Scenario: An empty value is filled once

- **WHEN** a person has no patronymic and a biological father with a usable Cyrillic given name
- **THEN** the derived value is stored
- **AND** a later save with a different father name does not replace it

#### Scenario: Unknown gender or no name

- **WHEN** the child's gender is unknown or the person has no name
- **THEN** the patronymic stays empty
- **AND** no error is reported

### Requirement: Unsupported or ambiguous cases are silent no-ops

The system SHALL leave the patronymic empty without an error when there is no biological father, more than one male biological parent, an adoptive-only parent, an unnamed father, a Latin or mixed-script name, or an ending the rule cannot resolve. The user SHALL still be able to enter the value manually.

#### Scenario: A Latin father

- **WHEN** the father's given name is `Igor` or another non-Cyrillic name
- **THEN** no patronymic is derived
- **AND** the relation and the person are stored normally

#### Scenario: No father at all

- **WHEN** the child has no `PARENT_CHILD` male parent
- **THEN** the patronymic is unchanged
- **AND** creating or saving the person succeeds

#### Scenario: Two male biological parents

- **WHEN** the child has two distinct male `PARENT_CHILD` parents
- **THEN** neither name is chosen and the patronymic stays empty

### Requirement: The fill runs on relation, birth-event and person saves

The system SHALL apply the fill when a biological `PARENT_CHILD` relation is created, when a `BIRTH` event that asserts the father is saved, and when the person form is saved with the father already stored. It SHALL NOT write during project open, backfill, import, export or a read-only request.

#### Scenario: Creating the father relation

- **WHEN** a biological `PARENT_CHILD` relation with a male Cyrillic father is created and the child's patronymic is empty
- **THEN** the child's patronymic is filled in the same command

#### Scenario: Selecting the father in a birth event

- **WHEN** a `BIRTH` event is saved with a male participant who becomes the child's biological parent
- **THEN** the child's empty patronymic is filled after the parent relation is derived

#### Scenario: Saving the person form

- **WHEN** the person form is saved for a child whose stored relations include one biological father
- **THEN** the submitted empty patronymic is filled before the person is written
- **AND** the saved response carries the filled value

#### Scenario: Opening a project does not fill

- **WHEN** a writable or read-only project is opened or backfilled
- **THEN** no patronymic is written by that pass
