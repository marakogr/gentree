---
type: architecture
title: React UI structure and localization
description: How the React front end is organized, how it navigates and themes itself, and how the six-locale i18n contract is enforced.
tags: [ui, react, i18n, fluentui, navigation]
sources:
  - id: openwiki-source-521dba66491bc60efe25ff97
    resource: repo://desktop/ui/package.json
  - id: openwiki-source-8a6c85e834a29ed68a813306
    resource: repo://desktop/ui/scripts/i18n-check.mjs
  - id: openwiki-source-da9accab707e4cb8b1b6ebbb
    resource: repo://desktop/ui/src/api/client.ts
  - id: openwiki-source-6986dd62a189e2f717f1d345
    resource: repo://desktop/ui/src/App.tsx
  - id: openwiki-source-c5895800018ce7a15d8f073b
    resource: repo://desktop/ui/src/app/providers.tsx
  - id: openwiki-source-c58af494e7bf17009632aa4c
    resource: repo://desktop/ui/src/components/feedback.tsx
  - id: openwiki-source-2898c243bb73722d59691b42
    resource: repo://desktop/ui/src/components/ui/combobox.tsx
  - id: openwiki-source-bd69d1cd6fbb3edb0044f1eb
    resource: repo://desktop/ui/src/components/ui/helpers.ts
  - id: openwiki-source-296b674e85c82c04d1d93998
    resource: repo://desktop/ui/src/features/graph/layout.ts
  - id: openwiki-source-7f66fd9f6969fa765b7e19a4
    resource: repo://desktop/ui/src/i18n/index.ts
  - id: openwiki-source-acdfbd17f9e5f50099153b83
    resource: repo://desktop/ui/src/lib/navigation.ts
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# React UI structure and localization

`desktop/ui` is a React 18 single-page app built with Vite 6 and TypeScript 5. It uses Fluent UI v9 for controls and tokens, Tailwind 4 for layout utilities, and i18next/react-i18next for text. Vitest covers pure feature logic; `npm run build` runs `tsc --noEmit` before Vite. An optional WebdriverIO harness under `e2e/` drives the built desktop app for UI review; it is separate from the unit tests and from `make check`.

## Shell and navigation

There is no routing library. `App.tsx` keeps the current `ShellTab` in state and derives the sidebar from the pure model in `src/lib/navigation.ts` (`ShellTab`, `ProjectsSection`, `GLOBAL_NAV`, `PROJECT_NAV`, `sidebarModel`, `activeNavId`, `backOrigin`, `backLabelKey`).

The available destinations are Project, Persons, Events, Map, Tree (graph), Relation (path), Timeline, Search, Chat and Settings. Project-scoped tabs are only reachable when a project is open; the default project tab is `persons`. Navigation state also carries one-shot focus targets (a person, an event, a graph root, a timeline person), which is how the validation report and chat links jump into a screen without a global router.

The sidebar collapses to icons below 900 px and can be toggled manually; a manual choice wins until the next media-query change. Theme preference is `system | light | dark`, persisted locally for instant first paint, then reconciled with `settings_get` because the config file is the source of truth.

## Layering inside the UI

- `src/api/client.ts` holds typed `invoke` wrappers grouped by domain (`projectsApi`, `personsApi`, `eventsApi`, `timelineApi`, …). This is the only place that talks to Rust.
- `src/api/types.ts` mirrors the Rust DTOs (camelCase, `Versioned<T>`, `Page<T>`).
- `src/features/<area>` contains a page, feature-specific components/CSS and small pure modules (`layout.ts`, `helpers.ts`, `format.ts`, `view.ts`, `adapter.ts`) that are unit tested without DOM.
- `src/components/ui` is the shared primitive set (button, chip, combobox, date wheel, dialog, empty state, field, icon button, menu, toast), and `src/components` holds cross-feature pieces such as the master-detail sidebar.
- `src/lib` holds framework-free utilities: navigation, theme, contrast, dates, errors, table columns, view state, debounced values and async-action helpers.

Feature logic lives in these pure modules specifically so that graph layout, timeline bucketing, path alternatives, kinship labels and filter parsing can be tested with Vitest and never duplicated inside JSX.

## Graph screen

`src/features/graph` is the most stateful screen. `GraphPage.tsx` owns the root person (persisted through `persons_set_home`, with a session-only override), the mode, independent ancestor and descendant depths, pan/zoom state and the optional whole-tree flag. The pure modules `layout.ts`, `combined.ts`, `forest.ts`, `parents.ts` and `root.ts` are covered by Vitest.

The mode is one of:

- **Both** (the default) - ancestors above the root and descendants below it. `combineLayouts` aligns the two halves on the shared root card and re-routes the edges.
- **Ancestors only** - `layoutAncestors` stacks generations bottom-up with the root at the bottom. Unknown-parent placeholders stay dashed, and a couple that is also a `SPOUSE`/`PARTNER` pair is laid out as one block (`SPOUSE_GAP`), so the spouse line never runs behind a third card.
- **Descendants only** - `layoutDescendants` grows top-down in breadth-first levels.
- **Blood relatives** - `buildBloodTree` takes everyone connected to the root by blood (parents, children, siblings, aunts, uncles, cousins and further), without spouses or adoptive links.
- **Whole tree** - `buildFullTree` is the experimental rootless mode, hidden behind the `app.graph_whole_tree` settings flag.

Siblings are never stored: they are derived from shared parents and appear through the blood-relative forest or the descendant levels. The root card owns two pairs of generation arrows, one for ancestors and one for descendants, so expanding one half never hides the other; `MIN_GENERATIONS` is `0` and the backend clamps explicit requests at `MAX_GENERATIONS = 8`. The toolbar also fits the canvas and zooms. Kinship labels come from `graphApi.kinship` and are rendered relative to the root; the role fallback comes from the `enums` namespace.

Node cards are plain buttons positioned over an SVG edge layer; panning is a translate on the outer layer and zooming is CSS `zoom`, so Chromium re-rasterizes text instead of stretching a bitmap.

## Other feature screens

- **People and events** share the filter bar and support bulk selection; the event form, place autocomplete and event-file section live under `src/features/events`.
- **Map** (`src/features/map`) filters events by year, groups and clusters confirmed points and draws optional OSM tiles or the bundled Natural Earth outline; see [Event places, coordinates and the map](../domain/places-and-map.md).
- **Onboarding** (`src/features/onboarding`) renders the first-run tour from pure step/storage helpers and keeps the bubble clear of search results.
- **Import** is a drop-zone modal that reports unparsed rows; **projects** owns the start screen, backup/restore and merge dialogs.

## Pickers and popups

`src/components/ui/combobox.tsx` wraps the Fluent `Combobox` for every person and place picker while keeping a stable `value: id` / `onChange(id)` API. Filtering stays in `filterComboItems`, which folds `ё` to `е`, lowercases and matches both the label and the hint (so a year or gender narrows the list).

The popup height contract is explicit: `COMBOBOX_VISIBLE_OPTIONS = 5`, `COMBOBOX_OPTION_HEIGHT_PX = 48`, and `comboListboxMaxHeightPx()` adds the listbox padding. Because Fluent positions the popup with `autoSize: true` and writes its own `max-height`/`height` onto the listbox, the shared `COMBOBOX_POSITIONING` sets `autoSize: "width"`; otherwise the list stretches to the rest of the window and the five-row cap is ignored. Rows are fixed-height with ellipsized text, and `renderOption` supplies rich rows (initials avatar, name, life years) without nested interactive elements. `PlaceAutocomplete` follows the same contract with its own CSS class.

## Merge dialog

`src/features/projects/ProjectMergeDialog.tsx` drives the merge preview: two project pickers (the same project is rejected in the UI and by the command), an optional new name, the preview summary and warnings, one card per suggested person/event with Merge/KeepBoth plus base and field choices, and the list of unmatched right people. `merge.ts` holds the pure default-decision and `MergeDecisions` builders described in [Project merge](../architecture/project-merge.md).

## Theme and providers

`AppProviders` wraps the tree in `FluentProvider` with the resolved Fluent theme and a full-height surface; `ToastProvider` supplies transient feedback. `src/app/theme.ts` maps the preference to a Fluent theme, `src/lib/theme.ts` handles persistence and OS preference detection, and `src/lib/contrast.ts` keeps custom colors readable. The independent style preference (`classic | swiss`) is applied as a `data-style` attribute and persisted through `src/lib/style.ts`; `swiss.css` redefines the semantic tokens instead of forking components.

## Localization contract

Every user-facing string lives in `src/i18n/locales/<locale>/<namespace>.json`. Supported locales are `en`, `ru`, `uk`, `be`, `de` and `es`; namespaces mirror feature areas (`common`, `project`, `person`, `event`, `search`, `relationship`, `graph`, `path`, `timeline`, `chat`, `kinship`, `import`, `map`, `onboarding`, `help`, `settings`, `enums`).

`npm run i18n:check` (`scripts/i18n-check.mjs`) is a hard gate:

- `en` is the reference dictionary;
- every locale must have exactly the reference namespace files and exactly the reference keys, in both directions;
- no locale may contain an empty or non-string value;
- no Cyrillic may appear in `.ts`/`.tsx` files outside `src/i18n/locales` (tests are excluded).

The last rule is what keeps hardcoded Russian out of components: adding a Russian literal to a component fails `make ui-check`. Stable backend error codes are localized the same way: `components/feedback.tsx` renders `errors.<CODE>` from the `common` namespace, so a new code such as `LIFE_EVENT_ALREADY_EXISTS` must be added to all six dictionaries.

Kinship is the most complex namespace: `src/i18n/kinship.ts` derives a label from a `KinshipDescriptor` and selects plural forms per locale, with dedicated tests for Russian/Ukrainian/Belarusian plural categories.

## Related pages

- [Tauri shell, IPC commands and app state](ipc-and-state.md)
- [Event places, coordinates and the map](../domain/places-and-map.md)
- [Relationships, graph invariants and kinship](../domain/relationships-and-kinship.md)
- [Project merge: preview, decisions and apply](../architecture/project-merge.md)
- [Contract test map](../testing/contracts.md)
