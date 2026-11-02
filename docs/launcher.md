# Gentree Launcher

`desktop/apps/launcher` is a separate Tauri 2 app that installs and updates
Gentree. It owns no data: it reads a version feed, downloads the installer for
the current OS/architecture, verifies its SHA-256, runs the installer and can
launch the installed app.

The launcher is **forge-independent**. GitHub or Gitea only host the files; the
contract is the JSON feed below. A build is not tied to a specific repository,
release page or API.

## Goals and non-goals

- **Goals:** list available versions, offer the newest stable one by default,
  download with progress, verify SHA-256, run the platform installer, open the
  installed app, check for updates on demand and on start.
- **Non-goals:** background daemon, unattended updates, code-signature
  verification, delta updates, Linux packages, storing or syncing user data.

Nothing is installed without an explicit click. The auto-check switch only
controls whether the feed is fetched when the window opens (and on focus, at
most every 30 minutes); it never downloads or installs on its own.

## Feed contract (schema 1)

```json
{
  "schema": 1,
  "app": "gentree",
  "latest": "0.2.1",
  "versions": [
    {
      "version": "0.2.1",
      "released": "2026-11-01T12:00:00Z",
      "notes": "What is new",
      "prerelease": false,
      "files": [
        {
          "os": "windows",
          "arch": "x86_64",
          "kind": "nsis",
          "url": "https://downloads.example/Gentree_0.2.1_x64-setup.exe",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "size": 123456
        },
        {
          "os": "macos",
          "arch": "aarch64",
          "kind": "dmg",
          "url": "https://downloads.example/Gentree_0.2.1_aarch64.dmg",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "size": 123456
        }
      ]
    }
  ]
}
```

### Rules

| Field | Rule |
| --- | --- |
| `schema` | Must be `1`; any other value is rejected (`feed_schema`). |
| `app` | Must be `gentree` (`feed_app`). |
| `latest` | Optional. If present, must be one of `versions[].version` (`feed_latest`). |
| `versions[].version` | SemVer (`major.minor.patch`, optional `-prerelease`, optional `+build`). Duplicates are rejected (`feed_version`). |
| `versions[].released` | RFC 3339 timestamp (`feed_released`). |
| `versions[].notes` | Optional; shown verbatim in the UI. Untrusted text, rendered with `textContent`. |
| `versions[].prerelease` | Optional, default `false`. A SemVer prerelease tag also marks the row as a preview. Preview rows are hidden by default and shown by the toggle. |
| `files[].os` | `windows` or `macos`. |
| `files[].arch` | `x86_64` or `aarch64`. |
| `files[].kind` | `nsis` (Windows) or `dmg` (macOS). |
| `files[].url` | Absolute HTTPS URL. Plain HTTP is accepted only for loopback hosts (`127.0.0.1`, `localhost`, `::1`) so the local test server works. |
| `files[].sha256` | Required, exactly 64 hexadecimal characters. Stored lowercase. |
| `files[].size` | Optional. When present it must match the downloaded byte count. |

### Version selection

- If `latest` is present, that entry is offered.
- Otherwise the highest **stable** version by SemVer wins.
- A feed with only prereleases falls back to the highest prerelease so the
  window is never empty; the prerelease badge stays visible.

### Platform mapping

The launcher selects the first file where `os` matches the host and `arch`
matches the build, and where `kind` matches the OS (`windows` → `nsis`,
`macos` → `dmg`). A DMG is never selected on Windows even if `os`/`arch`
happen to match. A release without a file for the current platform stays in the
list but its install button is disabled (`no_file`).

## Build

Prerequisites are the same as for the desktop app (Rust 1.88+, Tauri 2
prerequisites for the OS). The launcher UI is static: no npm, no bundler.

```powershell
# From desktop/
cargo build -p gentree-launcher

# Installer bundle (needs the Tauri CLI from desktop/ui/node_modules)
cd apps/launcher
../../ui/node_modules/.bin/tauri.cmd build
```

`tauri.conf.json` points `frontendDist` at `apps/launcher/ui`, so the static
files are embedded as-is. `withGlobalTauri` is enabled because there is no
JavaScript package manager in this app.

## Local end-to-end check (no GitHub)

All test data is synthetic. No real installers are committed; fixtures live in
an ignored directory.

1. Generate a feed with three synthetic versions, artifacts and correct hashes:

   ```powershell
   node scripts/launcher-feed.mjs --fixtures
   ```

   This writes `.launcher-feed/` with `versions.json`, six synthetic
   `*.exe`/`*.dmg` files (1 MiB each) and their SHA-256 values in the feed.

2. Serve it on loopback only:

   ```powershell
   node scripts/launcher-feed.mjs
   ```

   The server binds `127.0.0.1:8787` and prints the feed URL. Use `--port` to
   change the port; regenerate fixtures with the same `--port` so artifact URLs
   keep pointing at the running server. `--dir <path>` serves another directory.

3. Point the launcher at it and start it (from `desktop/`):

   ```powershell
   $env:GENTREE_LAUNCHER_FEED='http://127.0.0.1:8787/versions.json'
   cargo run -p gentree-launcher
   ```

   Any other environment value is used as-is and must still satisfy the
   transport rule (HTTPS, or HTTP on loopback). Without the variable the
   launcher uses `DEFAULT_FEED_URL` in `src/main.rs`, which currently carries a
   `TODO` placeholder owner. A URL containing `OWNER` or `TODO` is refused
   before any request with `feed_not_configured`, so a build that ships the
   placeholder never calls GitHub; set `GENTREE_LAUNCHER_FEED` or replace the
   constant once the release feed exists.

4. What to verify:

   - The feed loads and shows versions `9.9.2` (latest), `9.9.1`, and
     `9.9.3-beta.1` only after **Preview releases** is enabled.
   - The installed version comes from the OS: `DisplayVersion` of the
     `Gentree` uninstall entry on Windows, `CFBundleShortVersionString` in
     `/Applications/Gentree.app/Contents/Info.plist` on macOS. A real 0.2.x
     install is older than the synthetic 9.9.x feed, so the update banner
     appears.
   - **Install** shows download progress, then `Verifying SHA-256`, and only
     then starts the installer. The synthetic `.exe` is not a real NSIS
     installer, so a real install ends with `install_failed` — that is the
     expected result of the fixture. Download and verification complete before
     that point.
   - To exercise a checksum failure, flip one byte in a served artifact, then
     install again: the launcher reports `checksum_mismatch` and deletes both
     the partial and final file from `<app data>/downloads`.
   - With Gentree running, install is refused with `app_running` before any
     download starts.
   - On macOS the installer step opens the DMG in Finder (`status.manualDmg`);
     drag Gentree into Applications. The launcher never copies files or asks
     for elevated rights.
   - Turning **Check for updates** off persists in the launcher settings and
     stops the start-up check; **Refresh** still loads the feed on demand.
   - Changing the language updates the whole screen and survives a restart
     (`localStorage`).

The generated `.exe` and `.dmg` files are opaque bytes. To test a real install,
serve a real build produced by the release pipeline instead; keep such artifacts
out of git.

## Files on disk

| Path | Content |
| --- | --- |
| `<app data>/logs/launcher.log` | Technical log: event names, versions, sizes, error codes. No URLs, paths or tokens. |
| `<app data>/downloads/` | Verified artifacts (`*.part` while downloading, removed on failure). |
| `<app config>/settings.json` | `{"autoCheck": true}` — the only persisted preference. |

On Windows both directories are under `%APPDATA%\com.gentree.launcher`; on macOS
under `~/Library/Application Support/com.gentree.launcher`. The interface
language is stored separately in the webview's `localStorage`.

## Error codes

Every IPC failure is `{ "code": "<stable id>", "detail"?: "<technical>" }`.
The UI localizes `error.<code>` and never shows an absolute path or secret.

| Code | Meaning |
| --- | --- |
| `feed_parse` | The feed is not valid JSON or misses a required field. |
| `feed_schema` / `feed_app` | Wrong schema number or product id. |
| `feed_version` / `feed_released` | Invalid SemVer or timestamp, duplicate version, or unknown requested version. |
| `feed_sha256` | A checksum is not 64 hex characters. |
| `feed_url` | A URL is not HTTPS (or HTTP on loopback). |
| `feed_latest` / `feed_files` | `latest` names a missing version, a release has no files, or duplicate artifacts. |
| `feed_too_large` | The feed exceeds 2 MiB. |
| `http_status` / `network` | The server answered with an error or was unreachable. |
| `download_read` / `download_write` | Local I/O failure while saving the artifact. |
| `checksum_mismatch` / `size_mismatch` | Verification failed; the artifact was deleted. |
| `app_running` | Gentree is running; close it before installing. |
| `process_check` | The OS process list could not be read. |
| `no_file` | No artifact for this OS/architecture. |
| `unsupported_platform` | The launcher build does not support the host. |
| `install_failed` | The installer could not be started or exited non-zero. |
| `open_failed` / `not_installed` | The installed app could not be started or was not found. |
| `settings_io` | The settings file could not be written. |
| `internal` | Unexpected launcher failure. |

## Publishing a feed

The release pipeline and the landing page can generate the same JSON:

1. Build the Windows NSIS `-setup.exe` and the macOS `aarch64`/`x86_64` DMGs.
2. Compute SHA-256 (and optionally the byte size) for each artifact.
3. Upload the artifacts to a host that serves them directly over HTTPS.
4. Publish `versions.json` with absolute artifact URLs. `latest` is optional;
   include it to pin the offered version, omit it to let the launcher pick the
   highest stable release.

No GitHub-specific fields are part of the contract, so the same feed works
from Gitea, object storage or a static site.
