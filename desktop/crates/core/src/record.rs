use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::date::DateValue;
use crate::error::{AppError, AppResult};
use crate::event_fields::{is_valid_event_detail_key, MAX_EVENT_DETAILS, MAX_EVENT_DETAIL_VALUE};
use crate::geo::PlaceGeo;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    Birth,
    Death,
    Marriage,
    Divorce,
    Burial,
    Residence,
    Occupation,
    Education,
    Other,
}

impl EventType {
    /// Every built-in type in declaration order.
    pub const ALL: [Self; 9] = [
        Self::Birth,
        Self::Death,
        Self::Marriage,
        Self::Divorce,
        Self::Burial,
        Self::Residence,
        Self::Occupation,
        Self::Education,
        Self::Other,
    ];

    /// Stable code used by `config.yaml` (`event_fields.custom[].type`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Birth => "BIRTH",
            Self::Death => "DEATH",
            Self::Marriage => "MARRIAGE",
            Self::Divorce => "DIVORCE",
            Self::Burial => "BURIAL",
            Self::Residence => "RESIDENCE",
            Self::Occupation => "OCCUPATION",
            Self::Education => "EDUCATION",
            Self::Other => "OTHER",
        }
    }

    /// Case-insensitive lookup used by the config layer; unknown codes are
    /// custom event types, not errors.
    pub fn from_code(code: &str) -> Option<Self> {
        let code = code.trim();
        Self::ALL
            .into_iter()
            .find(|event_type| event_type.code().eq_ignore_ascii_case(code))
    }
}

/// Event with one owning person and optional co-participants. A marriage is
/// owned by one spouse and lists the other in [`Event::participant_ids`];
/// `original_type` keeps the source value when it is not in the enum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: Uuid,
    pub person_id: Uuid,
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub date: DateValue,
    pub place: Option<String>,
    /// Confirmed map point chosen for `place` (ADR-0020). Absent when the place
    /// was typed without a suggestion, or when the text changed by hand.
    /// Omitted from JSON so events without a point stay byte-compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place_geo: Option<PlaceGeo>,
    pub description: Option<String>,
    pub source_ids: Vec<Uuid>,
    pub original_type: Option<String>,
    /// Other people taking part in the event (a marriage spouse, a witness).
    /// The owner is never repeated here.
    #[serde(default)]
    pub participant_ids: Vec<Uuid>,
    /// Type-specific values keyed by a stable snake_case key (ADR-0015).
    /// The schema is curated in [`crate::event_fields`] and in the user's
    /// config; the domain only checks the generic shape. An empty map is
    /// omitted, so events without details stay byte-compatible.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
}

impl Event {
    pub fn new(person_id: Uuid, event_type: EventType) -> Self {
        Self {
            id: Uuid::now_v7(),
            person_id,
            event_type,
            date: DateValue::default(),
            place: None,
            place_geo: None,
            description: None,
            source_ids: Vec::new(),
            original_type: None,
            participant_ids: Vec::new(),
            details: BTreeMap::new(),
        }
    }

    /// `true` when the person is the owner or a co-participant.
    pub fn involves(&self, person_id: Uuid) -> bool {
        self.person_id == person_id || self.participant_ids.contains(&person_id)
    }

    /// `true` when anyone from `person_ids` takes part in the event.
    pub fn involves_any(&self, person_ids: &std::collections::BTreeSet<Uuid>) -> bool {
        person_ids.contains(&self.person_id)
            || self
                .participant_ids
                .iter()
                .any(|participant| person_ids.contains(participant))
    }

    /// Removes one person from the event. Returns `true` when nobody is left
    /// and the event itself must be deleted; otherwise the first remaining
    /// co-participant is promoted to owner.
    pub fn detach_person(&mut self, person_id: Uuid) -> bool {
        if self.person_id == person_id {
            if let Some(next) = self.participant_ids.first().copied() {
                self.person_id = next;
                self.participant_ids
                    .retain(|id| *id != next && *id != person_id);
                return false;
            }
            return true;
        }
        self.participant_ids.retain(|id| *id != person_id);
        false
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.person_id.is_nil() {
            return Err(AppError::validation("personId", "required"));
        }
        if self.event_type == EventType::Residence {
            // A residence may be ongoing: `RANGE` with a start and no end.
            self.date.validate_open_range()?;
        } else {
            self.date.validate()?;
        }
        if self.place.as_deref().is_some_and(|value| value.len() > 500) {
            return Err(AppError::validation("place", "tooLong"));
        }
        if let Some(point) = &self.place_geo {
            point.validate()?;
        }
        let mut seen = std::collections::HashSet::new();
        for participant in &self.participant_ids {
            if participant.is_nil() {
                return Err(AppError::validation("participantIds", "required"));
            }
            if *participant == self.person_id {
                return Err(AppError::validation("participantIds", "owner"));
            }
            if !seen.insert(*participant) {
                return Err(AppError::validation("participantIds", "duplicate"));
            }
        }
        if self.details.len() > MAX_EVENT_DETAILS {
            return Err(AppError::validation("details", "tooMany")
                .with_param("max", MAX_EVENT_DETAILS.to_string()));
        }
        for (key, value) in &self.details {
            if !is_valid_event_detail_key(key) {
                return Err(
                    AppError::validation("details", "invalidKey").with_param("key", key.clone())
                );
            }
            if value.trim().is_empty() {
                return Err(
                    AppError::validation("details", "required").with_param("key", key.clone())
                );
            }
            if value.chars().count() > MAX_EVENT_DETAIL_VALUE {
                return Err(
                    AppError::validation("details", "maxLength").with_param("key", key.clone())
                );
            }
        }
        Ok(())
    }
}

/// Backfills the other spouse on legacy marriage events that have no
/// co-participants yet. A person with exactly one spouse/partner link gets that
/// partner; an ambiguous person (several spouse links) is left untouched rather
/// than guessing. Returns the number of events changed.
pub fn backfill_marriage_participants(
    events: &mut [Event],
    relationships: &[crate::relationship::Relationship],
) -> usize {
    use crate::relationship::RelationshipType;

    let mut changed = 0usize;
    for event in events.iter_mut() {
        if event.event_type != EventType::Marriage || !event.participant_ids.is_empty() {
            continue;
        }
        let mut spouses = relationships
            .iter()
            .filter(|row| {
                row.rel_type == RelationshipType::Spouse
                    || row.rel_type == RelationshipType::Partner
            })
            .filter_map(|row| {
                if row.person_id == event.person_id {
                    Some(row.related_person_id)
                } else if row.related_person_id == event.person_id {
                    Some(row.person_id)
                } else {
                    None
                }
            });
        let Some(first) = spouses.next() else {
            continue;
        };
        if spouses.next().is_some() {
            continue;
        }
        event.participant_ids.push(first);
        changed += 1;
    }
    changed
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: Uuid,
    pub title: String,
    pub author: Option<String>,
    pub publication: Option<String>,
    pub repository: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
}

impl Source {
    pub fn new(title: impl Into<String>) -> AppResult<Self> {
        let source = Self {
            id: Uuid::now_v7(),
            title: title.into(),
            author: None,
            publication: None,
            repository: None,
            url: None,
            notes: None,
        };
        source.validate()?;
        Ok(source)
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.title.trim().is_empty() {
            return Err(AppError::validation("title", "required"));
        }
        if let Some(url) = &self.url {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(AppError::validation("url", "scheme"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CitationTarget {
    Person,
    Event,
    Relationship,
    Media,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub id: Uuid,
    pub source_id: Uuid,
    pub target_type: CitationTarget,
    pub target_id: Uuid,
    pub page: Option<String>,
    pub confidence: Option<Confidence>,
}

impl Citation {
    pub fn new(source_id: Uuid, target_type: CitationTarget, target_id: Uuid) -> Self {
        Self {
            id: Uuid::now_v7(),
            source_id,
            target_type,
            target_id,
            page: None,
            confidence: None,
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.source_id.is_nil() || self.target_id.is_nil() {
            return Err(AppError::validation("citation", "reference"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: Uuid,
    pub file_name: String,
    pub mime_type: String,
    /// Lowercase hex sha256 of the file bytes.
    pub checksum: String,
    pub caption: Option<String>,
    pub source_id: Option<Uuid>,
    /// Person the media is attached to; `None` when the source has no link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_id: Option<Uuid>,
    /// Event the media documents (ADR-0018). A row is attached to a person or
    /// to an event, never to both; `None` keeps the older person-only shape, so
    /// projects written before the field read and round-trip unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<Uuid>,
    /// `true` for the person's profile photo. Older projects have no field and
    /// read as `false`; the default is also omitted from the exchange format so
    /// the existing export schema stays unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
}

impl Media {
    pub fn validate(&self) -> AppResult<()> {
        if self.file_name.trim().is_empty() {
            return Err(AppError::validation("fileName", "required"));
        }
        if self.checksum.len() != 64 || !self.checksum.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::validation("checksum", "sha256"));
        }
        if self.mime_type.trim().is_empty() {
            return Err(AppError::validation("mimeType", "required"));
        }
        if self.event_id.is_some_and(|id| id.is_nil()) {
            return Err(AppError::validation("eventId", "nil"));
        }
        // One row documents one thing: a person's photo or an event's scan.
        // Keeping both links would make deletion of either side ambiguous.
        if self.person_id.is_some() && self.event_id.is_some() {
            return Err(AppError::validation("eventId", "exclusive"));
        }
        // `primary` is the person's profile photo; event files have no such
        // concept, and a row with no person cannot be a profile photo.
        if self.primary && self.person_id.is_none() {
            return Err(AppError::validation("primary", "personOnly"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_validates_date() {
        let mut event = Event::new(Uuid::now_v7(), EventType::Birth);
        event.date = DateValue::exact_year(1950);
        event.validate().unwrap();
        event.place = Some("Москва".into());
        event.validate().unwrap();
    }

    #[test]
    fn event_details_round_trip_and_empty_map_is_omitted() {
        let mut event = Event::new(Uuid::now_v7(), EventType::Education);
        let stored = serde_json::to_value(&event).unwrap();
        assert!(
            stored.get("details").is_none(),
            "empty details must be omitted"
        );

        event.details.insert("institution".into(), "МГУ".into());
        event.details.insert("specialty".into(), "История".into());
        event.validate().unwrap();

        let stored = serde_json::to_value(&event).unwrap();
        assert_eq!(stored["details"]["institution"], "МГУ");

        let restored: Event = serde_json::from_value(stored).unwrap();
        assert_eq!(restored, event);
        // A legacy event without the field reads as an empty map.
        let legacy: Event = serde_json::from_value(serde_json::json!({
            "id": Uuid::now_v7(),
            "personId": Uuid::now_v7(),
            "type": "BIRTH",
            "date": {"start": null, "end": null, "precision": "UNKNOWN", "qualifier": "UNKNOWN", "original": null},
            "place": null,
            "description": null,
            "sourceIds": [],
            "originalType": null,
            "participantIds": [],
        }))
        .unwrap();
        assert!(legacy.details.is_empty());
    }

    #[test]
    fn event_omits_an_absent_point_and_reads_old_rows() {
        let event = Event::new(Uuid::now_v7(), EventType::Birth);
        let stored = serde_json::to_value(&event).unwrap();
        assert!(
            stored.get("placeGeo").is_none(),
            "an absent point must be omitted"
        );

        let legacy: Event = serde_json::from_value(serde_json::json!({
            "id": Uuid::now_v7(),
            "personId": Uuid::now_v7(),
            "type": "BIRTH",
            "date": {"start": null, "end": null, "precision": "UNKNOWN", "qualifier": "UNKNOWN", "original": null},
            "place": "Ивановка",
            "description": null,
            "sourceIds": [],
            "originalType": null,
            "participantIds": [],
        }))
        .unwrap();
        assert!(legacy.place_geo.is_none());
    }

    #[test]
    fn event_round_trips_a_confirmed_point() {
        let mut event = Event::new(Uuid::now_v7(), EventType::Residence);
        event.place = Some("Ивановка".into());
        event.place_geo = Some(crate::geo::PlaceGeo {
            lat: 57.4321,
            lon: 49.1234,
            precision: crate::geo::PlacePrecision::Settlement,
            source: crate::geo::PlaceSource::Photon,
            provider_ref: Some("N123456".into()),
            label: Some("Ивановка, Кировская область, Россия".into()),
        });
        event.validate().unwrap();

        let stored = serde_json::to_value(&event).unwrap();
        assert_eq!(stored["placeGeo"]["lat"], 57.4321);
        assert_eq!(stored["placeGeo"]["precision"], "SETTLEMENT");
        assert_eq!(stored["placeGeo"]["source"], "PHOTON");
        assert_eq!(stored["placeGeo"]["providerRef"], "N123456");

        let restored: Event = serde_json::from_value(stored).unwrap();
        assert_eq!(restored, event);
    }

    #[test]
    fn event_rejects_an_invalid_point() {
        let mut event = Event::new(Uuid::now_v7(), EventType::Residence);
        event.place_geo = Some(crate::geo::PlaceGeo {
            lat: 91.0,
            lon: 0.0,
            precision: crate::geo::PlacePrecision::Point,
            source: crate::geo::PlaceSource::Manual,
            provider_ref: None,
            label: None,
        });
        let error = event.validate().unwrap_err();
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("placeGeo")
        );
    }

    #[test]
    fn event_details_reject_bad_shape() {
        let mut event = Event::new(Uuid::now_v7(), EventType::Birth);

        event.details.insert("Hospital".into(), "ГКБ 1".into());
        let error = event.validate().unwrap_err();
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("invalidKey")
        );
        assert_eq!(
            error.params.get("key").map(String::as_str),
            Some("Hospital")
        );

        event.details.clear();
        event.details.insert("certificate".into(), "   ".into());
        let error = event.validate().unwrap_err();
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("required")
        );

        event.details.clear();
        event.details.insert("certificate".into(), "я".repeat(2001));
        let error = event.validate().unwrap_err();
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("maxLength")
        );
        event.details.insert("certificate".into(), "я".repeat(2000));
        event.validate().unwrap();

        event.details.clear();
        for index in 0..=crate::event_fields::MAX_EVENT_DETAILS {
            event
                .details
                .insert(format!("field_{index}"), "value".into());
        }
        let error = event.validate().unwrap_err();
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("tooMany")
        );
    }

    #[test]
    fn event_accepts_unknown_detail_keys() {
        let mut event = Event::new(Uuid::now_v7(), EventType::Residence);
        event.details.insert("custom_key".into(), "значение".into());
        event.validate().unwrap();
    }

    #[test]
    fn marriage_backfill_uses_the_only_spouse_link() {
        use crate::relationship::{Relationship, RelationshipType};

        let husband = Uuid::now_v7();
        let wife = Uuid::now_v7();
        let event = Event::new(husband, EventType::Marriage);
        let spouse = Relationship::new(RelationshipType::Spouse, husband, wife).unwrap();
        let mut events = vec![event.clone()];

        assert_eq!(backfill_marriage_participants(&mut events, &[spouse]), 1);
        assert_eq!(events[0].participant_ids, vec![wife]);
        assert!(events[0].involves(wife));

        // A person with two spouse links is ambiguous and stays untouched.
        let other = Uuid::now_v7();
        let second = Relationship::new(RelationshipType::Spouse, husband, other).unwrap();
        let mut ambiguous = vec![event];
        assert_eq!(
            backfill_marriage_participants(
                &mut ambiguous,
                &[
                    Relationship::new(RelationshipType::Spouse, husband, wife).unwrap(),
                    second,
                ]
            ),
            0
        );
    }

    #[test]
    fn source_rejects_non_http_url() {
        let mut source = Source::new("Метрическая книга").unwrap();
        source.url = Some("javascript:alert(1)".into());
        assert_eq!(
            source
                .validate()
                .unwrap_err()
                .params
                .get("rule")
                .map(String::as_str),
            Some("scheme")
        );
    }

    #[test]
    fn media_requires_sha256() {
        let mut media = Media {
            id: Uuid::now_v7(),
            file_name: "scan.jpg".into(),
            mime_type: "image/jpeg".into(),
            checksum: "abc".into(),
            caption: None,
            source_id: None,
            person_id: None,
            event_id: None,
            primary: false,
        };
        assert!(media.validate().is_err());
        media.checksum = "a".repeat(64);
        media.validate().unwrap();
    }

    #[test]
    fn media_targets_a_person_or_an_event_but_never_both() {
        let mut media = Media {
            id: Uuid::now_v7(),
            file_name: "scan.jpg".into(),
            mime_type: "application/pdf".into(),
            checksum: "a".repeat(64),
            caption: None,
            source_id: None,
            person_id: None,
            event_id: Some(Uuid::now_v7()),
            primary: false,
        };
        media.validate().unwrap();

        media.person_id = Some(Uuid::now_v7());
        let error = media.validate().unwrap_err();
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("eventId")
        );
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("exclusive")
        );

        // The profile-photo flag belongs to people only.
        media.person_id = None;
        media.primary = true;
        let error = media.validate().unwrap_err();
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("primary")
        );
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("personOnly")
        );

        media.primary = false;
        media.event_id = Some(Uuid::nil());
        let error = media.validate().unwrap_err();
        assert_eq!(error.params.get("rule").map(String::as_str), Some("nil"));
    }

    #[test]
    fn media_event_id_round_trips_and_is_absent_for_person_rows() {
        let mut media = Media {
            id: Uuid::now_v7(),
            file_name: "certificate.pdf".into(),
            mime_type: "application/pdf".into(),
            checksum: "b".repeat(64),
            caption: Some("synthetic caption".into()),
            source_id: None,
            person_id: None,
            event_id: Some(Uuid::now_v7()),
            primary: false,
        };
        let stored = serde_json::to_value(&media).unwrap();
        assert_eq!(stored["eventId"], media.event_id.unwrap().to_string());

        let restored: Media = serde_json::from_value(stored).unwrap();
        assert_eq!(restored, media);

        // A person row keeps the pre-ADR-0018 shape: no `eventId` key at all.
        media.event_id = None;
        media.person_id = Some(Uuid::now_v7());
        let stored = serde_json::to_value(&media).unwrap();
        assert!(stored.get("eventId").is_none());

        // Legacy rows without the field read as "not attached to an event".
        let mut legacy = stored.clone();
        legacy.as_object_mut().unwrap().remove("eventId");
        let restored: Media = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.event_id, None);
        assert_eq!(restored.person_id, media.person_id);
    }

    #[test]
    fn media_without_the_primary_field_reads_as_not_primary() {
        // A row written before profile photos existed has no `primary` key.
        let legacy = serde_json::json!({
            "id": Uuid::now_v7(),
            "fileName": "scan.jpg",
            "mimeType": "image/jpeg",
            "checksum": "a".repeat(64),
            "caption": null,
            "sourceId": null,
            "personId": null,
        });
        let media: Media = serde_json::from_value(legacy).unwrap();
        assert!(!media.primary);

        // The default is omitted again, so the exchange schema is unchanged.
        let stored = serde_json::to_value(&media).unwrap();
        assert!(stored.get("primary").is_none());
    }
}
