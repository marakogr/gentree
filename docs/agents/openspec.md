# Specs (OpenSpec)

Referenced from `AGENTS.md`. Read before starting capability-level work.

Use OpenSpec for new capabilities and behavior that spans layers or changes a contract (chat history, import policy, project format, dates, relations).

Do not use it for bugs, UI polish, copy, layout, dependency bumps, or release engineering. A bug gets a failing regression test, not a spec folder.

- One change = one `openspec/changes/<id>/` with `proposal.md`, `design.md`, `tasks.md` and the spec delta. Link the GitHub issue and the change folder in the PR.
- After merge, `openspec archive` merges the delta into `openspec/specs/`; keep the archived change in git.
- Precedence: invariants > contract tests > specs > docs. If a spec contradicts a contract test, fix the spec.
- Layout: `openspec/config.yaml` (schema and project context), `openspec/specs/` (accepted specs), `openspec/changes/` (active changes), `openspec/changes/archive/` (archived changes, kept in git).
- Slash commands `/opsx-propose`, `/opsx-explore`, `/opsx-apply`, `/opsx-update`, `/opsx-sync`, `/opsx-archive` are committed in `.opencode/commands/`. Flow: propose → apply → archive.
- Setup (once per machine): install the CLI, then `openspec init --tools opencode --no-animation` and `openspec config set telemetry.enabled false`. Generated `.opencode/skills/` is local-only and gitignored. After a CLI upgrade run `openspec update` and review the diff of the committed commands.
- Pilot: `add-chat-history`. If it duplicates issues and tests and starts to rot, drop `openspec/` instead of maintaining ceremony.
