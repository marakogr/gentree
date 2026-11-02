//! Version comparison between the installed app and the feed.

use semver::Version;
use serde::Serialize;

/// Relationship between the installed Gentree and a candidate release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    UpToDate,
    UpdateAvailable,
    InstalledNewer,
    Unknown,
}

/// Parses a version read from the OS.
///
/// Installed versions come from installers, not the feed, so the accepted
/// shapes are a little wider than SemVer: an optional `v` prefix, a trailing
/// `.0` revision written as four components, and a two-component version.
pub fn parse_installed(raw: &str) -> Option<Version> {
    let trimmed = raw.trim();
    let trimmed = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if let Ok(version) = Version::parse(trimmed) {
        return Some(version);
    }

    let parts: Vec<&str> = trimmed.split('.').collect();
    let numeric = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());

    if parts.len() == 4 && parts[3] == "0" && parts[..3].iter().all(|part| numeric(part)) {
        return Version::parse(&format!("{}.{}.{}", parts[0], parts[1], parts[2])).ok();
    }
    if parts.len() == 2 && parts.iter().all(|part| numeric(part)) {
        return Version::parse(&format!("{trimmed}.0")).ok();
    }
    None
}

/// Compares the installed version with the version offered by the feed.
pub fn update_state(installed: Option<&str>, latest: Option<&str>) -> UpdateState {
    match (
        installed.and_then(parse_installed),
        latest.and_then(parse_installed),
    ) {
        (Some(installed), Some(latest)) if latest > installed => UpdateState::UpdateAvailable,
        (Some(installed), Some(latest)) if latest == installed => UpdateState::UpToDate,
        (Some(_), Some(_)) => UpdateState::InstalledNewer,
        _ => UpdateState::Unknown,
    }
}

/// Whether `candidate` is strictly newer than the installed version.
pub fn is_newer(candidate: &str, installed: Option<&str>) -> bool {
    match (
        parse_installed(candidate),
        installed.and_then(parse_installed),
    ) {
        (Some(candidate), Some(installed)) => candidate > installed,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_written_by_installers() {
        assert_eq!(
            parse_installed("0.2.1").map(|value| value.to_string()),
            Some("0.2.1".to_string())
        );
        assert_eq!(
            parse_installed("v0.2.1").map(|value| value.to_string()),
            Some("0.2.1".to_string())
        );
        assert_eq!(
            parse_installed("0.2.1.0").map(|value| value.to_string()),
            Some("0.2.1".to_string())
        );
        assert_eq!(
            parse_installed("0.2").map(|value| value.to_string()),
            Some("0.2.0".to_string())
        );
        assert!(parse_installed("").is_none());
        assert!(parse_installed("unknown").is_none());
        assert!(parse_installed("0.2.1.5").is_none());
    }

    #[test]
    fn reports_an_available_update() {
        assert_eq!(
            update_state(Some("0.2.0"), Some("0.2.1")),
            UpdateState::UpdateAvailable
        );
        assert_eq!(
            update_state(Some("0.2.0"), Some("0.2.0")),
            UpdateState::UpToDate
        );
        assert_eq!(
            update_state(Some("0.3.0"), Some("0.2.1")),
            UpdateState::InstalledNewer
        );
        assert_eq!(update_state(None, Some("0.2.1")), UpdateState::Unknown);
        assert_eq!(update_state(Some("0.2.0"), None), UpdateState::Unknown);
    }

    #[test]
    fn orders_prereleases_below_releases() {
        assert!(!is_newer("0.3.0-beta.1", Some("0.3.0")));
        assert!(is_newer("0.3.0", Some("0.3.0-beta.1")));
        assert!(is_newer("0.2.10", Some("0.2.9")));
        assert!(!is_newer("0.2.1", None));
    }
}
