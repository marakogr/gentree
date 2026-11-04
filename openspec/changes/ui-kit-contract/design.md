# Design

## Context

The UI is visually stable: `classic` and `swiss` share one token bridge, contrast is measured, and
the screens look like one product. The code under that surface is not layered:

- 20,450 lines of TSX and 7,489 lines of CSS under `features/`, built on 12 primitives in
  `components/ui` and 6 components in `components/filters`.
- Two independent table stacks: Fluent `Table` with `colgroup`, resize and column menu in
  `PersonsPage` and `EventsPage`, and a raw `<table>` with Tailwind utilities in `TimelinePage`.
- Byte-identical CSS blocks (`splitter`, `.col-resize-handle`) and about 190 duplicated lines of
  splitter logic across the two list pages.
- 47 raw `<button>` elements, 13 files importing Fluent `Button` directly, 6 hand-written
  `role="dialog"` surfaces, and two exports named `EmptyState`.
- `components/filters/EventFilterHeader` imports `features/events` and `features/persons`, so the
  shared layer depends on the features it is supposed to serve.
- Three styling mechanisms coexist: `makeStyles` + tokens (25 files), Tailwind utilities (9 files)
  and 162 global selectors in `styles.css`.
- Gates are `tsc --strict`, `vitest` (64 pure test files, 0 component tests), `i18n-check` and a
  token contrast test. There is no ESLint, although 5 `eslint-disable` comments remain. The e2e
  review harness exists but is optional and Windows-oriented.

AGENTS.md requires user-facing strings in `i18n/locales`, stable error codes, and no Cyrillic in
`src`. Two style axes (`classic`, `swiss`) multiply every visual decision by two, and two schemes by
another two.

See `proposal.md` for motivation. The media library, sources and places screens are out of scope,
but the extracted patterns must not assume a table body.

## Goals / Non-Goals

**Goals:**

- One implementation of each repeated page-level pattern, with two real consumers before it is
  considered shared.
- A dependency direction that the build enforces, not a convention in comments.
- Behavior that can be tested without a DOM: geometry, keyboard, selection, pagination, layout.
- A gate that fails new violations while letting existing debt be paid down.

**Non-Goals:**

- New screens, new IPC, Rust changes, project-format changes.
- Replacing Fluent UI or the token bridge.
- A component-test framework or a visual-regression service.
- ESLint in this change.
- Any visual redesign.

## Decisions

### D1. Fluent stays the behavior engine; the kit is a thin typed layer

Keep Fluent UI v9 for interaction, accessibility and positioning, and keep the existing wrappers
(`Button`, `MenuButton`, `Dialog`, `Combobox`). The change adds a pattern layer above them.

Alternatives: own primitives (re-implements listbox, dialog and menu, risks a11y regressions);
headless hooks + custom markup (most expensive, no user-visible gain at this size). Both are
rejected for cost, not for taste.

### D2. Composition and pure hooks, not a config-driven table

`DataTable` exposes `DataTable`, `HeaderCell` (sortable, resizable, with an `aside` slot),
`colgroup`/width helpers and the selection column. Pages keep rendering their own cells as JSX.
Resize, sort direction and column visibility stay in pure modules/hooks (`lib/tableColumns.ts`
already exists and is tested).

Alternatives: `<DataTable columns={[{ key, render }]} />` turns every domain cell into a render
prop and pulls i18n into the config; a fully headless table gives no visual consistency. Composition
keeps the shared part shared and the domain part in the feature.

### D3. `CollectionShell` is extracted from two real screens, with a body slot

Persons and Events already have the same shape: toolbar, optional bulk bar, filter slot, list pane,
vertical splitter, detail pane, footer/pager. The shell owns that layout and accepts the body as a
slot, so a table is the first consumer and a grid remains possible without designing for it now. No
grid component is added in this change.

### D4. Zero-dependency checks now, ESLint later

The checks are Node scripts in `desktop/ui/scripts`, modeled on `i18n-check.mjs`: read files, apply
rules, print `rule file count`, exit non-zero. They are wired into `make ui-check`. This avoids a new
dev dependency (HITL per AGENTS.md) and avoids a noisy first ESLint run over 20k lines.

Alternatives: ESLint with `no-restricted-imports`/`no-restricted-syntax` (better for JSX structure,
but a dependency plus baseline ceremony); Biome (same problem, less ecosystem); no gate (rejected -
this change exists because convention alone drifted). ESLint remains a candidate after the debt
drops; that is recorded as an open question, not a hidden dependency.

### D5. Central allowlist with a ratchet, not inline pragmas

`desktop/ui/ui-kit.allowlist.json` records `{ rule, file, count, reason }`. The checker compares the
current count to the recorded one: more fails, fewer warns and must be lowered in the same change.
New files are checked with no allowance.

Alternatives: inline `// allow` comments (local and self-documenting, but easy to hide and hard to
audit as a whole); a generated baseline snapshot (a large opaque diff that nobody reviews); fixing
everything first (blocks the branch for weeks and mixes refactor with design decisions).

### D6. Keep current locations; add one new directory

Primitives stay in `components/ui`. New compositions go to `components/patterns`. Event-specific
composites (`EventFilterHeader`, `TimelineFilters` merge) move to `features/events`, which removes
the reverse dependency. `lib/` keeps pure helpers and hooks.

Alternatives: move everything to `src/ui/` (a mass rename with no behavioral gain and an unreviewable
diff); put patterns next to features (recreates the duplication the change removes).

### D7. Pure modules are the tested contract

Every extracted behavior gets a pure module with unit tests, following the existing pattern
(`multiSelectRules`, `yearRangeRules`, `tableColumns`, `viewState`). Components stay thin. No
component-test framework is introduced; DOM behavior is checked manually in the four style
combinations and, when available, through the existing e2e harness.

### D8. Token-only styling inside the kit

Shared components use `makeStyles` + `tokens`. Tailwind utilities and raw colours are rejected by
the style check. Global page classes must not be required by a shared component, otherwise `swiss`
cannot re-skin it. `swiss.css` is not edited except for a genuine missing bridge.

## Risks / Trade-offs

- **Visual drift while extracting** -> migration is per screen and per pattern; screenshots in
  `classic`/`swiss` x light/dark are part of every extraction task; styling stays token-only.
- **Behavioral regression in keyboard or ARIA** -> keep existing roles, labels and focus order;
  move logic into tested pure modules before changing call sites; manual keyboard pass per screen.
- **Allowlist rot** -> counts are printed on every run, stale entries are reported, and touching a
  file requires lowering its entry. The list only shrinks.
- **Refactor scope creep** -> new screens and visual fixes are explicitly out of scope; a defect
  found during extraction becomes a separate change.
- **Two style axes** -> new patterns must use existing tokens and classes that `swiss.css` already
  targets; any new selector needs a check in both axes.
- **Resize and splitter internals** -> these rely on pointer capture and `requestAnimationFrame`;
  keep effects idempotent for React 18 StrictMode and cover pure math with tests.
- **Shared table becomes too generic** -> the API is composition + slots; if a feature needs a
  different cell, it renders it, it does not add a prop to `DataTable`.

## Migration Plan

Phases are independently shippable and revertible; there is no data, format or IPC change.

1. Contract + checker in report mode + allowlist seeded with today's counts.
2. Small patterns (page shell/toolbar, splitter, pager, sort icon, column menu); migrate Persons and
   Events; delete the duplicated CSS.
3. `DataTable`; migrate Persons, then Events; move the timeline's undated table if it fits.
4. `CollectionShell`; migrate both list screens onto it.
5. Filter layering: generic pieces stay shared, event composite moves to `features/events`; merge
   the timeline filter row.
6. Dropdown base; rebuild single and multi-select on it; document the searchable exception.
7. Cleanup (dead `EmptyState`, raw controls, unused CSS) and flip the checks to blocking.

Rollback is a per-phase revert: after each phase the app has one fewer duplicate and one more shared
component, never a half-migrated screen.

## Open Questions

- When to adopt ESLint: after the debt drops, or never. Does not change the specs or the task split.
- Whether the timeline's undated table fits the compact `DataTable` or stays an allowlisted raw
  table. Decided in phase 3 by trying it; the approach does not change.
- Final naming of the filter directory after the domain split (`components/filters` vs
  `components/patterns`). Cosmetic; decided in phase 5.
