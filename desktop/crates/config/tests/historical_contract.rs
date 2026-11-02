//! Contract tests for the Wikidata historical-place provider (ADR-0021).
//! Synthetic values only; no network.

use gentree_config::{
    load, AppConfig, ConfigLayer, DEFAULT_HISTORICAL_TIMEOUT_SECONDS, DEFAULT_WIKIDATA_API_URL,
};
use serde_json::json;

#[test]
fn historical_provider_is_on_by_default() {
    let historical = AppConfig::default().historical_geocoder;

    assert!(historical.enabled);
    assert_eq!(historical.api_url, DEFAULT_WIKIDATA_API_URL);
    assert_eq!(
        historical.timeout_seconds,
        DEFAULT_HISTORICAL_TIMEOUT_SECONDS
    );
    AppConfig::default().validate().expect("defaults are valid");
}

#[test]
fn a_config_without_the_section_uses_the_default() {
    let layer = ConfigLayer::value("global", json!({"app": {"language": "en"}}));
    let (config, warnings) = load(&[layer]).expect("load");

    assert_eq!(
        config.historical_geocoder,
        AppConfig::default().historical_geocoder
    );
    assert!(warnings.is_empty());
}

#[test]
fn the_provider_can_be_switched_off_and_pointed_at_a_self_hosted_api() {
    let layer = ConfigLayer::value(
        "global",
        json!({
            "historical_geocoder": {
                "enabled": false,
                "api_url": "http://127.0.0.1:8080/w/api.php",
                "timeout_seconds": 3
            }
        }),
    );
    let (config, warnings) = load(&[layer]).expect("load historical");
    assert!(!config.historical_geocoder.enabled);
    assert_eq!(config.historical_geocoder.timeout_seconds, 3);
    assert!(warnings.is_empty());
}

#[test]
fn a_non_http_url_and_a_zero_timeout_are_rejected() {
    for (key, value) in [
        ("api_url", json!("file:///wikidata.json")),
        ("timeout_seconds", json!(0)),
    ] {
        let layer = ConfigLayer::value("global", json!({"historical_geocoder": { (key): value }}));
        let error = load(&[layer]).expect_err("invalid historical section");
        assert_eq!(error.code(), "CONFIG_INVALID");
    }
}
