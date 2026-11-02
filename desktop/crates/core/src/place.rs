//! Confirming a map point for existing events (ADR-0020).
//!
//! A place typed by hand has no coordinates. The user resolves it through a
//! suggestion or a manual point; this module applies that choice to the
//! selected events only. Text identity is case- and whitespace-insensitive, but
//! a changed place is never overwritten silently.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::geo::PlaceGeo;
use crate::record::Event;

/// Case- and whitespace-insensitive identity of a typed place. Display text is
/// never rewritten; this is only for matching the list the user saw.
pub fn normalize_place_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPlaceGeoResult {
    pub applied: usize,
    /// Requested events that were not changed: a different place, an existing
    /// point without `overwrite`, or a missing id.
    pub skipped: usize,
}

/// Applies one confirmed point to the selected events in place.
///
/// Rules:
/// - only events whose current `place` matches `expected_place` (case and
///   whitespace insensitive) are eligible;
/// - an event that already has a point is skipped unless `overwrite` is true;
/// - duplicate ids count once; unknown ids count as skipped;
/// - the point is validated before anything is touched.
pub fn apply_place_geo(
    events: &mut [Event],
    event_ids: &[Uuid],
    expected_place: &str,
    point: &PlaceGeo,
    overwrite: bool,
) -> AppResult<ApplyPlaceGeoResult> {
    point.validate()?;
    let expected = normalize_place_text(expected_place);
    if expected.is_empty() {
        return Err(AppError::validation("expectedPlace", "required"));
    }
    let requested: BTreeSet<Uuid> = event_ids.iter().copied().collect();
    let mut applied = 0usize;
    for event in events.iter_mut() {
        if !requested.contains(&event.id) {
            continue;
        }
        let current = event.place.as_deref().unwrap_or_default();
        if normalize_place_text(current) != expected {
            continue;
        }
        if event.place_geo.is_some() && !overwrite {
            continue;
        }
        event.place_geo = Some(point.clone());
        applied += 1;
    }
    Ok(ApplyPlaceGeoResult {
        applied,
        skipped: requested.len() - applied,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::{PlacePrecision, PlaceSource};
    use crate::record::EventType;

    fn point(lat: f64) -> PlaceGeo {
        PlaceGeo {
            lat,
            lon: 49.0,
            precision: PlacePrecision::Settlement,
            source: PlaceSource::Photon,
            provider_ref: Some("N1".to_owned()),
            label: Some("Ивановка, Кировская область".to_owned()),
        }
    }

    fn event(place: &str) -> Event {
        let mut event = Event::new(Uuid::now_v7(), EventType::Residence);
        event.place = Some(place.to_owned());
        event
    }

    #[test]
    fn applies_only_to_events_with_the_expected_text() {
        let mut events = [event("Ивановка"), event("Другая")];
        let ids = events.iter().map(|row| row.id).collect::<Vec<_>>();
        let result =
            apply_place_geo(&mut events, &ids, "  ивановка ", &point(57.0), false).expect("apply");
        assert_eq!(
            result,
            ApplyPlaceGeoResult {
                applied: 1,
                skipped: 1
            }
        );
        assert!(events[0].place_geo.is_some());
        assert!(events[1].place_geo.is_none());
    }

    #[test]
    fn never_overwrites_a_point_without_overwrite() {
        let mut events = [event("Ивановка")];
        events[0].place_geo = Some(point(50.0));
        let ids = [events[0].id];
        let result =
            apply_place_geo(&mut events, &ids, "Ивановка", &point(57.0), false).expect("apply");
        assert_eq!(result.applied, 0);
        assert_eq!(result.skipped, 1);
        assert_eq!(events[0].place_geo.as_ref().expect("point").lat, 50.0);
    }

    #[test]
    fn overwrite_replaces_an_existing_point() {
        let mut events = [event("Ивановка")];
        events[0].place_geo = Some(point(50.0));
        let ids = [events[0].id];
        let result =
            apply_place_geo(&mut events, &ids, "Ивановка", &point(57.0), true).expect("apply");
        assert_eq!(result.applied, 1);
        assert_eq!(events[0].place_geo.as_ref().expect("point").lat, 57.0);
    }

    #[test]
    fn duplicate_and_missing_ids_are_counted_once() {
        let mut events = [event("Ивановка")];
        let id = events[0].id;
        let missing = Uuid::now_v7();
        let result = apply_place_geo(
            &mut events,
            &[id, id, missing],
            "Ивановка",
            &point(57.0),
            false,
        )
        .expect("apply");
        assert_eq!(
            result,
            ApplyPlaceGeoResult {
                applied: 1,
                skipped: 1
            }
        );
    }

    #[test]
    fn rejects_an_empty_expected_place_and_an_invalid_point() {
        let mut events = [event("Ивановка")];
        let ids = [events[0].id];
        let error =
            apply_place_geo(&mut events, &ids, "  ", &point(57.0), false).expect_err("empty");
        assert_eq!(error.params["field"], "expectedPlace");

        let mut bad = point(57.0);
        bad.lat = 91.0;
        let error =
            apply_place_geo(&mut events, &ids, "Ивановка", &bad, false).expect_err("invalid");
        assert_eq!(error.params["field"], "placeGeo");
    }

    #[test]
    fn is_idempotent_without_overwrite() {
        let mut events = [event("Ивановка")];
        let ids = [events[0].id];
        apply_place_geo(&mut events, &ids, "Ивановка", &point(57.0), false).expect("first");
        let second =
            apply_place_geo(&mut events, &ids, "Ивановка", &point(58.0), false).expect("second");
        assert_eq!(
            second,
            ApplyPlaceGeoResult {
                applied: 0,
                skipped: 1
            }
        );
        assert_eq!(events[0].place_geo.as_ref().expect("point").lat, 57.0);
    }
}
