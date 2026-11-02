//! Contract tests for the online address suggestions config (ADR-0016).
//! Synthetic values only; no network, no user data.

use std::fs;

use gentree_config::{
    apply_patch, load, write_file, AppConfig, ConfigError, ConfigLayer, GeocoderProvider,
    DEFAULT_DADATA_BASE_URL, DEFAULT_GEOCODER_API_KEY_ENV, DEFAULT_GEOCODER_TIMEOUT_SECONDS,
    DEFAULT_PHOTON_BASE_URL,
};
use serde_json::json;
use tempfile::tempdir;

fn key_of(error: &ConfigError) -> Option<&str> {
    error.key()
}

#[test]
fn geocoder_is_on_by_default_with_both_providers() {
    let geocoder = AppConfig::default().geocoder;

    assert!(geocoder.enabled);
    assert_eq!(geocoder.provider, GeocoderProvider::Both);
    assert_eq!(geocoder.photon_base_url, DEFAULT_PHOTON_BASE_URL);
    assert_eq!(geocoder.dadata_base_url, DEFAULT_DADATA_BASE_URL);
    assert_eq!(geocoder.api_key_env, DEFAULT_GEOCODER_API_KEY_ENV);
    assert_eq!(geocoder.timeout_seconds, DEFAULT_GEOCODER_TIMEOUT_SECONDS);
    AppConfig::default().validate().expect("defaults are valid");
}

#[test]
fn a_config_without_the_section_uses_the_default() {
    let layer = ConfigLayer::value("global", json!({"app": {"language": "en"}}));
    let (config, warnings) = load(&[layer]).expect("load");

    assert_eq!(config.geocoder, AppConfig::default().geocoder);
    assert!(warnings.is_empty());
}

#[test]
fn provider_enum_uses_snake_case_values() {
    for (value, expected) in [
        ("photon", GeocoderProvider::Photon),
        ("dadata", GeocoderProvider::Dadata),
        ("both", GeocoderProvider::Both),
    ] {
        let layer = ConfigLayer::value("global", json!({"geocoder": {"provider": value}}));
        let (config, warnings) = load(&[layer]).expect("load provider");
        assert_eq!(config.geocoder.provider, expected);
        assert!(warnings.is_empty());
    }

    let layer = ConfigLayer::value("global", json!({"geocoder": {"provider": "google"}}));
    let error = load(&[layer]).expect_err("unknown provider must fail");
    assert_eq!(error.code(), "CONFIG_INVALID");
}

#[test]
fn geocoder_round_trips_through_yaml() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("config.yaml");
    let mut config = AppConfig::default();
    config.geocoder.enabled = true;
    config.geocoder.provider = GeocoderProvider::Dadata;
    config.geocoder.photon_base_url = "https://photon.example/api/".to_owned();
    config.geocoder.dadata_base_url = "https://dadata.example/suggest".to_owned();
    config.geocoder.api_key_env = "SYNTHETIC_DADATA_KEY".to_owned();
    config.geocoder.timeout_seconds = 3;

    write_file(&path, &config).expect("write yaml");
    let text = fs::read_to_string(&path).expect("read yaml");
    assert!(text.contains("enabled: true"));
    assert!(text.contains("provider: dadata"));
    assert!(text.contains("api_key_env: SYNTHETIC_DADATA_KEY"));
    assert!(text.contains("timeout_seconds: 3"));

    let (loaded, warnings) = load(&[ConfigLayer::file("global", &path)]).expect("load yaml");
    assert_eq!(loaded.geocoder, config.geocoder);
    assert!(warnings.is_empty());
}

#[test]
fn both_base_urls_must_be_http_or_https() {
    for (key, field) in [
        ("photon_base_url", "geocoder.photon_base_url"),
        ("dadata_base_url", "geocoder.dadata_base_url"),
    ] {
        for value in ["", "ftp://example.test/api", "example.test/api"] {
            let layer = ConfigLayer::value("global", json!({"geocoder": {(key): value}}));
            let error = load(&[layer]).expect_err("invalid base url must fail");
            assert_eq!(key_of(&error), Some(field), "value: {value:?}");
        }
    }

    for value in ["http://127.0.0.1:8080/api/", "https://example.test/api"] {
        let layer = ConfigLayer::value(
            "global",
            json!({
                "geocoder": {
                    "photon_base_url": value,
                    "dadata_base_url": value
                }
            }),
        );
        load(&[layer]).expect("http(s) base urls are valid");
    }
}

#[test]
fn api_key_env_must_not_be_blank() {
    let layer = ConfigLayer::value("global", json!({"geocoder": {"api_key_env": "   "}}));
    let error = load(&[layer]).expect_err("blank env name must fail");

    assert_eq!(key_of(&error), Some("geocoder.api_key_env"));
}

#[test]
fn timeout_must_be_positive() {
    let layer = ConfigLayer::value("global", json!({"geocoder": {"timeout_seconds": 0}}));
    let error = load(&[layer]).expect_err("zero timeout must fail");

    assert_eq!(key_of(&error), Some("geocoder.timeout_seconds"));
}

#[test]
fn patching_another_section_keeps_the_geocoder() {
    let mut current = AppConfig::default();
    current.geocoder.enabled = true;
    current.geocoder.provider = GeocoderProvider::Photon;
    current.geocoder.api_key_env = "SYNTHETIC_DADATA_KEY".to_owned();

    let (next, warnings) =
        apply_patch(&current, &json!({"app": {"theme": "dark"}})).expect("patch");

    assert_eq!(next.geocoder, current.geocoder);
    assert_eq!(next.app.theme, gentree_config::Theme::Dark);
    assert!(warnings.is_empty());
}

#[test]
fn patching_the_geocoder_keeps_other_sections() {
    let mut current = AppConfig::default();
    current.chat.model = "local-model".to_owned();

    let (next, warnings) = apply_patch(
        &current,
        &json!({"geocoder": {"enabled": true, "provider": "dadata"}}),
    )
    .expect("patch");

    assert!(next.geocoder.enabled);
    assert_eq!(next.geocoder.provider, GeocoderProvider::Dadata);
    assert_eq!(
        next.geocoder.photon_base_url,
        current.geocoder.photon_base_url
    );
    assert_eq!(next.chat, current.chat);
    assert!(warnings.is_empty());
}

#[test]
fn an_unknown_geocoder_key_is_only_a_warning() {
    let layer = ConfigLayer::value("global", json!({"geocoder": {"enabeld": true}}));
    let (config, warnings) = load(&[layer]).expect("unknown key must not fail");

    assert!(config.geocoder.enabled);
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("geocoder.enabeld")));
}
