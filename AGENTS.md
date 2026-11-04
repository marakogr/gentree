# AGENTS.md — Gentree

Read at session start.

Local desktop app for a family archive.
Stack: Rust + Tauri 2, React/Vite/Tailwind, Tantivy, rusqlite (read-only AT5 import), OpenAI-compatible chat with in-process tools.

Setup, commands and layout: `README.md` (read only the relevant sections). All paths below are relative to the repo root.

## Sources of truth

Priority:
1. Invariants in this file.
2. Code and contract tests: `desktop/crates/*/tests/*_contract.rs` (plus `merge_contract.rs`, `prompt_snapshot.rs` snapshots).
3. OpenSpec specs in `openspec/specs/`, if the directory exists (intent and scenarios).
4. Current documentation in `docs/` and `desktop/docs/`.
5. `README.md` / `README-ru.md` (keep both in sync).

If behavior contradicts an invariant or a contract test, stop and ask a human. Never silently change either side. A spec that contradicts a contract test is a spec bug: fix the spec, not the test. Generated docs (`openwiki/`) are derived, not authoritative.

## Architecture

- `desktop/apps/desktop`: Tauri shell and IPC. `desktop/apps/launcher`: launcher.
- `desktop/crates/core`: pure domain, no I/O, depends on no other workspace crate.
- `desktop/crates/{storage,search,import,config,chat,mcp}`: each depends on `core`; the only allowed cross-crate edge is `import → storage`.
- `desktop/crates/mcp`: the in-process, read-only catalog of chat tools and DTOs. It is not a server (`rmcp` supplies the JSON Schemas only).
- `desktop/ui`: React UI.

Adding a crate or another cross-crate dependency is an architecture decision (see HITL).

## Invariants

- **Storage:** The project folder is the only source of truth. No backend server, PostgreSQL, accounts, or remote sync. One writer per project (exclusive `.lock` in the project folder). Writes are atomic and include a checksum in the manifest.
- **Dates:** Never invent timestamps for unknown dates. Use `DateValue` with `precision` and `qualifier`. Preserve unknown values in `original` with `precision = UNKNOWN`. Normalize only according to precision rules.
- **Relations:** Explicit types: `PARENT_CHILD`, `SPOUSE`, `PARTNER`, `ADOPTIVE_PARENT_CHILD`. For `PARENT_CHILD`, `person_id` is the parent and `related_person_id` the child. Siblings are derived from shared parents and never stored (no sibling edges). No self-links, duplicates, or cycles.
- **Deletion:** Deleting a person must not cascade-delete events with other participants. Removing a media link must not delete the file. Preserve provenance and external IDs.
- **Import:** Re-import is idempotent. Never silently overwrite manual edits. Report all unparsed data.
- **Media:** Checksum is mandatory. Errors must not expose absolute paths.
- **Chat/tools:** Never start an MCP server or listen on a socket; chat tools run inside the app. Send no chat data until a provider is explicitly configured. Secrets and keys must never reach logs, UI, git, or agent messages. (`opencode.jsonc` configures the OpenWiki MCP for developer agents; that is tooling, not the app.)
- **UI:** Russian, Ukrainian, English. All user-facing strings live in `desktop/ui/src/i18n/locales`; no Cyrillic elsewhere in `desktop/ui/src` (enforced by `make i18n`). Errors use stable codes and are localized in the UI. Docs, `README-ru.md` and issue bodies may be Russian.

## Privacy

Real AT5 trees contain personal data of living people.

- Real baselines are local only and never in git. `GENTREE_AT5_BASELINE` is opt-in for `#[ignore]` diagnostic tests.
- Never read raw `.at5`, `.atdb`, `.env`, or other secret files into agent context.
- Never expose names, dates, places, paths, or field values from real baselines in context, logs, PRs, issues, project fields, comments, or docs.
- Tests use synthetic data only. Baseline diagnostics return aggregates only (counts, codes, distributions); do not paste full output of a baseline run, report only the aggregates.
- Never pass baseline content to other agents or messages.

## Working with code

- Use OpenWiki as described in the OpenWiki block below; it is not startup reading.
- Search for target symbols, callers, and tests before opening files. Read narrow excerpts (50–150 lines); for files over 300 lines, search first and read targeted ranges.
- Do not dump whole files, directories, locale dictionaries, or large command output into context. Do not reread unchanged content unless verification requires it.
- Prefer RTK-wrapped commands for supported shell operations. Use actual available RTK commands; do not assume unsupported subcommands exist. Compressed output must keep failure details and the real exit status.
- Prefer `rg` for search (on Windows fall back to `Select-String` and `Get-Content` with line ranges). Restrict searches to relevant directories; never list the whole repository without need.
- Prefer focused `git diff`, symbol searches, and targeted tests. Batch independent read-only searches into one call.
- Group related edits into one patch. For bulk replacement, verify the match count first and inspect the diff afterward.
- After a failed command, diagnose before retrying; never rerun the same command unchanged without a reason.

## Environment

- Use the repository's native shell and existing scripts. On Windows assume PowerShell: no Bash syntax or Unix utilities, and separate statements instead of `&&`.
- Check tool availability once per session. If Rust tools are missing from `PATH`, locate the installed toolchain and update the session environment once; otherwise report the blocker.
- Do not switch to WSL for search or token savings.
- Use `make` targets, not their underlying commands (`make help` lists them).

## Workflow

1. **Scope:** requirements, affected layers, contracts, acceptance criteria.
2. **Research:** search symbols, callers, tests; OpenWiki only per its rules.
3. **Plan:** the smallest coherent change set. Split large tasks into independently verifiable phases, preferably by layer.
4. **Implement:** include callers, types, tests, translations, and docs. Before changing shared symbols or contracts, inspect their dependents. Never generate UI from a mockup without identifying the underlying data and IPC commands.
5. **Validate:** targeted tests first, then broader checks. For UI changes run `make ui-check`.
6. **Review:** inspect the diff for unintended changes, missing tests, contract violations, and leaked sensitive data.
7. **Report:** summarize changes and checks, including failures and blockers. A red run is partial: report failing tests and never claim unverified checks passed.

Rules:

- Stay within the assigned scope; do not edit unrelated files.
- Delete temporary diagnostic files; never reference them in PRs.
- Never delete or overwrite others' uncommitted changes.

## Quality gates

```powershell
make check    # fmt-check + clippy + Rust tests + UI typecheck/test/build/i18n
make ci       # make check + git diff --check
make build    # desktop bundles for the current OS (msi/nsis on Windows, dmg on macOS)
```

Run `make check` before opening a PR. If a target is unavailable, inspect `Makefile` and `scripts/` and report the limitation.

## Git

- `main` is protected and always green; no direct commits.
- One change = one branch from `main`, merged via PR; delete the branch after merge. Use `change/<name>` for code/UI and `release/<name>` for release engineering.
- One issue per PR; close it with `Closes #<n>` in the PR body.
- Conventional Commits: `feat(desktop): ...`, `fix(ui): ...`.
- Human approval is required for: `git reset --hard`, force push, `--no-verify`, `rm -rf` outside build artifacts, `DROP`/`TRUNCATE`, and merging into `main`.
- Never commit `.env`, secrets, `desktop/target/`, `node_modules/`, AT5 baselines, `docs/research/`, `.opencode/opencode.json`, or `HANDOFF.md`. `make hooks` enables the pre-commit guard; do not bypass it.

## HITL — mandatory stop

Ask a human before changing:
- Date semantics.
- Relation or adoption model.
- Person deletion/merge behavior.
- Re-import policy.
- Chat access model, including any new tool exposed to the chat model.
- Project format.
- Architecture: a new crate, a changed dependency direction, a new external dependency, a new network egress, a new IPC surface.

Record options, consequences, and a recommendation in the PR. If no human is available in the session, stop and leave a draft `hitl` issue text instead of choosing. Approved changes to the project format, dates, or relations are recorded in the PR and, once accepted, in the invariants above. Decisions are tracked as `hitl` issues (format in `docs/agents/github-workflow.md`).

Changes to this file's Invariants, Privacy, HITL, or Git sections need human review.

## Detailed guides

Read only when the trigger applies.

| Trigger | File |
|---|---|
| Creating or updating an issue, PR, milestone, project board item, tag or release | `docs/agents/github-workflow.md` |
| New capability or a change that spans layers or contracts (OpenSpec) | `docs/agents/openspec.md` |
| Adding a screen, shared UI component or page-level pattern | `docs/agents/ui-kit.md` |
| Ending a session in the middle of a large task, or resuming one | `docs/agents/handoff.md` |

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The wiki is refreshed manually by a maintainer (`openwiki code --update`); there is no CI workflow for it. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
