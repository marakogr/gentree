# Specs (OpenSpec)

Referenced from `AGENTS.md`. Read before starting capability-level work.

Use OpenSpec for new capabilities and behavior that spans layers or changes a contract (chat history, import policy, project format, dates, relations).

Do not use it for bugs, UI polish, copy, layout, dependency bumps, or release engineering. A bug gets a failing regression test, not a spec folder.

- One change = one `openspec/changes/<id>/` with `proposal.md`, `design.md`, `tasks.md` and the spec delta. Link the GitHub issue and the change folder in the PR.
- After merge, `openspec archive` merges the delta into `openspec/specs/`; keep the archived change in git.
- Precedence: invariants > contract tests > specs > docs. If a spec contradicts a contract test, fix the spec.
- Setup (once): install the CLI, run `openspec init`, `openspec config set telemetry.enabled false`, and review the diff, especially `AGENTS.md` and `.opencode/`, before committing. `openspec init` edits `AGENTS.md`: keep its generated blocks inside their markers and do not let it overwrite the rest.
- Pilot: `add-chat-history`. If it duplicates issues and tests and starts to rot, drop `openspec/` instead of maintaining ceremony.
