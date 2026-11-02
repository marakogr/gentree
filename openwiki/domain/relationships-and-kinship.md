---
type: concept
title: Relationships, graph invariants and kinship
description: The four explicit relationship types, how the validated relationship set prevents self-links, duplicates and cycles, how siblings are derived, and how ancestor and descendant graphs plus path and kinship results are computed.
tags: [domain, relationships, graph, kinship, invariants]
sources:
  - id: openwiki-source-bdc008b53d9bf75989e293a0
    resource: repo://desktop/apps/desktop/src/commands/graph.rs
  - id: openwiki-source-a78c99eabcd8f6a09bcde0cf
    resource: repo://desktop/crates/core/src/graph.rs
  - id: openwiki-source-5b74e20d575db9b583fcc562
    resource: repo://desktop/crates/core/src/kinship.rs
  - id: openwiki-source-ae545ae8d5e87316d95f9a38
    resource: repo://desktop/crates/core/src/path.rs
  - id: openwiki-source-e2c4cf229f14dc7e3285a29b
    resource: repo://desktop/crates/core/src/relationship.rs
  - id: openwiki-source-ba67a2844f3cdb93304b3fae
    resource: repo://desktop/crates/storage/src/lib.rs
  - id: openwiki-source-e9fc56aa91207443ba05fa00
    resource: repo://desktop/ui/src/features/graph/forest.ts
  - id: openwiki-source-f82f65fd375110ca41cadcfd
    resource: repo://desktop/ui/src/features/graph/parents.ts
  - id: openwiki-source-b33f0cfdfe2122b71041cbec
    resource: repo://desktop/ui/src/i18n/kinship.test.ts
  - id: openwiki-source-be234e63894ab92dbb458a11
    resource: repo://desktop/ui/src/i18n/kinship.ts
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# Relationships, graph invariants and kinship

Relationships are the only edges in a Gentree project. They are explicit, typed rows — never inferred from names or events — and the `RelationshipSet` wrapper is what keeps the graph acyclic and duplicate-free.

## Types and direction

| Type | Meaning | `person_id` | `related_person_id` |
| --- | --- | --- | --- |
| `PARENT_CHILD` | biological parent | parent | child |
| `ADOPTIVE_PARENT_CHILD` | adoptive parent | parent | child |
| `SPOUSE` | marriage | canonical lower UUID | canonical higher UUID |
| `PARTNER` | unmarried partnership | canonical lower UUID | canonical higher UUID |

`RelationshipType::is_parent()` covers both parent types; `is_spouse()` covers spouse and partner. For parent rows the direction is fixed: `person_id` is always the parent, `related_person_id` the child. Spouse and partner rows are stored in canonical order (`person_id < related_person_id`) so the same pair cannot be stored in two directions.

There is no sibling type. Siblings exist only as a derived result of sharing a parent.

## Row and set invariants

`Relationship::validate_row` rejects a self-link and a non-canonical spouse row. `RelationshipSet::push` adds the set-level rules:

- the exact same type and direction is `DUPLICATE_RELATIONSHIP`;
- any spouse/partner row for the same pair is a duplicate, even if the type differs;
- a parent edge is rejected with `RELATIONSHIP_CYCLE` when the proposed parent is already reachable upward from the child (`reaches` walks parent edges).

The storage layer validates the whole set on every `save_relationships`, so a row read from disk follows the same rules as a freshly created one. The command layer also rejects self-links and duplicates before they reach the store.

## Traversal helpers

`RelationshipSet` exposes deterministic traversals:

- `parents_of(child)` returns `(parent_id, adoptive)` sorted by id;
- `children_of(parent)` returns sorted child ids;
- `spouses_of(person)` looks at both sides of spouse/partner rows and sorts the result;
- `is_spouse_of` is the pairwise convenience check.

Because these helpers are sorted, layout, matching and path tie-breaks are reproducible.

Siblings are derived: `are_siblings(a, b)` is true when the two people share at least one parent, and `siblings_of(person)` unions the children of all parents. Neither method stores anything.

The graph screen reuses the same rule on the client without storing anything: `features/graph/forest.ts` builds a blood-relative forest from the loaded parent edges, so siblings, uncles, aunts and cousins are placed once each. The direct ancestor and descendant graphs deliberately keep only the vertical line; the blood-relative mode is the place where the wider family appears.

## Ancestor graph

`ancestors(root, generations)` builds the pedigree for the graph view:

- the root is generation 0; each level adds up to two parent slots (`father`/`mother` keys);
- unknown parents become placeholders with `person_id = None`, never fake people;
- the occurrence key is path-based (`0.f.m`), so a person who appears twice (pedigree collapse) stays as two distinct occurrences;
- `generations` defaults to 3 and is capped at 8 (`DEFAULT_GENERATIONS`, `MAX_GENERATIONS`);
- `MAX_ANCESTORS = 14` bounds rendering;
- `truncated` is set when a person at the last shown level still has parents;
- `pedigree_collapse` is set when any person appears in more than one node.

The desktop command passes each person's stored gender, so the two parent slots are labelled father/mother by fact where it is known and by slot order otherwise (`ancestors_with_gender`).

Siblings and uncles are deliberately not part of the ancestor graph; they would duplicate the same people and blow up the view.

## Descendant graph

`descendants(root, generations)` is the mirror image: the root is generation 0 and children grow downward in breadth-first levels.

- children are read from `children_of(person)`, which is sorted by id, so equal input yields equal output;
- the occurrence key extends the parent key (`<parent>.c<index>`), and a child reachable through two descendant parents is drawn **once**: the first occurrence wins and `pedigree_collapse` is reported;
- `MAX_DESCENDANT_NODES = 500` and `MAX_GENERATIONS = 8` bound the result; reaching either limit, or having a person with children at the last shown level, sets `truncated`;
- roles are `ROOT`, `SON`, `DAUGHTER` or `CHILD`; spouse/partner and sibling edges are never added.

Both directions are exposed by `graph_ancestors` / `graph_descendants`, and the UI picks the matching layout.

## Path finding

`find_path(from, to)` runs a Dijkstra-style search over three edge directions: up to a parent, down to a child, and across a spouse/partner edge. The cost tuple is `(spouse_edges, length, path)` — fewer spouse edges first, then fewer nodes, then lexicographically smaller ids. This prefers blood routes over marriage shortcuts and makes the result stable.

`PathResult` reports `found`, the ordered `PathStep`s with an `EdgeDirection` to the next person, `length`, `common_ancestor_id` and `spouse_edges`. Up to `MAX_ALTERNATIVES = 2` alternative routes are produced by banning one edge of the primary route at a time; alternatives are never nested, are deduplicated by node sequence, sorted and capped.

## Kinship

`kinship(from, to, gender_of)` derives a structural `KinshipDescriptor` from the shortest path, so the displayed term and the drawn chain always agree. The descriptor carries the `KinshipKind`, target and source gender, paternal/maternal line, degree and removed counts, generation delta, an optional spouse gender, the person path, resolved `KinshipEdge`s and the common ancestor.

Classification depends on the number of spouse steps in the chain:

- **zero** — blood relations: ancestors, descendants, siblings, uncles/aunts, nephews/nieces, cousins, great-grandparents/children, step relations for parent-spouse-child shapes;
- **one** — in-laws and spouse-of-relative forms (parent-in-law, child-in-law, sibling-in-law, spouse of sibling, sibling of spouse);
- **two** — only spouse → sibling → spouse has a dedicated term (spouse of a spouse's sibling).

If either person is the same person, no path exists, or an edge cannot be resolved to a stored relationship, the descriptor stays `UNKNOWN` and `kind` is not guessed. The core never produces localized text: `KinshipKind`, `KinshipLine` and genders are codes, and the UI renders them through the `kinship` i18n namespace with locale-specific plural forms.

The desktop exposes this as a batch: `graph_kinship(rootPersonId, targetPersonIds)` returns one descriptor per requested node relative to the same root, so a whole graph is labelled in one IPC call. Unknown target ids are skipped; malformed ids are a validation error.

## Related pages

- [People, events and validation](persons-and-events.md)
- [React UI structure and localization](../desktop/ui.md)
- [Project merge: preview, decisions and apply](../architecture/project-merge.md)
- [Contract test map](../testing/contracts.md)
