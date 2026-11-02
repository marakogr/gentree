//! The version feed consumed by the launcher.
//!
//! The wire format is fixed by `docs/launcher.md`: schema 1, app `gentree`,
//! SemVer versions, SHA-256 for every artifact. GitHub/Gitea only host the
//! files — nothing here knows about a forge.

use semver::Version;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use url::Url;

use crate::error::{codes, LauncherError};

/// Feed schema understood by this launcher build.
pub const SCHEMA: u32 = 1;
/// Feed application id; the launcher refuses any other product.
pub const APP: &str = "gentree";

/// Target operating system supported by the feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Windows,
    Macos,
}

impl Os {
    /// Installer format this OS expects.
    pub fn expected_kind(self) -> Kind {
        match self {
            Self::Windows => Kind::Nsis,
            Self::Macos => Kind::Dmg,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
        }
    }
}

/// Target CPU architecture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Arch {
    #[serde(rename = "x86_64")]
    X86_64,
    #[serde(rename = "aarch64")]
    Aarch64,
}

impl Arch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
        }
    }
}

/// Installer format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Nsis,
    Dmg,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nsis => "nsis",
            Self::Dmg => "dmg",
        }
    }
}

/// One downloadable artifact.
#[derive(Debug, Clone, Deserialize)]
pub struct FileEntry {
    pub os: Os,
    pub arch: Arch,
    pub kind: Kind,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// One released version and its artifacts.
#[derive(Debug, Clone, Deserialize)]
pub struct VersionEntry {
    pub version: String,
    pub released: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub files: Vec<FileEntry>,
    /// Filled by [`Feed::parse`]; never part of the wire format.
    #[serde(skip)]
    parsed: Option<Version>,
}

impl VersionEntry {
    fn semver(&self) -> Option<&Version> {
        self.parsed.as_ref()
    }

    /// A version is beta when the feed says so or when SemVer carries a
    /// prerelease tag; the two must not disagree about the default list.
    pub fn is_prerelease(&self) -> bool {
        self.prerelease || self.semver().is_some_and(|value| !value.pre.is_empty())
    }

    /// Artifact for `os`/`arch`, requiring the installer format of that OS.
    pub fn file_for(&self, os: Os, arch: Arch) -> Option<&FileEntry> {
        let kind = os.expected_kind();
        self.files
            .iter()
            .find(|file| file.os == os && file.arch == arch && file.kind == kind)
    }

    pub fn released_at(&self) -> Option<OffsetDateTime> {
        OffsetDateTime::parse(&self.released, &Rfc3339).ok()
    }
}

/// The parsed feed.
#[derive(Debug, Clone, Deserialize)]
pub struct Feed {
    pub schema: u32,
    pub app: String,
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
}

impl Feed {
    /// Parses and fully validates a feed document.
    pub fn parse(raw: &str) -> Result<Self, LauncherError> {
        let mut feed: Self = serde_json::from_str(raw)
            .map_err(|error| LauncherError::with_detail(codes::FEED_PARSE, error.to_string()))?;

        if feed.schema != SCHEMA {
            return Err(LauncherError::with_detail(
                codes::FEED_SCHEMA,
                format!("expected {SCHEMA}, got {}", feed.schema),
            ));
        }
        if feed.app != APP {
            return Err(LauncherError::with_detail(
                codes::FEED_APP,
                "unexpected app id",
            ));
        }
        if feed.versions.is_empty() {
            return Err(LauncherError::with_detail(codes::FEED_FILES, "no versions"));
        }

        let mut seen: Vec<Version> = Vec::with_capacity(feed.versions.len());
        for entry in &mut feed.versions {
            let parsed = Version::parse(entry.version.trim()).map_err(|error| {
                LauncherError::with_detail(codes::FEED_VERSION, error.to_string())
            })?;
            entry.version = parsed.to_string();
            if seen.contains(&parsed) {
                return Err(LauncherError::with_detail(
                    codes::FEED_VERSION,
                    "duplicate version",
                ));
            }
            seen.push(parsed.clone());
            entry.parsed = Some(parsed);

            entry.released_at().ok_or_else(|| {
                LauncherError::with_detail(codes::FEED_RELEASED, "released must be RFC 3339")
            })?;

            if entry.files.is_empty() {
                return Err(LauncherError::with_detail(
                    codes::FEED_FILES,
                    format!("no files for {}", entry.version),
                ));
            }

            let mut seen_files: Vec<(Os, Arch, Kind)> = Vec::new();
            for file in &mut entry.files {
                let key = (file.os, file.arch, file.kind);
                if seen_files.contains(&key) {
                    return Err(LauncherError::with_detail(
                        codes::FEED_FILES,
                        format!("duplicate artifact for {}", entry.version),
                    ));
                }
                seen_files.push(key);

                let digest = file.sha256.trim();
                if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(LauncherError::with_detail(
                        codes::FEED_SHA256,
                        format!("invalid sha256 for {}", entry.version),
                    ));
                }
                file.sha256 = digest.to_ascii_lowercase();

                parse_artifact_url(&file.url)?;
            }
        }

        if let Some(latest) = &feed.latest {
            if !feed.versions.iter().any(|entry| entry.version == *latest) {
                return Err(LauncherError::with_detail(
                    codes::FEED_LATEST,
                    "latest does not name a listed version",
                ));
            }
        }

        Ok(feed)
    }

    pub fn find(&self, version: &str) -> Option<&VersionEntry> {
        self.versions.iter().find(|entry| entry.version == version)
    }

    /// The version offered by default: `latest` when the feed names it,
    /// otherwise the highest stable version. A feed with only prereleases
    /// falls back to the highest prerelease so the screen is never empty.
    pub fn select_latest(&self) -> Option<&VersionEntry> {
        if let Some(latest) = &self.latest {
            return self.find(latest);
        }
        self.versions
            .iter()
            .filter(|entry| !entry.is_prerelease())
            .max_by(|left, right| compare_entries(left, right))
            .or_else(|| {
                self.versions
                    .iter()
                    .max_by(|left, right| compare_entries(left, right))
            })
    }

    /// Versions newest first; prereleases are hidden unless requested.
    pub fn sorted(&self, include_prerelease: bool) -> Vec<&VersionEntry> {
        let mut entries: Vec<&VersionEntry> = self
            .versions
            .iter()
            .filter(|entry| include_prerelease || !entry.is_prerelease())
            .collect();
        entries.sort_by(|left, right| compare_entries(right, left));
        entries
    }
}

fn compare_entries(left: &VersionEntry, right: &VersionEntry) -> std::cmp::Ordering {
    match (left.semver(), right.semver()) {
        (Some(left), Some(right)) => left.cmp(right),
        _ => left.version.cmp(&right.version),
    }
}

/// Only HTTPS is accepted; plain HTTP is limited to loopback for the local
/// test server described in `docs/launcher.md`.
pub fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// The checked-in default still names a placeholder repository. A build that
/// ships it must report "not configured" instead of requesting a 404 page.
/// The markers are case-sensitive: a real URL never contains them.
pub fn is_placeholder_url(raw: &str) -> bool {
    let raw = raw.trim();
    raw.is_empty() || raw.contains("OWNER") || raw.contains("TODO")
}

/// Parses an artifact URL and enforces the transport policy.
pub fn parse_artifact_url(raw: &str) -> Result<Url, LauncherError> {
    let url = Url::parse(raw.trim())
        .map_err(|_| LauncherError::with_detail(codes::FEED_URL, "invalid URL"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(LauncherError::with_detail(
            codes::FEED_URL,
            "credentials are not allowed",
        ));
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback_host(&url) => Ok(url),
        _ => Err(LauncherError::with_detail(
            codes::FEED_URL,
            "https required outside loopback",
        )),
    }
}

/// OS of this build, or `None` when the launcher runs on an unsupported host.
pub fn current_os() -> Option<Os> {
    #[cfg(target_os = "windows")]
    {
        Some(Os::Windows)
    }
    #[cfg(target_os = "macos")]
    {
        Some(Os::Macos)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

/// CPU architecture of this build, or `None` when unsupported.
pub fn current_arch() -> Option<Arch> {
    #[cfg(target_arch = "x86_64")]
    {
        Some(Arch::X86_64)
    }
    #[cfg(target_arch = "aarch64")]
    {
        Some(Arch::Aarch64)
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn file(os: &str, arch: &str, kind: &str) -> String {
        format!(
            r#"{{"os":"{os}","arch":"{arch}","kind":"{kind}","url":"https://downloads.example/gentree","sha256":"{DIGEST}","size":42}}"#
        )
    }

    fn feed(versions: &str, latest: Option<&str>) -> String {
        let latest = match latest {
            Some(value) => format!(r#""latest":"{value}","#),
            None => String::new(),
        };
        format!(r#"{{"schema":1,"app":"gentree",{latest}"versions":[{versions}]}}"#)
    }

    fn version(version: &str, prerelease: bool, files: &[String]) -> String {
        format!(
            r#"{{"version":"{version}","released":"2026-11-01T12:00:00Z","notes":"n","prerelease":{prerelease},"files":[{}]}}"#,
            files.join(",")
        )
    }

    fn stable_feed() -> String {
        feed(
            &format!(
                "{},{}",
                version("0.2.0", false, &[file("windows", "x86_64", "nsis")]),
                version("0.2.1", false, &[file("macos", "aarch64", "dmg")])
            ),
            Some("0.2.1"),
        )
    }

    #[test]
    fn parses_and_normalizes_a_valid_feed() {
        let raw = feed(
            &version(
                "0.2.1",
                false,
                &[format!(
                    r#"{{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/gentree.exe","sha256":"{}"}}"#,
                    DIGEST.to_ascii_uppercase()
                )],
            ),
            Some("0.2.1"),
        );

        let parsed = Feed::parse(&raw).expect("valid feed");

        assert_eq!(parsed.schema, 1);
        assert_eq!(
            parsed.select_latest().map(|entry| entry.version.as_str()),
            Some("0.2.1")
        );
        assert_eq!(parsed.versions[0].files[0].sha256, DIGEST);
        assert_eq!(
            parsed.versions[0]
                .file_for(Os::Windows, Arch::X86_64)
                .map(|file| file.kind),
            Some(Kind::Nsis)
        );
    }

    #[test]
    fn rejects_the_wrong_schema_or_app() {
        let wrong_schema = r#"{"schema":2,"app":"gentree","versions":[]}"#;
        assert_eq!(
            Feed::parse(wrong_schema).expect_err("schema").code,
            codes::FEED_SCHEMA
        );

        let wrong_app = r#"{"schema":1,"app":"other","versions":[]}"#;
        assert_eq!(
            Feed::parse(wrong_app).expect_err("app").code,
            codes::FEED_APP
        );
    }

    #[test]
    fn rejects_invalid_versions_and_dates() {
        let bad_version = feed(
            &version("1.2", false, &[file("windows", "x86_64", "nsis")]),
            None,
        );
        assert_eq!(
            Feed::parse(&bad_version).expect_err("semver").code,
            codes::FEED_VERSION
        );

        let bad_date = feed(
            r#"{"version":"1.0.0","released":"yesterday","notes":"","prerelease":false,"files":[{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/a","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]}"#,
            None,
        );
        assert_eq!(
            Feed::parse(&bad_date).expect_err("date").code,
            codes::FEED_RELEASED
        );
    }

    #[test]
    fn rejects_a_malformed_sha256() {
        for digest in ["", "abc", &"g".repeat(64), &"a".repeat(63)] {
            let raw = feed(
                &version(
                    "1.0.0",
                    false,
                    &[format!(
                        r#"{{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/a","sha256":"{digest}"}}"#
                    )],
                ),
                None,
            );
            assert_eq!(
                Feed::parse(&raw).expect_err("digest").code,
                codes::FEED_SHA256
            );
        }
    }

    #[test]
    fn rejects_duplicate_versions_and_artifacts() {
        let duplicate_version = feed(
            &format!(
                "{},{}",
                version("1.0.0", false, &[file("windows", "x86_64", "nsis")]),
                version("1.0.0", false, &[file("macos", "aarch64", "dmg")])
            ),
            None,
        );
        assert_eq!(
            Feed::parse(&duplicate_version).expect_err("duplicate").code,
            codes::FEED_VERSION
        );

        let duplicate_file = feed(
            &version(
                "1.0.0",
                false,
                &[
                    file("windows", "x86_64", "nsis"),
                    file("windows", "x86_64", "nsis"),
                ],
            ),
            None,
        );
        assert_eq!(
            Feed::parse(&duplicate_file)
                .expect_err("duplicate file")
                .code,
            codes::FEED_FILES
        );
    }

    #[test]
    fn rejects_unknown_latest_and_non_https_urls() {
        let unknown_latest = feed(
            &version("1.0.0", false, &[file("windows", "x86_64", "nsis")]),
            Some("9.9.9"),
        );
        assert_eq!(
            Feed::parse(&unknown_latest).expect_err("latest").code,
            codes::FEED_LATEST
        );

        let remote_http = feed(
            &version(
                "1.0.0",
                false,
                &[r#"{"os":"windows","arch":"x86_64","kind":"nsis","url":"http://downloads.example/a","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#.to_string()],
            ),
            None,
        );
        assert_eq!(
            Feed::parse(&remote_http).expect_err("http").code,
            codes::FEED_URL
        );
    }

    #[test]
    fn placeholder_feed_urls_are_refused() {
        assert!(is_placeholder_url(
            "https://github.com/OWNER/gentree/releases/latest/download/versions.json"
        ));
        assert!(is_placeholder_url("  "));
        assert!(is_placeholder_url("https://example.com/TODO/versions.json"));
        assert!(!is_placeholder_url(
            "https://github.com/gentree/gentree/releases/latest/download/versions.json"
        ));
        assert!(!is_placeholder_url("http://127.0.0.1:8787/versions.json"));
    }

    #[test]
    fn accepts_http_for_loopback_test_servers() {
        for url in [
            "http://127.0.0.1:8787/Gentree.exe",
            "http://localhost:8787/Gentree.exe",
            "http://[::1]:8787/Gentree.exe",
        ] {
            assert!(parse_artifact_url(url).is_ok(), "{url}");
        }
        assert!(parse_artifact_url("http://192.168.1.10/Gentree.exe").is_err());
        assert!(parse_artifact_url("ftp://127.0.0.1/Gentree.exe").is_err());
        assert!(parse_artifact_url("https://user:secret@downloads.example/a").is_err());
    }

    #[test]
    fn selects_the_named_latest_version() {
        let parsed = Feed::parse(&stable_feed()).expect("feed");

        assert_eq!(
            parsed.select_latest().map(|entry| entry.version.as_str()),
            Some("0.2.1")
        );
    }

    #[test]
    fn selects_the_highest_stable_version_without_latest() {
        let raw = feed(
            &format!(
                "{},{},{}",
                version("0.2.0", false, &[file("windows", "x86_64", "nsis")]),
                version("0.3.0-beta.1", true, &[file("windows", "x86_64", "nsis")]),
                version("0.2.10", false, &[file("windows", "x86_64", "nsis")])
            ),
            None,
        );
        let parsed = Feed::parse(&raw).expect("feed");

        assert_eq!(
            parsed.select_latest().map(|entry| entry.version.as_str()),
            Some("0.2.10")
        );
        let listed: Vec<&str> = parsed
            .sorted(false)
            .iter()
            .map(|entry| entry.version.as_str())
            .collect();
        assert_eq!(listed, ["0.2.10", "0.2.0"]);
        assert_eq!(parsed.sorted(true).len(), 3);
    }

    #[test]
    fn falls_back_to_prereleases_when_no_stable_version_exists() {
        let raw = feed(
            &version("0.3.0-beta.2", true, &[file("windows", "x86_64", "nsis")]),
            None,
        );
        let parsed = Feed::parse(&raw).expect("feed");

        assert_eq!(
            parsed.select_latest().map(|entry| entry.version.as_str()),
            Some("0.3.0-beta.2")
        );
        assert!(parsed.sorted(false).is_empty());
    }

    #[test]
    fn maps_os_and_arch_to_the_right_artifact() {
        let raw = feed(
            &version(
                "1.0.0",
                false,
                &[
                    file("windows", "x86_64", "nsis"),
                    file("macos", "aarch64", "dmg"),
                ],
            ),
            None,
        );
        let parsed = Feed::parse(&raw).expect("feed");
        let entry = &parsed.versions[0];

        assert_eq!(
            entry
                .file_for(Os::Windows, Arch::X86_64)
                .map(|file| file.kind),
            Some(Kind::Nsis)
        );
        assert_eq!(
            entry
                .file_for(Os::Macos, Arch::Aarch64)
                .map(|file| file.kind),
            Some(Kind::Dmg)
        );
        assert!(entry.file_for(Os::Macos, Arch::X86_64).is_none());
        // A DMG is never selected for Windows even when the platform matches.
        assert!(entry.file_for(Os::Windows, Arch::Aarch64).is_none());
    }

    #[test]
    fn marks_semver_prereleases_hidden_by_default() {
        let raw = feed(
            &format!(
                "{},{}",
                version("1.0.0", false, &[file("windows", "x86_64", "nsis")]),
                r#"{"version":"1.1.0-rc.1","released":"2026-11-01T12:00:00Z","notes":"","prerelease":false,"files":[{"os":"windows","arch":"x86_64","kind":"nsis","url":"https://downloads.example/a","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]}"#
            ),
            None,
        );
        let parsed = Feed::parse(&raw).expect("feed");

        assert!(parsed.versions[1].is_prerelease());
        assert_eq!(parsed.sorted(false).len(), 1);
    }
}
