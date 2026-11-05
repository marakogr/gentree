# Proposal

## Why

The tree currently shows blood relatives only, so a user cannot see a spouse next to the root or next to a relative. The data already exists as `SPOUSE` and `PARTNER` relationships, but the tree screen deliberately filters them out; the ancestor half only pairs co-parents and the descendant and blood-relative halves drop spouses entirely. Issue #81 asks for an explicit opt-in view that makes spouses visible without disturbing the blood-relative layout.

## What Changes

- Add a "Show spouses" toggle to the tree toolbar. It is off by default, so the current view is unchanged until the user turns it on.
- When enabled, show `SPOUSE` and `PARTNER` partners of the root and of every displayed blood relative in the rooted modes (`both`, `ancestors`, `descendants`, `relatives`). The rootless whole-project tree keeps its current behavior.
- Place each spouse on the same generation as their partner, immediately next to them, and draw a spouse connector between the cards. Blood-relative generations are copied from the base layout and never recomputed from the spouse links.
- Keep one card per person. A spouse who is also a blood relative stays on their blood card and only gains a connector; a person reachable through several marriages still appears once.
- Keep children attached to their blood parent/couple placement. A spouse card does not receive its own duplicate copy of the children and does not create a second subtree.
- Handle multiple spouses deterministically (relationship order, then id) and lay them out so cards do not overlap; show no spouse for a person without one.
- Restore the exact pre-toggle layout when the toggle is turned off, including node positions and controls.
- Persist the toggle for the app session, so switching tabs and returning keeps the choice; a restart starts from off.
- Localize the toggle label, hint and any new empty/overflow notice in `ru`, `uk` and `en`.
- Add pure layout/forest tests for spouse placement, duplicates, multiple spouses, unknown gender, empty spouse data and large synthetic trees, plus a render-level test for the toggle.
- Do not change the relation model, project format, IPC surface or dependencies. The change consumes existing relationships only, so relations materialized from events (#80) appear automatically.

HITL: this is a view capability, not a relation-model or project-format change. It adds no IPC command, no crate, no external dependency and no network egress. No `hitl` decision issue is required; the assumptions and open questions are recorded in `design.md`.

## Capabilities

### New Capabilities

- `tree-layout`: how the tree screen selects visible nodes, places spouses and blood relatives on generations, keeps one card per person and preserves a stable layout when visibility toggles change.

### Modified Capabilities

None.

## Impact

- `desktop/ui/src/features/graph`: new pure spouse-view transform over `persons`, `parentEdges` and `spousePairs`; extensions to `forest.ts` and `layout.ts` for couple slots and spouse edges; `GraphPage.tsx` for the toggle, view-state wiring and canvas labels.
- `desktop/ui/src/i18n/locales/{ru,uk,en}/graph.json`: new copy.
- `desktop/ui/src/styles.css`: only if the existing node/couple rendering needs a spouse card state; no new shared component is planned.
- Tests: `features/graph/*.test.ts`.
- Not affected: `desktop/crates/*`, project format, backups, export, merge, search, the relation model and event-derived relationship logic (#80). Issue #82 (parent alignment, three-line names) is an independent fix; this change must coexist with it but does not implement it.
