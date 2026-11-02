//! Draft changes proposed by the chat (design.md §9, ADR-0007, ADR-0012).
//!
//! The chat never writes to the project. A model that wants to change something
//! returns a [`DraftChange`]; the UI shows it, the user confirms, and only then
//! does the application layer apply it through the domain services.
//!
//! This module keeps the draft *inert*: [`DraftChange::validate`] deserializes
//! the payload, checks the domain invariants and rejects dangling references,
//! but it never touches a store. Applying is deliberately outside this crate:
//!
//! ```text
//! chat.applyDraft contract (application layer, design.md §9):
//!   1. require an explicit user confirmation; without it `apply` is not called;
//!   2. call DraftChange::validate(&persons, &events, &relationships) first and
//!      return its AppError unchanged (VALIDATION_ERROR / RELATIONSHIP_*);
//!   3. deserialize `payload` into the domain type again and pass it to the
//!      domain service in one transaction — no partial application;
//!   4. return the `updatedAt`/`version` of the written record;
//!   5. a cancelled or rejected draft leaves the project byte-for-byte intact.
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use gentree_core::{AppError, AppResult, Event, Person, Relationship, RelationshipSet};

/// What the draft would do once confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DraftKind {
    CreatePerson,
    UpdatePerson,
    CreateEvent,
    UpdateEvent,
    CreateRelationship,
}

impl DraftKind {
    /// Update drafts carry an existing entity and cannot create one.
    pub fn is_update(self) -> bool {
        matches!(self, Self::UpdatePerson | Self::UpdateEvent)
    }
}

/// Where the model's claim comes from. The hash, not the quote, travels with
/// the draft so user data is not duplicated into the transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftEvidence {
    /// Source title or id the model cited.
    pub source: String,
    /// sha256 (hex) of the quoted excerpt.
    pub quote_hash: String,
}

/// A proposed change that is waiting for explicit user confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftChange {
    pub id: Uuid,
    pub kind: DraftKind,
    /// Domain object of `kind`, serialized as-is (`Person`, `Event`,
    /// `Relationship`).
    pub payload: Value,
    #[serde(default)]
    pub evidence: Vec<DraftEvidence>,
    /// Entities the user saw in the confirmation dialog; applying must not
    /// silently touch anything else.
    #[serde(default)]
    pub target_ids: Vec<Uuid>,
    /// RFC 3339 UTC (`gentree_core::now_rfc3339`).
    pub created_at: String,
}

impl DraftChange {
    pub fn new(kind: DraftKind, payload: Value) -> Self {
        Self {
            id: Uuid::now_v7(),
            kind,
            payload,
            evidence: Vec::new(),
            target_ids: Vec::new(),
            created_at: gentree_core::now_rfc3339(),
        }
    }

    /// Checks the payload against the domain invariants and the current
    /// project state. Read-only: nothing is written and no id is generated.
    ///
    /// Errors are [`AppError`]s with stable codes: `VALIDATION_ERROR`,
    /// `DUPLICATE_RELATIONSHIP`, `RELATIONSHIP_CYCLE`.
    pub fn validate(
        &self,
        persons: &[Person],
        events: &[Event],
        relationships: &[Relationship],
    ) -> AppResult<()> {
        self.validate_evidence()?;
        self.validate_targets(persons, events, relationships)?;

        match self.kind {
            DraftKind::CreatePerson | DraftKind::UpdatePerson => self.validate_person(persons),
            DraftKind::CreateEvent | DraftKind::UpdateEvent => self.validate_event(persons, events),
            DraftKind::CreateRelationship => self.validate_relationship(persons, relationships),
        }
    }

    fn validate_evidence(&self) -> AppResult<()> {
        for evidence in &self.evidence {
            if evidence.source.trim().is_empty() || evidence.quote_hash.trim().is_empty() {
                return Err(AppError::validation("evidence", "required"));
            }
        }
        Ok(())
    }

    /// Every id the user is about to confirm must resolve in the project.
    fn validate_targets(
        &self,
        persons: &[Person],
        events: &[Event],
        relationships: &[Relationship],
    ) -> AppResult<()> {
        for target in &self.target_ids {
            let known = persons.iter().any(|person| person.id == *target)
                || events.iter().any(|event| event.id == *target)
                || relationships.iter().any(|row| row.id == *target);
            if !known {
                return Err(AppError::validation("targetId", "notFound")
                    .with_param("value", target.to_string()));
            }
        }
        Ok(())
    }

    fn validate_person(&self, persons: &[Person]) -> AppResult<()> {
        let person: Person = self.payload()?;
        person.validate()?;
        let existing = persons.iter().find(|candidate| candidate.id == person.id);
        if self.kind.is_update() {
            if existing.is_none() {
                return Err(AppError::validation("personId", "notFound")
                    .with_param("value", person.id.to_string()));
            }
        } else if existing.is_some() {
            return Err(AppError::validation("personId", "duplicate")
                .with_param("value", person.id.to_string()));
        }
        Ok(())
    }

    fn validate_event(&self, persons: &[Person], events: &[Event]) -> AppResult<()> {
        let event: Event = self.payload()?;
        event.validate()?;
        if !persons.iter().any(|person| person.id == event.person_id) {
            return Err(AppError::validation("personId", "notFound")
                .with_param("value", event.person_id.to_string()));
        }
        let existing = events.iter().find(|candidate| candidate.id == event.id);
        if self.kind.is_update() {
            if existing.is_none() {
                return Err(AppError::validation("eventId", "notFound")
                    .with_param("value", event.id.to_string()));
            }
        } else if existing.is_some() {
            return Err(AppError::validation("eventId", "duplicate")
                .with_param("value", event.id.to_string()));
        }
        Ok(())
    }

    fn validate_relationship(
        &self,
        persons: &[Person],
        relationships: &[Relationship],
    ) -> AppResult<()> {
        let row: Relationship = self.payload()?;
        if row.person_id == row.related_person_id {
            return Err(AppError::validation("relationship", "selfLink"));
        }
        for (field, id) in [
            ("personId", row.person_id),
            ("relatedPersonId", row.related_person_id),
        ] {
            if !persons.iter().any(|person| person.id == id) {
                return Err(
                    AppError::validation(field, "notFound").with_param("value", id.to_string())
                );
            }
        }
        if relationships.iter().any(|existing| existing.id == row.id) {
            return Err(AppError::validation("relationshipId", "duplicate")
                .with_param("value", row.id.to_string()));
        }
        // Reuse the domain rules (duplicates, spouse canonical form, parent
        // cycles) instead of re-implementing them in the chat crate.
        let mut set = RelationshipSet::new(relationships.to_vec())?;
        set.push(canonical(row))?;
        Ok(())
    }

    /// Deserializes `payload` into `T`, reporting a mismatch as a draft
    /// validation error rather than a transport error.
    fn payload<T: serde::de::DeserializeOwned>(&self) -> AppResult<T> {
        serde_json::from_value(self.payload.clone()).map_err(|err| {
            AppError::validation("payload", "invalid").with_param("reason", err.to_string())
        })
    }
}

/// Spouse rows are stored with `person_id < related_person_id`; the model may
/// send either order. Only a local copy is reordered — the payload is untouched.
fn canonical(mut row: Relationship) -> Relationship {
    row.canonicalize_spouse_order();
    row
}
