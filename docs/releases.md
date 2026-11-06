# Releases and in-app updates

Gentree ships Windows installers, a portable Windows archive, and can update
itself through [`tauri-plugin-updater`](https://tauri.app/plugin/updater/). This
document covers the release pipeline, the keys and secrets it needs, how the
update endpoint is wired, and what is verified before a release becomes public.

Every release publishes Windows x64 and macOS arm64 (Apple Silicon) artifacts.
Both are unsigned until their certificate secrets are configured: Authenticode
for Windows, Developer ID with notarization for macOS (see
[Code signing](#code-signing)). Intel Macs are not covered by the release yet;
build from source with `make build` (`desktop/docs/build.md`).

The release workflow code-signs the artifacts when a certificate is configured
and verifies the signatures, the checksums and a Microsoft Defender scan while
the release is still a draft. An unsigned build is still possible and is
reported as a warning, not a failure; see [Code signing](#code-signing).

The updater is **opt-in**: the app makes no update request until the user turns
on **Settings → Updates → Check for updates at startup** (`updates.auto_check`,
off by default) or presses **Check for updates**. There is no telemetry.

The Microsoft Store is a second channel with its own packaging and updates: the
Store build is a full-trust MSIX that the Store signs and updates, and it ships
without the in-app updater. See [`store.md`](store.md) (`docs/ru/store.md`).

## How the app decides whether updates are configured

The release-side settings live in `desktop/apps/desktop/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/marakogr/gentree/releases/latest/download/latest.json"
    ],
    "pubkey": "<the minisign public key committed in tauri.conf.json>"
  }
}
```

The endpoint is a public URL and the public key is not a secret, so both are
committed. A build that ships without release keys still cannot reach a host:
the overlays leave the values empty or keep the `REPLACE_WITH` marker, and the
readiness check below refuses them before any client is created.

The Rust commands in `desktop/apps/desktop/src/updates.rs` read this section.

- `update_status` never touches the network. It returns the current version and
  whether both values are real.
- `update_check` and `update_install` return `UPDATE_NOT_CONFIGURED` and do not
  create an HTTP client while the endpoint is missing, contains the
  `REPLACE_WITH` marker or is not `https://`, or while the public key is empty
  or a placeholder. A local test build may allow plain HTTP for a loopback host
  only, and only when its own config overlay sets
  `dangerousInsecureTransportProtocol`.
- The startup check runs only when `updates.auto_check` is on **and** the build
  is configured.

The shipped `tauri.conf.json` carries the real endpoint and key, so a released
build is configured. `tauri.portable.conf.json` empties both values, and a unit
test in `updates.rs` fails if the checked-in config ever regresses to a
placeholder.

## One-time key generation

The updater verifies every artifact with a minisign key pair. Generate it once
on a trusted machine and keep the private key out of the repository.

```powershell
# Windows (PowerShell)
cd desktop/apps/desktop
..\..\ui\node_modules\.bin\tauri.cmd signer generate -w "$env:USERPROFILE\.tauri\gentree.key"
```

```bash
# macOS / Linux
cd desktop/apps/desktop
../../ui/node_modules/.bin/tauri signer generate -w ~/.tauri/gentree.key
```

The command asks for a password, prints the public key and writes two files:

- `gentree.key` — private key. Never commit, print or paste it anywhere except
  the CI secret store.
- `gentree.key.pub` — public key. Paste its contents into
  `plugins.updater.pubkey` in `tauri.conf.json`.

Keep an offline backup of `gentree.key`: losing it means a new key pair and a
manually installed build for every existing user, because old clients trust the
old public key.

## GitHub secrets

Configure these in **Settings → Secrets and variables → Actions** of the
repository. Only the names are documented here; values never belong in the
repository, an issue, a PR or an agent message. The release workflow reads both
and fails before the build when the private key is missing, because without it
no updater artifact or `latest.json` can be produced.

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | full contents of `gentree.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password chosen during key generation |

`GITHUB_TOKEN` is provided by Actions; the workflow needs `contents: write` to
create the draft release, which is already set.

## Code signing

The minisign key above protects the update channel: it proves that an update
came from the project. It says nothing to Windows SmartScreen or to antivirus
engines, which check Authenticode (Windows) and Developer ID / notarization
(macOS) instead. Both layers are independent and both matter.

### Windows (Authenticode)

The workflow supports a `.pfx` code-signing certificate and does not require it:

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | base64 of the `.pfx` (see the command below) |
| `WINDOWS_CERTIFICATE_PASSWORD` | password that protects the `.pfx` |

```powershell
# Base64 without header lines; paste the result into the secret.
[Convert]::ToBase64String([IO.File]::ReadAllBytes('certificate.pfx'))
```

When both secrets exist, the `Prepare Windows code signing` step imports the
certificate into the runner's `Cert:\CurrentUser\My` store, writes a
git-ignored `desktop/apps/desktop/tauri.signing.conf.json` overlay with
`certificateThumbprint`, `digestAlgorithm: sha256`, `tsp: true` and
`timestampUrl: http://timestamp.acs.microsoft.com` (RFC 3161), and `tauri-action`
signs the application executable, the uninstaller and the NSIS installer. The
portable executable is built separately, so it is signed by an explicit
`signtool` call before it is archived.

Without the secrets the overlay is `{}`: installers are still built and
uploaded, the verification step reports `NotSigned` as a warning, and the draft
release can still be published (not recommended for a public announcement).

For a certificate that cannot be exported as a `.pfx` (HSM-bound subscriptions),
use Azure Artifact Signing (formerly Azure Trusted Signing) through
`bundle.windows.signCommand`, for example
`artifact-signing-cli -e https://<region>.codesigning.azure.net -a <account> -c <profile> -d Gentree %1`.
The verification steps work unchanged: they read the signature, not the tool.

Two expectations to keep:

- Since 2024 an EV certificate no longer grants instant SmartScreen
  reputation. OV and EV builds reputation the same way, so a fresh release may
  still warn until the file and the certificate accumulate downloads.
- Reputation attaches to the certificate and the file. Sign every release with
  the same certificate, never rebuild an already published version, and do not
  rename signed artifacts.

### macOS (Developer ID and notarization)

The macOS job builds an unsigned `.dmg` until these secrets exist. Tauri reads
them directly; there is no overlay file to write, unlike Windows:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of a `Developer ID Application` `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` from `security find-identity -v -p codesigning` |
| `APPLE_TEAM_ID` | the `TEAMID` from that identity |
| `APPLE_ID` + `APPLE_PASSWORD` | Apple ID and an app-specific password (notarization via Apple ID) |
| or `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_P8` | App Store Connect key ID, issuer ID and the `.p8` contents; the workflow writes the key file and exports `APPLE_API_KEY_PATH`. The safer option for CI |

```bash
# Base64 without line breaks; paste the result into the secret.
openssl base64 -A -in certificate.p12 -out certificate-base64.txt
```

With the secrets present, `tauri-action` signs the `.app` and the `.dmg` with
the Developer ID identity, submits the bundle for notarization and staples the
ticket. Provide either the Apple ID pair or the API key triple; notarization
credentials are required, the certificate alone is not enough. The
`Verify the macOS artifacts` step then passes
`--require-signature`, so `spctl --assess` and `stapler validate` failures fail
the release instead of only warning. Without `APPLE_CERTIFICATE` the step warns,
the draft is published unsigned, and the release notes tell users how to open
the app.

The updater does not depend on Developer ID: the `.app.tar.gz` is signed with
the minisign key like every other artifact, so updates work before notarization
is configured. Gatekeeper still decides whether the user can *first* start the
app.

Two expectations to keep:

- Notarization adds an external dependency to the release: an Apple outage or an
  expired certificate must fail the draft, never publish an unsigned `.dmg`
  silently.
- The identity must match the certificate. A mismatched `APPLE_SIGNING_IDENTITY`
  makes `codesign` fail; copy it from `security find-identity`, do not retype it.

### Unsigned preview releases

Until a certificate is configured, every published artifact is unsigned. That
is a documented limitation, not an accident, and it has three consequences:

- Windows SmartScreen shows **Windows protected your PC** on the first launch.
  The README, the release body (`releaseBody` in the workflow) and the readme
  inside the portable archive tell users to click **More info** → **Run anyway**
  and to verify the checksum first.
- Windows 11 **Smart App Control** blocks unsigned apps and offers no per-app
  exception. Turning it off is a system-wide security change, so users must
  decide for themselves; do not present it as an install step. A signed build is
  the only fix.
- Antivirus false positives are more likely and harder to triage without a
  publisher name. Handle each report as a release incident: ask for the file
  name, SHA-256, Windows version and the detection name, then follow
  [When an engine reports a false positive](#when-an-engine-reports-a-false-positive).

Do not rebuild or rename an artifact after publishing it. File reputation is
tracked by hash, so a new hash starts from zero, and renaming an asset breaks
the checksums users already collected.

The update channel is enabled before Authenticode signing lands. The updater
still verifies every package with the minisign key, so a tampered download is
rejected; what Authenticode adds is trust in the installer as a file, which is
what SmartScreen and behavioural engines look at. The accepted consequence is
that the first update installs an unsigned NSIS package, so publish 0.2.1 only
after the local and published update checks in the release checklist pass.

For an open-source project the cheapest real certificate is
[SignPath Foundation](https://signpath.org/) (free signing for OSS projects,
certificate hosted by them). Once any certificate is available, the existing
secrets turn signing on without further code changes.

## Endpoint

The app polls the update manifest of this repository:

```
https://github.com/marakogr/gentree/releases/latest/download/latest.json
```

`latest.json` is generated by `tauri-action` (`includeUpdaterJson: true`) from
the signed updater artifacts and uploaded to every release. The
`/releases/latest/` URL only resolves for a **published** release; draft
releases are not "latest" and are invisible to the updater. That is intentional:
publishing is a manual review step.

The endpoint must be HTTPS. The app does not enable
`dangerousInsecureTransportProtocol`, so a plain `http://` endpoint is reported
as `UPDATE_NOT_CONFIGURED` instead of being used.

The Windows job publishes the NSIS installer only. It installs per user, needs
no administrator rights, and the updater can run it silently. The macOS job adds
one updater archive, so `latest.json` carries a `windows-x86_64` entry and a
`darwin-aarch64` entry. The MSI is still produced by a local
`make build` for managed deployments; it is not a release asset and an MSI
install is not updated by this pipeline. Upgrade such installations with your
own tooling.

## Release checklist

1. Bump the version in `desktop/apps/desktop/tauri.conf.json`. Keep
   `desktop/Cargo.toml` (`[workspace.package] version`) and
   `desktop/ui/package.json` in step for consistency.
2. Update `CHANGELOG.md`.
3. Merge to `main`; `main` must be green.
4. Tag and push:

   ```bash
   make release
   ```

   It reads the version from `tauri.conf.json`, refuses a dirty tree, a branch
   other than `main`, an out-of-sync `main`, a missing `## [<version>]`
   changelog section or an existing tag, then creates and pushes the annotated
   tag. The manual equivalent is `git tag v<version> && git push origin
   v<version>`.

5. `.github/workflows/release.yml` runs the quality gates from `make check`
   (fmt, clippy, Rust tests, UI tests, locale parity) on every platform in the
   matrix, then builds Windows x64 and macOS arm64 and uploads everything to one
   **draft** release. Before the build it checks that the tag matches
   `tauri.conf.json`, that the update endpoint and public key are real, and that
   the signing key secret is present.
6. Review the draft assets:
   - `Gentree_<version>_x64-setup.exe` (NSIS) and its minisign `.sig`;
   - `Gentree_<version>_x64_portable.zip`;
   - `Gentree_<version>_aarch64.dmg`;
   - `Gentree_<version>_aarch64.app.tar.gz` and its minisign `.sig` (the
     updater artifact);
   - `SHA256SUMS-windows-x64.txt` and `SHA256SUMS-macos-arm64.txt`;
   - `latest.json` with the `windows-x86_64` and `darwin-aarch64` entries.
7. Read the CI verification log: signature status per artifact, the Defender
   scan result and the checksum files. CI covers signatures and a single
   engine; the multi-engine check and the manual installs are up to you:
   - scan the installers and the portable archive with a current multi-engine
     scanner (VirusTotal or a local suite) and require zero detections;
   - download the artifacts in a browser on a clean Windows 11 VM, confirm the
     SmartScreen prompt, complete an install and start the app;
   - unzip the portable archive outside `%LOCALAPPDATA%`, start it, and confirm
     that **Check for updates** reports that updates are not configured;
   - download the `.dmg` on a clean Apple Silicon Mac, confirm the Gatekeeper
     prompt (or the notarized launch once `APPLE_*` is configured), drag the app
     into **Applications** and start it.
8. Publish the draft (not "Save draft"). Publishing is what makes
   `/releases/latest/download/latest.json` resolve.
9. Verify from a machine that is not the build host:

   ```bash
   curl -fsSL https://github.com/marakogr/gentree/releases/latest/download/latest.json
   ```

10. Test the update path before announcing the release: build the previous
    version with `tauri.release.conf.json` (see
    [Local builds and updater artifacts](#local-builds-and-updater-artifacts)),
    install it, and press **Check for updates** once the release is published.

## Pre-publish verification

`scripts/verify-release.mjs` is the same gate locally and in CI:

```powershell
node scripts/verify-release.mjs `
  --asset desktop/target/release/bundle/nsis/Gentree_0.2.0_x64-setup.exe `
  --asset release-assets/Gentree_0.2.0_x64_portable.zip `
  --verify-only desktop/target/release/gentree-desktop.exe `
  --sums release-assets/SHA256SUMS-windows-x64.txt `
  --require-signature --defender
```

- `--asset` is a release artifact: its signature is checked and its SHA-256 is
  written to the checksum file.
- `--verify-only` checks a file that is not published on its own, such as the
  portable executable.
- `--require-signature` turns a missing signature into a failure. CI passes it
  only when the certificate secrets exist, so the pipeline works before the
  certificate is bought.
- `--defender` runs an on-demand Microsoft Defender scan. It is advisory: a
  runner without Defender produces a warning, not a failed release. It is a
  smoke test, not proof — one engine is not a multi-engine result.

On macOS the same script checks a `.dmg` with `spctl --assess` and
`xcrun stapler validate`, and an `.app` bundle with `codesign --verify --deep
--strict`. CI verifies the `.dmg`; a local check of the bundle looks like this:

```bash
node scripts/verify-release.mjs \
  --asset desktop/target/release/bundle/dmg/Gentree_0.2.0_aarch64.dmg \
  --sums release-assets/SHA256SUMS-macos-arm64.txt
```

`--require-signature` is passed only when `APPLE_CERTIFICATE` exists, so the
pipeline works before the certificate is bought, and a signed release cannot
quietly lose its signature.

### When an engine reports a false positive

1. Re-scan the exact published file, not a local rebuild: a different hash
   starts with no reputation.
2. Submit the file to Microsoft through the
   [Windows Defender file submission](https://www.microsoft.com/en-us/wdsi/filesubmission/)
   form; ask for a review of the false positive and for reputation.
3. Submit to the vendor shown in the detection (Avast, ESET, Kaspersky,
   Bitdefender, McAfee and others have false-positive forms). Keep one message
   template with the release URL, the SHA-256, the version and a short
   description.
4. If the detection is behavioral, note which step triggers it. Installing
   without a certificate, downloading WebView2 during setup and self-updating
   are the three usual causes.
5. Record the outcome in the release notes so users who see the warning know it
   is being handled.

## Portable archive

`make portable` builds a production executable with
`--config tauri.portable.conf.json` and packages it as
`Gentree_<version>_x64_portable.zip` with `scripts/package-portable.mjs`. The
overlay empties the updater endpoint and public key, so a portable copy reports
`UPDATE_NOT_CONFIGURED` and can never install itself into `%LOCALAPPDATA%`.

The archive holds one executable and a readme, no installer and no
self-extracting stub. See [`docs/portable.md`](portable.md) for the user-facing
details, including the WebView2 requirement and the `%APPDATA%\Gentree` data
location.

## Updating a bad release

The updater only accepts a version greater than the current one. A broken
release is fixed by publishing a higher version; there is no downgrade path and
no "un-publish" for clients that already installed it. Deleting `latest.json`
from the published release only breaks checks for everyone else.

## Local builds and updater artifacts

`tauri.conf.json` alone does not create updater artifacts, so `make build` works
without a signing key and produces ordinary installers. The release workflow
passes `tauri.release.conf.json` on top, which turns
`bundle.createUpdaterArtifacts` on and therefore requires the key secret. To
build the same signed artifacts locally, pass the overlay:

```bash
# Signed installers plus updater artifacts
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/gentree.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
cd desktop/apps/desktop
../../ui/node_modules/.bin/tauri build --config tauri.release.conf.json
```

```powershell
# Windows PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\gentree.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."
cd desktop\apps\desktop
..\..\ui\node_modules\.bin\tauri.cmd build --config tauri.release.conf.json
```

For a plain local run use `make exe`, `make run` or `make dev`.

## Testing an update locally

The updater does not depend on GitHub: it downloads a static JSON manifest and
the artifact it names. Any static file server works; the steps below use a local
one, so the test never touches a published release.

1. Generate a throwaway key pair and keep the private key out of git:

   ```bash
   npm --prefix desktop/ui exec tauri signer generate -- -w .tauri/gentree-local.key
   ```

2. Create `desktop/apps/desktop/tauri.local.conf.json` (git-ignored). It merges
   over `tauri.conf.json`:

   ```json
   {
     "bundle": { "createUpdaterArtifacts": true },
     "plugins": {
       "updater": {
         "endpoints": [
           "http://127.0.0.1:3001/latest.json"
         ],
         "pubkey": "<public key from the generated pair>",
         "dangerousInsecureTransportProtocol": true
       }
     }
   }
   ```

   Plain HTTP is accepted only for `127.0.0.1`, `localhost` or `[::1]` and only
   with this flag. Never put the flag in the shipped config.

3. Build the **previous** version with both overlays and the private key in the
   environment, then install it:

   ```bash
   cd desktop/apps/desktop
   ../../ui/node_modules/.bin/tauri build --config tauri.release.conf.json \
     --config tauri.local.conf.json
   ```

4. Build the next version the same way. The build writes
   `Gentree_<version>_x64-setup.exe` and its `.sig` next to the NSIS installer.
   Copy both into an empty folder with a hand-written `latest.json`:

   ```json
   {
     "version": "0.2.1",
     "notes": "Local update test",
     "pub_date": "2026-11-01T12:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the .exe.sig file>",
         "url": "http://127.0.0.1:3001/Gentree_0.2.1_x64-setup.exe"
       }
     }
   }
   ```

   `tauri-action` writes `latest.json` for GitHub from the same inputs, so the
   hand-written file only mirrors its shape.

5. Serve that folder on port 3001 (`npx serve -l 3001 .` or
   `python -m http.server 3001`) and confirm `http://127.0.0.1:3001/latest.json`
   opens.

6. Start the installed previous version, open **Settings → Updates** and press
   **Check for updates**. The app downloads the artifact, verifies the signature
   and installs it. A wrong signature or a truncated download must end in
   `UPDATE_INSTALL_FAILED` instead of an install.

`latest.json` is validated as a whole, so every platform entry in it must be
complete. On macOS the updater artifact is the `.app.tar.gz` and its `.sig`;
plain HTTP and Gatekeeper make local macOS testing less useful than Windows.

## Why there is no download page yet

Every release needs a manual review before it becomes public. Until a landing
page exists, the GitHub Releases page is the download page.

When the page is added, it should not scrape HTML. Two stable options:

- link to `https://github.com/marakogr/gentree/releases/latest` for people;
- call `GET https://api.github.com/repos/marakogr/gentree/releases/latest` and
  read `tag_name`, `published_at` and `assets[].browser_download_url`, filtering
  by asset name for the platform.

`latest.json` is for the updater, not for a download page: it lists updater
archives and signatures, not the installers a person should download.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `UPDATE_NOT_CONFIGURED` | endpoint or `pubkey` is empty, a placeholder, or the endpoint is not `https://` |
| `UPDATE_CHECK_FAILED` | endpoint unreachable, 404, or malformed `latest.json`; a draft release is not visible |
| `UPDATE_INSTALL_FAILED` | signature mismatch, truncated download, or installer failure |
| Update never offered | remote version is not greater than the installed one, or the target/arch entry is missing from `latest.json` |
| Release fails at "Check that the updater is configured" | the endpoint or key is a placeholder, or `TAURI_SIGNING_PRIVATE_KEY` is not set |
| `NotSigned` in the verification log | no certificate secrets; see [Code signing](#code-signing) |
| `SignTool not found` on a local signed build | the Windows SDK is not registered in the registry; set `TAURI_WINDOWS_SIGNTOOL_PATH` to `<Windows Kits>\10\bin\<version>\x64\signtool.exe` |
| `SignTool Error: The specified timestamp server ...` | the TSA is unreachable from the build host; the workflow uses `http://timestamp.acs.microsoft.com` with `tsp: true` |
| `stapler validate` fails | the DMG was not notarized; check the `APPLE_*` secrets |
| Portable build offers no updates | expected: `tauri.portable.conf.json` empties the updater endpoint |

Errors are shown through the localized `errors.<code>` strings. The backend
never logs or returns the endpoint URL, the key or the response body.
