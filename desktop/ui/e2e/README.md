# UI review harness (WebdriverIO)

Front-end review of the desktop app: drives the **real Tauri window** over
WebDriver and collects evidence instead of asserting pixel or copy details.
It is optional tooling; `make check` does not depend on it.

## Why WebdriverIO

Tauri 2 exposes its window through [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/),
which speaks plain W3C WebDriver and forwards to `msedgedriver` (WebView2).
WebdriverIO is a first-class client for that protocol, so the same specs can
use `$`, `browser.keys`, `browser.saveScreenshot` and friends against the
production binary. A browser-only runner would need an IPC mock instead: the
UI calls `@tauri-apps/api/core` directly and has no browser fallback.

## What a run produces

`artifacts/<timestamp>/` (git-ignored), one set per run:

- `shell-1200x800.png`, `shell-960x600.png` — empty state at the default and
  the minimum supported window size.
- `page-<slug>.png` — every project section after a synthetic project is
  created: persons, events, timeline, graph, kinship, search, chat, settings,
  projects.
- `*.json` — the DOM audit next to each screenshot: interactive controls,
  controls without an accessible name, hit targets under 24 px, contrast
  candidates, elements overflowing the viewport, untranslated i18n keys and
  the keyboard focus order with focus-indicator detection.

The audits are **evidence for a human review**, not WCAG conformance:
contrast is approximated from computed colors, so every candidate should be
confirmed on the screenshot before it becomes an issue. Specs fail only when
the session breaks, a section renders no heading, or the console reports
severe errors.

## Privacy and isolation

Real archives are local-only. A review run must never read them, so the
harness does not reuse the normal app identity:

1. `tauri.ux.conf.json` overrides the bundle identifier to
   `com.gentree.desktop.ux`. Windows keeps app data under
   `%APPDATA%\<identifier>`, so the review starts with an empty home.
2. The build goes to `desktop/target/ux`, leaving the normal release binary
   untouched.
3. `WEBVIEW2_USER_DATA_FOLDER` points at `e2e/.cache/webview2`, so
   localStorage, cache and IndexedDB of the real app are not reused.
4. `GENTREE_APP_LANGUAGE=ru`, `GENTREE_APP_THEME=light`, `GENTREE_APP_STYLE=classic`
   and `GENTREE_CHAT_ENABLED=false` make screens deterministic and guarantee no
   provider calls.
5. Only the `com.gentree.desktop.ux` data folders are cleaned between runs.
   `UX_KEEP_APP_DATA=1` skips that cleanup, which is required when a run has to
   seed the isolated home with copies of an existing project (for example an
   acceptance checklist on real data). Copies still live under the review
   identifier, never next to the original archive.

`settings_get` still reads `%APPDATA%\Gentree\config.yaml` (the config path is
independent of the identifier). The run treats it as read-only: do not change
settings during a review, because that write would land in the user config.

Known product gap that the isolation works around: `project_list`,
`project_create` and backups use Tauri's `app_data_dir`, while the settings
screen and `GENTREE_STORAGE_PROJECTS_DIR` only affect the config values. The
two paths disagree; see `desktop/apps/desktop/src/main.rs` (`cached_app_dir`).

## Prerequisites

- Windows with WebView2 Runtime (same version as Edge).
- Node 20+ and UI deps: `make install`.
- `tauri-driver` once:
  `cargo install tauri-driver --locked`.
- `msedgedriver` matching WebView2: `make ux-setup` downloads and caches it
  under `e2e/.cache/msedgedriver` and refreshes it when the runtime updates.

## Commands

```powershell
make ux-setup    # check tauri-driver, fetch the matching msedgedriver
make ux-review   # drivers -> isolated build -> full review pass
npm --prefix desktop/ui run ux:smoke          # attach + one screenshot only
npm --prefix desktop/ui run ux:review -- --no-build
npm --prefix desktop/ui run ux:review -- --spec=./specs/02-shell-audit.js
```

The first `ux:review` compiles the whole Rust workspace into
`desktop/target/ux` (slow). Later runs reuse it, and `--no-build` skips the
step entirely.

## Adding a spec

- Prefer roles and accessible names (`navButton("Люди")`), not CSS classes.
- Use `lib/report.js` (`shot`, `save`) so evidence lands in the run folder.
- Use `lib/audit.js` (`auditPage`, `focusState`) for DOM evidence.
- Keep assertions behavioural (screen opened, no crash); put opinions in the
  review notes, not in red tests.

## Limits

- Windows only: `tauri-driver` on Linux needs `WebKitWebDriver`, and macOS has
  no WebDriver bridge for WKWebView. The scripts fail with a clear message.
- Native OS dialogs (import/export file pickers, media save-as, reveal in file
  manager) cannot be driven; cover those by hand.
- The run leaves screenshots only. Screenshot diffing needs a baseline policy
  and deterministic fonts; not enabled on purpose yet.
- Text selectors are Russian because the run forces `GENTREE_APP_LANGUAGE=ru`.
  Adding locales means adding a label map, not duplicating specs.
