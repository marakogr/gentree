# Spec Delta

## Purpose

Keeps the shared UI layer from drifting again by making its rules executable in the standard check
pipeline, and by defining how existing debt is paid down instead of frozen.

## ADDED Requirements

### Requirement: Conformance checks run in the UI gate

`make ui-check` SHALL run the UI conformance checks and SHALL fail on any non-allowlisted violation.
Each failure SHALL name the rule, the file and the offending count or location.

#### Scenario: Violation fails the gate

- **WHEN** a checked rule is violated outside the allowlist
- **THEN** `make ui-check` exits non-zero and prints the rule, the file and the count

#### Scenario: Clean tree passes

- **WHEN** no rule is violated
- **THEN** the check exits zero and prints the per-rule totals

### Requirement: Legacy debt is ratcheted

Existing violations SHALL be recorded in a versioned allowlist that names the rule, the file, the
recorded count and a reason. Recorded counts MUST NOT increase, files not present in the allowlist
MUST be fully compliant, and a file being modified SHALL remove or lower its entry.

#### Scenario: Violation grows in an allowlisted file

- **WHEN** an allowlisted file gains more violations than its recorded count
- **THEN** the check fails

#### Scenario: New file with a violation

- **WHEN** a file that is not in the allowlist introduces a violation
- **THEN** the check fails

#### Scenario: Debt is removed

- **WHEN** a file loses violations or a file disappears
- **THEN** the check reports the stale entry and the allowlist is lowered in the same change

### Requirement: Checks are zero-dependency and deterministic

Checks SHALL run on the repository's existing Node runtime without additional npm packages, network
access or generated baselines, and SHALL produce stable, human-readable output.

#### Scenario: Offline run

- **WHEN** the checks run without network access
- **THEN** they produce the same result as an online run

#### Scenario: Repeated run

- **WHEN** the checks run twice on an unchanged tree
- **THEN** the output and exit code are identical

### Requirement: The contract is documented and discoverable

The repository SHALL contain a human-readable guide describing the layers, the allowlist process,
the styling rules and the definition of done for a new screen. The guide SHALL be reachable from
`AGENTS.md` and from the UI package.

#### Scenario: Contributor looks for the rules

- **WHEN** a contributor follows the detailed-guides table in `AGENTS.md`
- **THEN** the UI kit guide is reachable and lists the layers, the allowlist process and the
  new-screen checklist

#### Scenario: Checklist is actionable

- **WHEN** a new screen is prepared for review
- **THEN** the checklist names the shared patterns to use and the commands that must pass

### Requirement: Extraction is verified as pixel-neutral

A change that extracts shared components SHALL include before/after evidence for every affected
screen in `classic` and `swiss`, light and dark. An intended visual change SHALL be delivered as a
separate change.

#### Scenario: Extraction change

- **WHEN** a screen is migrated to a shared pattern
- **THEN** the change carries four-combination screenshots and the reviewer confirms no visual
  difference

#### Scenario: Visual change is needed

- **WHEN** the migration reveals a design defect that should be fixed
- **THEN** the fix is proposed separately instead of being folded into the extraction
