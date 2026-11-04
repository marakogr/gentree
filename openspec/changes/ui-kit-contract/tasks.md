# Tasks

## 1. Contract and conformance foundation

- [x] 1.1 Write `docs/agents/ui-kit.md`: layers and allowed imports, primitive ownership, styling
  rules, allowlist process, definition of done for a new screen. Link it from the detailed-guides
  table in `AGENTS.md`. Verify every rule maps to a requirement in `specs/ui-kit` or
  `specs/ui-conformance`, and that the guide is reachable from `AGENTS.md`.
- [x] 1.2 Extract the checker's pure logic into `desktop/ui/scripts/ui-kit-rules.mjs` (allowlist
  parsing, count comparison, rule matching, path classification) and add
  `desktop/ui/scripts/ui-kit-rules.test.ts`. Verify `npm --prefix desktop/ui test` discovers and
  passes the new tests.
- [x] 1.3 Implement `desktop/ui/scripts/ui-kit-check.mjs` in report mode with the boundaries,
  raw-primitive, kit-purity and style rules. Verify it exits zero on the current tree and prints the
  observed counts (raw buttons, raw dialogs, components-to-features imports, kit translations).
- [x] 1.4 Seed `desktop/ui/ui-kit.allowlist.json` from the report with `rule`, `file`, `count` and a
  reason for each entry. Verify a raised count and a new unlisted violating file both fail, while a
  lowered count passes and is reported as stale.
- [x] 1.5 Add the `ui:kit` script to `desktop/ui/package.json` and call it from `make ui-check` in
  report mode. Verify `make ui-check` runs it and the guide documents the command and its output.

## 2. Page-level patterns

- [x] 2.1 Add `PageShell` with header, title and actions slots in `components/patterns`, and migrate
  the screens that hand-roll `.panel` + `.card-head` + `.page-title` (Persons, Events, Search, Path,
  Graph, Map, Settings, Help, Chat). Verify there is one source of that markup and that headings and
  actions keep their current DOM order and accessible names.
- [x] 2.2 Add a pure `splitter.ts` module (bounds, clamping, keyboard steps, persisted width) with unit
  tests, plus a `Splitter` component. Verify the tests cover pointer and keyboard bounds, and that
  Persons and Events both consume the shared component with no local copy.
- [x] 2.3 Add `Pager`, `SortIcon` and `ColumnMenu` patterns and use them in both list screens. Verify
  each has a single definition in the repository and that paging, sort direction and column
  visibility behave as before.
- [x] 2.4 Delete the duplicated splitter, resize-handle and pager CSS from `persons.css` and
  `events.css`. Verify the duplicate-CSS report drops and the four-combination screenshots are
  unchanged.

## 3. Data table

- [x] 3.1 Add the composable `DataTable` parts to `components/patterns`: table shell, sortable and
  resizable `HeaderCell` with an `aside` slot, colgroup helpers, selection column. Verify unit tests
  for sort direction and width helpers, and that a page can still render custom cells as JSX.
- [x] 3.2 Wire the existing `lib/tableColumns.ts` into the pattern without changing its behaviour.
  Verify its existing tests pass and stored widths still restore per project and screen.
- [x] 3.3 Migrate `PersonsPage` to `DataTable`. Verify sort, resize, column menu, bulk selection,
  scroll restoration and keyboard behaviour are unchanged.
- [x] 3.4 Migrate `EventsPage` to `DataTable`. Verify the same parity checks plus event row actions
  and the detail pane hand-off.
- [x] 3.5 Move the timeline's undated table to the compact `DataTable` variant, or record an
  allowlist entry with a reason if it does not fit. Verify no raw `<table>` remains outside
  `Markdown` and the shared kit, or that the exception is explicitly recorded.

## 4. Collection shell

- [x] 4.1 Extract `CollectionShell` (toolbar, filter slot, body slot, splitter, detail slot, footer)
  from the migrated list screens, with a pure `collectionLayout.ts` module for defaults, clamping
  and persistence. Verify unit tests cover the layout rules and both screens consume the shell.
- [x] 4.2 Remove the page-local splitter state and handlers from Persons and Events. Verify stored
  widths still restore and the stacked layout at the existing breakpoint is unchanged.
- [x] 4.3 Document the shell contract (slots, optional detail pane, footer) in the UI kit guide.
  Verify a new screen can follow the checklist without reading the page implementations.

## 5. Filters

- [x] 5.1 Split `FilterBar` into generic pieces (search field, chips row, reset, panel toggle) while
  keeping the current props for Search, Persons and Events. Verify pure tests for chip and reset
  visibility, and that all three consumers still render their current controls.
- [x] 5.2 Move `EventFilterHeader` into `features/events` and update the Events and Map imports.
  Verify the boundaries report shows zero `components/` to `features/` imports.
- [x] 5.3 Merge `TimelineFilters` into the shared event filter row, keeping generations and sort
  local to the timeline. Verify a person/type/year choice still carries across Events, Map and
  Timeline, and that the timeline strip keeps its one-row layout.
- [x] 5.4 Remove the now-empty timeline filter CSS and duplicate option mapping. Verify one source
  for event type options and person scopes is used by all three views.

## 6. Dropdowns

- [x] 6.1 Extract a pure `listbox.ts` module (active index, wrap, Home/End, Tab close, target to
  scroll into view) from Select and Multi-select, with unit tests. Verify the tests cover both the
  single-select and multi-select key maps.
- [x] 6.2 Add `DropdownBase` (trigger, popover, listbox, ARIA wiring) and rebuild `SelectDropdown`
  and `MultiSelectDropdown` on it with unchanged public props. Verify keyboard, mouse, Escape, Tab
  and the "all" row behave as before.
- [x] 6.3 Keep the searchable `Combobox` on Fluent and document why in the guide (filtering, clear
  semantics, option rendering). Verify no duplicated trigger or listbox markup remains in the two
  hand-rolled dropdowns.
- [x] 6.4 Keep `multiSelectRules` tests green and add coverage for the new shared base. Verify
  `npm --prefix desktop/ui test` passes.

## 7. Cleanup and enforcement

- [x] 7.1 Remove the duplicate `EmptyState` from `components/feedback.tsx` and any other dead
  exports found by the checker. Verify no importers remain and the dead-code rule reports zero.
- [x] 7.2 Migrate the remaining trivial raw controls (Help toggles, ClarifyPanel, Projects and Import
  dialogs) to the kit, and keep canvas, graph, markdown and popover surfaces in the allowlist with
  reasons. Verify the raw-control counts drop to the recorded allowlist.
- [x] 7.3 Flip boundaries, raw primitives, kit purity and styles from report to blocking in
  `make ui-check`. Verify a deliberate violation fails the gate, a clean tree passes, and the
  allowlist contains no stale entries.
- [x] 7.4 Add a kit gallery to `design-system/gentree/preview.html` covering primitives and patterns
  in `classic`/`swiss` and light/dark. Verify it opens offline and matches the shipped components.
- [x] 7.5 Final verification: run `make check`; capture four-combination screenshots for Persons,
  Events, Timeline, Search and Map; run `npm run ux:review` if the harness is available; record
  before/after duplication counts (splitter, pager, sort header, dropdown shell, raw controls) in
  the change and the PR.
