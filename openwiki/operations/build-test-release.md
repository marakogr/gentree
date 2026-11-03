---
type: guide
title: Build, quality gates and release
description: The local Make workflow, what each quality gate covers, how Tauri installers are produced, and which repository hooks keep secrets and real AT5 data out of git.
tags: [operations, build, ci, git-hooks, release]
sources:
  - id: openwiki-source-6983d4a49fc6ae63a12ff946
    resource: repo://.githooks/commit-msg
  - id: openwiki-source-bf5be0c9253ed1d07b502e10
    resource: repo://.githooks/pre-commit
  - id: openwiki-source-b44a8027ffdbd67cec7a542d
    resource: repo://desktop/docs/build.md
  - id: openwiki-source-fb9602341b89c516f9c15ec6
    resource: repo://desktop/ui/e2e/README.md
  - id: openwiki-source-aa05f27e33bf1e720a0c80f5
    resource: repo://desktop/ui/e2e/tauri.ux.conf.json
  - id: openwiki-source-012f2c78e3b1446dfc35803f
    resource: repo://Makefile
  - id: openwiki-source-88a80e92b2a7ee2aea8481b3
    resource: repo://scripts/doctor.mjs
  - id: openwiki-source-6c1e6679adf9b50d263823d2
    resource: repo://scripts/setup.mjs
generated: { by: "opencode", at: "2026-11-03T10:50:52.373Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-03T10:50:52.373Z
---

# Build, quality gates and release

Everything runs locally; there is no backend deployment. The Makefile is the single entry point, and every target is designed to work from the repository root on Windows (cmd.exe recipes), macOS and Linux.

## Prerequisites

- Node.js 20+ and npm (the UI is an npm workspace under `desktop/ui`);
- Rust 1.88+; the pinned toolchain is `desktop/rust-toolchain.toml`;
- MSVC Build Tools + Windows SDK on Windows, Xcode Command Line Tools on macOS;
- GNU make and git. On Windows, `make` is not preinstalled; `git` also supplies the `grep`/`awk` used by the help target.

`make setup` bootstraps the rest: it installs rustup when `cargo` is missing, runs `npm ci` for the UI and enables the git hooks. `make doctor` prints one status line per check (Node, npm, Rust, linker, UI dependencies) and exits non-zero when something required is missing.

## Make targets

| Target | What it does |
| --- | --- |
| `make install` | `npm ci` for `desktop/ui` |
| `make setup` | one-time bootstrap of Rust, UI deps and hooks |
| `make doctor` | diagnose the dev environment |
| `make fmt` / `make fmt-check` | `cargo fmt --all` / check only |
| `make lint` | `cargo clippy --workspace --all-targets -- -D warnings` |
| `make test` | `cargo test --workspace` |
| `make ui-check` | UI typecheck, Vitest, production build and i18n gate |
| `make i18n` | locale parity and hardcoded-string scan only |
| `make ux-setup` | check WebDriver prerequisites for the optional UI review |
| `make ux-review` | run the WebdriverIO UX review against an isolated build |
| `make check` | fmt-check + lint + test + ui-check |
| `make ci` | `make check` plus `git diff --check` |
| `make dev` | Vite dev server on 1420 + Tauri window with hot reload |
| `make exe` | release executable without installers |
| `make run` | `make exe`, then launch it detached |
| `make build` | installers for the current OS (`.msi` + NSIS `.exe`, or `.dmg`) |
| `make portable` | portable Windows archive from a production executable with no updater |
| `make rebuild` | clean + build |
| `make clean` | remove Rust artifacts and `desktop/ui/dist` |
| `make hooks` | set `core.hooksPath=.githooks` |
| `make demo-project` | regenerate the synthetic demo project |
| `make demo-screenshots` | capture the README gallery from that demo |
| `make release` | tag the version in `tauri.conf.json` and push it; CI builds a draft release |

## Quality gates

`make check` is the gate before a pull request:

1. `cargo fmt --all -- --check` — formatting;
2. `cargo clippy --workspace --all-targets -- -D warnings` — every crate, tests included; the workspace also forbids `unsafe_code`;
3. `cargo test --workspace` — domain, storage, search, import, config and chat tests;
4. UI typecheck (`tsc --noEmit`), Vitest, `vite build` and the i18n gate.

`make ci` adds `git diff --check`, which catches trailing whitespace and conflict markers. The i18n gate is described in [React UI structure](../desktop/ui.md): six locales, English reference, no empty values, no Cyrillic outside dictionaries.

## Optional UI review harness

`desktop/ui/e2e` is an optional WebdriverIO harness for reviewing the real Tauri window; it is **not** part of `make check` and does not run in CI by default.

- `make ux-setup` checks the driver prerequisites (`npm run ux:setup`) and fetches the matching `msedgedriver`; `make ux-review` runs the review (`npm run ux:review`, or `ux:smoke` for a single screenshot);
- the harness builds into `desktop/target/ux` from `e2e/tauri.ux.conf.json`, which changes the bundle identifier to `com.gentree.desktop.ux` and points WebView2 at `e2e/.cache`, so the review starts from an empty app home and never reads the user's project folders;
- `GENTREE_APP_LANGUAGE=ru`, `GENTREE_APP_THEME=light` and `GENTREE_CHAT_ENABLED=false` make the run deterministic and prevent provider calls; the user's `config.yaml` is still read, so a review must not change settings;
- caches and evidence live under `e2e/.cache` and `e2e/artifacts` (gitignored); specs drive the shell, a DOM audit and a project tour, and write screenshots plus JSON evidence instead of asserting pixels.

It is Windows-only (tauri-driver + msedgedriver); missing prerequisites are reported by `make ux-setup` instead of failing a normal build.

## Git hooks

`make hooks` points git at `.githooks`:

- **pre-commit** refuses staged `.env` and `.env.*` files (except `.env.example`), private keys and key stores, `test-fixtures/` or any `.at5`/`.atdb` file, build artifacts (`node_modules/`, `dist/`, `coverage/`, `target/`, `release-assets/`, generated Tauri folders and installers), internal research/local agent config/handoffs (`docs/research/`, `.opencode/opencode.json`, `HANDOFF.md`) and the transient `openwiki/.run.json`. Real family data and local-only notes cannot be committed by accident.
- **commit-msg** requires Conventional Commits (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, optional scope, optional `!`, then a description of at least three characters). Merge, revert, `fixup!` and `squash!` messages are exempt.

## Desktop builds

Run Tauri through the Make targets, not bare `cargo build`. A plain `cargo build --release` omits the `tauri/custom-protocol` feature, so the binary loads the dev URL `http://localhost:1420` instead of the bundled assets and shows `ERR_CONNECTION_REFUSED`. Use `make exe`, `make run` or `make build`.

Outputs:

- executable: `desktop/target/release/gentree-desktop.exe` (no `.exe` on macOS);
- installers: `desktop/target/release/bundle/msi`, `.../nsis` (Windows) or `.../dmg`, `.../macos` (macOS);
- UI assets: `desktop/ui/dist`, embedded into the binary/bundle.

On macOS, `make build` produces a `.dmg` for the host architecture; a universal build needs both Rust targets and `tauri build --target universal-apple-darwin`. `hdiutil`, `codesign` and the macOS SDK are required, so cross-building the dmg from Windows is not possible.

Replacing the release binary requires the app to be closed: while `gentree-desktop.exe` is running, `make exe` fails with an OS "file in use"/access-denied error on `desktop/target/release/gentree-desktop.exe`. Stop the process (or use `make dev` for hot reload) before rebuilding.

## Release pipeline

The GitHub release workflow runs on a `v*` tag and creates a draft release. `make release` (which calls `scripts/release.mjs`) tags the version from `desktop/apps/desktop/tauri.conf.json` and pushes the tag; the workflow then verifies that the tag matches that version before building. It builds the NSIS installer and the portable archive, writes `SHA256SUMS-windows-x64.txt`, signs the artifacts when a Windows certificate is configured, and runs an advisory Defender scan. The MSI stays a local `make build` target. The portable build uses `tauri.portable.conf.json`, which empties the updater endpoint and key so a portable copy can never install itself. In-app updates are opt-in and remain disconnected while `tauri.conf.json` keeps the placeholder endpoint or public key; `docs/releases.md` documents the key generation, endpoint and verification steps.

## Documentation automation

There is no CI workflow for the wiki. A maintainer refreshes `openwiki/` locally with `openwiki code --update`, which rewrites the generated pages and the OpenWiki block in `AGENTS.md` from current source, then commits the result by hand. Because the wiki is generated from source, do not hand-edit OpenWiki pages unless explicitly asked; change code/docs and regenerate.

## Privacy hygiene

- Real AT5 baselines stay outside git; the pre-commit hook enforces it.
- Tests use synthetic fixtures; the opt-in baseline diagnostic prints aggregates only.
- Chat keys are read from environment variables and never logged; see [Chat assistant](../chat/assistant.md).
- Installation never posts project data anywhere.

## Related pages

- [Contract test map](../testing/contracts.md)
- [React UI structure and localization](../desktop/ui.md)
- [Gentree Desktop quickstart](../quickstart.md)
