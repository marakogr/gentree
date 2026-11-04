# Portable build (Windows)

The portable archive is a zip with one production executable and a short
readme. Nothing is installed, no shortcuts are created and no registry entries
are written. It is the option for a user who wants to run Gentree from a folder
without an installer, or who cannot run an installer at all.

Download `Gentree_<version>_x64_portable.zip` from the release page, unzip it
anywhere and start `Gentree.exe`. The release publishes
`SHA256SUMS-windows-x64.txt` next to the archive; verify the download before the
first launch:

```powershell
Get-FileHash Gentree_0.2.0_x64_portable.zip -Algorithm SHA256
```

The archive is not code-signed yet, so Windows SmartScreen warns about an
unknown publisher on the first launch: click **More info**, then **Run anyway**.
The checksum above is what tells you the file is the one that was published.

## Requirements

- Windows 10 version 1803 (build 17134) or newer, or Windows 11, x64, with the
  Microsoft Edge WebView2 Runtime. Windows 11 and current Windows 10 updates
  already include it; otherwise install it from
  <https://developer.microsoft.com/microsoft-edge/webview2/>. The archive
  cannot install the runtime itself — the NSIS installer can, because it embeds
  the bootstrapper.
- Keep the folder together. Renaming or moving `Gentree.exe` is fine. A
  portable copy shares `%APPDATA%\Gentree` with an installed copy, so both see
  the same settings and project list.

## Where data lives

Settings, projects, backups and search indexes live in `%APPDATA%\Gentree`, not
next to the executable. Upgrading means replacing the folder with a newer
archive; the data stays where it is. Project and backup folders are configurable
in Settings.

Chat conversations are auxiliary app data. They live in a `chat` folder under
the application data root returned by `app.path().app_data_dir()` (the same root
as projects and indexes; `%APPDATA%\com.gentree.desktop` on Windows), never in a
project folder, its backups, its checksums or an export. Deleting a project
removes its conversations; clearing history affects only the open project.

This is deliberate: a portable app that keeps project data next to the
executable would write into a folder the user may have unzipped into a
read-only or synced location, and a crash during a save would be harder to
recover from. The project folder itself is always the source of truth and can
live anywhere, including a removable drive.

## Updates

A portable build never downloads or installs an update by itself. It is built
with `desktop/apps/desktop/tauri.portable.conf.json`, which empties the updater
endpoint and public key, so **Check for updates** reports
`UPDATE_NOT_CONFIGURED`. To upgrade, quit Gentree and replace the folder with
the newer archive.

## Building the archive

```powershell
make portable
```

The recipe builds with `--no-bundle --config tauri.portable.conf.json`, then
runs `scripts/package-portable.mjs`, which stages `Gentree.exe` and a generated
`README.txt`, writes `Gentree_<version>_x64_portable.zip` into
`release-assets/` and prints its SHA-256. The archive is produced with
PowerShell's `Compress-Archive`; the target is Windows-only. macOS ships its own
`.dmg` from the same release.

In CI the Windows job builds the same archive after the bundled build, signs the
executable with the same certificate when one is configured, then runs
`scripts/verify-release.mjs` before uploading the zip and the checksum file to
the draft release. The archive is not rebuilt from a different source tree, so
the published executable is the one that was signed and checked.

## Why a zip and not a single self-extracting executable

An unsigned one-file installer that unpacks another executable and runs it is
the shape heuristic engines treat as suspicious, and it also loses the code
signature of the inner file when the wrapper is repacked. A plain executable
inside a zip keeps one hash, one signature and a predictable extraction, which
is what the release checks measure. The same reasoning is why the archive
contains no launcher and no custom unpacker.
