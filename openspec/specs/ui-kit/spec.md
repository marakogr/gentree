# ui-kit Specification

## Purpose

Defines the shared UI layer of the desktop app: which primitives and patterns exist, how they may
depend on each other, and how screens compose them.

## Requirements

### Requirement: UI layers have a single dependency direction

UI code SHALL be organized in layers with one allowed direction: `features` may import patterns and
primitives; patterns may import primitives, foundations and pure helpers; primitives may import
foundations and pure helpers. Shared components and patterns MUST NOT import feature modules, API
clients or domain entity types. Pure helper modules MUST NOT import React components.

#### Scenario: Shared component imports a feature module

- **WHEN** a file under `src/components/` imports from `src/features/`, `src/api/` or a domain type
- **THEN** the conformance check fails and names the importing file and the rule

#### Scenario: Feature composes shared patterns

- **WHEN** a feature screen imports primitives and patterns from the shared layer
- **THEN** the boundary check passes

#### Scenario: Pure helper imports a component

- **WHEN** a module without React imports a component module
- **THEN** the boundary check fails

### Requirement: Shared components own framework controls

Interactive controls SHALL be consumed through the shared kit: button, icon button, menu, dialog,
dropdown, text field and date field. Raw native controls and direct Fluent UI primitives MAY appear
only inside shared components or in an allowlisted renderer whose markup is not a standard control.

#### Scenario: New raw button in a feature

- **WHEN** a feature file adds a raw `<button>`, `<select>` or `role="dialog"` outside the kit
- **THEN** the conformance check fails

#### Scenario: Graphics renderer

- **WHEN** a canvas, graph or markdown renderer needs element-level markup
- **THEN** it passes only through an allowlist entry that records the file, the rule and a reason

### Requirement: Shared components are domain- and locale-free

Shared components MUST receive all user-visible text and all data through props. They MUST NOT call
`useTranslation`, import locale namespaces, API clients or feature modules, and MUST NOT declare
domain entity types.

#### Scenario: Kit component translates its own label

- **WHEN** a file under `src/components/` calls `useTranslation`
- **THEN** the kit-purity check fails

#### Scenario: Screen passes strings down

- **WHEN** a feature screen translates its labels and passes them as props
- **THEN** the kit-purity check passes

### Requirement: Screens compose shared patterns

A list screen with a detail pane SHALL be composed from the shared collection shell, data table,
splitter and pager. Screens MUST NOT re-implement pager markup, splitter dragging, column menus,
column resizing or sortable header cells.

#### Scenario: Existing list screens

- **WHEN** the persons and events screens are migrated
- **THEN** the repository contains one pager definition, one splitter implementation and one
  sortable-header implementation

#### Scenario: Screen-local splitter

- **WHEN** a screen introduces its own splitter drag logic instead of the shared pattern
- **THEN** the conformance check fails

### Requirement: Interaction logic lives in tested pure modules

Non-trivial interaction logic - geometry, keyboard navigation, selection, pagination and persisted
layout - SHALL live in pure TypeScript modules covered by unit tests. Components SHALL only
translate that logic into DOM and MUST NOT duplicate it.

#### Scenario: Splitter bounds change

- **WHEN** a splitter bound or keyboard step changes
- **THEN** a unit test for the pure module fails until the expectation is updated

#### Scenario: Keyboard rules are testable

- **WHEN** listbox or splitter keyboard behaviour is covered
- **THEN** it is exercised through the pure module without rendering a component

### Requirement: Kit styling uses design tokens

Shared components SHALL style with Fluent `makeStyles` and design tokens. They MUST NOT use Tailwind
utility classes, raw hex/rgb/hsl colours or page-global classes. Every shared component SHALL render
in both style axes (`classic`, `swiss`) and both colour schemes.

#### Scenario: Raw colour in a shared component

- **WHEN** a shared component contains a raw hex, rgb or hsl value
- **THEN** the style check fails

#### Scenario: Both style axes

- **WHEN** a shared component is rendered with `data-style="classic"` and with `data-style="swiss"`
- **THEN** it keeps its structure, and colours, borders and radii come from tokens in both
