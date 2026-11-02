use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// On-disk project format.
///
/// Version 2 adds optional type-specific event `details` (ADR-0015). Version 3
/// adds the optional `eventId` link on media rows (ADR-0018); older builds
/// ignore an unknown JSON field, so without the bump a rewrite would silently
/// drop every event attachment. Both fields are optional in the row itself,
/// which is why a project needs no per-row rewrite: the first successful
/// mutation stamps the current version (see `ProjectStore::finish_mutation`).
pub const FORMAT_VERSION: u32 = 5;
pub const SCHEMA_VERSION: u32 = 1;

/// Maximum project name length in characters (not bytes).
pub const PROJECT_NAME_MAX_LEN: usize = 200;

pub type ProjectId = Uuid;

/// Trim a user-supplied project name and reject blank or over-long values.
///
/// Both failures are `VALIDATION_ERROR` on the `name` field: `required` for a
/// blank name, `maxLength` above [`PROJECT_NAME_MAX_LEN`] characters.
pub fn normalize_project_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::validation("name", "required"));
    }
    if name.chars().count() > PROJECT_NAME_MAX_LEN {
        return Err(AppError::validation("name", "maxLength"));
    }
    Ok(name.to_owned())
}

/// Case-insensitive project name comparison; surrounding whitespace is ignored.
pub fn project_names_equal(left: &str, right: &str) -> bool {
    left.trim().to_lowercase() == right.trim().to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub persons: usize,
    pub events: usize,
    pub relationships: usize,
    pub sources: usize,
    pub citations: usize,
    pub media: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub schema_version: u32,
    pub project_id: ProjectId,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub app_version: String,
    pub home_person_id: Option<Uuid>,
    pub content_hash: String,
    #[serde(default)]
    pub counts: Counts,
}

impl Manifest {
    pub fn new(name: impl Into<String>, now: String) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            schema_version: SCHEMA_VERSION,
            project_id: Uuid::now_v7(),
            name: name.into(),
            created_at: now.clone(),
            updated_at: now,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            home_person_id: None,
            content_hash: String::new(),
            counts: Counts::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip_is_camel_case() {
        let manifest = Manifest::new("Моя семья", "2026-10-22T00:00:00Z".into());
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["formatVersion"], 5);
        assert_eq!(json["projectId"], manifest.project_id.to_string());
        assert!(json.get("format_version").is_none());
    }

    #[test]
    fn project_name_is_trimmed() {
        assert_eq!(normalize_project_name("  Семья  ").unwrap(), "Семья");
    }

    #[test]
    fn blank_project_name_is_rejected_on_name_field() {
        for raw in ["", "   ", "\t\n"] {
            let err = normalize_project_name(raw).unwrap_err();
            assert_eq!(err.code, crate::error::codes::VALIDATION_ERROR);
            assert_eq!(err.params.get("field").map(String::as_str), Some("name"));
            assert_eq!(err.params.get("rule").map(String::as_str), Some("required"));
        }
    }

    #[test]
    fn project_name_length_is_counted_in_characters() {
        let max = "я".repeat(PROJECT_NAME_MAX_LEN);
        assert_eq!(normalize_project_name(&max).unwrap().chars().count(), 200);

        let too_long = "я".repeat(PROJECT_NAME_MAX_LEN + 1);
        let err = normalize_project_name(&too_long).unwrap_err();
        assert_eq!(err.params.get("field").map(String::as_str), Some("name"));
        assert_eq!(
            err.params.get("rule").map(String::as_str),
            Some("maxLength")
        );
    }

    #[test]
    fn project_names_compare_case_insensitively() {
        assert!(project_names_equal("  Семья ", "семья"));
        assert!(!project_names_equal("Семья", "Семьи"));
    }
}
