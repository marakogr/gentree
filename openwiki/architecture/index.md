# Files

- [Project folder format and write discipline](project-format.md) - How a Gentree project is laid out on disk, how the manifest and content hash are maintained, which atomicity, locking and backup rules protect the folder, and how a merge writes a new project without touching its sources.
- [Project merge: preview, decisions and apply](project-merge.md) - How two projects are merged into a new one - deterministic person and event matching, confidence and warnings, per-pair decisions and field policies, id remapping, media and citation handling, and why the sources stay untouched.
- [Workspace layout and crate dependencies](workspace.md) - The Cargo workspace behind Gentree Desktop, the responsibility of each crate, and why dependencies flow toward the pure domain layer.
