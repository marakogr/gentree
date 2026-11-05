use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{codes, AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RelationshipType {
    ParentChild,
    AdoptiveParentChild,
    Spouse,
    Partner,
}

/// Who created a relationship row. Legacy rows have no field and read as
/// [`RelationOrigin::Manual`], so older builds and older projects stay safe.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RelationOrigin {
    #[default]
    Manual,
    Event,
}

fn is_manual_origin(origin: &RelationOrigin) -> bool {
    *origin == RelationOrigin::Manual
}

impl RelationshipType {
    pub fn is_parent(self) -> bool {
        matches!(self, Self::ParentChild | Self::AdoptiveParentChild)
    }

    pub fn is_spouse(self) -> bool {
        matches!(self, Self::Spouse | Self::Partner)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub rel_type: RelationshipType,
    /// For parent edges this is the parent; the other side is the child.
    pub person_id: Uuid,
    pub related_person_id: Uuid,
    pub notes: Option<String>,
    /// Manual rows (and legacy rows without the field) are never retracted by
    /// an event edit or delete. Omitted when manual, so legacy bytes stay stable.
    #[serde(default, skip_serializing_if = "is_manual_origin")]
    pub origin: RelationOrigin,
    /// Events that currently assert this row. Empty for a purely manual row.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_event_ids: Vec<Uuid>,
}

impl Relationship {
    /// Spouse/partner rows are canonicalised so `person_id < related_person_id`.
    pub fn new(rel_type: RelationshipType, a: Uuid, b: Uuid) -> AppResult<Self> {
        let mut row = Self {
            id: Uuid::now_v7(),
            rel_type,
            person_id: a,
            related_person_id: b,
            notes: None,
            origin: RelationOrigin::Manual,
            source_event_ids: Vec::new(),
        };
        row.canonicalize_spouse_order();
        row.validate_row()?;
        Ok(row)
    }

    /// Sorts a spouse pair into canonical order; other rows are untouched.
    pub fn canonicalize_spouse_order(&mut self) {
        if self.rel_type.is_spouse() && self.person_id > self.related_person_id {
            std::mem::swap(&mut self.person_id, &mut self.related_person_id);
        }
    }

    /// Row-level invariants: no self-link, canonical spouse order.
    ///
    /// Shared by construction, [`RelationshipSet::push`] and the storage layer,
    /// so a row read from disk follows the same rules as a freshly created one.
    pub fn validate_row(&self) -> AppResult<()> {
        if self.person_id == self.related_person_id {
            return Err(
                AppError::new(codes::VALIDATION_ERROR, "Self-link is not allowed")
                    .with_param("rule", "selfLink"),
            );
        }
        if self.rel_type.is_spouse() && self.person_id > self.related_person_id {
            return Err(AppError::new(
                codes::VALIDATION_ERROR,
                "Spouse rows must be canonicalised",
            )
            .with_param("rule", "spouseOrder"));
        }
        if self.origin == RelationOrigin::Event && self.source_event_ids.is_empty() {
            return Err(AppError::validation("sourceEventIds", "required"));
        }
        let mut seen = HashSet::new();
        for event_id in &self.source_event_ids {
            if event_id.is_nil() || !seen.insert(*event_id) {
                return Err(AppError::validation("sourceEventIds", "invalid"));
            }
        }
        Ok(())
    }

    pub fn is_automatic(&self) -> bool {
        self.origin == RelationOrigin::Event
    }

    pub fn child(&self) -> Option<Uuid> {
        self.rel_type.is_parent().then_some(self.related_person_id)
    }

    pub fn parent(&self) -> Option<Uuid> {
        self.rel_type.is_parent().then_some(self.person_id)
    }
}

/// Validated relationship set: rejects self-links, duplicates and parent cycles.
#[derive(Debug, Clone, Default)]
pub struct RelationshipSet {
    rows: Vec<Relationship>,
}

impl RelationshipSet {
    pub fn new(rows: Vec<Relationship>) -> AppResult<Self> {
        let mut set = Self::default();
        for row in rows {
            set.push(row)?;
        }
        Ok(set)
    }

    pub fn rows(&self) -> &[Relationship] {
        &self.rows
    }

    pub fn push(&mut self, row: Relationship) -> AppResult<()> {
        row.validate_row()?;
        if self.rows.iter().any(|existing| {
            existing.rel_type == row.rel_type
                && existing.person_id == row.person_id
                && existing.related_person_id == row.related_person_id
        }) {
            return Err(AppError::new(
                codes::DUPLICATE_RELATIONSHIP,
                "Relationship already exists",
            )
            .with_param("personId", row.person_id.to_string())
            .with_param("relatedPersonId", row.related_person_id.to_string()));
        }
        if row.rel_type.is_parent() && self.reaches(row.person_id, row.related_person_id) {
            return Err(
                AppError::new(codes::RELATIONSHIP_CYCLE, "Parent cycle detected")
                    .with_param("personId", row.person_id.to_string())
                    .with_param("relatedPersonId", row.related_person_id.to_string()),
            );
        }
        if row.rel_type.is_spouse() {
            let (a, b) = (row.person_id, row.related_person_id);
            let pair_exists = self.rows.iter().any(|existing| {
                existing.rel_type.is_spouse()
                    && existing.person_id == a
                    && existing.related_person_id == b
            });
            if pair_exists {
                return Err(AppError::new(
                    codes::DUPLICATE_RELATIONSHIP,
                    "Spouse relationship already exists",
                ));
            }
        }
        self.rows.push(row);
        Ok(())
    }

    pub fn remove(&mut self, id: Uuid) -> bool {
        let before = self.rows.len();
        self.rows.retain(|row| row.id != id);
        before != self.rows.len()
    }

    /// Parents of `child`, sorted by personId for deterministic traversal.
    pub fn parents_of(&self, child: Uuid) -> Vec<(Uuid, bool)> {
        let mut out: Vec<(Uuid, bool)> = self
            .rows
            .iter()
            .filter_map(|row| {
                row.child().filter(|value| *value == child).map(|_| {
                    (
                        row.person_id,
                        row.rel_type == RelationshipType::AdoptiveParentChild,
                    )
                })
            })
            .collect();
        out.sort_by_key(|(id, _)| *id);
        out
    }

    pub fn children_of(&self, parent: Uuid) -> Vec<Uuid> {
        let mut out: Vec<Uuid> = self
            .rows
            .iter()
            .filter(|row| row.parent() == Some(parent))
            .map(|row| row.related_person_id)
            .collect();
        out.sort();
        out
    }

    pub fn spouses_of(&self, person: Uuid) -> Vec<Uuid> {
        let mut out: Vec<Uuid> = self
            .rows
            .iter()
            .filter(|row| row.rel_type.is_spouse())
            .filter_map(|row| {
                if row.person_id == person {
                    Some(row.related_person_id)
                } else if row.related_person_id == person {
                    Some(row.person_id)
                } else {
                    None
                }
            })
            .collect();
        out.sort();
        out
    }

    pub fn is_spouse_of(&self, a: Uuid, b: Uuid) -> bool {
        self.spouses_of(a).contains(&b)
    }

    /// True when `target` is reachable from `start` following parent edges.
    fn reaches(&self, start: Uuid, target: Uuid) -> bool {
        let mut seen = HashSet::new();
        let mut stack = vec![start];
        while let Some(current) = stack.pop() {
            if current == target {
                return true;
            }
            if !seen.insert(current) {
                continue;
            }
            for (parent, _) in self.parents_of(current) {
                stack.push(parent);
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persons() -> [Uuid; 4] {
        [
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
        ]
    }

    #[test]
    fn spouse_rows_are_canonical() {
        let [a, b, _, _] = persons();
        let (low, high) = if a < b { (a, b) } else { (b, a) };
        let row = Relationship::new(RelationshipType::Spouse, high, low).unwrap();
        assert_eq!(row.person_id, low);
        assert_eq!(row.related_person_id, high);
    }

    #[test]
    fn self_link_is_rejected() {
        let [a, _, _, _] = persons();
        let err = Relationship::new(RelationshipType::ParentChild, a, a).unwrap_err();
        assert_eq!(err.params.get("rule").map(String::as_str), Some("selfLink"));
    }

    #[test]
    fn duplicate_is_rejected() {
        let [a, b, _, _] = persons();
        let mut set = RelationshipSet::default();
        set.push(Relationship::new(RelationshipType::ParentChild, a, b).unwrap())
            .unwrap();
        let err = set
            .push(Relationship::new(RelationshipType::ParentChild, a, b).unwrap())
            .unwrap_err();
        assert_eq!(err.code, codes::DUPLICATE_RELATIONSHIP);
    }

    #[test]
    fn parent_cycle_is_rejected() {
        let [a, b, c, _] = persons();
        let mut set = RelationshipSet::default();
        set.push(Relationship::new(RelationshipType::ParentChild, a, b).unwrap())
            .unwrap();
        set.push(Relationship::new(RelationshipType::ParentChild, b, c).unwrap())
            .unwrap();
        let err = set
            .push(Relationship::new(RelationshipType::ParentChild, c, a).unwrap())
            .unwrap_err();
        assert_eq!(err.code, codes::RELATIONSHIP_CYCLE);
    }

    #[test]
    fn parents_are_sorted() {
        let [a, b, child, _] = persons();
        let mut set = RelationshipSet::default();
        set.push(Relationship::new(RelationshipType::ParentChild, b, child).unwrap())
            .unwrap();
        set.push(Relationship::new(RelationshipType::ParentChild, a, child).unwrap())
            .unwrap();
        let parents: Vec<Uuid> = set
            .parents_of(child)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(parents, expected);
    }

    #[test]
    fn legacy_rows_load_as_manual_and_serialize_unchanged() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let row = Relationship::new(RelationshipType::Spouse, a, b).unwrap();
        let value = serde_json::to_value(&row).unwrap();
        assert!(value.get("origin").is_none());
        assert!(value.get("sourceEventIds").is_none());

        let legacy = serde_json::json!({
            "id": a,
            "type": "PARENT_CHILD",
            "personId": b,
            "relatedPersonId": a,
            "notes": null
        });
        let parsed: Relationship = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.origin, RelationOrigin::Manual);
        assert!(parsed.source_event_ids.is_empty());
    }

    #[test]
    fn derived_rows_serialize_origin_and_sources_and_require_a_source() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let event = Uuid::now_v7();
        let mut row = Relationship::new(RelationshipType::ParentChild, a, b).unwrap();
        row.origin = RelationOrigin::Event;
        row.source_event_ids = vec![event];
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(value["origin"], "EVENT");
        assert_eq!(value["sourceEventIds"][0], event.to_string());

        let mut missing = row.clone();
        missing.source_event_ids.clear();
        let err = missing.validate_row().unwrap_err();
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert_eq!(
            err.params.get("field").map(String::as_str),
            Some("sourceEventIds")
        );
    }
}
