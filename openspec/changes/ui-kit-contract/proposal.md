# Proposal

## Why

The UI looks consistent, but that consistency is maintained by hand. Shared primitives exist in
`desktop/ui/src/components/ui` and `components/filters`, yet every list screen re-implements the
same page-level patterns: page shell, toolbar, sortable table header, column resize, column menu,
master-detail splitter, pager and filter row. The persons and events screens already carry
byte-identical CSS and about 190 duplicated lines of splitter logic, and the shared filter layer
imports feature modules, so "shared" components cannot be reused without pulling domain code.

The next screens (media library, sources, places) are not part of this change, but they will start
from a copy of the same patterns unless the patterns become components first. Nothing in the build
currently prevents a new raw `<button>`, a third dropdown implementation or a `components/` import
of `features/`.

## What Changes

- Make the three-layer structure explicit: `features -> patterns -> primitives -> foundations`,
  with no reverse edges and no domain code in shared components.
- Extract page-level patterns that already exist twice into shared, composable components: page
  shell and toolbar, collection shell (list + splitter + detail + pager), splitter, pager, column
  menu, sortable header and the column-resize plumbing.
- Turn the persons and events tables into one composable data table and use it for both, including
  the timeline's undated table where it fits.
- Unify the dropdown family (single-select, multi-select, searchable) on one trigger/popover/listbox
  shell while keeping the existing keyboard model and public props.
- Separate generic filter pieces from the event-specific composite; move event code out of
  `components/`.
- Add a zero-dependency conformance check to `make ui-check`: import boundaries, raw-primitive
  bypass, kit purity, style rules, dead exports and CSS, duplicate CSS. Ship it with a versioned
  allowlist so existing debt is ratcheted down instead of blocking the branch.
- Remove duplicated and dead UI code found during extraction (the second `EmptyState`, copy-pasted
  CSS blocks).
- Document the contract, the allowlist process and the definition of done for a new screen.
- **Pixel-neutral**: extraction only. No visual redesign and no behavior change; `classic`/`swiss`
  and light/dark must look identical before and after.

Explicitly not included: new screens (media library, sources, places), new IPC, Rust changes, a
project-format change, ESLint or any other new npm dependency.

## Capabilities

### New Capabilities

- `ui-kit`: the shared UI layer - which primitives and patterns exist, how they depend on each
  other, and how screens compose them.
- `ui-conformance`: the automated checks and the debt ratchet that keep the shared layer from
  drifting, plus the documented contract and the verification protocol for extraction changes.

### Modified Capabilities

None. The project has no archived capability specs yet.

## Impact

- `desktop/ui/src/components/**` - new patterns, moved domain composites, dead code removed.
- `desktop/ui/src/features/{persons,events,timeline,map,search}` - migrated to shared patterns.
- `desktop/ui/scripts`, `desktop/ui/package.json`, `Makefile` - the `ui:kit` check.
- `docs/agents/ui-kit.md` and the guide table in `AGENTS.md`.
- `design-system/gentree/preview.html` - optional kit gallery for the four style combinations.

No Rust, IPC, project format or runtime dependency changes.
