# UI kit contract

Referenced from `AGENTS.md`. Read before adding a screen, a shared component or a
page-level pattern, and before touching `desktop/ui/ui-kit.allowlist.json`.

The executable form of this guide is `make ui-check` → `npm --prefix desktop/ui run ui:kit`.
When this guide and the checker disagree, fix one of them in the same change; the
requirements live in `openspec/specs/ui-kit` and `openspec/specs/ui-conformance` once
the `ui-kit-contract` change is archived.

## Layers and allowed imports

| Layer | Path | May import |
|---|---|---|
| Features | `src/features/**`, `src/App.tsx` | patterns, primitives, foundations, pure helpers, API |
| Patterns | `src/components/patterns/**`, `src/components/filters/**` | primitives, foundations, pure helpers |
| Primitives | `src/components/ui/**` | foundations, pure helpers |
| Foundations | `src/app/**`, `src/lib/**`, `src/styles.css`, `src/theme.css` | React, Fluent and other foundations |
| API | `src/api/**` | domain types |

- `features → patterns → primitives → foundations` is the only direction. There is no
  reverse edge.
- Shared components (`src/components/**`) never import `src/features/**`, `src/api/**` or
  `src/i18n/**`.
- A pure helper (`src/lib/**` without React) never imports a component.
- A primitive never imports a pattern.
- Domain entity types live in `src/api/types.ts`. A feature may pass primitives to a
  pattern; a pattern accepts data through props and generic slots, not domain types.

## Primitive ownership

The kit owns the framework controls. Feature code uses the wrappers, never the raw
element and never Fluent directly:

| Control | Owner |
|---|---|
| Button, icon button, bulk bar | `components/ui/button.tsx`, `icon-button.tsx`, `bulk-bar.tsx` |
| Menu | `components/ui/menu.tsx` |
| Dialog | `components/ui/dialog.tsx` |
| Dropdown / combobox / multi-select | `components/patterns` (base) and `components/filters` (event filters) |
| Text field, date field | `components/ui/field.tsx`, `components/ui/date-wheel.tsx` |
| Chips, empty state, toast | `components/ui/chip.tsx`, `empty.tsx`, `toast.tsx` |

Raw `<button>`, `<select>`, `<input>`, `<textarea>` and `role="dialog"` are allowed only
inside the kit, or in an allowlisted renderer whose markup is not a standard control
(canvas, graph, map, markdown, tour overlay, native file picker). Raw `<table>` markup is
allowed only in `Markdown` (document semantics) and the recorded compact timeline table.
Every exception needs an allowlist entry with a reason.

## Styling

- Shared components use Fluent `makeStyles` and design tokens. No Tailwind utility
  classes, no raw hex/rgb/hsl values, no page-global classes.
- Global classes (`styles.css`, `swiss.css`) are for the page frame only; a shared
  component must not require one, otherwise `swiss` cannot re-skin it.
- Every shared component is checked in `classic` and `swiss`, light and dark. Structure,
  colours, borders and radii come from tokens in both axes.
- `swiss.css` is edited only for a genuine missing token bridge.

## Patterns

New screens compose these instead of copying a page:

- `PageShell` / `PageHeader` (`components/patterns/page-shell.tsx`) - page panel, header
  row, title, optional title aside (badges/counts) and actions. It owns the `.panel`,
  `.card-head` and `.page-title` markup.
- `Splitter` (`components/patterns/splitter-view.tsx`) + pure `splitter.ts` - pointer capture,
  bounds, keyboard steps and persisted width.
- `CollectionShell` (`components/patterns/collection-shell.tsx`) + pure
  `collectionLayout.ts` - toolbar, filter slot, body slot, splitter, optional detail slot
  and footer; owns the master-detail grid, the stacked breakpoint and the stored width.
- `DataTable` (`components/patterns/data-table.tsx`) - table shell, sortable/resizable
  `HeaderCell` with an `aside` slot, `colgroup` helpers and the selection column. Pages
  still render their own cells as JSX; `lib/tableColumns.ts` owns widths and resize.
- `Pager`, `SortIcon`, `ColumnMenu` (`components/patterns/`) - pagination, sort direction
  and the visibility menu.
- `FilterBar` pieces (`components/filters/FilterBar.tsx`) - search field, chips row,
  reset and panel toggle. Event-specific composites live in `features/events`, not in
  `components/`.

Searchable `Combobox` stays on Fluent: it needs filtering, clear semantics and custom
option rendering that the generic dropdown base does not provide. Single-select and
multi-select share `DropdownBase`; that is the documented exception, not a second
pattern.

## Pure modules are the tested contract

Interaction logic lives in pure modules with unit tests:

| Module | Covers |
|---|---|
| `lib/tableColumns.ts` | column widths, resize pointer math, persistence |
| `components/patterns/splitter.ts` | splitter bounds, clamping, keyboard steps, stored width |
| `components/patterns/collectionLayout.ts` | collection grid defaults, clamping, persistence |
| `components/patterns/listbox.ts` | active index, wrap, Home/End, Tab close, scroll target |
| `components/filters/multiSelectRules.ts` | multi-select key map |
| `components/filters/yearRangeRules.ts` | year slider geometry |

Components translate the module into DOM; they do not duplicate the math. A behavior
change starts as a failing unit test.

## Allowlist and ratchet

`desktop/ui/ui-kit.allowlist.json` records existing debt:

```json
{ "rule": "raw-primitive", "file": "src/features/x/Y.tsx", "count": 3, "reason": "..." }
```

- A file not listed must be fully compliant.
- A recorded count must not grow; growth fails the gate.
- A lowered count is reported as `stale` and the entry is lowered in the same change.
- A vanished file or a zero count is stale and its entry is removed.
- The list only shrinks. New debt is not added to it.

Run `npm --prefix desktop/ui run ui:kit` for the report. It prints `rule file count`
lines, `would-fail`/`violation` lines and `stale` lines, and always prints per-rule
totals. `make ui-check` adds `--all-blocking`, so every rule fails the gate outside the
allowlist.

## Collection shell contract

`CollectionShell` is the master-detail frame for a list screen:

| Slot | Required | Contents |
|---|---|---|
| `toolbar` | yes | filter row, page actions, optional bulk bar |
| `banner` | no | notices that belong above the list, e.g. stale-write warning |
| `children` | yes | list body: `DataTable`, empty state or loading skeleton |
| `footer` | no | normally `Pager`; the shell keeps it at the bottom of the list panel |
| `detail` | no | detail pane; when absent the list takes the full width and no splitter renders |
| `detailAs` / `detailPanel` / `detailClassName` | no | wrapper element and classes for the detail pane |

- `storedWidth` and `onCommitWidth` connect the splitter to the section filters;
  `bounds` supplies the default, minimum and maximum. The shell owns the width and
  resizing state, so a page never keeps its own splitter handlers.
- `layoutClassName`, `listClassName`, `detailClassName` and `splitterClassName` keep
  page-specific chrome without re-implementing the grid.
- The grid, the 8px splitter track, the stacked layout at 1100px and the splitter
  cursor live in `components/patterns/patterns.css`.
- A screen without a detail pane passes no `detail`; the splitter is not rendered.

## Definition of done for a new screen

1. Build the frame with `PageShell`; pass every label as a prop.
2. Compose `CollectionShell` when the screen has a list and a detail pane; use
   `Splitter` only through the shell.
3. Render rows with `DataTable` parts; keep domain cells in the feature as JSX.
4. Use `Pager`, `SortIcon`, `ColumnMenu`; do not add local pager, splitter or sort-header
   markup.
5. Translate in the screen, never in the kit; no domain types in shared components.
6. Style only through the kit and tokens. Check `classic`/`swiss` × light/dark.
7. Add unit tests for every new pure rule.
8. Run `make ui-check`. New violations are fixed, not allowlisted.
9. For an extraction, attach four-combination before/after screenshots for every affected
   screen. A visual defect is a separate change.

## Verification protocol for extraction changes

- Before/after screenshots for Persons, Events, Timeline, Search and Map in `classic` and
  `swiss`, light and dark.
- A keyboard pass per screen: Tab order, sort header, column resize, splitter
  arrows/Home/End, dropdown Escape/Tab/Home/End.
- `npm run ux:review` when the harness is available (Windows-oriented, optional).
- Record before/after duplication counts (splitter, pager, sort header, dropdown shell,
  raw controls) in the change and the PR.
