//! A confirmed map point for an event place (ADR-0020).
//!
//! The point belongs to one event, not to a place name: two events may name the
//! same village and mean different settlements. It is only ever written from a
//! suggestion the user picked or from a manual pin, never from geocoding a bare
//! string.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// How precise the provider's point is. A settlement centroid is not a house.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlacePrecision {
    /// House or street.
    Point,
    /// City, town, village or locality.
    Settlement,
    /// District, county or state.
    Region,
    Country,
    /// The provider returned a point but no usable object type.
    Unknown,
}

/// Where the point came from. Manual points are never overwritten by a geocoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlaceSource {
    Photon,
    Dadata,
    /// A historical name resolved through Wikidata (ADR-0021).
    Wikidata,
    /// Coordinates read from `PLAC.MAP` in an imported GEDCOM file.
    Gedcom,
    Manual,
}

/// WGS84 point chosen for an event place, with provenance.
///
/// `Eq` is implemented manually: `f64` is not `Eq`, but [`PlaceGeo::validate`]
/// rejects NaN and infinities, and JSON cannot carry them. The invariant is
/// enforced on every write path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceGeo {
    pub lat: f64,
    pub lon: f64,
    pub precision: PlacePrecision,
    pub source: PlaceSource,
    /// Photon `osm_type` + `osm_id`, DaData `fias_id`/`kladr_id`. Provenance and
    /// deduplication only, never a global identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_ref: Option<String>,
    /// Provider label at selection time. Display and provenance only; the
    /// event's `place` stays the editable source of truth for the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl Eq for PlaceGeo {}

impl PlaceGeo {
    /// Builds a validated point.
    pub fn new(
        lat: f64,
        lon: f64,
        precision: PlacePrecision,
        source: PlaceSource,
    ) -> AppResult<Self> {
        let point = Self {
            lat,
            lon,
            precision,
            source,
            provider_ref: None,
            label: None,
        };
        point.validate()?;
        Ok(point)
    }

    pub fn validate(&self) -> AppResult<()> {
        if !self.lat.is_finite() || !(-90.0..=90.0).contains(&self.lat) {
            return Err(AppError::validation("placeGeo", "latitude"));
        }
        if !self.lon.is_finite() || !(-180.0..=180.0).contains(&self.lon) {
            return Err(AppError::validation("placeGeo", "longitude"));
        }
        if self
            .provider_ref
            .as_deref()
            .is_some_and(|value| value.chars().count() > 200)
        {
            return Err(AppError::validation("placeGeo", "providerRefTooLong"));
        }
        if self
            .label
            .as_deref()
            .is_some_and(|value| value.chars().count() > 500)
        {
            return Err(AppError::validation("placeGeo", "labelTooLong"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(lat: f64, lon: f64) -> PlaceGeo {
        PlaceGeo {
            lat,
            lon,
            precision: PlacePrecision::Settlement,
            source: PlaceSource::Photon,
            provider_ref: Some("N123".to_owned()),
            label: Some("Ивановка, Кировская область, Россия".to_owned()),
        }
    }

    #[test]
    fn serializes_camel_case_and_omits_absent_provenance() {
        let json = serde_json::to_value(PlaceGeo {
            provider_ref: None,
            label: None,
            ..point(57.4321, 49.1234)
        })
        .expect("serialize");
        assert_eq!(json["lat"], 57.4321);
        assert_eq!(json["lon"], 49.1234);
        assert_eq!(json["precision"], "SETTLEMENT");
        assert_eq!(json["source"], "PHOTON");
        assert!(json.get("providerRef").is_none());
        assert!(json.get("label").is_none());
    }

    #[test]
    fn round_trips_through_json() {
        let value = point(-33.8688, 151.2093);
        let json = serde_json::to_string(&value).expect("serialize");
        let back: PlaceGeo = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, value);
    }

    #[test]
    fn rejects_non_finite_and_out_of_range_values() {
        for (lat, lon) in [
            (f64::NAN, 0.0),
            (0.0, f64::INFINITY),
            (90.1, 0.0),
            (0.0, 180.1),
        ] {
            let error = point(lat, lon).validate().expect_err("must reject");
            assert_eq!(error.code, crate::codes::VALIDATION_ERROR);
            assert_eq!(error.params["field"], "placeGeo");
        }
    }

    #[test]
    fn accepts_the_poles_and_the_date_line() {
        point(90.0, 180.0).validate().expect("valid");
        point(-90.0, -180.0).validate().expect("valid");
    }

    #[test]
    fn rejects_overlong_provenance() {
        let mut value = point(1.0, 1.0);
        value.provider_ref = Some("x".repeat(201));
        assert_eq!(
            value.validate().expect_err("ref").params["rule"],
            "providerRefTooLong"
        );
        value.provider_ref = None;
        value.label = Some("x".repeat(501));
        assert_eq!(
            value.validate().expect_err("label").params["rule"],
            "labelTooLong"
        );
    }

    #[test]
    fn gedcom_source_serializes_as_screaming_snake_case() {
        let json = serde_json::to_value(PlaceSource::Gedcom).expect("serialize");
        assert_eq!(json, "GEDCOM");
        assert_eq!(
            serde_json::from_value::<PlaceSource>(json).expect("deserialize"),
            PlaceSource::Gedcom
        );
    }

    #[test]
    fn unknown_enum_values_are_rejected() {
        let json = r#"{"lat":1,"lon":1,"precision":"HOUSE","source":"PHOTON"}"#;
        assert!(serde_json::from_str::<PlaceGeo>(json).is_err());
    }
}
