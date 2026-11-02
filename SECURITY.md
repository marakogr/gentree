# Security policy

Gentree is a local desktop application. It has no backend, no accounts and no
telemetry, but it does read untrusted import files, stores personal data and can
call user-configured network services.

## Supported versions

Security fixes are provided for the latest published `0.2.x` release. Older
preview builds are expected to be upgraded.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately to the maintainers through a security advisory in this
repository. If that is not available, contact a maintainer directly and share
only the minimum information needed to reproduce the problem.

Include:

- the Gentree version and operating system;
- a short description of the impact;
- reproduction steps, ideally against synthetic data;
- any suggested fix or mitigation.

**Never include real archive data, names, dates, places, file paths, provider
keys or `.env` contents in a report.** Replace them with synthetic values.

We will acknowledge the report as soon as possible and coordinate disclosure
after a fix is available. This is a volunteer project, so response times are
best effort.

## Scope

In scope:

- project isolation and path traversal;
- unsafe handling of imported AT5, GEDCOM, JSON or ZIP files;
- leakage of provider keys or archive data to logs, the UI or the network;
- Tauri IPC commands reachable from the webview;
- denial of service through a malformed project or import file.

Out of scope:

- attacks that require an already compromised operating system or account;
- the content of a real archive shared by the user on purpose;
- third-party providers (Photon, DaData, chat providers) — report those to the
  provider, but tell us if Gentree handles the response unsafely;
- unsigned preview builds being blocked or flagged by the operating system.

## Safe defaults

- The chat provider sends no data until it is configured.
- Address suggestions can be switched off; while off, no query leaves the
  machine.
- Provider keys are read from environment variables named in the settings and
  are never written to the project, config, logs or UI.
