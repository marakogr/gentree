//! AT5/GEDCOM/JSON/ZIP import. Contract: design.md §12, ADR-0013.
//!
//! [`at5`] opens the file read-only, recognises either a real EAV export
//! (`ValuesStr`/`ValuesDates`/`EventDetails`) or a simplified person table, and
//! maps persons, relationships, events and media metadata; anything it does not
//! understand is reported. [`gedcom`] reads GEDCOM 5.5.1 and 7.0 into persons,
//! relationships, events and media metadata, and writes either version.
//! [`exchange`] handles `.gentree.json` (no media bytes) and `.gentree.zip`
//! (full project in the ADR-0009 backup layout). [`export`] writes AT5 and
//! GEDCOM exchange archives with a sibling `.files` folder. [`dedupe`] holds
//! the idempotency helpers.
//!
//! Tests use synthetic fixtures only. The opt-in, ignored diagnostic against a
//! local private baseline prints aggregate counts and never field values.

pub mod at5;
mod at5_export;
pub mod dedupe;
pub mod exchange;
pub mod export;
pub mod gedcom;
pub mod report;

pub use at5::{
    parse_date, plan_at5, plan_at5_with_media_dirs, read_at5, read_at5_bundle,
    read_at5_bundle_with_media_dirs, At5Bundle, At5MediaFile, SOURCE as AT5_SOURCE,
};
pub use dedupe::dedupe_persons;
pub use exchange::{
    export_json, export_zip, import_json, import_zip, ImportBundle, ProjectSnapshotData,
};
pub use export::{export_archive, ExportFormat};
pub use gedcom::SOURCE as GEDCOM_SOURCE;
pub use gedcom::{
    detect_version as detect_gedcom_version, export as export_gedcom,
    export_full as export_gedcom_full, export_versioned as export_gedcom_versioned,
    parse as parse_gedcom, parse_bundle as parse_gedcom_bundle, ExportMedia as GedcomExportMedia,
    ExportReport, GEDCOMReport, GedcomBundle, GedcomVersion,
};
pub use report::{Conflict, ConflictReason, ImportReport};
