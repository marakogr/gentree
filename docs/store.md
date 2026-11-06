# Publishing to the Microsoft Store

Gentree is also submitted to the Microsoft Store as a full-trust MSIX package.
The Store signs the upload itself, so this channel needs no code-signing
certificate, and it delivers updates for you. This document covers the package,
the build, and what the Store needs before the first submission.

The GitHub channel does not go away: `make build` keeps producing the NSIS
installer (with the in-app updater) and `make portable` the portable archive.
See [`releases.md`](releases.md).

## Identity

The values below come from Partner Center **Apps and games → Gentree →
Product identity**. They are public and committed in
`desktop/apps/desktop/msix/AppxManifest.xml`; everything else in the manifest is
derived from it.

| Field | Value |
| --- | --- |
| Package/Identity/Name | `marakogr.Gentree` |
| Package/Identity/Publisher | `CN=CCBFC6D1-565E-4E3F-8A41-E60352A1730E` |
| Package/Properties/PublisherDisplayName | `marakogr` |
| Package Family Name | `marakogr.Gentree_3w8vqcv266qa8` |
| Store ID | `9NC0PQH3JF6C` |

A package whose `Publisher` differs by one character is rejected during upload,
which is why the manifest is the only place the identity is written down and
`scripts/package-msix.mjs` reads it back.

## Building the package

```bash
make store        # unsigned MSIX for Partner Center
make store-test   # the same package, signed with a local test certificate
```

Both run `tauri build --no-bundle --features store` and then
`scripts/package-msix.mjs`, which

1. copies the executable and the tile assets into a layout directory,
2. renders `Wide310x150Logo.png` and `SplashScreen.png` from
   `desktop/apps/desktop/icons/icon.png` (MSIX needs them, Tauri does not
   generate them),
3. writes `AppxManifest.xml` with the Store version `0.7.0.0`,
4. packs the layout with `makeappx.exe` and unpacks it again to prove nothing
   was lost.

The result is `release-assets/store/marakogr.Gentree_<version>.0_x64.msix`,
about 11 MB. Requirements: Windows, PowerShell, Node.js, and the Windows SDK
(`makeappx.exe`/`signtool.exe` ship with the MSVC build tools). Set `MAKEAPPX`
or `SIGNTOOL` to override the discovered tool path.

## What the Store build changes

The package is compiled with `--features store`, and that feature is the whole
difference from the GitHub build:

- the updater plugin is not registered at all (`src/main.rs`), so the app cannot
  replace its own package. Store policy requires packaged apps to update through
  the Store, and `C:\Program Files\WindowsApps` is read-only anyway;
- `update_status` reports `channel = "store"` and `configured = false`, and both
  update commands refuse with `UPDATE_NOT_CONFIGURED`;
- **Settings → Updates** says the Store delivers updates and hides the
  check/install controls instead of offering buttons that could only fail.

Everything else is the same program: same project format, same Tauri
identifier, same local-first storage. The package is full trust
(`Windows.FullTrustApplication` + `rescap:runFullTrust`), so file dialogs,
project folders on disk and the chat provider keep working.

Three packaging consequences are worth knowing:

- **App data is virtualized.** `%APPDATA%\Gentree` inside the package resolves to
  `%LOCALAPPDATA%\Packages\marakogr.Gentree_3w8vqcv266qa8\LocalCache\Roaming\Gentree`.
  A Store install and a GitHub install therefore keep separate settings and
  separate search indexes, while both can open the same project folders (the
  project `.lock` still allows only one of them at a time).
- **No WebView2 bootstrapper.** `--no-bundle` skips the installer that would run
  it, so the package relies on the system WebView2 Evergreen Runtime. Windows 11
  and current Windows 10 updates already have it; the Store listing states this
  as a system requirement.
- **`bundle.targets` is irrelevant here.** Nothing is bundled by Tauri; the MSIX
  layout is produced from the plain release executable.

## Submitting

1. **Packages**: upload the `.msix` file. It must stay unsigned — the Store
   signs it after certification. A self-signed package (`make store-test`) is
   only for a local install and is rejected on upload.
2. **Properties**: category *Productivity*, the three UI languages (en, ru, uk),
   Windows 10 1809+ x64.
3. **Age rating**: the IARC questionnaire.
4. **Privacy policy URL**: required, and honest here — projects stay on disk,
   the only network egress is the chat provider the user configures.
5. **Notes for certification**: explain `runFullTrust` (a desktop app that opens
   the user's own project folders) and `internetClient` (the optional chat).
6. **Pricing and availability**: free, the markets you want.

The first certification takes longer than later ones; a new package for an
existing app usually clears within a day.

## Updates

Publishing an update is the same flow with a higher version:

1. bump the version in `desktop/Cargo.toml`, `desktop/apps/desktop/tauri.conf.json`
   and `desktop/ui/package.json` (plus the changelog entry),
2. `make store`,
3. upload the new `.msix` to Partner Center and submit.

The Store applies updates automatically; a user can turn automatic updates off,
and a submission marked as a **mandatory update** installs regardless. The
four-part package version is the app version plus `.0`, so `0.7.0` ships as
`0.7.0.0` and must strictly increase.

CI does the build for a tag or on demand: the **Store package** workflow runs the
Store flavour's lints and tests, builds the MSIX, verifies the identity and that
the file is unsigned, and uploads `gentree-store-x64` as a run artifact together
with `SHA256SUMS-store-x64.txt`. The artifact is not attached to a GitHub
release: an unsigned MSIX is not installable by the public, and the Store listing
is the public channel.

## Testing a package locally

```bash
make store-test
Add-AppxPackage -Path release-assets/store/marakogr.Gentree_0.7.0.0_x64.msix
```

`--dev-sign` creates a throw-away self-signed certificate with the Store
publisher as its subject, puts it in the current user's `TrustedPeople` store and
signs the package, so Windows accepts the install. Sideloading must be allowed
(Settings → System → For developers). Remove the test install and certificate
when done:

```powershell
Get-AppxPackage marakogr.Gentree | Remove-AppxPackage
Get-ChildItem Cert:\CurrentUser\My | Where-Object FriendlyName -like 'Gentree MSIX*' | Remove-Item
```

Because the test package carries the Store identity, a test install and a Store
install of Gentree are the same package: installing one replaces the other.
