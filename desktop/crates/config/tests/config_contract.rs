//! Contract tests for the layered config (design.md §10, ADR-0012).
//! Synthetic values only; no user data, no real config files.

use std::fs;
use std::path::{Path, PathBuf};

use gentree_config::{
    apply_patch, default_paths, load, update_global, write_file, AppConfig, ConfigError,
    ConfigLayer, Language, Style, Theme,
};
use serde_json::json;
use tempfile::tempdir;

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, text).expect("write fixture");
    path
}

#[test]
fn yaml_round_trip_keeps_every_section() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");
    let mut config = AppConfig::default();
    config.app.language = Language::En;
    config.app.theme = Theme::Dark;
    config.storage.autosave_ms = 5_000;
    config.chat.model = "local-model".to_owned();
    config.chat.temperature = 0.5;
    config.backup.keep = 3;
    config.updates.auto_check = true;

    write_file(&path, &config).expect("write yaml");
    let text = fs::read_to_string(&path).expect("read yaml");
    assert!(text.contains("language: en"));
    assert!(text.contains("projects_dir:"));
    assert!(text.contains("auto_check: true"));

    let (loaded, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("load yaml");
    assert_eq!(loaded, config);
    assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
}

#[test]
fn json_and_yaml_parse_into_the_same_type() {
    let dir = tempdir().expect("temp dir");
    let yaml_path = write(
        dir.path(),
        "config.yaml",
        "app:\n  language: ru\nchat:\n  model: local-model\n",
    );
    let json_path = write(
        dir.path(),
        "config.json",
        r#"{"app":{"language":"ru"},"chat":{"model":"local-model"}}"#,
    );

    let (from_yaml, yaml_warnings) =
        load(&[ConfigLayer::file("global", &yaml_path)]).expect("yaml");
    let (from_json, json_warnings) =
        load(&[ConfigLayer::file("global", &json_path)]).expect("json");

    assert_eq!(from_yaml, from_json);
    assert_eq!(from_yaml.app.language, Language::Ru);
    assert_eq!(from_yaml.chat.model, "local-model");
    assert!(yaml_warnings.is_empty());
    assert!(json_warnings.is_empty());
}

#[test]
fn defaults_apply_to_missing_sections() {
    let layer = ConfigLayer::value("global", json!({"app": {"language": "en"}}));
    let (config, warnings) = load(&[layer]).expect("load");

    let expected = AppConfig::default();
    assert_eq!(config.app.language, Language::En);
    assert_eq!(config.app.theme, expected.app.theme);
    assert_eq!(config.storage, expected.storage);
    assert_eq!(config.search, expected.search);
    assert_eq!(config.chat, expected.chat);
    assert_eq!(config.backup, expected.backup);
    assert_eq!(config.updates, expected.updates);
    assert!(warnings.is_empty());
}

#[test]
fn old_configs_keep_update_checks_off() {
    // A file written before the `updates` section existed must load with the
    // network-facing feature off, not fail and not opt in silently.
    let layer = ConfigLayer::value("global", json!({"app": {"language": "en"}}));
    let (config, warnings) = load(&[layer]).expect("load");
    assert!(!config.updates.auto_check);
    assert!(warnings.is_empty());
}

#[test]
fn updates_auto_check_is_read_and_patched() {
    let layer = ConfigLayer::value("global", json!({"updates": {"auto_check": true}}));
    let (config, warnings) = load(&[layer]).expect("load");
    assert!(config.updates.auto_check);
    assert!(warnings.is_empty());

    let (patched, _) = apply_patch(
        &AppConfig::default(),
        &json!({"updates": {"auto_check": true}}),
    )
    .expect("patch");
    assert!(patched.updates.auto_check);

    // `null` restores the off default, like every other key.
    let (reset, _) =
        apply_patch(&patched, &json!({"updates": {"auto_check": null}})).expect("reset");
    assert!(!reset.updates.auto_check);
}

#[test]
fn unknown_updates_keys_are_warnings() {
    let layer = ConfigLayer::value("global", json!({"updates": {"autoCheck": true}}));
    let (config, warnings) = load(&[layer]).expect("unknown key must not fail");
    assert!(!config.updates.auto_check);
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("updates.autoCheck")));
}

#[test]
fn later_layers_win_over_earlier_ones() {
    let global = ConfigLayer::value("global", json!({"chat": {"model": "global-model"}}));
    let project = ConfigLayer::value(
        "project",
        json!({"chat": {"model": "project-model"}, "app": {"theme": "light"}}),
    );
    let (config, warnings) = load(&[global, project]).expect("load");
    assert_eq!(config.chat.model, "project-model");
    assert_eq!(config.app.theme, Theme::Light);
    assert!(warnings.is_empty());
}

#[test]
fn invalid_relative_path_is_rejected_with_the_key() {
    let layer = ConfigLayer::value(
        "global",
        json!({"storage": {"projects_dir": "relative/projects"}}),
    );
    let error = load(&[layer]).expect_err("relative path must fail");
    match &error {
        ConfigError::Invalid { key, .. } => assert_eq!(key, "storage.projects_dir"),
        other => panic!("expected Invalid, got {other:?}"),
    }
    assert_eq!(error.code(), "CONFIG_INVALID");
}

#[test]
fn tilde_paths_are_expanded() {
    let layer = ConfigLayer::value(
        "global",
        json!({"search": {"index_dir": "~/gentree/indexes"}}),
    );
    let (config, warnings) = load(&[layer]).expect("load");
    assert!(config.search.index_dir.is_absolute());
    assert!(warnings.is_empty());
}

#[test]
fn unknown_keys_are_warnings_not_errors() {
    let layer = ConfigLayer::value(
        "global",
        json!({"app": {"langauge": "en"}, "future": {"flag": true}}),
    );
    let (config, warnings) = load(&[layer]).expect("unknown keys must not fail");
    assert_eq!(config.app.language, Language::System);
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("app.langauge")));
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("\"future\"")));
}

#[test]
fn language_enum_accepts_every_supported_value_and_rejects_others() {
    for value in Language::VALUES {
        let layer = ConfigLayer::value("global", json!({"app": {"language": value}}));
        let (config, _) = load(&[layer]).expect("known language");
        assert_eq!(config.app.language.as_str(), value);
    }

    let layer = ConfigLayer::value("global", json!({"app": {"language": "xx"}}));
    let error = load(&[layer]).expect_err("unsupported language");
    assert_eq!(error.key(), Some("app.language"));
    assert_eq!(error.code(), "CONFIG_INVALID");
}

#[test]
fn patch_merges_only_touched_keys() {
    let current = AppConfig::default();
    let (next, warnings) = apply_patch(
        &current,
        &json!({"app": {"theme": "dark"}, "backup": {"keep": 4}}),
    )
    .expect("patch");
    assert_eq!(next.app.theme, Theme::Dark);
    assert_eq!(next.backup.keep, 4);
    assert_eq!(next.app.language, current.app.language);
    assert_eq!(next.storage, current.storage);
    assert!(warnings.is_empty());
}

#[test]
fn null_in_patch_restores_the_default() {
    let mut current = AppConfig::default();
    current.chat.model = "local-model".to_owned();
    let (next, _) = apply_patch(&current, &json!({"chat": {"model": null}})).expect("patch");
    assert_eq!(next.chat.model, AppConfig::default().chat.model);
}

#[test]
fn update_global_writes_atomically_and_reloads() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");

    let (written, warnings) = update_global(
        &path,
        &json!({"app": {"language": "en"}, "backup": {"keep": 2}}),
    )
    .expect("update");
    assert_eq!(written.app.language, Language::En);
    assert_eq!(written.backup.keep, 2);
    assert!(warnings.is_empty());

    let entries: Vec<_> = fs::read_dir(dir.path())
        .expect("read dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(entries.len(), 1, "no temp files left: {entries:?}");

    let (reloaded, _) = load(&[ConfigLayer::file("global", &path)]).expect("reload");
    assert_eq!(reloaded, written);
}

#[test]
fn broken_global_file_is_recoverable() {
    let dir = tempdir().expect("temp dir");
    let path = write(dir.path(), "config.yaml", "app: [not, a, mapping");

    let (config, warnings) =
        update_global(&path, &json!({"app": {"language": "ru"}})).expect("recover");
    assert_eq!(config.app.language, Language::Ru);
    assert!(warnings.iter().any(|warning| warning.contains("ignored")));
}

#[test]
fn app_style_defaults_to_classic_and_round_trips() {
    // A config written before `app.style` existed must keep the classic look.
    let default = AppConfig::default();
    assert_eq!(default.app.style, Style::Classic);

    let (patched, warnings) =
        apply_patch(&default, &json!({"app": {"style": "swiss"}})).expect("patch");
    assert_eq!(patched.app.style, Style::Swiss);
    assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");

    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");
    write_file(&path, &patched).expect("write yaml");
    let text = fs::read_to_string(&path).expect("read yaml");
    assert!(text.contains("style: swiss"), "persisted style: {text}");
    let (reloaded, _) = load(&[ConfigLayer::file("global", &path)]).expect("reload");
    assert_eq!(reloaded.app.style, Style::Swiss);
}

#[test]
fn rejects_unknown_app_style() {
    let layer = ConfigLayer::value("global", json!({"app": {"style": "brutal"}}));
    let error = load(&[layer]).expect_err("unsupported style");
    assert_eq!(error.code(), "CONFIG_INVALID");
}

#[test]
fn default_paths_use_the_application_directory() {
    let paths = default_paths().expect("default paths");
    assert!(paths.root_dir.ends_with("Gentree"));
    assert_eq!(paths.global_config_path, paths.root_dir.join("config.yaml"));
}
