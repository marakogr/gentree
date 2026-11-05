# Design

## Context

See `proposal.md` for motivation and `specs/tree-layout/spec.md` for the behavior contract.

The tree screen already loads everything the view needs in one place: up to 1000 people, all relationships, and media. It derives a `Set` of spouse pair keys and a child-to-parents index from those rows. Four rooted modes are rendered:

- `both`: backend ancestor graph plus backend descendant graph, merged on the root card;
- `ancestors` and `descendants`: one backend graph each;
- `relatives`: a local blood-relative forest built from the same parent index;
- `tree`: the feature-flagged rootless whole-project forest, out of scope here.

`layoutAncestors` already groups co-parents who are also `SPOUSE`/`PARTNER` into one visual block, but it cannot add a card that the backend did not return. `layoutDescendants` has no spouse concept and places a child under one primary parent, drawing the second parent as an extra edge. Blood-relative building deliberately excludes spouses so spouses cannot be mistaken for blood links.

Constraints: pure layout modules stay deterministic for equal input, the relation model and project format are unchanged, and no new IPC or dependency is added.

## Goals / Non-Goals

**Goals:**

- Add spouse-only cards and spouse connectors on top of the existing graphs without recomputing blood generations.
- Keep every person on exactly one card, including people who are both blood relatives and spouses.
- Keep the layout deterministic and linear in the number of visible nodes plus spouse links.
- Make the toggle a reversible view state with a clear default and session lifetime.

**Non-Goals:**

- Showing spouses of people who are not displayed, or expanding a spouse's own blood relatives.
- Representing marriage dates, divorce or union status; the view only knows `SPOUSE` and `PARTNER` rows.
- Changing `graph_ancestors`, `graph_descendants`, the kinship API, backend limits, the project format or the relation model.
- Implementing issue #82 (one-level parents, three-line names); this view only has to coexist with it.

## Decisions

### 1. Build a spouse index in the UI; add no backend call

Extend the relationship loading step from a `Set` of pair keys to an ordered index:

- `partnersOf: Map<personId, personId[]>` in relationship row order, deduplicated;
- fallback ordering by person id when rows for one person have no stable order;
- `pairs: Set<pairKey>` kept for existing `layoutAncestors` co-parent grouping.

Ignore self-links, rows whose person is not in the loaded project, and duplicate pairs. Relationships materialized from events (#80) are normal storage rows by the time the UI reads them, so this path needs no event-specific logic.

Alternative rejected: a backend "include spouses" flag. It would add an IPC contract, duplicate traversal rules and have to be tested in Rust, while all required data is already loaded.

### 2. Decorate the graph with spouse nodes before layout

A pure `spouse view` transform takes the base graph (ancestor or descendant), the persons map and the spouse index, and returns:

- the base nodes and edges unchanged;
- additional spouse-only nodes with a deterministic synthetic occurrence key (for example `s:<anchorKey>:<n>`), generation equal to the anchor's generation, and a `spouseOfKey` pointing at the anchor;
- a `couplePairs` set of existing blood nodes that are spouses but are both already displayed.

Only partners of displayed blood people are added. A spouse who is already displayed (for example a married cousin) is never added a second time; the pair is recorded for a connector only. The rootless whole-project graph bypasses the transform.

Alternative rejected: a post-layout pass that moves cards aside. It cannot guarantee no overlap with siblings' subtrees without re-running packing, and it would make "toggle off restores the view" depend on reverse moves rather than recomputing from base data.

### 3. A spouse card occupies a slot in the anchor's couple block

Both layout functions gain one shared concept: a map from spouse occurrence key to anchor occurrence key.

- **Descendants:** the anchor and its spouse-only cards form one block on the anchor's row. Children are still placed under the anchor exactly as before, and the block is centred over them. Spouse cards do not become roots and do not own child bands.
- **Ancestors:** the existing father/mother block is extended with any spouse-only cards of either parent on the same row. Root spouse cards extend the root block. Father stays left of mother; extra spouses follow in index order.
- **Blood forest:** the same decoration is applied after `buildBloodTree`; blood membership and generations are computed exactly as today.

`LayoutNode` gains an optional `spouseOfKey`/`spouse` marker. Rendering uses it for the card meta and to skip descendant role labels; it does not change card size. Spouse slot spacing reuses `NODE_WIDTH` and `SPOUSE_GAP`, and both layouts keep reusing `NODE_HEIGHT`/`V_GAP`, so #82's node sizing change flows through without a second layout constant.

Rejected alternatives: giving a spouse a normal parent edge (would create a second child band and change generations), and placing spouses as free-floating roots (would put them on generation 0).

### 4. `combineLayouts` deduplicates spouse cards across halves

The root card is taken from the ancestor half. The root's spouse-only card is therefore injected once, into the ancestor half when `both` is rendered; the descendant half adds spouses only for descendants. If both halves independently produce the same spouse person, `combineLayouts` drops the duplicate by person id while keeping the connector, mirroring the existing root deduplication.

### 5. Multiple spouses and blood-blood couples

- All distinct partners of a displayed person are shown; the order is relationship order, then id. No subset is guessed because the data has no "current spouse" flag.
- A spouse-only card sits immediately next to the anchor. When both partners are blood nodes (married cousins), neither is moved: the layout keeps their blood positions and draws a routed spouse connector through the inter-row gap so it does not cross card bodies. This is the one case where adjacency is not possible without violating blood generations.

### 6. Toggle state lives in session storage, not project data

The toggle is a `Button` primitive with `aria-pressed`, consistent with the existing toolbar buttons and requiring no new shared component. A small pure helper reads and writes a `sessionStorage` key guarded by `try/catch` and a storage abstraction for tests:

- default `false`;
- survives tab switches and GraphPage remounts in the same app session;
- resets on restart;
- never touches `localStorage`, project files, the manifest, backups or export.

Rejected alternatives: `localStorage` per project (contradicts the session-scoped acceptance criterion and would grow the stored view blob), URL state (lost on tab switch), and app settings (would require a config field and a settings screen form).

### 7. Recompute from base data on every toggle change

The decorated view and layout are memoized on `(mode, baseGraph, persons, spouseIndex, showSpouses)`. Turning the toggle off recomputes the base layout from unchanged inputs, which restores the exact coordinates, bounds and fit baseline rather than trying to undo a mutation. No extra network or IPC work happens.

### 8. Rendering, kinship and accessibility

- Spouse cards use the same card component and node dimensions; meta shows a localized "spouse/partner" role. Gendered labels are used only when gender is known; `UNKNOWN` gets a neutral label.
- Spouse person ids join `graphPersonIds` for the existing kinship batch, so labels such as husband/wife appear where the backend can resolve them.
- The toggle has a localized label and hint, and `aria-pressed` carries its state. The canvas accessible label stays mode-based; the toggle announces the added layer.
- New copy goes to `graph.json` in `ru`, `uk` and `en` only.

## Risks / Trade-offs

- **Wide rows from several spouses** → Deterministic slot packing reuses the existing subtree-width calculation; extremely wide couples push siblings apart but never overlap. A synthetic stress test covers it.
- **Spouse connectors spanning other cards** → Spouse-only cards are adjacent, so their connector never spans a third card. Only blood-blood couples use a routed connector in the row gap; tests assert it does not cross card rectangles.
- **Duplicate cards across the two halves** → `combineLayouts` deduplicates by person id, and the decorated view never adds an already visible person.
- **Kinship labels for spouse-only cards** → The kinship request already accepts arbitrary ids; if the backend cannot resolve a label the card falls back to the localized spouse role. Failure is decorative only.
- **Toggle state leaking between projects** → Session-scoped state is global by design; this is documented and can be revisited as an open question. It never leaks into project data.
- **Interaction with #82** → If #82 changes node height or name line count before this change lands, spouse placement inherits the shared constants; the pure layout tests assert relative geometry, not hardcoded pixels beyond the exported constants.

## Migration Plan

No migration. The toggle defaults off, so existing projects render exactly as before. Rollback is removing the toggle and the decoration transform; no stored project data changes.

## Open Questions

- Should the preference become per-project and survive restart, or stay session-scoped as the acceptance criterion currently states?
- Should the rootless whole-project tree offer the same toggle once the rooted view ships?
- Should ended unions (divorce) be visually distinguished once the relation model can express them? Today every stored `SPOUSE`/`PARTNER` row is shown.
