# AGENTS.md — Gentree Desktop

Read at session start.

Local desktop app for a family archive.
Stack: Rust + Tauri 2 + React/Vite/Tailwind, Tantivy, rusqlite (read-only AT5 import), OpenAI-compatible chat with built-in tools.

Setup, commands and layout: `README.md`. Read only relevant sections.

## Sources of truth

Priority:
1. Invariants in this file.
2. Code and contract tests in `desktop/crates/*/tests/`.
3. Current documentation in `docs/` and `desktop/docs/`.
4. `README.md` / `README.ru.md` (keep both in sync).

If behavior contradicts an invariant or contract test, stop and ask a human. Never silently change either side. Generated docs are derived, not authoritative.

## Architecture

`apps/desktop` (Tauri shell/IPC), `crates/core` (pure domain, no I/O), `storage`, `search`, `import`, `config`, `chat`, `mcp` (in-process read-only chat tool catalog and DTOs, not a server), `ui` (React).

Dependencies point toward `core`; `core` depends on no other crate.

## Invariants

- **Storage:** Project folder is the only source of truth. No backend server, PostgreSQL, accounts, or remote sync. One writer per project. Writes are atomic and include a checksum in the manifest.
- **Dates:** Never invent timestamps for unknown dates. Use `DateValue` with `precision` and `qualifier`. Preserve unknown values in `original` with `precision = UNKNOWN`. Normalize only according to precision rules.
- **Relations:** Explicit types: `PARENT_CHILD`, `SPOUSE`, `PARTNER`, `ADOPTIVE_PARENT_CHILD`. For `PARENT_CHILD`, `person_id` is the parent and `related_person_id` the child. Siblings are derived from shared parents and never stored. No self-links, duplicates, or cycles.
- **Deletion:** Deleting a person must not cascade-delete events with other participants. Removing a media link must not delete the file. Preserve provenance and external IDs.
- **Import:** Re-import is idempotent. Never silently overwrite manual edits. Report all unparsed data.
- **Media:** Checksum is mandatory. Errors must not expose absolute paths.
- **Chat/tools:** Never start an MCP server; tools run inside the app. Send no chat data until a provider is explicitly configured. Secrets and keys must never reach logs, UI, git, or agent messages.
- **UI:** Russian, Ukrainian, English. All user-facing strings belong in i18n dictionaries; no Cyrillic outside them. Errors use stable codes and are localized in the UI.

## Privacy

Real AT5 trees contain personal data of living people.

- Real baselines are local only and never in git. `GENTREE_AT5_BASELINE` is opt-in for diagnostic tests.
- Never read raw `.at5`, `.atdb`, `.env`, or other secret files into agent context.
- Never expose names, dates, places, paths, or field values from real baselines in context, logs, PRs, issues, or docs.
- Tests use synthetic data only. Baseline diagnostics return aggregates only: counts, codes, distributions.
- Never pass baseline content to other agents or messages.

## Research and file access

- For non-trivial tasks, use OpenWiki to discover relevant architecture, contracts, components, and source files. Do not read the entire wiki.
- For trivial, localized changes, skip wiki research if the affected code is already known.
- Treat wiki content as navigation and context, not proof of current behavior. Verify relevant details in source code and tests.
- If wiki findings conflict with source or tests, trust current source and tests; investigate material discrepancies before proceeding.
- Search for target symbols, callers, and tests before opening source files.
- Prefer narrow source excerpts (typically 50–150 lines) around relevant symbols. Expand only when necessary.
- For files over 300 lines, search first and read targeted ranges. Read whole files only when needed to understand cross-cutting behavior.
- Do not reread unchanged content already available in context unless verification requires it.
- Avoid dumping entire files, directories, locale dictionaries, or large command outputs into context.
- Inspect README and relevant `docs/` sections only when the task needs them.

## Token-efficient tool usage

- Prefer RTK-wrapped commands for supported shell operations. Use actual available RTK commands; do not assume unsupported subcommands exist.
- Prefer `rg`/`rg.exe` for code search. On Windows, fall back to `Select-String` and `Get-Content` with line ranges if needed.
- Never recursively list the entire repository unless necessary. Restrict searches to relevant directories and file types.
- Prefer focused `git diff`, symbol searches, and targeted tests over full file dumps or complete history.
- Keep output minimal: request relevant matches, changed lines, failures, and summaries.
- Batch independent read-only searches into one tool call where practical.
- Group related changes into a single patch. Use safe scripted bulk edits for repetitive changes across files.
- Before bulk replacement, verify the match count and scope; inspect the resulting diff afterward.
- Do not create separate edits for individual occurrences when one safe replacement can handle them.
- After a failed command, diagnose the cause before retrying. Never repeat the same failing command with unchanged arguments without a reason.
- Ensure compressed test output preserves failure details and the actual process exit status.

## Environment

- Use the repository's native shell and existing scripts.
- On Windows, assume PowerShell; do not assume Bash syntax or Unix utilities.
- Use separate PowerShell statements instead of `&&`.
- Check tool availability once per session if needed. Do not repeatedly retry unavailable tools.
- If Rust tools are missing from `PATH`, locate the installed toolchain and update the session environment once. If unavailable, report the blocker and use available alternatives.
- Do not switch to WSL solely for search or token savings. Keep commands consistent with the environment used for project builds and tests.
- Use `make` targets rather than duplicating their commands.

## Workflow

1. **Scope:** Identify requirements, affected layers, relevant contracts, and acceptance criteria.
2. **Research:** Use OpenWiki when useful, then search source symbols, callers, and tests.
3. **Plan:** Establish the smallest coherent set of changes. For large tasks, split work by independently verifiable phases.
4. **Implement:** Make related changes together, including callers, types, tests, translations, and docs where needed.
5. **Validate:** Run targeted tests first; run broader checks when the implementation is ready.
6. **Review:** Inspect the diff for unintended changes, missing tests, contract violations, and accidental exposure of sensitive data.
7. **Report:** Summarize changes and checks, including failures and blockers.

Additional rules:

- Work within the assigned scope; do not edit unrelated files.
- Before changing shared symbols or contracts, inspect their dependents.
- For UI changes, run `make ui-check`.
- Do not rerun unchanged failing commands without a reason. Fix the cause or report the blocker.
- A red run is partial: report failing tests and do not claim unverified checks passed.
- Delete temporary diagnostic files; never reference them in PRs.
- Never delete or overwrite others' uncommitted changes.

## Large tasks and context

- Split large features into independently verifiable phases, preferably by architectural layer.
- Complete and validate a phase before moving to the next.
- Use a new session at a meaningful phase boundary or when accumulated context makes continued work inefficient.
- When handing work to a new session, create a concise `HANDOFF.md` containing:
  - Goal and acceptance criteria.
  - Completed changes and relevant files.
  - Decisions and constraints.
  - Remaining work and known failures.
  - Tests and commands already run, with results.
- Keep the handoff factual and concise. Do not copy full source files or conversation history into it.
- In a new session, read the handoff and inspect current git state before continuing. Do not reread the entire previous implementation history.

## Quality gates

```powershell
make check    # fmt-check + clippy + Rust tests + UI typecheck/test/build/i18n
make ci       # make check + git diff --check
make build    # installer for the current OS
```

Use the targets rather than duplicating their commands. Run `make check` before opening a PR. If a target is unavailable, inspect repository scripts and report the limitation.

## Git

- `main` is protected and always green; no direct commits.
- One change = one branch `change/<name>` from `main`, merged via PR; delete the branch after merge.
- Conventional Commits: `feat(desktop): ...`, `fix(ui): ...`.
- Human approval is required for `git reset --hard`, force push, `--no-verify`, `rm -rf` outside build artifacts, `DROP`/`TRUNCATE`, and merging into `main` until the process stabilizes.
- Never commit `.env`, secrets, `desktop/target/`, `node_modules/`, or AT5 baselines.

## HITL — mandatory stop

Ask a human before changing:
- Date semantics.
- Relation or adoption model.
- Person deletion/merge behavior.
- Re-import policy.
- Chat access model.
- Architecture decisions.
- Project format.

Record options, consequences, and a recommendation in the PR. Approved changes to the project format, dates, or relations are recorded in the pull request and, once accepted, in the invariants above.

## Never

- Create sibling edges or fake timestamps.
- Cascade-delete events with other participants.
- Start a network MCP server or log secrets.
- Generate UI from mockups without identifying the underlying data and IPC commands.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The OpenWiki GitHub Actions workflow can refresh the repository wiki manually; it is not scheduled. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
