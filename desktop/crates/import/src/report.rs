//! Import report shared by every importer. Contract: design.md §12, ADR-0013.

use gentree_core::person::PersonId;
use serde::{Deserialize, Serialize};

/// Why an incoming person was not added as a new record.
///
/// The value is a stable code, not a message: the UI localises it under
/// `import.conflict.<reason>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictReason {
    /// The existing person carries the same `(source, externalId)` pair.
    ExternalId,
    /// Normalised full name and both date starts match an existing person.
    FioAndDates,
}

/// One incoming person that matched an existing person.
///
/// Only the position in the incoming list, the existing id and a stable reason
/// code are reported: never names, dates or external id values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// 0-based position in the incoming list passed to the dedupe helper.
    pub incoming_index: usize,
    /// Id of the existing person that already covers this record.
    pub existing_id: PersonId,
    pub reason: ConflictReason,
}

/// Outcome of one import run.
///
/// `persons`, `relationships`, `events` and `media` are counts of mapped
/// records. `warnings` carries schema notices (tables and columns the importer
/// does not know), `issues` carries data problems (unparsed dates, unnamed
/// rows, skipped links). `conflicts` is filled by the idempotency helpers.
///
/// The lists never repeat field values, so a report can be logged without
/// leaking personal data.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub persons: usize,
    pub relationships: usize,
    pub events: usize,
    pub media: usize,
    pub warnings: Vec<String>,
    pub issues: Vec<String>,
    pub conflicts: Vec<Conflict>,
}

impl ImportReport {
    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }

    pub(crate) fn issue(&mut self, message: impl Into<String>) {
        self.issues.push(message.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn report_serializes_to_camel_case_codes() {
        let report = ImportReport {
            persons: 1,
            conflicts: vec![Conflict {
                incoming_index: 2,
                existing_id: Uuid::nil(),
                reason: ConflictReason::FioAndDates,
            }],
            ..Default::default()
        };
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["persons"], 1);
        assert_eq!(value["relationships"], 0);
        assert_eq!(value["conflicts"][0]["incomingIndex"], 2);
        assert_eq!(value["conflicts"][0]["reason"], "fioAndDates");
        assert_eq!(
            value["conflicts"][0]["existingId"],
            serde_json::json!(Uuid::nil())
        );
    }
}
