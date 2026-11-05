# Spec Delta

## Purpose

Defines how the tree screen chooses visible people and generations, including the optional display of spouses beside the root and blood relatives, while keeping one card per person and a stable blood-relative layout.

## ADDED Requirements

### Requirement: Spouses are an explicit opt-in view

The tree screen SHALL provide a "Show spouses" toggle. The toggle MUST be off by default, so the initial view contains the same people in the same positions as the current tree.

#### Scenario: First open with the toggle off

- **WHEN** a user opens the tree for a project with spouses recorded
- **THEN** no spouse-only card is shown and the blood-relative layout matches the pre-change view

#### Scenario: User enables the toggle

- **WHEN** the user turns "Show spouses" on
- **THEN** spouse cards appear in the same render pass without reloading the project

#### Scenario: Toggle is announced

- **WHEN** the toggle has focus
- **THEN** it exposes its pressed state and a localized accessible name

### Requirement: The toggle survives navigation within a session

The chosen toggle state SHALL persist while the app runs and reset to off when the app restarts. It MUST NOT be written into the project folder, its manifest or exports.

#### Scenario: Tab switch and return

- **WHEN** the user enables spouses, opens another tab and returns to the tree
- **THEN** the toggle is still on and spouse cards are shown

#### Scenario: Restart

- **WHEN** the app is restarted and the tree is opened
- **THEN** the toggle is off again and no project file changed

### Requirement: Spouses are shown for the root and for relatives

When the toggle is on, the tree SHALL show the current `SPOUSE` and `PARTNER` partners of the root and of every displayed blood relative. This applies to the combined, ancestor, descendant and blood-relative modes. The rootless whole-project mode MUST keep its current behavior.

#### Scenario: Root has a spouse

- **WHEN** the root has a `SPOUSE` relationship and the toggle is on
- **THEN** the spouse card is displayed next to the root

#### Scenario: Relative has a spouse

- **WHEN** a displayed sibling or cousin has a `PARTNER` relationship and the toggle is on
- **THEN** that partner card is displayed next to the relative

#### Scenario: A spouse is not a blood relative

- **WHEN** a spouse has no blood link to the root
- **THEN** the spouse is shown as a spouse card only, not as a blood generation

#### Scenario: Rootless whole-project mode

- **WHEN** the user switches to the whole-project tree
- **THEN** spouse visibility follows the existing behavior and the toggle does not add or remove its nodes

### Requirement: A spouse shares the partner's generation

Each spouse card SHALL use the generation of the partner. Showing spouses MUST NOT change the generation of any blood relative or the vertical order of blood generations.

#### Scenario: Spouse does not shift a blood level

- **WHEN** the toggle is enabled on a tree with known generations
- **THEN** every blood person keeps their pre-toggle generation and vertical position relative to other generations

#### Scenario: Spouse of an ancestor

- **WHEN** a grandparent has a spouse who is not the root's other grandparent
- **THEN** that spouse appears on the grandparent generation, adjacent to the grandparent

### Requirement: A spouse is placed next to the partner without overlap

A spouse-only card SHALL be laid out immediately adjacent to the partner on the same row, with a spouse connector between the two cards. When both partners are blood cards, neither card moves and the connector is routed clear of card bodies. Cards MUST NOT overlap and the couple MUST remain readable at the default fit scale.

#### Scenario: Couple reads as one block

- **WHEN** a person and one spouse-only card are displayed
- **THEN** their cards are neighbours and a connector joins them

#### Scenario: Both partners are blood relatives

- **WHEN** both spouses are already displayed blood cards
- **THEN** their blood positions stay unchanged and a routed connector joins them without crossing another card

#### Scenario: Neighbouring families do not collide

- **WHEN** two siblings both have spouses displayed
- **THEN** each couple occupies its own horizontal space and no card overlaps another

### Requirement: One card per person

The tree SHALL render each person at most once. A spouse who is also a blood relative MUST keep the blood card and MUST only gain a spouse connector; a person related by several marriages MUST NOT be repeated.

#### Scenario: Married cousins

- **WHEN** two displayed blood relatives are also spouses
- **THEN** each appears once on their blood generation with one connector between them

#### Scenario: Repeated relationship rows

- **WHEN** the project stores the same spouse pair more than once
- **THEN** the tree still shows one spouse card and one connector

#### Scenario: Person married twice

- **WHEN** a displayed person has two spouses and both are shown
- **THEN** the person still has one card and each spouse appears once

### Requirement: Children stay under their parent or couple

Children SHALL remain attached to their blood parent placement. Showing a spouse MUST NOT duplicate a child under the spouse, MUST NOT move a child to a different generation, and MUST NOT create a second subtree for the same child.

#### Scenario: Couple with common children

- **WHEN** both partners are displayed and have common children
- **THEN** each child appears once below the couple, not once per partner

#### Scenario: Spouse with children from another union

- **WHEN** a displayed spouse has a child who is not a descendant of the blood partner
- **THEN** that child is not added by this view unless it is already part of the displayed blood set

### Requirement: Multiple spouses are ordered predictably

When a person has several spouses or partners, the view SHALL place all distinct displayed partners in a deterministic order: relationship order first, then person id. Equal project data MUST produce equal positions.

#### Scenario: Two spouses of the root

- **WHEN** the root has two spouse relationships and the toggle is on
- **THEN** both spouses are shown in a stable order on the root generation

#### Scenario: Deterministic re-render

- **WHEN** the same project is laid out twice with the same toggle state
- **THEN** node positions and spouse order are identical

### Requirement: Disabling the toggle restores the previous view

Turning the toggle off SHALL remove spouse-only cards and connectors and SHALL restore the pre-toggle positions, zoom baseline and canvas bounds for the current mode.

#### Scenario: Toggle off after on

- **WHEN** the user turns the toggle on, then off
- **THEN** blood nodes return to their previous coordinates and no spouse-only node remains

#### Scenario: Toggle on then off in another mode

- **WHEN** the toggle is enabled in the blood-relative mode and disabled in the combined mode
- **THEN** the combined mode renders exactly as it did without spouses

### Requirement: Unknown and incomplete data degrade gracefully

Spouse display SHALL rely on the relationship type, not on gender. A person with unknown gender or missing names MUST still receive a readable card. A person without a spouse MUST NOT get a placeholder spouse.

#### Scenario: Unknown gender

- **WHEN** a spouse has `UNKNOWN` gender
- **THEN** the card is shown without a gendered role label and without a layout error

#### Scenario: No spouse data

- **WHEN** the project has no `SPOUSE` or `PARTNER` relationships
- **THEN** the toggle remains usable, the view shows the ordinary tree, and no empty spouse notice is treated as an error

#### Scenario: Self-link or dangling relationship

- **WHEN** a spouse relationship points to the same person or to a person outside the loaded project
- **THEN** it is ignored without a duplicate card, crash or broken connector

### Requirement: Large trees remain responsive

Spouse decoration SHALL be computed from the already loaded people and relationships without a new IPC request, in time and memory proportional to the displayed nodes and their spouse links. A synthetic tree of hundreds of nodes MUST lay out without duplicate cards or visible overlap.

#### Scenario: Broad synthetic tree

- **WHEN** the toggle is enabled on a synthetic tree with several hundred people and many spouses
- **THEN** the layout completes within the screen's existing interaction budget and uses no additional backend call

#### Scenario: Dense multiple marriages

- **WHEN** many people in that tree have two or more spouses
- **THEN** the layout has no duplicate occurrence keys and no overlapping cards

### Requirement: Spouse view coexists with tree fixes and event-derived relations

The spouse view SHALL keep the blood layout rules of issue #82 and SHALL consume relationship rows as stored, so relationships derived from events (#80) need no separate tree path. It MUST NOT change the relation model, project format or IPC surface.

#### Scenario: Parent alignment and name wrapping

- **WHEN** parents are aligned on one level and names wrap to three lines
- **THEN** spouse cards respect the same node size, alignment and wrapping without covering neighbours

#### Scenario: Marriage event creates a spouse relationship

- **WHEN** a marriage event has materialized a `SPOUSE` relationship
- **THEN** the tree shows the spouse when the toggle is on without event-specific code

#### Scenario: No new data surface

- **WHEN** the change is implemented
- **THEN** no IPC command, project-format field or dependency is added

### Requirement: Toggle copy is localized

The toggle label, its hint and any spouse-related status or empty copy SHALL exist in Russian, Ukrainian and English, with no user-facing text outside the locale dictionaries.

#### Scenario: All three locales

- **WHEN** the UI language is Russian, Ukrainian or English
- **THEN** the toggle and its hint render in that language

#### Scenario: I18n gate

- **WHEN** `make i18n` runs
- **THEN** no untranslated or locale-leaking string is reported
