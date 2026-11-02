//! Default locations and `~` expansion. Contract: design.md §10, ADR-0012.
//!
//! On Windows the root is `%APPDATA%\Gentree`, on macOS
//! `~/Library/Application Support/Gentree`; `~`, `~/…` and `~\…` expand to the
//! home directory, and relative paths are rejected.

use std::path::{Path, PathBuf};

use directories::BaseDirs;

use crate::error::ConfigError;

/// Application directory name below the OS data directory.
pub const APP_DIR_NAME: &str = "Gentree";
/// Name of the global configuration file.
pub const CONFIG_FILE_NAME: &str = "config.yaml";

/// Default locations derived from the OS data directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultPaths {
    pub root_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub index_dir: PathBuf,
    pub global_config_path: PathBuf,
}

impl DefaultPaths {
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root_dir = root.into();
        Self {
            projects_dir: root_dir.join("projects"),
            backups_dir: root_dir.join("backups"),
            index_dir: root_dir.join("indexes"),
            global_config_path: root_dir.join(CONFIG_FILE_NAME),
            root_dir,
        }
    }

    /// Last resort when the OS does not expose a data directory. The settings
    /// screen still opens and shows the resolved path.
    pub fn fallback() -> Self {
        Self::from_root(std::env::temp_dir().join(APP_DIR_NAME))
    }

    pub(crate) fn resolve_or_fallback() -> Self {
        default_paths().unwrap_or_else(|_| Self::fallback())
    }
}

/// Resolves the OS-specific application root and its subdirectories.
pub fn default_paths() -> Result<DefaultPaths, ConfigError> {
    let base = BaseDirs::new().ok_or_else(|| {
        ConfigError::invalid(
            "storage.projects_dir",
            "the OS data directory is not available",
        )
    })?;
    Ok(DefaultPaths::from_root(base.data_dir().join(APP_DIR_NAME)))
}

fn home_dir(key: &str) -> Result<PathBuf, ConfigError> {
    BaseDirs::new()
        .map(|base| base.home_dir().to_path_buf())
        .ok_or_else(|| ConfigError::invalid(key, "the home directory is not available"))
}

/// Expands `~` and requires an absolute result.
///
/// The error carries the settings key, so the UI can point at the exact field.
pub fn expand_path(key: &str, raw: impl AsRef<Path>) -> Result<PathBuf, ConfigError> {
    let raw = raw.as_ref().to_string_lossy();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ConfigError::invalid(key, "path is empty"));
    }

    let expanded = if trimmed == "~" {
        home_dir(key)?
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        home_dir(key)?.join(rest)
    } else if trimmed.starts_with('~') {
        return Err(ConfigError::invalid(
            key,
            "only `~`, `~/` and `~\\` prefixes are supported",
        ));
    } else {
        PathBuf::from(trimmed)
    };

    if !expanded.is_absolute() {
        return Err(ConfigError::invalid(
            key,
            "path must be absolute after `~` expansion",
        ));
    }
    if expanded.to_string_lossy().trim().is_empty() {
        return Err(ConfigError::invalid(key, "path is empty"));
    }
    Ok(expanded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_use_the_os_data_directory() {
        let paths = default_paths().expect("data directory");
        assert!(paths.root_dir.is_absolute());
        assert!(paths.root_dir.ends_with(APP_DIR_NAME));
        assert_eq!(paths.projects_dir, paths.root_dir.join("projects"));
        assert_eq!(paths.backups_dir, paths.root_dir.join("backups"));
        assert_eq!(paths.index_dir, paths.root_dir.join("indexes"));
        assert_eq!(
            paths.global_config_path,
            paths.root_dir.join(CONFIG_FILE_NAME)
        );
    }

    #[test]
    fn tilde_expands_to_the_home_directory() {
        let expanded = expand_path("storage.projects_dir", "~/gentree/projects").expect("expand");
        assert!(expanded.is_absolute());
        assert!(expanded.ends_with("gentree/projects"));
    }

    #[test]
    fn bare_tilde_expands_to_home() {
        let home = home_dir("home").expect("home");
        assert_eq!(expand_path("home", "~").expect("expand"), home);
    }

    #[test]
    fn relative_paths_are_rejected() {
        let error = expand_path("storage.backups_dir", "backups").expect_err("must fail");
        assert_eq!(error.key(), Some("storage.backups_dir"));
    }

    #[test]
    fn unknown_home_shorthand_is_rejected() {
        let error = expand_path("search.index_dir", "~other/index").expect_err("must fail");
        assert_eq!(error.code(), "CONFIG_INVALID");
    }
}
