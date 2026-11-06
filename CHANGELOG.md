# Changelog

All notable changes to Gentree are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-11-06

Gentree is on its way to the Microsoft Store: the same app is built as a
full-trust MSIX package that the Store signs and updates for you, while the
GitHub build keeps its own installer and in-app updater.

### Added

- A Microsoft Store package (`make store`): a full-trust MSIX generated from
  `msix/AppxManifest.xml` with the Partner Center identity, tile assets and the
  Store-assigned four-part version.
- A Store build flavour (`--features store`) that ships without the updater
  plugin: the Store delivers updates, so the app never replaces its own package.
- The Updates screen names the channel: a Store build says the Store handles
  updates instead of offering buttons that could only fail.

### Changed

- The update check and install buttons are hidden in a build that cannot update
  itself, instead of failing with a localized error when pressed.

## [0.6.0] — 2026-11-06

Family tree and relations: parents, spouses and birth events now agree with each
other, existing archives are migrated on first writable open, and dates and
patronymics follow explicit rules.

### Added

- Date validation: birth before death, plausible date ranges, and parents at
  least 11 years older than their children; unknown dates stay unknown.
- Derive spouse and parent-child relations from life events.
- Show spouses on the family tree for the root person and relatives.
- Bidirectional sync between biological parent-child relations and the child's
  birth event; adoptive links stay separate.
- Writable-open migration for existing projects: missing life events, relations
  derived from events, birth-event parent mirrors, and patronymic backfill.
  Read-only projects are untouched, re-opening is idempotent and reports contain
  aggregates only.
- Automatic patronymic from a known father for Cyrillic names and a known child
  gender; existing patronymics are never overwritten.
- Timeline: 10% initial edge padding, bounded wheel/pinch zoom and pan that keeps
  at least one marker visible.
- WebDriver coverage for the 0.6.0 feedback rules.

### Changed

- Event form is type-first, keeps its footer visible and scrolls the files block;
  parent slots resolve by gender, and existing birth/death event types are
  blocked with a localized hint.
- Tree cards fit the root name, align parents and captions, and show only the
  relationship to the root on hover.
- Event filters stay per project and show an active-filter notice, reset and a
  real year control.
- Person and event cards, the events table, dialog close controls, import
  preview, map search controls and shell spacing follow the shared UI kit.

### Fixed

- Timeline no longer scrolls to extreme years when wheel or pinch zooming.
- Deleting a father no longer shifts the mother into the father slot.
- Event form footer and files no longer overflow; duplicate BIRTH/DEATH types
  cannot be added.
- Person and event cards no longer clip long values or leave dialogs stuck.
- Event table shows the event owner instead of every participant; tree hover no
  longer duplicates relationships.
- Import preview badges, frame and action buttons no longer overlap.
- Map coordinate search controls no longer jump while typing.

## [0.5.0] — 2026-11-04

Chat history: conversations now survive project switches and restarts, with a
conversation rail, explicit limits and safe deletion.

### Added

- A project-scoped chat history stored under the application data directory,
  outside the project folder, backups, checksums and exports. One JSONL file per
  conversation, rewritten atomically.
- A conversation rail with the automatic title, updated date, active row,
  per-row delete and **Clear history** behind explicit confirmation.
- Automatic titles from the first user message: whitespace collapsed, truncated
  to 80 characters plus an ellipsis. No provider request and no rename surface.
- Persistence of the full screen state: roles, content, statuses, skills and the
  already-truncated tool arguments and results. Pending or streaming answers
  load as cancelled.
- Explicit limits without silent pruning: 400 entries and 8 MiB per
  conversation, 200 conversations and 64 MiB per project, with
  `CHAT_HISTORY_LIMIT` and a blocked turn before the provider call.
- Damaged conversation files are isolated: the list still shows healthy
  conversations, marks the damaged item and allows deleting it; a load returns
  `CHAT_HISTORY_CORRUPTED` without a partial transcript.
- Deleting a project removes its chat history. Restoring a backup starts with a
  new project id and no old conversations.
- Chat and error copy in all six UI locales.

### Changed

- The chat screen is a master-detail layout with a resizable conversation list.
  At 1100 px and narrower the list and detail stack, both scroll internally and
  the composer stays visible.
- Snapshot saves are serialized; switching, starting a new chat, deleting the
  active conversation or clearing history while streaming asks for confirmation,
  stops the request and saves the partial answer as cancelled.
- The app follows the shared UI kit contract across screens, with consistent
  buttons, dialogs and list layouts.

### Fixed

- Historical street and avenue names resolve again instead of falling back to
  the raw imported text.

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

[0.7.0]: ../../releases/tag/v0.7.0
[0.6.0]: ../../releases/tag/v0.6.0
[0.5.0]: ../../releases/tag/v0.5.0
[0.4.0]: ../../releases/tag/v0.4.0
[0.3.0]: ../../releases/tag/v0.3.0
[0.2.1]: ../../releases/tag/v0.2.1
[0.2.0]: ../../releases/tag/v0.2.0
