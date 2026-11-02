//! Type-specific event detail fields (ADR-0015).
//!
//! Events keep one generic `details` map, never a typed struct per event type.
//! This module owns the curated built-in key registry and the generic shape
//! limits; custom keys come from the user's global `config.yaml`. The domain
//! never rejects an unknown key, because the schema is config-driven.

use crate::record::EventType;

/// Upper bound on `details` entries of one event.
pub const MAX_EVENT_DETAILS: usize = 40;
/// Longest accepted detail key, in characters.
pub const MAX_EVENT_DETAIL_KEY: usize = 64;
/// Longest accepted detail value, in characters (not bytes).
pub const MAX_EVENT_DETAIL_VALUE: usize = 2000;

/// A detail key is a stable lowercase ASCII snake_case id: `[a-z][a-z0-9_]*`,
/// 1..=[`MAX_EVENT_DETAIL_KEY`] characters. Renaming a key orphans its values,
/// so keys are never derived from a label.
pub fn is_valid_event_detail_key(key: &str) -> bool {
    let mut characters = key.chars();
    match characters.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    key.len() <= MAX_EVENT_DETAIL_KEY
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

/// Curated, immutable detail keys of a built-in event type.
pub fn builtin_event_field_keys(event_type: EventType) -> &'static [&'static str] {
    match event_type {
        EventType::Birth => &["birth_certificate", "hospital"],
        EventType::Death => &["cause", "death_certificate"],
        EventType::Marriage => &["marriage_certificate", "marriage_rite", "officiant"],
        EventType::Divorce => &["reason", "court", "divorce_certificate"],
        EventType::Burial => &["cemetery", "grave", "burial_rite", "burial_officiant"],
        EventType::Residence => &["address"],
        EventType::Occupation => &["position", "employer"],
        EventType::Education => &["institution", "faculty", "specialty", "qualification"],
        EventType::Other => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_lowercase_snake_case() {
        for key in ["a", "address", "military_rank", "field_2", "x_9"] {
            assert!(is_valid_event_detail_key(key), "{key} must be valid");
        }
        for key in [
            "",
            "Address",
            "A",
            "1address",
            "_address",
            "ad-dress",
            "ad dress",
            "адрес",
        ] {
            assert!(!is_valid_event_detail_key(key), "{key} must be invalid");
        }
    }

    #[test]
    fn key_length_is_counted_in_characters() {
        assert!(is_valid_event_detail_key(&"a".repeat(MAX_EVENT_DETAIL_KEY)));
        assert!(!is_valid_event_detail_key(
            &"a".repeat(MAX_EVENT_DETAIL_KEY + 1)
        ));
    }

    #[test]
    fn registry_keys_are_valid_and_unique_per_type() {
        for event_type in EventType::ALL {
            let keys = builtin_event_field_keys(event_type);
            let mut seen = std::collections::HashSet::new();
            for key in keys {
                assert!(
                    is_valid_event_detail_key(key),
                    "{} has an invalid key {key}",
                    event_type.code()
                );
                assert!(
                    seen.insert(*key),
                    "{} repeats a key {key}",
                    event_type.code()
                );
            }
        }
        assert!(builtin_event_field_keys(EventType::Other).is_empty());
    }

    #[test]
    fn event_type_codes_round_trip_case_insensitively() {
        for event_type in EventType::ALL {
            assert_eq!(EventType::from_code(event_type.code()), Some(event_type));
            assert_eq!(
                EventType::from_code(&event_type.code().to_ascii_lowercase()),
                Some(event_type)
            );
        }
        assert_eq!(EventType::from_code(" relocation "), None);
    }
}
