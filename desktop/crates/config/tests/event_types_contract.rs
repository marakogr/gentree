//! Contract tests for `event_types.custom` (custom event type names).
//! Synthetic values only; custom types are labels, not new enum members.

use std::fs;

use gentree_config::{
    apply_patch, load, update_global, write_file, AppConfig, ConfigError, ConfigLayer,
    MAX_CUSTOM_EVENT_TYPES, MAX_EVENT_TYPE_NAME,
};
use serde_json::json;
use tempfile::tempdir;

fn custom_error(config: &AppConfig) -> ConfigError {
    config.validate().expect_err("config must be rejected")
}

#[test]
fn custom_names_round_trip_trimmed_and_without_warnings() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");
    let text = "event_types:\n  custom:\n    - \"  Engagement  \"\n    - Relocation\n";
    fs::write(&path, text).expect("write fixture");

    let (config, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("load");
    assert_eq!(config.event_types.custom, ["Engagement", "Relocation"]);
    assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");

    write_file(&path, &config).expect("write yaml");
    let (reloaded, _) = load(&[ConfigLayer::file("global", &path)]).expect("reload");
    assert_eq!(reloaded, config);
}

#[test]
fn patch_replaces_the_list_and_null_restores_the_default() {
    let current = AppConfig::default();
    let (next, warnings) = apply_patch(
        &current,
        &json!({"event_types": {"custom": ["Engagement", "Relocation"]}}),
    )
    .expect("patch");
    assert_eq!(next.event_types.custom, ["Engagement", "Relocation"]);
    assert!(warnings.is_empty());

    let (cleared, _) = apply_patch(&next, &json!({"event_types": {"custom": []}})).expect("clear");
    assert!(cleared.event_types.custom.is_empty());

    let (with_one, _) =
        apply_patch(&next, &json!({"event_types": {"custom": ["Relocation"]}})).expect("shrink");
    let (restored, _) = apply_patch(&with_one, &json!({"event_types": null})).expect("reset");
    assert_eq!(restored.event_types, AppConfig::default().event_types);
}

#[test]
fn update_global_persists_custom_names() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");

    update_global(
        &path,
        &json!({"event_types": {"custom": ["  Engagement  "]}}),
    )
    .expect("update");
    let (reloaded, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("reload");
    assert_eq!(reloaded.event_types.custom, ["Engagement"]);
    assert!(warnings.is_empty());
}

#[test]
fn duplicate_names_are_rejected_case_insensitively() {
    let mut config = AppConfig::default();
    config.event_types.custom = vec!["Relocation".to_owned(), "relocation".to_owned()];
    let error = custom_error(&config);
    assert_eq!(error.code(), "CONFIG_INVALID");
    assert_eq!(error.key(), Some("event_types.custom"));

    let err = apply_patch(
        &AppConfig::default(),
        &json!({"event_types": {"custom": ["Engagement", " engagement "]}}),
    )
    .expect_err("duplicates must fail");
    assert_eq!(err.key(), Some("event_types.custom"));
}

#[test]
fn empty_and_too_long_names_are_rejected() {
    let mut config = AppConfig::default();
    config.event_types.custom = vec!["   ".to_owned()];
    assert_eq!(custom_error(&config).key(), Some("event_types.custom"));

    config.event_types.custom = vec!["x".repeat(MAX_EVENT_TYPE_NAME + 1)];
    assert_eq!(custom_error(&config).key(), Some("event_types.custom"));

    config.event_types.custom = vec!["x".repeat(MAX_EVENT_TYPE_NAME)];
    config.validate().expect("the limit itself is allowed");

    let err = apply_patch(
        &AppConfig::default(),
        &json!({"event_types": {"custom": ["  "]}}),
    )
    .expect_err("blank names must fail");
    assert_eq!(err.key(), Some("event_types.custom"));
}

#[test]
fn the_number_of_custom_names_is_capped() {
    let mut config = AppConfig::default();
    config.event_types.custom = (0..=MAX_CUSTOM_EVENT_TYPES)
        .map(|index| format!("type-{index}"))
        .collect();
    assert_eq!(custom_error(&config).key(), Some("event_types.custom"));

    config.event_types.custom.pop();
    config.validate().expect("the limit itself is allowed");
}

#[test]
fn unknown_event_types_keys_stay_warnings() {
    let layer = ConfigLayer::value(
        "global",
        json!({"event_types": {"custom": ["Engagement"], "colour": "red"}}),
    );
    let (config, warnings) = load(&[layer]).expect("unknown nested key must not fail");
    assert_eq!(config.event_types.custom, ["Engagement"]);
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("event_types.colour")));
}
