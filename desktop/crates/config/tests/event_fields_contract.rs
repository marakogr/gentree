//! Contract tests for `event_fields.custom` (ADR-0015).
//! Synthetic labels only; the section is global config, not part of a project.

use std::fs;

use gentree_config::{
    apply_patch, load, write_file, AppConfig, ConfigError, ConfigLayer, MAX_CUSTOM_EVENT_FIELDS,
    MAX_EVENT_FIELD_GROUPS,
};
use serde_json::json;
use tempfile::tempdir;

fn error(config: &AppConfig) -> ConfigError {
    config.validate().expect_err("config must be rejected")
}

fn group(event_type: &str, key: &str, label: &str) -> gentree_config::EventFieldGroup {
    gentree_config::EventFieldGroup {
        event_type: event_type.to_owned(),
        fields: vec![gentree_config::CustomEventField {
            key: key.to_owned(),
            label: label.to_owned(),
            multiline: false,
        }],
    }
}

#[test]
fn custom_fields_round_trip_normalized_and_without_warnings() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");
    let text = "\
event_fields:
  custom:
    - type: '  occupation  '
      fields:
        - key: 'Military_Rank'
          label: '  Воинское звание  '
          multiline: true
    - type: Relocation
      fields:
        - key: reason
          label: Причина
";
    fs::write(&path, text).expect("write fixture");

    let (config, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("load");
    assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");

    let groups = &config.event_fields.custom;
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].event_type, "occupation");
    assert_eq!(groups[0].fields[0].key, "military_rank");
    assert_eq!(groups[0].fields[0].label, "Воинское звание");
    assert!(groups[0].fields[0].multiline);
    // A custom type label and an unused group are both allowed.
    assert_eq!(groups[1].event_type, "Relocation");
    assert_eq!(groups[1].fields[0].key, "reason");
    assert!(!groups[1].fields[0].multiline);

    write_file(&path, &config).expect("write yaml");
    let (reloaded, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("reload");
    assert_eq!(reloaded, config);
    assert!(warnings.is_empty());
}

#[test]
fn duplicate_group_types_are_rejected_case_insensitively() {
    let mut config = AppConfig::default();
    config.event_fields.custom = vec![
        group("OCCUPATION", "rank", "Звание"),
        group("occupation", "unit", "Часть"),
    ];
    let error = error(&config);
    assert_eq!(error.code(), "CONFIG_INVALID");
    assert_eq!(error.key(), Some("event_fields.custom[1].type"));
}

#[test]
fn duplicate_keys_within_a_group_are_rejected() {
    let mut config = AppConfig::default();
    config.event_fields.custom = vec![gentree_config::EventFieldGroup {
        event_type: "Relocation".into(),
        fields: vec![
            gentree_config::CustomEventField {
                key: "reason".into(),
                label: "Причина".into(),
                multiline: false,
            },
            gentree_config::CustomEventField {
                key: "reason".into(),
                label: "Повтор".into(),
                multiline: false,
            },
        ],
    }];
    let error = error(&config);
    assert_eq!(error.key(), Some("event_fields.custom[0].fields[1].key"));
    assert!(
        error.to_string().contains("unique"),
        "reason should name the duplicate: {error}"
    );
}

#[test]
fn builtin_key_collision_is_rejected() {
    let mut config = AppConfig::default();
    config.event_fields.custom = vec![group("OCCUPATION", "employer", "Работодатель")];
    let error = error(&config);
    assert_eq!(error.key(), Some("event_fields.custom[0].fields[0].key"));
    assert!(
        error.to_string().contains("built-in"),
        "reason should name the collision: {error}"
    );

    // The same key is fine on a type that does not own it.
    let mut other = AppConfig::default();
    other.event_fields.custom = vec![group("Relocation", "employer", "Работодатель")];
    other.validate().expect("unrelated type accepts the key");
}

#[test]
fn builtin_key_collision_from_an_older_config_is_dropped_with_a_warning() {
    // `burial_officiant` became built in after users could already have saved it
    // as a custom field. Loading such a config must not fall back to defaults.
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");
    let text = "\
event_fields:
  custom:
    - type: BURIAL
      fields:
        - key: burial_officiant
          label: Кто совершил обряд
        - key: plot_owner
          label: Владелец участка
    - type: Relocation
      fields:
        - key: reason
          label: Причина
";
    fs::write(&path, text).expect("write fixture");

    let (config, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("load tolerates");
    assert_eq!(warnings.len(), 1, "one warning expected: {warnings:?}");
    assert!(
        warnings[0].contains("BURIAL.burial_officiant"),
        "warning names the dropped field: {warnings:?}"
    );

    let groups = &config.event_fields.custom;
    assert_eq!(groups.len(), 2, "other groups survive");
    assert_eq!(groups[0].event_type, "BURIAL");
    assert_eq!(groups[0].fields.len(), 1, "only the duplicate is dropped");
    assert_eq!(groups[0].fields[0].key, "plot_owner");
    assert_eq!(groups[1].event_type, "Relocation");
    assert_eq!(groups[1].fields[0].key, "reason");

    // The built-in field is now the one the UI and the API describe.
    assert!(
        gentree_core::event_fields::builtin_event_field_keys(gentree_core::EventType::Burial)
            .contains(&"burial_officiant")
    );
}

#[test]
fn reserved_keys_are_rejected() {
    for key in ["id", "type", "date", "place", "description", "details"] {
        let mut config = AppConfig::default();
        config.event_fields.custom = vec![group("Relocation", key, "Ярлык")];
        let error = error(&config);
        assert_eq!(
            error.key(),
            Some("event_fields.custom[0].fields[0].key"),
            "key {key}"
        );
    }
}

#[test]
fn empty_and_overlong_values_are_rejected() {
    let mut config = AppConfig::default();
    config.event_fields.custom = vec![group("Relocation", "", "Ярлык")];
    assert_eq!(
        error(&config).key(),
        Some("event_fields.custom[0].fields[0].key")
    );

    let mut config = AppConfig::default();
    config.event_fields.custom = vec![group("Relocation", "reason", "  ")];
    assert_eq!(
        error(&config).key(),
        Some("event_fields.custom[0].fields[0].label")
    );

    let mut config = AppConfig::default();
    config.event_fields.custom = vec![group("Relocation", "reason", &"я".repeat(81))];
    assert_eq!(
        error(&config).key(),
        Some("event_fields.custom[0].fields[0].label")
    );

    let mut config = AppConfig::default();
    config.event_fields.custom = vec![group("   ", "reason", "Причина")];
    assert_eq!(error(&config).key(), Some("event_fields.custom[0].type"));
}

#[test]
fn limits_are_enforced() {
    let mut config = AppConfig::default();
    config.event_fields.custom = (0..=MAX_EVENT_FIELD_GROUPS)
        .map(|index| group(&format!("Type{index}"), "reason", "Причина"))
        .collect();
    assert_eq!(error(&config).key(), Some("event_fields.custom"));

    let mut config = AppConfig::default();
    config.event_fields.custom = vec![gentree_config::EventFieldGroup {
        event_type: "Relocation".into(),
        fields: (0..=MAX_CUSTOM_EVENT_FIELDS)
            .map(|index| gentree_config::CustomEventField {
                key: format!("field_{index}"),
                label: "Поле".into(),
                multiline: false,
            })
            .collect(),
    }];
    assert_eq!(error(&config).key(), Some("event_fields.custom[0].fields"));
}

#[test]
fn patching_event_types_preserves_event_fields() {
    let (config, warnings) = apply_patch(
        &AppConfig::default(),
        &json!({
            "event_types": {"custom": ["Relocation"]},
            "event_fields": {"custom": [
                {"type": "Relocation", "fields": [
                    {"key": "Reason", "label": " Причина ", "multiline": true}
                ]}
            ]}
        }),
    )
    .expect("patch");
    assert!(warnings.is_empty());
    assert_eq!(config.event_fields.custom[0].fields[0].key, "reason");
    assert_eq!(config.event_fields.custom[0].fields[0].label, "Причина");

    let (renamed, _) = apply_patch(
        &config,
        &json!({"event_types": {"custom": ["Relocation", "Emigration"]}}),
    )
    .expect("patch event types");
    assert_eq!(renamed.event_fields, config.event_fields);
    assert_eq!(renamed.event_types.custom.len(), 2);

    let (patched, _) = apply_patch(
        &renamed,
        &json!({"event_fields": {"custom": [
            {"type": "Relocation", "fields": [
                {"key": "reason", "label": "Причина"},
                {"key": "destination", "label": "Куда"}
            ]}
        ]}}),
    )
    .expect("patch fields");
    assert_eq!(patched.event_fields.custom[0].fields.len(), 2);
    assert_eq!(patched.event_types.custom.len(), 2);

    let (cleared, _) = apply_patch(&patched, &json!({"event_fields": null})).expect("reset");
    assert_eq!(cleared.event_fields, AppConfig::default().event_fields);
    assert_eq!(cleared.event_types.custom.len(), 2);
}
