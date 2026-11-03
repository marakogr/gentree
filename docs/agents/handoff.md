# Large tasks and handoff

Referenced from `AGENTS.md`. Read when a task spans several sessions.

- Split large features into independently verifiable phases, preferably by architectural layer. Complete and validate a phase before moving to the next.
- Use a new session at a meaningful phase boundary or when accumulated context makes continued work inefficient.
- Write a concise `HANDOFF.md` in the repo root. It is never committed: the pre-commit hook rejects it.

`HANDOFF.md` contains:
- Goal and acceptance criteria.
- Completed changes and relevant files.
- Decisions and constraints.
- Remaining work and known failures.
- Tests and commands already run, with results.

Keep it factual and short. Do not copy full source files or conversation history. The GitHub issue and project board carry status and scope; the handoff adds only context the issue lacks.

In a new session, read the handoff and check `git status` and `git log` before continuing. Do not reread the whole previous implementation history. Delete `HANDOFF.md` when the task is done.
