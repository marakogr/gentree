# Contributing to Gentree

Thanks for taking the time to help. Gentree is a local-first family archive, so
contributions are judged by two things: the archive must stay safe, and the app
must stay understandable.

## Before you start

- **Small fixes and docs** can go straight to a pull request.
- **Larger features, format changes or architecture work:** open an issue first.
  Changes to dates, relations/adoption, person deletion or merge behaviour,
  re-import policy, chat access or the project format need maintainer approval
  and a written rationale in the pull request before implementation. See
  [`AGENTS.md`](AGENTS.md).
- **Security issues** do not belong in a public issue. Follow
  [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements are listed in the [README](README.md#quick-start). In short:

```bash
make setup     # Rust toolchain, UI dependencies, git hooks
make doctor    # diagnose a missing tool or linker
make dev       # run the app in dev mode
```

The repository is a Rust workspace under `desktop/` plus the React UI under
`desktop/ui`. Dependencies point toward `desktop/crates/core`; `core` depends on
no other crate.

## Quality gates

Run the same gates as CI before opening a pull request:

```bash
make check     # fmt-check + clippy + Rust tests + UI typecheck/test/build/i18n
make ci        # make check + git diff --check
```

Optional UI review against an isolated build:

```bash
make ux-setup
make ux-review
```

A red run is partial. Report failing tests instead of claiming that unverified
checks passed.

## Branches, commits and pull requests

- `main` is protected; do not commit to it directly.
- One change = one branch `change/<short-name>` from `main`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(desktop): ...`, `fix(ui): ...`, `docs: ...`.
- Keep pull requests focused. Describe what changed, why, and which checks ran.
- Delete the branch after merge.

The optional git hooks enabled by `make setup` check the commit message and
block secrets, build artifacts, internal research notes and transient OpenWiki
run state.

## Data and privacy

- **Never commit real family data.** No `.at5`, `.atdb`, `.env`, exported
  projects or screenshots of a real archive.
- Tests use synthetic data only. A local AT5 baseline stays outside git and is
  opt-in for diagnostic tests.
- Do not paste names, dates, places, paths or field values from a real archive
  into issues, pull requests, documentation or logs.
- Secrets and provider keys must never reach logs, the UI, git or agent
  messages.

## Translations

All user-facing strings live in `desktop/ui/src/i18n/locales/<locale>/`. Keep every
locale in sync; `npm --prefix desktop/ui run i18n:check` enforces key parity and
rejects empty values and hardcoded Cyrillic outside the dictionaries.

## Architecture and decisions

- Invariants: [`AGENTS.md`](AGENTS.md)
- Launcher, portable build and releases: [`docs/`](docs/)
- Build notes: [`desktop/docs/build.md`](desktop/docs/build.md)

Code and contract tests are the source of truth. If a document contradicts them,
stop and ask before changing either side.

## Code style

- Rust: `cargo fmt`, clippy with `-D warnings`, pure domain logic in `core`.
- TypeScript/React: follow the existing feature structure and UI kit; no
  hardcoded user-facing text.
- Keep comments about behaviour and trade-offs, not about the diff.

## Review

Reviewers look for contract coverage, missing translations, accidental data
exposure and changes outside the stated scope. Be ready for a request to split a
large pull request.
