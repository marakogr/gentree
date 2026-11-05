# Tasks

## 1. Spouse index and session toggle state

- [x] 1.1 Add a pure spouse-index helper in `desktop/ui/src/features/graph` that turns relationship rows into an ordered, deduplicated `partnersOf` map plus the existing pair-key set. Verify with unit tests for `SPOUSE` and `PARTNER`, reversed duplicate rows, self-links, unknown person ids and deterministic ordering.
- [x] 1.2 Add a pure session-toggle helper with an injectable storage surface, default off, guarded reads/writes and no `localStorage` or project data. Verify with unit tests for missing storage, corrupt values, round-trip and quota/security exceptions.
- [x] 1.3 Replace the inline pair-key construction in `GraphPage.tsx` with the helper and keep the existing `layoutAncestors` co-parent pairing behavior. Verify existing `layout.test.ts` and `forest.test.ts` stay green.

## 2. Descendant spouse decoration and layout

- [x] 2.1 Add a pure spouse-decoration transform for a `DescendantGraph`: add spouse-only nodes with deterministic synthetic keys, the anchor's generation and a `spouseOfKey`, and record already-visible blood partners only as pairs. Verify with tests for root spouse, relative spouse, multiple spouses, duplicate rows, married cousins (no second node) and no spouse data.
- [x] 2.2 Extend `layoutDescendants` to accept spouse slots, keep spouse nodes out of root placement and child bands, and draw spouse connectors. Verify layout tests assert same generation, adjacency, no overlapping rectangles, one child occurrence and deterministic output.
- [x] 2.3 Add the routed connector for couples where both cards are blood relatives and assert its path stays outside card rectangles. Verify with a layout test using a synthetic married-cousin graph.
- [x] 2.4 Apply the decoration to the blood-relative forest in `forest.ts` without changing blood membership or generations. Verify `buildBloodTree` tests for spouse-on-toggle and unchanged blood nodes when the toggle is off.

## 3. Ancestor and combined halves

- [x] 3.1 Extend `layoutAncestors` to accept spouse slots and place spouse-only cards in the anchor's row block, preserving father-left-of-mother order and existing co-parent blocks. Verify layout tests for a root spouse, a grandparent's second spouse, multiple spouses and unchanged blood generations.
- [x] 3.2 Deduplicate spouse cards in `combineLayouts` by person id while keeping one connector, mirroring the root-card rule. Verify a combined-layout test with the root spouse injected in the ancestor half and a descendant spouse in the descendant half.
- [x] 3.3 Confirm the decoration reuses `NODE_WIDTH`, `NODE_HEIGHT`, `SPOUSE_GAP` and `V_GAP` rather than new pixel constants, so the #82 sizing change flows through. Verify by asserting relative geometry from the exported constants.

## 4. Tree screen wiring and localization

- [x] 4.1 Add the "Show spouses" toolbar toggle backed by the session helper, with `aria-pressed`, a localized label and hint, and wiring for `both`, `ancestors`, `descendants` and `relatives`; leave the rootless `tree` mode on its current path. Verify a render test toggles it and observes spouse cards and the pressed state.
- [x] 4.2 Memoize the decorated view on the base graph, persons, spouse index and toggle, and recompute the base layout when the toggle turns off. Verify a test that turning it off restores identical blood coordinates, canvas bounds and fit baseline.
- [x] 4.3 Include spouse person ids in the kinship request and render a neutral spouse role for `UNKNOWN` gender. Verify a test with unknown gender and a spouse card without a gendered label.
- [x] 4.4 Add `graph.json` copy for `ru`, `uk` and `en`. Verify `make i18n` and the locale parity tests pass.

## 5. Integration checks

- [x] 5.1 Add a synthetic stress test with several hundred people and many multiple marriages; assert no duplicate occurrence keys, no overlapping rectangles, deterministic output and no additional API call. Verify the test runs in the standard UI test suite.
- [x] 5.2 Run `make ui-check` and confirm the toggle uses kit primitives and no non-allowlisted rule is violated.
- [x] 5.3 Run `make check` and confirm the whole gate is green, including no changes to Rust crates, IPC types, project format or dependencies.
- [x] 5.4 Review the diff for accidental changes to `desktop/crates`, locale files outside `graph.json`, and any real personal data or absolute paths in tests and docs.

## Workflow follow-up

- Open the PR with `Refs #81` (not `Closes`) so the issue stays open for review of the implemented view.
- Archive the change after review; verify `openspec/specs/tree-layout/spec.md` contains the accepted requirements.
