//! Contract tests for the event map basemap config (ADR-0020).
//! Synthetic values only; no network.

use gentree_config::{load, AppConfig, ConfigLayer, MapBasemap, DEFAULT_MAP_TILE_URL};
use serde_json::json;

#[test]
fn map_uses_osm_tiles_by_default() {
    let map = AppConfig::default().map;

    assert_eq!(map.basemap, MapBasemap::Osm);
    assert_eq!(map.tile_url, DEFAULT_MAP_TILE_URL);
    AppConfig::default().validate().expect("defaults are valid");
}

#[test]
fn a_config_without_the_section_uses_the_default() {
    let layer = ConfigLayer::value("global", json!({"app": {"language": "en"}}));
    let (config, warnings) = load(&[layer]).expect("load");

    assert_eq!(config.map, AppConfig::default().map);
    assert!(warnings.is_empty());
}

#[test]
fn basemap_values_are_snake_case() {
    for (value, expected) in [("osm", MapBasemap::Osm), ("offline", MapBasemap::Offline)] {
        let layer = ConfigLayer::value("global", json!({"map": {"basemap": value}}));
        let (config, warnings) = load(&[layer]).expect("load basemap");
        assert_eq!(config.map.basemap, expected);
        assert!(warnings.is_empty());
    }

    let layer = ConfigLayer::value("global", json!({"map": {"basemap": "google"}}));
    let error = load(&[layer]).expect_err("unknown basemap must fail");
    assert_eq!(error.code(), "CONFIG_INVALID");
}

#[test]
fn a_non_http_tile_url_is_rejected() {
    for value in ["", "file:///tiles/{z}/{x}/{y}.png", "tile.example/{z}"] {
        let layer = ConfigLayer::value("global", json!({"map": {"tile_url": value}}));
        let error = load(&[layer]).expect_err("invalid URL must fail");
        assert_eq!(error.code(), "CONFIG_INVALID");
        assert_eq!(error.key(), Some("map.tile_url"));
    }
}

#[test]
fn a_self_hosted_tile_url_is_accepted() {
    let layer = ConfigLayer::value(
        "global",
        json!({"map": {"basemap": "offline", "tile_url": "http://127.0.0.1:8080/{z}/{x}/{y}.png"}}),
    );
    let (config, warnings) = load(&[layer]).expect("load self-hosted tiles");
    assert_eq!(config.map.basemap, MapBasemap::Offline);
    assert!(warnings.is_empty());
}
