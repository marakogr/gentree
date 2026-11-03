# Changelog

All notable changes to Gentree are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-11-03

One filter row across Events, Map and Timeline, a card for every event, and a
straight path from a person's events to the timeline.

### Added

- An event card: a row click selects the event and shows it in a side panel with
  every field, the participants and the files; **Edit** opens the full form.
- A **relation** filter shared by Events, Map and Timeline: only the person,
  ancestors, descendants, or ancestors and descendants. It is built from the
  existing parent-child links, with no invented relations.
- **Go to timeline** on Events carries the current search and filters into the
  timeline, and the breadcrumb returns to Events with the same filters.
- An **Occupation** fact on a person, collected from occupation events as plain
  text in timeline order.
- The data check opens in a dialog from the problem badge, so Events stays on
  screen.
- The ancestors and descendants walk on the timeline has a depth limit.

### Changed

- Events, Map and Timeline share one filter header and one filter model, so a
  filter set once follows the user between the three views.
- Event types are one searchable multi-select with the table icons, keyboard
  navigation and the same "All types" semantics everywhere.
- The timeline's scope pills are replaced by the shared relation select; the
  Map is drawn inside the same panel as Events, with the title and counters
  above the filters.
- The resizable split between the list and the card is shared with People and
  its width is remembered.
- The project menu is ordered People, Events, Map, Timeline, Tree, Search,
  Kinship, Chat; the tour follows the same order.

### Fixed

- The keyboard stays in the type dropdown after a mouse click, so arrows and
  Escape keep working.
- Person filter photos load once per screen, and a broken media library no
  longer hides the events.
- Empty year ranges collapse to a single label instead of a dead slider.

## [0.3.0] — 2026-11-02

One look across the project screens, calmer settings and help, and a single
filter row on events.

### Added

- Age sorting on People: living people are measured to today, deceased people to
  the date of death, and rows with unclear dates stay last.
- Sorting from the column headers on Projects, with the direction remembered
  between visits.
- A sticky section list in Settings; the geocoder now sits inside the Map
  section.
- A table toolbar on People and Events with the columns menu and the main action.

### Changed

- One page-title style and one content spacing across People, Events, Tree,
  Kinship, Map, Timeline and Search.
- Settings no longer has a "Back to project" button and no longer shows the tile
  warning.
- Help is titled "Help" and opens with a full-width search; the "ask the
  assistant" buttons are gone.
- The assistant no longer receives the built-in UI guide, so it answers about
  the archive rather than about screens and buttons.
- The Projects screen drops the "Recent projects" heading and uses one panel;
  the collapsed sidebar no longer shows a project initial.
- Events keep the search, the person filter and the always-open filters in one
  toolbar; the applied-filter chips and the actions column are gone, and a row
  click opens the event form.
- The name column is labelled "Full name" (ФИО); the year filter is labelled
  "Years".

### Fixed

- Windows no longer suggests previously typed names over the person pickers.

## [0.2.1] — 2026-11-02

This release connects the in-app update channel to GitHub Releases.

### Changed

- In-app updates now come from the project's GitHub Releases: every release
  publishes `latest.json` and a minisign signature for the NSIS installer.
  The portable build still ships without updates.

## [0.2.0] — 2026-11-02

The first public preview. Gentree is usable, but the interface and the project
format may still change between releases. The builds are not code-signed yet, so
Windows SmartScreen or macOS Gatekeeper may ask for confirmation on first launch.

### Added

- Local-first project folder: JSON manifest, JSONL collections, atomic writes,
  manifest checksums and automatic backups with restore.
- People with multiple names, events, media, sources, citations and explicit
  relationships. Dates carry precision (day, month, year, unknown) and qualifiers
  such as approximate, before, after and range.
- Event details: curated fields for each built-in event type, plus custom fields
  defined in `config.yaml` or in Settings. The versioned project format keeps
  them, and the first change upgrades an older project in place.
- Event media: photos and documents attached to a person or an event, with
  profile photos, checksummed files and links that never delete the file.
- Map of events with a confirmed point, filtered by year. Points group by place,
  cluster when zoomed out and keep working with the bundled offline outline.
- Ancestor, descendant, blood-relative and whole-project tree layouts with
  spouse pairs, adoption links and kinship labels relative to any root.
- Kinship mode: pick two people and see the term, common ancestor, path length,
  alternative paths and a diagram.
- Timeline of dated events with filters; undated events are listed separately.
- Full-text search over people and events (Tantivy), data-quality checks and
  project validation, including a lifespan check for events.
- Import from AT5 (read-only) and GEDCOM 5.5.1 or 7.0; export to either GEDCOM
  version and JSON/ZIP; project merge with a review step.
- Address suggestions for event places (Photon and DaData), enabled by default
  and switchable in Settings; while off, nothing is sent.
- Historical place names through Wikidata, shown next to the historical text
  stored in the event.
- Optional chat with any OpenAI-compatible provider, using 14 in-process read
  tools and 12 embedded genealogy skills. Proposed person edits are shown for
  review and applied only after confirmation. Nothing is sent until a provider
  is configured.
- UI in Russian, Ukrainian, Belarusian, English, German and Spanish, with light,
  dark and system themes plus the optional Swiss archive style.
- Launcher and portable Windows archive: one production executable in a zip,
  no installer and no self-updating. `make portable` builds it;
  `docs/portable.md` documents the WebView2 requirement and data location.
- Release gate: `scripts/verify-release.mjs` checks code signatures, writes
  `SHA256SUMS-<platform>.txt` and runs an advisory Microsoft Defender scan. The
  release workflow signs Windows installers and the portable executable with an
  Authenticode certificate when one is configured, and verifies every artifact
  before uploading it to the draft release.
- Desktop builds for Windows 10/11 (x64) and macOS 11+.

### Changed

- Tree screen: the root card owns the generation controls. Up/down arrows on its
  left add or hide ancestor levels, and the same arrows on its right do the same
  for descendants. Switching between ancestors and descendants keeps the current
  depth instead of expanding to every available generation.
- The sibling overlay is replaced by a blood-relatives view: everyone connected
  to the root by blood (parents, children, siblings, aunts, uncles, cousins and
  further), without spouses or adoptive links.
- The rootless whole-project tree is an experimental mode behind a settings flag
  with an explicit readability warning.
- Releases are Windows-only for now: the workflow publishes the NSIS installer
  and the portable archive. The MSI remains a local `make build` target for
  managed deployments. The Windows installer embeds the WebView2 bootstrapper
  instead of downloading and running it during setup.
- Unsigned preview builds carry their SmartScreen note everywhere users meet
  it: README (EN/RU), the generated release notes and the readme inside the
  portable archive, including the checksum step.

### Removed

- The "Show from selected" and "Show siblings" tree buttons. The root picker
  already chooses the person the tree is built from.

[0.4.0]: ../../releases/tag/v0.4.0
[0.3.0]: ../../releases/tag/v0.3.0
[0.2.1]: ../../releases/tag/v0.2.1
[0.2.0]: ../../releases/tag/v0.2.0
