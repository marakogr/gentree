//! GEDCOM 5.5.1 and 7.0 reader and writer. Contract: ADR-0019.
//!
//! Parsing is delegated to the [`ged_io`] crate (MIT, 5.5.1 + 7.0, ANSEL and
//! Latin-1 decoding, unknown tags kept in `custom_data`). The domain mapped
//! here is `Person`/`Relationship`/`Event`/`Media`; [`Person::notes`] carries
//! only the genuine `NOTE`/`CONT`/`CONC` text, while everything the domain
//! cannot hold is summarised in [`GEDCOMReport::warnings`] by tag only —
//! warnings never repeat field values, so a report can be logged.
//!
//! [`parse_bundle`] is the full read path: persons, relationships, events and
//! media metadata. Media bytes are hashed but never copied by the parser:
//! `OBJE.FILE` is looked up in `<file>.files` / `<stem>.files` next to the
//! GEDCOM file and in each extra media folder, and each resolved file is
//! returned in [`GedcomBundle::media_files`] so the caller can store the copy.
//! [`parse`] remains the persons-and-relationships wrapper.
//!
//! Export is written line by line instead of through the crate's writer,
//! because GEDCOM cannot represent every domain field and every loss has to
//! reach [`ExportReport`] as a warning. [`export_full`] keeps the historical
//! 5.5.1 output (UTF-8, CRLF, `CONT`/`CONC`, no invented day or header date);
//! [`export_versioned`] adds the 7.0 header (no `CHAR`, no `GEDC.FORM`),
//! unwrapped lines, `CONT` for embedded newlines, pointer-based media records,
//! and sources/citations. The same input always produces the same bytes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use ged_io::encoding::{decode_with_encoding, GedcomEncoding};
use ged_io::types::address::Address;
use ged_io::types::custom::UserDefinedTag;
use ged_io::types::event::detail::Detail;
use ged_io::types::event::Event as GedcomEvent;
use ged_io::types::individual::attribute::detail::AttributeDetail;
use ged_io::types::individual::attribute::IndividualAttribute;
use ged_io::types::individual::gender::GenderType;
use ged_io::types::individual::name::{Name as GedcomName, NameType as GedcomNameType};
use ged_io::types::individual::Individual;
use ged_io::types::multimedia::Multimedia;
use ged_io::types::note::Note as GedcomNote;
use ged_io::types::GedcomData;
use ged_io::{GedcomBuilder, GedcomError};
use gentree_core::date::{days_in_month, CivilDate, DatePrecision, DateQualifier, DateValue};
use gentree_core::error::{codes, AppError};
use gentree_core::event_fields::{
    is_valid_event_detail_key, MAX_EVENT_DETAILS, MAX_EVENT_DETAIL_VALUE,
};
use gentree_core::person::{ExternalId, Gender, Name, NameType, Person, PersonId};
use gentree_core::record::{Citation, Confidence, Event, EventType, Media, Source};
use gentree_core::relationship::{Relationship, RelationshipSet, RelationshipType};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::at5::{guess_mime, parse_date as parse_at5_date, sha256_file, trimmed};

/// Source label stored in [`ExternalId::source`] for ids read from GEDCOM.
pub const SOURCE: &str = "GEDCOM";

/// Vendor tag used by several exporters for the married (or maiden) surname
/// next to the primary `NAME`. It is not standard GEDCOM, but mapping it keeps
/// a second surname instead of dropping it.
const MARRIED_NAME_TAG: &str = "_MARNM";
/// Non-standard patronymic tags used by some Russian exporters.
const PATRONYMIC_TAGS: [&str; 2] = ["_PATR", "PATR"];

/// Prefix of the inline `NOTE` that carries type-specific event details which
/// have no standard GEDCOM tag (ADR-0015). The rest of the line is compact JSON
/// (`key -> string`), so the export round-trips through Gentree while other
/// apps see ordinary, human-readable note text.
const DETAILS_NOTE_PREFIX: &str = "[gentree:details]";
/// Reported when a details note is not a JSON object of strings. The line stays
/// in the description so nothing is silently lost.
const DETAILS_NOTE_WARNING: &str = "gentree details note is not valid JSON; kept as description";
/// Reported when imported detail keys or values fail the generic shape rules.
/// Values are never repeated, so the report stays safe to log.
const DETAILS_ENTRY_WARNING: &str = "invalid event detail entries dropped";

/// Longest payload line the writer emits; GEDCOM 5.5.1 limits a line to 255
/// bytes, the margin leaves room for the level, tag and separator.
const LINE_LIMIT: usize = 200;

const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// GEDCOM specification version the reader recognises and the writer emits.
///
/// The default is 5.5.1 because it is the format every other genealogy
/// application can read; 7.0 is opt-in (ADR-0019). The reader accepts any
/// `7.x` declaration as 7.0, because a later patch or minor release is
/// backward compatible within the major version.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GedcomVersion {
    /// GEDCOM 5.5.1 (1999/2019), the compatibility default.
    #[default]
    V5_5_1,
    /// GEDCOM 7.0, UTF-8-only.
    V7_0,
}

impl GedcomVersion {
    /// Short version label; the 7.0 header writes the `7.0.18` patch explicitly.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::V5_5_1 => "5.5.1",
            Self::V7_0 => "7.0",
        }
    }

    #[must_use]
    pub const fn is_v7(self) -> bool {
        matches!(self, Self::V7_0)
    }
}

/// Outcome of one GEDCOM import.
///
/// `persons` and `relationships` are the counts of mapped records. `warnings`
/// names structures the domain has no field for (tags and record kinds only),
/// `issues` names data problems (unparsed dates, skipped records). Neither list
/// repeats field values.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GEDCOMReport {
    pub persons: usize,
    pub relationships: usize,
    pub warnings: Vec<String>,
    pub issues: Vec<String>,
}

impl GEDCOMReport {
    /// Adds `message` once: the importer reports per tag, not per record, so
    /// repeated records would only produce identical lines.
    fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.warnings.contains(&message) {
            self.warnings.push(message);
        }
    }

    fn issue(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.issues.contains(&message) {
            self.issues.push(message);
        }
    }
}

/// Outcome of one GEDCOM export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub warnings: Vec<String>,
}

impl ExportReport {
    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.warnings.contains(&message) {
            self.warnings.push(message);
        }
    }
}

/// One resolved media entry: the domain record plus the file it came from.
///
/// The parser only reads and hashes the source; copying the bytes into a
/// project is the caller's job. `source` is the absolute path returned by the
/// media-folder search, so it is never persisted or shown in a report.
/// [`Media::person_id`] is already resolved to the created [`Person::id`] when
/// the `OBJE` structure belongs to an individual; a family or top-level
/// structure has no single person and keeps `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GedcomMediaFile {
    pub media: Media,
    pub source: PathBuf,
}

/// Everything one GEDCOM file yields, plus the import report.
///
/// `media` and `media_files` are parallel: the same entries in the same order.
/// The first is the metadata contract shared with AT5, the second adds the
/// resolved source path so the caller can copy the bytes. `report.persons` and
/// `report.relationships` repeat `persons.len()` and `relationships.len()`;
/// events and media have no counter in [`GEDCOMReport`], use the vectors.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GedcomBundle {
    pub persons: Vec<Person>,
    pub relationships: Vec<Relationship>,
    pub events: Vec<Event>,
    pub media: Vec<Media>,
    pub media_files: Vec<GedcomMediaFile>,
    pub report: GEDCOMReport,
    /// Detected specification version; 5.5.1 when the header declares none.
    pub version: GedcomVersion,
}

/// Read only `HEAD.GEDC.VERS` from a GEDCOM file.
///
/// Detection is independent of the parser and of the `HEAD.SOUR.VERS` value
/// (the exporting application version, which also sits at level 2). Unknown or
/// missing versions fall back to [`GedcomVersion::V5_5_1`] so the caller keeps
/// the historical compatibility behaviour; [`parse_bundle`] still reports the
/// declared string when it is neither 5.5.x nor 7.x.
pub fn detect_version(path: &Path) -> Result<GedcomVersion, AppError> {
    let file = file_label(path);
    if !path.is_file() {
        return Err(
            AppError::new(codes::IO_ERROR, "GEDCOM file not found").with_param("file", file)
        );
    }
    let bytes = std::fs::read(path).map_err(|err| {
        AppError::new(
            codes::IO_ERROR,
            format!("cannot read GEDCOM file ({:?})", err.kind()),
        )
        .with_param("file", file.clone())
    })?;
    let text = decode(&bytes).map_err(|message| parse_error(&file, message))?;
    Ok(classify_version(declared_version(&text).as_deref()).unwrap_or_default())
}

/// Reads `HEAD.GEDC.VERS` from decoded text.
///
/// `SOUR` also has a level-2 `VERS`, so the scan only accepts a `VERS` while
/// the last level-1 structure was `GEDC`.
fn declared_version(text: &str) -> Option<String> {
    let mut in_gedc = false;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let mut parts = line.splitn(3, ' ');
        let level = parts.next().unwrap_or_default();
        let tag = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default().trim();
        match level {
            "0" => in_gedc = false,
            "1" => in_gedc = tag == "GEDC",
            "2" if in_gedc && tag == "VERS" && !value.is_empty() => {
                return Some(value.to_owned());
            }
            _ => {}
        }
    }
    None
}

/// Maps a declared version string to the supported subset. A `7.x` minor or
/// patch keeps the 7.0 meaning, and every `5.5.x` keeps the 5.5.1 meaning.
fn classify_version(raw: Option<&str>) -> Option<GedcomVersion> {
    let raw = raw?.trim();
    if raw == "7" || raw.starts_with("7.") {
        Some(GedcomVersion::V7_0)
    } else if raw.starts_with("5.5") {
        Some(GedcomVersion::V5_5_1)
    } else {
        None
    }
}

/// Read a GEDCOM file and map it to persons, relationships, events and media.
///
/// Encoding is taken from `HEAD.CHAR`: UTF-8, ANSEL, ASCII and the two ISO-8859
/// charsets are decoded; any other declared charset, or non-UTF-8 bytes without
/// `CHAR`, is an error instead of mojibake. `BIRT`/`DEAT` map to
/// [`Person::birth`]/[`Person::death`] through the same [`DateValue`] rules as
/// the AT5 importer. `FAM` produces one `SPOUSE` edge per husband/wife pair and
/// one `PARENT_CHILD` edge per parent/child pair.
///
/// Events: every `INDI` event and the `OCCU`/`EDUC`/`RESI` facts become an
/// [`Event`]; `FAM` events (`MARR`, `DIV`, …) are attached to the first spouse
/// (husband, else wife) because the domain [`Event`] has no participants, and
/// that loss is warned about once. Tags the domain enum cannot name keep their
/// GEDCOM tag in [`Event::original_type`] and map to [`EventType::Other`], with
/// one warning per tag. `PLAC` becomes [`Event::place`], `NOTE`/`TYPE`/value
/// become [`Event::description`]; identical events are skipped.
///
/// Media: `OBJE` under `INDI`/`FAM` (including events) and top-level `OBJE`
/// records are resolved through their `FILE`, optionally `FORM`/`TITL`. Each
/// `FILE` is searched in order in `<file>.files` and `<stem>.files` next to the
/// GEDCOM file, then in `extra_media_dirs`; the relative path is tried before
/// its base name. Absolute paths, drive letters, `..` and NUL are refused.
/// Found files become [`Media`] with a sha256 checksum and, for `INDI`
/// structures, the created person's id in [`Media::person_id`]; `FAM` and
/// unreferenced top-level structures stay unlinked. Entries are deduplicated by
/// `(checksum, fileName)`; missing files and refused paths are reported as
/// issues and skipped. Every mapped entry is also returned in
/// [`GedcomBundle::media_files`] together with its resolved source path.
///
/// Errors carry the GEDCOM file name (never an absolute path) in `params.file`
/// and the line in `params.line` where the parser knows it. They are
/// `IMPORT_PARSE_ERROR` for decoding/parsing and `IO_ERROR` for reading the
/// file. Records that cannot be turned into a `Person` at all (no usable name)
/// are reported as issues and skipped.
pub fn parse_bundle(path: &Path, extra_media_dirs: &[PathBuf]) -> Result<GedcomBundle, AppError> {
    let file = file_label(path);
    if !path.is_file() {
        return Err(
            AppError::new(codes::IO_ERROR, "GEDCOM file not found").with_param("file", file)
        );
    }
    let bytes = std::fs::read(path).map_err(|err| {
        AppError::new(
            codes::IO_ERROR,
            format!("cannot read GEDCOM file ({:?})", err.kind()),
        )
        .with_param("file", file.clone())
    })?;
    let text = decode(&bytes).map_err(|message| parse_error(&file, message))?;
    let data = parse_text(&text, &file)?;

    let mut report = GEDCOMReport::default();
    let declared = declared_version(&text);
    let version = match classify_version(declared.as_deref()) {
        Some(version) => version,
        None => match declared {
            Some(version) => {
                report.warn(format!(
                    "GEDCOM version {version}; imported with 5.5.1 rules"
                ));
                GedcomVersion::V5_5_1
            }
            None => {
                report.warn("no HEAD.GEDC.VERS; assuming GEDCOM 5.5.1");
                GedcomVersion::V5_5_1
            }
        },
    };
    report_unmapped_records(&data, &mut report);
    if version.is_v7() {
        report_unmapped_v7(&data, &mut report);
    }

    let mut persons: Vec<Person> = Vec::with_capacity(data.individuals.len());
    let mut by_xref: HashMap<String, PersonId> = HashMap::new();
    let mut events: Vec<Event> = Vec::new();
    for (index, individual) in data.individuals.iter().enumerate() {
        let Some(person) = convert_individual(&data, individual, index + 1, version, &mut report)
        else {
            continue;
        };
        if let Some(xref) = individual.xref.as_deref() {
            by_xref.insert(xref.to_owned(), person.id);
        }
        convert_individual_events(&data, individual, person.id, &mut events, &mut report);
        persons.push(person);
    }

    let relationships = convert_families(&data, &by_xref, &mut events, &mut report);
    let media_files = convert_media(
        &data,
        &by_xref,
        &media_roots(path, extra_media_dirs),
        &mut report,
    );
    let media = media_files
        .iter()
        .map(|entry| entry.media.clone())
        .collect::<Vec<_>>();

    report.persons = persons.len();
    report.relationships = relationships.len();
    Ok(GedcomBundle {
        persons,
        relationships,
        events,
        media,
        media_files,
        report,
        version,
    })
}

/// Read a GEDCOM file and map it to persons and relationships.
///
/// Thin compatibility wrapper over [`parse_bundle`], which also returns events
/// and media. It keeps the historical `String` error for callers that only
/// display one message.
pub fn parse(path: &Path) -> Result<(Vec<Person>, Vec<Relationship>, GEDCOMReport), String> {
    match parse_bundle(path, &[]) {
        Ok(bundle) => Ok((bundle.persons, bundle.relationships, bundle.report)),
        Err(error) => Err(format!("{}: {}", error.code, error.message)),
    }
}

/// One media entry prepared by the archive writer: the domain row and the file
/// name it has inside `<stem>.files`.
#[derive(Debug, Clone, Copy)]
pub struct ExportMedia<'a> {
    pub media: &'a Media,
    pub file_name: &'a str,
}

/// Write `persons` and `relationships` as GEDCOM 5.5.1 UTF-8.
///
/// Legacy entry point without events or media. It refuses an unnamed person;
/// [`export_full`] allows one and reports it, because an archive export must not
/// fail on a person the domain explicitly permits.
pub fn export(
    persons: &[Person],
    relationships: &[Relationship],
    path: &Path,
) -> Result<ExportReport, String> {
    if persons.iter().any(|person| {
        person
            .names
            .iter()
            .all(|name| name.display().trim().is_empty())
    }) {
        return Err("person without a name cannot be exported to GEDCOM".to_owned());
    }
    export_full(persons, relationships, &[], &[], path)
}

/// Write a project snapshot as GEDCOM 5.5.1 UTF-8 with events and media.
///
/// Everything the format cannot represent (patronymics, notes on parent-child
/// relationships, adoptive parentage, extra event participants, relations to
/// persons outside the export) is reported in [`ExportReport::warnings`];
/// nothing is dropped silently. Media names are relative to the caller's
/// `<stem>.files` folder; this writer only writes the `OBJE` links.
pub fn export_full(
    persons: &[Person],
    relationships: &[Relationship],
    events: &[Event],
    media: &[ExportMedia<'_>],
    path: &Path,
) -> Result<ExportReport, String> {
    export_versioned(
        persons,
        relationships,
        events,
        media,
        &[],
        &[],
        GedcomVersion::V5_5_1,
        path,
    )
}

/// Write a project snapshot as GEDCOM in `version`.
///
/// GEDCOM 7.0 differs structurally from 5.5.1 (ADR-0019): the header declares
/// `GEDC.VERS 7.0.18` and omits `CHAR`/`GEDC.FORM`, lines are never wrapped,
/// `CONT` preserves embedded newlines, text keeps a leading `@` escaped, media
/// are records linked by pointer instead of inline `OBJE.FILE`, and
/// sources/citations are written.
/// The 5.5.1 output is byte-for-byte the same as before; sources and citations
/// are accepted but ignored there, because the existing archive exporter
/// already reports them as not included.
#[allow(clippy::too_many_arguments)]
pub fn export_versioned(
    persons: &[Person],
    relationships: &[Relationship],
    events: &[Event],
    media: &[ExportMedia<'_>],
    sources: &[Source],
    citations: &[Citation],
    version: GedcomVersion,
    path: &Path,
) -> Result<ExportReport, String> {
    let mut report = ExportReport::default();
    let mut by_id: HashMap<PersonId, &Person> = HashMap::with_capacity(persons.len());
    let mut xrefs: HashMap<PersonId, String> = HashMap::with_capacity(persons.len());
    for (index, person) in persons.iter().enumerate() {
        if by_id.insert(person.id, person).is_some() {
            return Err("duplicate person id in the export set".to_owned());
        }
        if person
            .names
            .iter()
            .all(|name| name.display().trim().is_empty())
        {
            report.warn("unnamed person exported without NAME; some readers may skip it");
        }
        xrefs.insert(person.id, format!("@I{}@", index + 1));
    }

    let (parents_of, spouse_pairs) = collect_edges(relationships, &by_id, &mut report);
    let mut families: Vec<FamilyRecord> = Vec::new();
    let mut family_index: HashMap<FamilyKey, usize> = HashMap::new();

    for person in persons {
        let Some(parents) = parents_of.get(&person.id) else {
            continue;
        };
        if parents.len() == 2 && spouse_pairs.contains(&ordered_pair(parents[0], parents[1])) {
            let pair = ordered_pair(parents[0], parents[1]);
            let key = FamilyKey::Couple(pair.0, pair.1);
            let slot = family_slot(&mut families, &mut family_index, key, parents.clone());
            families[slot].children.push(person.id);
        } else {
            // A family record with two parents implies a union in GEDCOM.
            // Co-parents that are not spouses get one record each, so the
            // export does not invent a spouse edge.
            for parent in parents {
                let slot = family_slot(
                    &mut families,
                    &mut family_index,
                    FamilyKey::Single(*parent),
                    vec![*parent],
                );
                families[slot].children.push(person.id);
            }
        }
    }
    for pair in &spouse_pairs {
        family_slot(
            &mut families,
            &mut family_index,
            FamilyKey::Couple(pair.0, pair.1),
            vec![pair.0, pair.1],
        );
    }

    for relationship in relationships {
        if !relationship.rel_type.is_spouse() || !by_id.contains_key(&relationship.person_id) {
            continue;
        }
        let notes = relationship
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty());
        let Some(notes) = notes else { continue };
        let pair = ordered_pair(relationship.person_id, relationship.related_person_id);
        match family_index.get(&FamilyKey::Couple(pair.0, pair.1)) {
            Some(slot) => families[*slot].notes.push(notes.to_owned()),
            None => report
                .warn("note on a spouse relationship could not be attached to a family record"),
        }
    }

    let mut spouse_families: HashMap<PersonId, Vec<usize>> = HashMap::new();
    let mut child_families: HashMap<PersonId, Vec<usize>> = HashMap::new();
    for (index, family) in families.iter().enumerate() {
        for parent in &family.parents {
            spouse_families.entry(*parent).or_default().push(index);
        }
        for child in &family.children {
            child_families.entry(*child).or_default().push(index);
        }
    }

    // Birth/death structures absorb the matching event's place and description;
    // marriage/divorce structures belong to the family record when the pair is
    // known. Every other event is attached to its owning person.
    let mut birth_events: HashMap<PersonId, &Event> = HashMap::new();
    let mut death_events: HashMap<PersonId, &Event> = HashMap::new();
    let mut person_events: HashMap<PersonId, Vec<&Event>> = HashMap::new();
    let mut family_events: HashMap<usize, Vec<&Event>> = HashMap::new();
    for event in events {
        if !by_id.contains_key(&event.person_id) {
            report.warn("event references a person outside the export; skipped");
            continue;
        }
        match event.event_type {
            EventType::Birth => {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    birth_events.entry(event.person_id)
                {
                    entry.insert(event);
                } else {
                    report
                        .warn("a person has more than one birth event; only the first is exported");
                }
            }
            EventType::Death => {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    death_events.entry(event.person_id)
                {
                    entry.insert(event);
                } else {
                    report
                        .warn("a person has more than one death event; only the first is exported");
                }
            }
            EventType::Marriage | EventType::Divorce => {
                let partner = event
                    .participant_ids
                    .iter()
                    .find(|participant| by_id.contains_key(participant))
                    .copied();
                if event.participant_ids.len() > 1 {
                    report.warn("event participants beyond the first are not exported to GEDCOM");
                }
                match partner {
                    Some(partner) => {
                        let pair = ordered_pair(event.person_id, partner);
                        match family_index.get(&FamilyKey::Couple(pair.0, pair.1)) {
                            Some(slot) => {
                                family_events.entry(*slot).or_default().push(event);
                            }
                            None => {
                                person_events
                                    .entry(event.person_id)
                                    .or_default()
                                    .push(event);
                                report.warn(
                                    "a family event has no matching spouse pair; exported as an individual event",
                                );
                            }
                        }
                    }
                    None => {
                        person_events
                            .entry(event.person_id)
                            .or_default()
                            .push(event);
                        report.warn(
                            "a family event has no matching spouse pair; exported as an individual event",
                        );
                    }
                }
            }
            _ => {
                if !event.participant_ids.is_empty() {
                    report.warn("co-participants of non-family events are not exported to GEDCOM");
                }
                person_events
                    .entry(event.person_id)
                    .or_default()
                    .push(event);
            }
        }
    }

    // Type-specific details are written as standard tags where one exists and
    // otherwise in one machine-readable NOTE per event (ADR-0015), so the
    // export no longer warns about them.

    let mut media_by_person: HashMap<PersonId, Vec<usize>> = HashMap::new();
    let mut unlinked_media: Vec<usize> = Vec::new();
    for (index, item) in media.iter().enumerate() {
        match item.media.person_id {
            Some(person_id) if by_id.contains_key(&person_id) => {
                media_by_person.entry(person_id).or_default().push(index);
            }
            Some(_) => {
                report.warn("media linked to a person outside the export; exported without a link");
                unlinked_media.push(index);
            }
            None => unlinked_media.push(index),
        }
        if item.media.primary {
            report.warn("profile photo flags are not exported to GEDCOM");
        }
    }

    // Sources and citations are only representable in the 7.0 writer; the
    // archive exporter already warns that the 5.5.1 export omits them.
    let source_xrefs: HashMap<Uuid, String> = if version.is_v7() {
        sources
            .iter()
            .enumerate()
            .map(|(index, source)| (source.id, format!("@S{}@", index + 1)))
            .collect()
    } else {
        HashMap::new()
    };
    let citations_by_target: HashMap<Uuid, Vec<&Citation>> = if version.is_v7() {
        let mut map: HashMap<Uuid, Vec<&Citation>> = HashMap::new();
        for citation in citations {
            map.entry(citation.target_id).or_default().push(citation);
        }
        map
    } else {
        HashMap::new()
    };
    if version.is_v7() && sources.iter().any(|source| source.repository.is_some()) {
        report.warn(
            "source repositories have no GEDCOM 7.0 record in this export; repository text omitted",
        );
    }

    // Citations on a family are written under the FAM record. A spouse edge
    // maps directly; a parent-child edge is attached to the family that holds
    // both people, because GEDCOM has no citation on an individual FAMC link.
    let mut family_citations: HashMap<usize, Vec<&Citation>> = HashMap::new();
    if version.is_v7() {
        for relationship in relationships {
            let Some(rows) = citations_by_target.get(&relationship.id) else {
                continue;
            };
            if !by_id.contains_key(&relationship.person_id)
                || !by_id.contains_key(&relationship.related_person_id)
            {
                continue;
            }
            let slot = if relationship.rel_type.is_spouse() {
                let pair = ordered_pair(relationship.person_id, relationship.related_person_id);
                family_index
                    .get(&FamilyKey::Couple(pair.0, pair.1))
                    .copied()
            } else {
                families.iter().position(|family| {
                    family.parents.contains(&relationship.person_id)
                        && family.children.contains(&relationship.related_person_id)
                })
            };
            match slot {
                Some(slot) => family_citations
                    .entry(slot)
                    .or_default()
                    .extend(rows.iter().copied()),
                None => report
                    .warn("a relationship citation has no family record in the export; omitted"),
            }
        }
    }

    let mut out = String::new();
    write_head(&mut out, version);
    for person in persons {
        let xref = &xrefs[&person.id];
        line(&mut out, 0, &format!("{xref} INDI"), None);
        write_names(&mut out, person, version, &mut report);
        match person.gender {
            Gender::Male => line(&mut out, 1, "SEX", Some("M")),
            Gender::Female => line(&mut out, 1, "SEX", Some("F")),
            Gender::Unknown => {}
        }
        write_person_event(
            &mut out,
            "BIRT",
            &person.birth,
            birth_events.get(&person.id).copied(),
            &source_xrefs,
            &citations_by_target,
            version,
            &mut report,
        );
        write_person_event(
            &mut out,
            "DEAT",
            &person.death,
            death_events.get(&person.id).copied(),
            &source_xrefs,
            &citations_by_target,
            version,
            &mut report,
        );
        for external in &person.external_ids {
            let value = single_line(&external.value);
            if value.is_empty() {
                report.warn("empty external id omitted");
                continue;
            }
            line(&mut out, 1, "REFN", Some(&value));
            let source = single_line(&external.source);
            if !source.is_empty() {
                line(&mut out, 2, "TYPE", Some(&source));
            }
        }
        if let Some(notes) = person
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            write_text(&mut out, 1, "NOTE", notes, version, &mut report);
        }
        write_citations(
            &mut out,
            1,
            person.id,
            &source_xrefs,
            &citations_by_target,
            version,
            &mut report,
        );
        for event in person_events.get(&person.id).into_iter().flatten() {
            write_event(
                &mut out,
                1,
                event,
                &source_xrefs,
                &citations_by_target,
                version,
                &mut report,
            );
        }
        for index in media_by_person.get(&person.id).into_iter().flatten() {
            if version.is_v7() {
                line(&mut out, 1, "OBJE", Some(&format!("@M{}@", index + 1)));
            } else {
                write_media(&mut out, 1, &media[*index], None);
            }
        }
        for index in spouse_families.get(&person.id).into_iter().flatten() {
            let family = format!("@F{}@", index + 1);
            line(&mut out, 1, "FAMS", Some(&family));
        }
        for index in child_families.get(&person.id).into_iter().flatten() {
            let family = format!("@F{}@", index + 1);
            line(&mut out, 1, "FAMC", Some(&family));
        }
    }
    for (index, family) in families.iter().enumerate() {
        line(&mut out, 0, &format!("@F{}@ FAM", index + 1), None);
        let (husband, wife) = spouse_roles(&family.parents, &by_id, &mut report);
        if let Some(id) = husband {
            line(&mut out, 1, "HUSB", Some(&xrefs[&id]));
        }
        if let Some(id) = wife {
            line(&mut out, 1, "WIFE", Some(&xrefs[&id]));
        }
        for child in &family.children {
            line(&mut out, 1, "CHIL", Some(&xrefs[child]));
        }
        for notes in &family.notes {
            write_text(&mut out, 1, "NOTE", notes, version, &mut report);
        }
        for citation in family_citations.get(&index).into_iter().flatten() {
            write_citation(&mut out, 1, citation, &source_xrefs, version, &mut report);
        }
        for event in family_events.get(&index).into_iter().flatten() {
            write_event(
                &mut out,
                1,
                event,
                &source_xrefs,
                &citations_by_target,
                version,
                &mut report,
            );
        }
    }
    if version.is_v7() {
        for source in sources {
            write_source(&mut out, source, &source_xrefs, version, &mut report);
        }
        for (index, item) in media.iter().enumerate() {
            write_media_record(
                &mut out,
                index + 1,
                item,
                &source_xrefs,
                &citations_by_target,
                version,
                &mut report,
            );
        }
    } else {
        for index in &unlinked_media {
            write_media(&mut out, 0, &media[*index], Some(index + 1));
        }
    }
    out.push_str("0 TRLR\r\n");

    std::fs::write(path, out.as_bytes())
        .map_err(|err| format!("cannot write GEDCOM file: {err}"))?;
    Ok(report)
}

/// `BIRT`/`DEAT` with the person's date, enriched by the matching event.
#[allow(clippy::too_many_arguments)]
fn write_person_event(
    out: &mut String,
    tag: &str,
    date: &DateValue,
    event: Option<&Event>,
    source_xrefs: &HashMap<Uuid, String>,
    citations_by_target: &HashMap<Uuid, Vec<&Citation>>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    let has_value = date.precision != DatePrecision::Unknown || has_original(date);
    if !has_value && event.is_none() {
        return;
    }
    line(out, 1, tag, None);
    let value = if has_value {
        date
    } else {
        event.map(|event| &event.date).unwrap_or(date)
    };
    write_event_date(out, 1, value, version, report);
    if let Some(event) = event {
        write_event_details(out, 2, event, version, report);
        write_citations(
            out,
            2,
            event.id,
            source_xrefs,
            citations_by_target,
            version,
            report,
        );
        write_event_source_ids(
            out,
            2,
            event,
            source_xrefs,
            citations_by_target,
            version,
            report,
        );
    }
}

/// Event rows that link a source without a `Citation` record still need a
/// `SOUR` line; a citation for the same source already carries the page and
/// confidence, so it is not duplicated.
#[allow(clippy::too_many_arguments)]
fn write_event_source_ids(
    out: &mut String,
    level: usize,
    event: &Event,
    source_xrefs: &HashMap<Uuid, String>,
    citations_by_target: &HashMap<Uuid, Vec<&Citation>>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    if !version.is_v7() || event.source_ids.is_empty() {
        return;
    }
    let covered: HashSet<Uuid> = citations_by_target
        .get(&event.id)
        .into_iter()
        .flatten()
        .map(|citation| citation.source_id)
        .collect();
    for source_id in &event.source_ids {
        if covered.contains(source_id) {
            continue;
        }
        match source_xrefs.get(source_id) {
            Some(xref) => line(out, level, "SOUR", Some(xref)),
            None => report.warn("event source is outside the export; omitted"),
        }
    }
}

/// One event below an `INDI` or `FAM` structure.
#[allow(clippy::too_many_arguments)]
fn write_event(
    out: &mut String,
    level: usize,
    event: &Event,
    source_xrefs: &HashMap<Uuid, String>,
    citations_by_target: &HashMap<Uuid, Vec<&Citation>>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    let tag = gedcom_event_tag(event);
    match event_tag_value(event) {
        Some(value) => write_text(out, level, tag, &value, version, report),
        None => line(out, level, tag, None),
    }
    if event.event_type == EventType::Other && (tag == "EVEN" || tag.starts_with('_')) {
        if let Some(original) = trimmed(event.original_type.as_deref()) {
            write_text(
                out,
                level + 1,
                "TYPE",
                &single_line(&original),
                version,
                report,
            );
        }
    }
    write_event_date(out, level, &event.date, version, report);
    write_event_details(out, level + 1, event, version, report);
    write_citations(
        out,
        level + 1,
        event.id,
        source_xrefs,
        citations_by_target,
        version,
        report,
    );
    write_event_source_ids(
        out,
        level + 1,
        event,
        source_xrefs,
        citations_by_target,
        version,
        report,
    );
}

fn write_event_date(
    out: &mut String,
    level: usize,
    date: &DateValue,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    if date.precision == DatePrecision::Unknown && !has_original(date) {
        return;
    }
    match format_gedcom_date(date) {
        Some(text) => write_text(out, level + 1, "DATE", &text, version, report),
        None => report.warn("event date has no GEDCOM representation; omitted"),
    }
}

fn has_original(date: &DateValue) -> bool {
    date.original
        .as_deref()
        .map(str::trim)
        .is_some_and(|text| !text.is_empty())
}

fn write_event_details(
    out: &mut String,
    level: usize,
    event: &Event,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    if let Some(place) = trimmed(event.place.as_deref()) {
        write_text(out, level, "PLAC", &single_line(&place), version, report);
    }
    // Details with a standard tag stay visible to other apps; whatever is left
    // travels in one machine-readable NOTE so Gentree round-trips its export.
    let mut remaining = event.details.clone();
    for &(key, tag) in standard_detail_tags(event.event_type) {
        if let Some(value) = trimmed(remaining.get(key).map(String::as_str)) {
            write_text(out, level, tag, &value, version, report);
            remaining.remove(key);
        }
    }
    if let Some(key) = event_tag_value_key(event.event_type) {
        if event_tag_value(event).is_some() {
            remaining.remove(key);
        }
    }
    if let Some(description) = trimmed(event.description.as_deref()) {
        write_text(out, level, "NOTE", &description, version, report);
    }
    if !remaining.is_empty() {
        if let Ok(payload) = serde_json::to_string(&remaining) {
            write_text(
                out,
                level,
                "NOTE",
                &format!("{DETAILS_NOTE_PREFIX} {payload}"),
                version,
                report,
            );
        }
    }
}

/// Standard GEDCOM child tags for details that have one, per event type. Keys
/// written as the event's own tag value are covered by [`event_tag_value_key`].
fn standard_detail_tags(event_type: EventType) -> &'static [(&'static str, &'static str)] {
    match event_type {
        EventType::Birth => &[("hospital", "ADDR")],
        EventType::Death => &[("cause", "CAUS")],
        EventType::Marriage => &[("marriage_rite", "TYPE"), ("officiant", "AGNC")],
        EventType::Divorce => &[("reason", "CAUS"), ("court", "AGNC")],
        EventType::Burial => &[("cemetery", "ADDR")],
        EventType::Residence => &[("address", "ADDR")],
        EventType::Occupation => &[("employer", "AGNC")],
        EventType::Education | EventType::Other => &[],
    }
}

/// The detail written as the event's own tag value (`1 OCCU ...`, `1 EDUC ...`).
fn event_tag_value_key(event_type: EventType) -> Option<&'static str> {
    match event_type {
        EventType::Occupation => Some("position"),
        EventType::Education => Some("qualification"),
        _ => None,
    }
}

fn event_tag_value(event: &Event) -> Option<String> {
    let key = event_tag_value_key(event.event_type)?;
    trimmed(event.details.get(key).map(String::as_str))
}

fn gedcom_event_tag(event: &Event) -> &str {
    match event.event_type {
        EventType::Birth => "BIRT",
        EventType::Death => "DEAT",
        EventType::Marriage => "MARR",
        EventType::Divorce => "DIV",
        EventType::Burial => "BURI",
        EventType::Residence => "RESI",
        EventType::Occupation => "OCCU",
        EventType::Education => "EDUC",
        EventType::Other => event
            .original_type
            .as_deref()
            .map(str::trim)
            .filter(|tag| valid_gedcom_tag(tag))
            .unwrap_or("EVEN"),
    }
}

fn valid_gedcom_tag(tag: &str) -> bool {
    let mut characters = tag.chars();
    match characters.next() {
        Some(first) if first.is_ascii_uppercase() || first == '_' => {}
        _ => return false,
    }
    tag.len() <= 64
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn write_media(out: &mut String, level: usize, item: &ExportMedia<'_>, record: Option<usize>) {
    match record {
        Some(number) => line(out, level, &format!("@M{number}@ OBJE"), None),
        None => line(out, level, "OBJE", None),
    }
    let field = level + 1;
    write_text_551(out, field, "FILE", item.file_name);
    if let Some(extension) = Path::new(item.file_name)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        line(out, field, "FORM", Some(&extension.to_ascii_uppercase()));
    }
    if let Some(caption) = trimmed(item.media.caption.as_deref()) {
        write_text_551(out, field, "TITL", &caption);
    }
}

/// One `MULTIMEDIA_RECORD` for GEDCOM 7.0.
///
/// 7.0 removed the inline `OBJE.FILE` form; a media row must be a record that
/// other structures point at. `FORM` is mandatory and takes a media type, not
/// the 5.5.1 file extension.
fn write_media_record(
    out: &mut String,
    number: usize,
    item: &ExportMedia<'_>,
    source_xrefs: &HashMap<Uuid, String>,
    citations_by_target: &HashMap<Uuid, Vec<&Citation>>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    line(out, 0, &format!("@M{number}@ OBJE"), None);
    write_text(out, 1, "FILE", item.file_name, GedcomVersion::V7_0, report);
    let mime = single_line(&item.media.mime_type);
    if mime.is_empty() {
        report.warn("media without a media type; GEDCOM 7.0 FORM omitted");
    } else {
        line(out, 2, "FORM", Some(&mime));
    }
    if let Some(caption) = trimmed(item.media.caption.as_deref()) {
        write_text(out, 2, "TITL", &caption, GedcomVersion::V7_0, report);
    }
    if let Some(source_id) = item.media.source_id {
        match source_xrefs.get(&source_id) {
            Some(xref) => line(out, 1, "SOUR", Some(xref)),
            None => report.warn("media source is outside the export; omitted"),
        }
    }
    write_citations(
        out,
        1,
        item.media.id,
        source_xrefs,
        citations_by_target,
        version,
        report,
    );
}

/// One `SOURCE_RECORD` for GEDCOM 7.0.
fn write_source(
    out: &mut String,
    source: &Source,
    xrefs: &HashMap<Uuid, String>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    let Some(xref) = xrefs.get(&source.id) else {
        return;
    };
    line(out, 0, &format!("{xref} SOUR"), None);
    let title = single_line(&source.title);
    if title.is_empty() {
        report.warn("source without a title; GEDCOM 7.0 TITL omitted");
    } else {
        write_text(out, 1, "TITL", &title, version, report);
    }
    if let Some(author) = source.author.as_deref().map(single_line) {
        if !author.is_empty() {
            write_text(out, 1, "AUTH", &author, version, report);
        }
    }
    if let Some(publication) = source.publication.as_deref().map(single_line) {
        if !publication.is_empty() {
            write_text(out, 1, "PUBL", &publication, version, report);
        }
    }
    if let Some(url) = source.url.as_deref().map(single_line) {
        if !url.is_empty() {
            line(out, 1, "WWW", Some(&url));
        }
    }
    if let Some(notes) = trimmed(source.notes.as_deref()) {
        write_text(out, 1, "NOTE", &notes, version, report);
    }
}

/// Every citation attached to `target`, if the 7.0 writer is active.
#[allow(clippy::too_many_arguments)]
fn write_citations(
    out: &mut String,
    level: usize,
    target: Uuid,
    source_xrefs: &HashMap<Uuid, String>,
    citations_by_target: &HashMap<Uuid, Vec<&Citation>>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    if !version.is_v7() {
        return;
    }
    for citation in citations_by_target.get(&target).into_iter().flatten() {
        write_citation(out, level, citation, source_xrefs, version, report);
    }
}

fn write_citation(
    out: &mut String,
    level: usize,
    citation: &Citation,
    source_xrefs: &HashMap<Uuid, String>,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    if !version.is_v7() {
        return;
    }
    let Some(xref) = source_xrefs.get(&citation.source_id) else {
        report.warn("citation references a source outside the export; omitted");
        return;
    };
    line(out, level, "SOUR", Some(xref));
    if let Some(page) = trimmed(citation.page.as_deref()) {
        write_text(out, level + 1, "PAGE", &page, version, report);
    }
    if let Some(confidence) = citation.confidence {
        let value = match confidence {
            Confidence::Low => "1",
            Confidence::Medium => "2",
            Confidence::High => "3",
        };
        line(out, level + 1, "QUAY", Some(value));
    }
}

/// One `FAM` record under construction.
struct FamilyRecord {
    parents: Vec<PersonId>,
    children: Vec<PersonId>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum FamilyKey {
    Couple(PersonId, PersonId),
    Single(PersonId),
}

fn family_slot(
    families: &mut Vec<FamilyRecord>,
    index: &mut HashMap<FamilyKey, usize>,
    key: FamilyKey,
    parents: Vec<PersonId>,
) -> usize {
    if let Some(existing) = index.get(&key) {
        return *existing;
    }
    let position = families.len();
    families.push(FamilyRecord {
        parents,
        children: Vec::new(),
        notes: Vec::new(),
    });
    index.insert(key, position);
    position
}

fn ordered_pair(a: PersonId, b: PersonId) -> (PersonId, PersonId) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Parent edges per child and the distinct spouse pairs, in input order.
type ParentMap = HashMap<PersonId, Vec<PersonId>>;
type SpousePairs = Vec<(PersonId, PersonId)>;

fn collect_edges(
    relationships: &[Relationship],
    by_id: &HashMap<PersonId, &Person>,
    report: &mut ExportReport,
) -> (ParentMap, SpousePairs) {
    let mut parents_of: ParentMap = HashMap::new();
    let mut spouse_pairs: SpousePairs = Vec::new();
    for relationship in relationships {
        if !by_id.contains_key(&relationship.person_id)
            || !by_id.contains_key(&relationship.related_person_id)
        {
            report.warn("relationship references a person outside the export; skipped");
            continue;
        }
        if relationship.rel_type.is_spouse() {
            if relationship.rel_type == RelationshipType::Partner {
                report.warn(
                    "partner relationships are exported as spouse edges; GEDCOM 5.5.1 has no partner type",
                );
            }
            let pair = ordered_pair(relationship.person_id, relationship.related_person_id);
            if !spouse_pairs.contains(&pair) {
                spouse_pairs.push(pair);
            }
            continue;
        }
        if relationship.rel_type == RelationshipType::AdoptiveParentChild {
            report.warn(
                "adoptive parent-child relationship exported as parent-child (PEDI not written)",
            );
        }
        let notes = relationship
            .notes
            .as_deref()
            .map(str::trim)
            .is_some_and(|notes| !notes.is_empty());
        if notes {
            report.warn(
                "note on a parent-child relationship cannot be represented in GEDCOM; omitted",
            );
        }
        let parents = parents_of
            .entry(relationship.related_person_id)
            .or_default();
        if !parents.contains(&relationship.person_id) {
            parents.push(relationship.person_id);
        }
    }
    (parents_of, spouse_pairs)
}

fn write_head(out: &mut String, version: GedcomVersion) {
    line(out, 0, "HEAD", None);
    line(out, 1, "SOUR", Some("GENTREE"));
    line(out, 2, "VERS", Some(env!("CARGO_PKG_VERSION")));
    line(out, 1, "GEDC", None);
    match version {
        // 7.0.18: a semantic version. Readers treat every 7.x as 7.0.
        GedcomVersion::V7_0 => line(out, 2, "VERS", Some("7.0.18")),
        GedcomVersion::V5_5_1 => line(out, 2, "VERS", Some("5.5.1")),
    }
    if version.is_v7() {
        // 7.0 removed GEDC.FORM and HEAD.CHAR: UTF-8 is mandatory and the
        // encoding is no longer declared.
    } else {
        line(out, 2, "FORM", Some("LINEAGE-LINKED"));
        line(out, 1, "CHAR", Some("UTF-8"));
    }
}

fn write_names(
    out: &mut String,
    person: &Person,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    let mut names: Vec<&Name> = person.names.iter().collect();
    if let Some(position) = names.iter().position(|name| name.is_primary) {
        let primary = names.remove(position);
        names.insert(0, primary);
    }
    let mut patronymics = 0usize;
    for name in names {
        let text = name_text(name);
        if text.trim().is_empty() {
            continue;
        }
        write_text(out, 1, "NAME", &text, version, report);
        if name
            .patronymic
            .as_deref()
            .is_some_and(|part| !part.trim().is_empty())
        {
            patronymics += 1;
        }
        let given = [name.given.as_deref(), name.patronymic.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !given.is_empty() {
            write_text(out, 2, "GIVN", &given, version, report);
        }
        if let Some(surname) = trimmed(name.surname.as_deref()) {
            write_text(out, 2, "SURN", &surname, version, report);
        }
        if let Some(prefix) = trimmed(name.prefix.as_deref()) {
            write_text(out, 2, "NPFX", &single_line(&prefix), version, report);
        }
        if let Some(suffix) = trimmed(name.suffix.as_deref()) {
            write_text(out, 2, "NSFX", &single_line(&suffix), version, report);
        }
        match name.name_type {
            NameType::Birth => {}
            NameType::Married => line(out, 2, "TYPE", Some("MARRIED")),
            NameType::Religious => line(out, 2, "TYPE", Some("RELIGIOUS")),
            NameType::Other => line(out, 2, "TYPE", Some("OTHER")),
        }
    }
    if patronymics > 0 {
        report.warn(format!(
            "{patronymics} name(s) have a patronymic; exported inside the given name"
        ));
    }
}

fn name_text(name: &Name) -> String {
    let mut parts = String::new();
    if let Some(prefix) = trimmed(name.prefix.as_deref()) {
        parts.push_str(&single_line(&prefix));
        parts.push(' ');
    }
    if let Some(given) = trimmed(name.given.as_deref()) {
        parts.push_str(&single_line(&given));
        parts.push(' ');
    }
    if let Some(patronymic) = trimmed(name.patronymic.as_deref()) {
        parts.push_str(&single_line(&patronymic));
        parts.push(' ');
    }
    if let Some(surname) = trimmed(name.surname.as_deref()) {
        parts.push('/');
        parts.push_str(&single_line(&surname));
        parts.push('/');
    }
    if let Some(suffix) = trimmed(name.suffix.as_deref()) {
        parts.push(' ');
        parts.push_str(&single_line(&suffix));
    }
    parts.trim().to_owned()
}

fn spouse_roles(
    parents: &[PersonId],
    by_id: &HashMap<PersonId, &Person>,
    report: &mut ExportReport,
) -> (Option<PersonId>, Option<PersonId>) {
    match parents {
        [] => (None, None),
        [only] => match by_id.get(only).map(|person| person.gender) {
            Some(Gender::Female) => (None, Some(*only)),
            _ => (Some(*only), None),
        },
        [a, b, ..] => {
            if parents.len() > 2 {
                report.warn("family with more than two parents exported with the first two");
            }
            match (
                by_id.get(a).map(|person| person.gender),
                by_id.get(b).map(|person| person.gender),
            ) {
                (Some(Gender::Female), _) => (Some(*b), Some(*a)),
                (_, Some(Gender::Female)) => (Some(*a), Some(*b)),
                (Some(Gender::Male), Some(Gender::Male)) => {
                    report.warn("same-sex couple exported with HUSB/WIFE roles");
                    (Some(*a), Some(*b))
                }
                _ => (Some(*a), Some(*b)),
            }
        }
    }
}

fn line(out: &mut String, level: usize, tag: &str, value: Option<&str>) {
    let _ = write!(out, "{level} {tag}");
    if let Some(value) = value {
        if !value.is_empty() {
            out.push(' ');
            out.push_str(value);
        }
    }
    out.push_str("\r\n");
}

/// Writes a payload according to the target version.
///
/// 5.5.1 keeps the historical line wrapping: `CONT` for embedded newlines and
/// `CONC` for over-long lines. 7.0 removed `CONC` and the line-length limit,
/// so a long value stays on one line and embedded newlines (including blank
/// ones) use `CONT`, the structure 7.0 kept for multi-line values.
fn write_text(
    out: &mut String,
    level: usize,
    tag: &str,
    text: &str,
    version: GedcomVersion,
    report: &mut ExportReport,
) {
    match version {
        GedcomVersion::V5_5_1 => write_text_551(out, level, tag, text),
        GedcomVersion::V7_0 => write_text_v7(out, level, tag, text, report),
    }
}

/// Historical 5.5.1 form; kept verbatim so existing exports do not change.
fn write_text_551(out: &mut String, level: usize, tag: &str, text: &str) {
    let continuation = level + 1;
    for (index, segment) in text.split('\n').enumerate() {
        let segment = segment.strip_suffix('\r').unwrap_or(segment);
        if index == 0 {
            write_wrapped(out, level, tag, continuation, segment);
        } else {
            write_wrapped(out, continuation, "CONT", continuation, segment);
        }
    }
}

/// GEDCOM 7.0 form: one physical line per value line, no `CONC`, and `CONT`
/// for every embedded newline so blank lines survive.
fn write_text_v7(
    out: &mut String,
    level: usize,
    tag: &str,
    text: &str,
    _report: &mut ExportReport,
) {
    if text.is_empty() {
        return;
    }
    let mut segments = text
        .split('\n')
        .map(|line_text| line_text.strip_suffix('\r').unwrap_or(line_text));
    let first = segments.next().unwrap_or_default();
    line(out, level, tag, Some(&escape_leading_at(first)));
    for segment in segments {
        let value = escape_leading_at(segment);
        line(
            out,
            level + 1,
            "CONT",
            if value.is_empty() { None } else { Some(&value) },
        );
    }
}

/// A 7.0 line value that starts with `@` must double that `@`; later `@` are
/// literal. 5.5.1 text is written as-is by the historical path.
fn escape_leading_at(value: &str) -> String {
    match value.strip_prefix('@') {
        Some(rest) => format!("@@{rest}"),
        None => value.to_owned(),
    }
}

/// `tag_level` is the level of `tag` (or `CONT`), `conc_level` the level of the
/// `CONC` lines that continue it; both are children of the same structure.
fn write_wrapped(out: &mut String, tag_level: usize, tag: &str, conc_level: usize, text: &str) {
    let prefix = tag_level.to_string().len() + 1 + tag.len() + 1;
    let limit = LINE_LIMIT.saturating_sub(prefix).max(1);
    let mut rest = text;
    let mut first = true;
    loop {
        let (chunk, remainder) = split_at_char_boundary(rest, limit);
        if first {
            line(out, tag_level, tag, Some(chunk));
        } else {
            line(out, conc_level, "CONC", Some(chunk));
        }
        first = false;
        match remainder {
            Some(remainder) => rest = remainder,
            None => break,
        }
    }
}

fn split_at_char_boundary(text: &str, limit: usize) -> (&str, Option<&str>) {
    if text.len() <= limit {
        return (text, None);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        end = text
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(text.len())
            .min(text.len());
    }
    (&text[..end], Some(&text[end..]))
}

fn single_line(value: &str) -> String {
    value
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/// Decode the raw file bytes according to `HEAD.CHAR` (ADR-0013).
fn decode(bytes: &[u8]) -> Result<String, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec())
            .map_err(|_| "GEDCOM file has a UTF-8 BOM but is not valid UTF-8".to_owned());
    }
    if let Some(encoding) = utf16_bom(bytes) {
        return decode_with_encoding(bytes, encoding)
            .map(|(text, _)| text)
            .map_err(|err| format!("cannot decode GEDCOM file as UTF-16: {err}"));
    }
    match declared_charset(bytes) {
        Some(charset) => decode_declared(bytes, &charset),
        None => String::from_utf8(bytes.to_vec()).map_err(|_| {
            "GEDCOM file declares no HEAD.CHAR and is not valid UTF-8; refusing to guess an encoding"
                .to_owned()
        }),
    }
}

fn utf16_bom(bytes: &[u8]) -> Option<GedcomEncoding> {
    match bytes {
        [0xFF, 0xFE, ..] => Some(GedcomEncoding::Utf16Le),
        [0xFE, 0xFF, ..] => Some(GedcomEncoding::Utf16Be),
        _ => None,
    }
}

/// Reads the ASCII `CHAR` value from the first kilobytes of the file. The
/// bytes are widened one-to-one, so this works for every ASCII-compatible
/// charset without already knowing the charset.
fn declared_charset(bytes: &[u8]) -> Option<String> {
    let sample = &bytes[..bytes.len().min(4096)];
    let text: String = sample.iter().map(|byte| char::from(*byte)).collect();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() == Some("1") && parts.next() == Some("CHAR") {
            return parts.next().map(str::to_owned);
        }
    }
    None
}

fn decode_declared(bytes: &[u8], charset: &str) -> Result<String, String> {
    let normalized = charset.trim().to_ascii_uppercase().replace('_', "-");
    let encoding = match normalized.as_str() {
        "UTF-8" | "UTF8" => GedcomEncoding::Utf8,
        "ANSEL" => GedcomEncoding::Ansel,
        "ASCII" => GedcomEncoding::Ascii,
        "ISO-8859-1" | "ISO8859-1" | "LATIN1" | "LATIN-1" => GedcomEncoding::Iso8859_1,
        "ISO-8859-15" | "ISO8859-15" | "LATIN9" | "LATIN-9" => GedcomEncoding::Iso8859_15,
        "UTF-16" | "UTF16" | "UNICODE" | "UTF-16LE" | "UTF16LE" => GedcomEncoding::Utf16Le,
        "UTF-16BE" | "UTF16BE" => GedcomEncoding::Utf16Be,
        other => return Err(format!("unsupported GEDCOM encoding in HEAD.CHAR: {other}")),
    };
    decode_with_encoding(bytes, encoding)
        .map(|(text, _)| text)
        .map_err(|err| format!("cannot decode GEDCOM file as {normalized}: {err}"))
}

fn parse_text(text: &str, file: &str) -> Result<GedcomData, AppError> {
    // `ged_io` asserts on some duplicated family events. A panic inside a
    // third-party parser must not take the application down, so it becomes a
    // clear import error instead.
    let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        GedcomBuilder::new().build_from_str(text)
    }))
    .map_err(|_| {
        parse_error(
            file,
            "GEDCOM parser aborted on this file (unsupported structure); nothing was imported",
        )
    })?;
    parsed.map_err(|err| {
        let (line, message) = gedcom_error(&err);
        let error = parse_error(file, message);
        match line {
            Some(line) => error.with_param("line", line.to_string()),
            None => error,
        }
    })
}

/// Parse position and a value-free message for a `ged_io` failure.
///
/// Only tags, levels and line numbers are repeated; values from the file
/// (dates, names) never reach a log.
fn gedcom_error(error: &GedcomError) -> (Option<u32>, String) {
    match error {
        GedcomError::ParseError { line, .. } => {
            (Some(*line), "GEDCOM parser rejected a structure".to_owned())
        }
        GedcomError::InvalidTag { line, tag } => (
            u32::try_from(*line).ok(),
            format!("unsupported GEDCOM tag: {tag}"),
        ),
        GedcomError::UnexpectedLevel {
            line,
            expected,
            found,
        } => (
            u32::try_from(*line).ok(),
            format!("unexpected GEDCOM level: expected {expected}, found {found}"),
        ),
        GedcomError::MissingRequiredValue { line, tag } => (
            u32::try_from(*line).ok(),
            format!("missing GEDCOM value for tag: {tag}"),
        ),
        GedcomError::InvalidValueFormat { line, .. } => (
            u32::try_from(*line).ok(),
            "GEDCOM value has an unsupported format".to_owned(),
        ),
        GedcomError::InvalidFormat(_) => (None, "unsupported GEDCOM structure".to_owned()),
        GedcomError::EncodingError(_) => (None, "GEDCOM encoding error".to_owned()),
        GedcomError::FileSizeLimitExceeded { .. } => (None, "GEDCOM file is too large".to_owned()),
        GedcomError::IoError(_) => (None, "GEDCOM file cannot be read".to_owned()),
    }
}

/// File name only: errors never carry an absolute path (ADR-0013).
fn file_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("gedcom")
        .to_owned()
}

fn parse_error(file: &str, message: impl Into<String>) -> AppError {
    AppError::new(codes::IMPORT_PARSE_ERROR, message).with_param("file", file)
}

// ---------------------------------------------------------------------------
// Import mapping
// ---------------------------------------------------------------------------

fn report_unmapped_records(data: &GedcomData, report: &mut GEDCOMReport) {
    if !data.repositories.is_empty() {
        report.warn("unparsed record: REPO (repositories are not imported)");
    }
    if !data.sources.is_empty() {
        report.warn("unparsed record: SOUR (sources are not imported)");
    }
    if !data.submitters.is_empty() {
        report.warn("unparsed record: SUBM (submitters are not imported)");
    }
    if !data.submissions.is_empty() {
        report.warn("unparsed record: SUBN (submissions are not imported)");
    }
    if !data.shared_notes.is_empty() {
        report.warn("unparsed record: SNOTE (shared notes are resolved into person notes)");
    }
    for custom in &data.custom_data {
        report.warn(format!("unparsed record: {}", custom.tag));
    }
}

/// Structures introduced by 7.0 that the domain has no field for.
///
/// The 5.5.1 mapping already reports its own losses; this second pass is only
/// called for 7.0 so the historical warnings stay identical. Each message
/// names a tag, never a value, and `warn` drops duplicates.
fn report_unmapped_v7(data: &GedcomData, report: &mut GEDCOMReport) {
    for individual in &data.individuals {
        for detail in &individual.events {
            report_event_detail_v7(detail, report);
        }
        for attribute in &individual.attributes {
            if let Some(date) = attribute.date.as_ref() {
                report_date_v7(date, report);
            }
        }
        for link in individual.families() {
            if link.pedigree_linkage_type.is_some() {
                report.warn(
                    "unparsed tag: INDI.FAMC.PEDI (adoptive/foster parentage imported as parent-child)",
                );
            }
            if link.child_linkage_status.is_some() {
                report.warn("unparsed tag: INDI.FAMC.STAT");
            }
            if link.adopted_by.is_some() {
                report.warn("unparsed tag: INDI.FAMC.ADOP");
            }
            for note in &link.notes {
                if note.value.is_some() {
                    report.warn("unparsed tag: INDI.FAMC.NOTE");
                }
            }
            for custom in &link.custom_data {
                preserve_custom(custom, report);
            }
        }
    }
    for family in &data.families {
        for detail in &family.events {
            report_event_detail_v7(detail, report);
        }
    }
    for record in &data.multimedia {
        if !record.notes.is_empty() {
            report.warn("unparsed tag: OBJE.NOTE");
        }
        if record.source_citation.is_some() {
            report.warn("unparsed tag: OBJE.SOUR (citations are not imported)");
        }
        for custom in &record.custom_data {
            preserve_custom(custom, report);
        }
    }
}

fn report_event_detail_v7(detail: &Detail, report: &mut GEDCOMReport) {
    let tag = event_tag(&detail.event).unwrap_or("EVEN");
    if let Some(date) = detail.date.as_ref() {
        report_date_v7(date, report);
    }
    if detail.sort_date.is_some() {
        report.warn(format!("unparsed tag: {tag}.SDATE"));
    }
    if !detail.associations.is_empty() {
        report.warn(format!("unparsed tag: {tag}.ASSO"));
    }
    for (present, suffix) in [
        (detail.age.is_some(), "AGE"),
        (detail.restriction.is_some(), "RESN"),
        (detail.religion.is_some(), "RELI"),
    ] {
        if present {
            report.warn(format!("unparsed tag: {tag}.{suffix}"));
        }
    }
}

fn report_date_v7(date: &ged_io::types::date::Date, report: &mut GEDCOMReport) {
    if date.time.is_some() {
        report.warn("unparsed tag: DATE.TIME");
    }
    if date.phrase.is_some() {
        report.warn("unparsed tag: DATE.PHRASE");
    }
}

fn convert_individual(
    data: &GedcomData,
    individual: &Individual,
    ordinal: usize,
    version: GedcomVersion,
    report: &mut GEDCOMReport,
) -> Option<Person> {
    // The export stores `_MARNM` at level 2 under `NAME`, and `NAME` holds the
    // maiden surname. The married surname therefore becomes the primary name;
    // the original `NAME` stays as the birth name. Given name, patronymic,
    // prefix and suffix are copied to both by cloning the converted name.
    let mut names: Vec<Name> = Vec::new();
    let mut first_name_married = false;
    let mut has_indi_married_name = false;
    for (index, gedcom_name) in individual.names.iter().enumerate() {
        let birth_name = convert_name(gedcom_name, report);
        let Some(married_surname) = custom_values(&gedcom_name.custom_data, MARRIED_NAME_TAG)
            .into_iter()
            .next()
        else {
            names.push(birth_name);
            continue;
        };
        if birth_name.surname.as_deref() == Some(married_surname.as_str()) {
            report.warn(format!(
                "custom tag NAME.{MARRIED_NAME_TAG} equals the NAME surname; no second name"
            ));
            names.push(birth_name);
            continue;
        }
        report.warn(format!(
            "custom tag NAME.{MARRIED_NAME_TAG} mapped to the primary married name"
        ));
        if index == 0 {
            first_name_married = true;
        }
        let mut married_name = birth_name.clone();
        married_name.surname = Some(married_surname);
        married_name.name_type = NameType::Married;
        married_name.is_primary = true;
        names.push(married_name);

        let mut maiden_name = birth_name;
        maiden_name.name_type = NameType::Birth;
        maiden_name.is_primary = false;
        if !maiden_name.display().trim().is_empty() {
            names.push(maiden_name);
        }
    }
    let before = names.len();
    names.retain(|name| !name.display().trim().is_empty());
    if names.len() != before {
        report.issue("empty NAME structure skipped");
    }

    // `_MARNM` at INDI level (older exports) still adds a surname-only
    // non-primary name and marks the primary as the married form. Values are
    // never repeated in the report.
    let married_surnames = custom_values(&individual.custom_data, MARRIED_NAME_TAG);
    if individual
        .custom_data
        .iter()
        .any(|custom| custom.tag == MARRIED_NAME_TAG)
    {
        report.warn(format!(
            "custom tag INDI.{MARRIED_NAME_TAG} mapped to a non-primary name"
        ));
    }
    for surname in married_surnames {
        if names
            .iter()
            .any(|name| name.surname.as_deref() == Some(surname.as_str()))
        {
            continue;
        }
        has_indi_married_name = true;
        names.push(Name {
            surname: Some(surname),
            name_type: NameType::Birth,
            is_primary: false,
            ..Name::default()
        });
    }

    if names.is_empty() {
        report.warn(format!(
            "individual #{ordinal} has no usable name; imported unnamed"
        ));
    } else {
        // Exactly one primary name. The primary keeps the surname the person
        // is filed under, so `_MARNM` marks it as the married form.
        for (index, name) in names.iter_mut().enumerate() {
            name.is_primary = index == 0;
        }
        names[0].name_type = if first_name_married || has_indi_married_name {
            NameType::Married
        } else {
            NameType::Birth
        };
    }

    let mut person = match Person::new(names) {
        Ok(person) => person,
        Err(err) => {
            report.issue(format!(
                "individual #{ordinal} rejected ({}); skipped",
                err.code
            ));
            return None;
        }
    };

    match individual.sex.as_ref().map(|sex| &sex.value) {
        Some(GenderType::Male) => person.gender = Gender::Male,
        Some(GenderType::Female) => person.gender = Gender::Female,
        Some(GenderType::Nonbinary) => {
            report.issue("SEX value outside M/F mapped to UNKNOWN");
        }
        Some(GenderType::Unknown) | None => {}
    }

    let mut birth = None;
    let mut death = None;
    for event in &individual.events {
        match event.event {
            GedcomEvent::Birth if birth.is_none() => birth = Some(event),
            GedcomEvent::Death if death.is_none() => death = Some(event),
            ref other => {
                let label = other.to_string();
                report.warn(format!("unparsed event: {label}"));
            }
        }
    }
    if let Some(event) = birth {
        person.birth = convert_event(data, event, "BIRT", report);
    }
    if let Some(event) = death {
        person.death = convert_event(data, event, "DEAT", report);
    }

    for attribute in &individual.attributes {
        let label = attribute.attribute.to_string();
        report.warn(format!("unparsed attribute: {label}"));
        if attribute.age.is_some()
            || attribute.address.is_some()
            || attribute.cause.is_some()
            || attribute.agency.is_some()
            || attribute.attribute_type.is_some()
            || attribute.restriction.is_some()
        {
            report.warn(format!("unparsed attribute detail: {label}"));
        }
        if !attribute.sources.is_empty() {
            report.warn(format!("unparsed tag: {label}.SOUR"));
        }
        if !attribute.multimedia.is_empty() {
            report.warn(format!("unparsed tag: {label}.OBJE"));
        }
        for custom in &attribute.custom_data {
            preserve_custom(custom, report);
        }
    }
    if !individual.source.is_empty() {
        report.warn("unparsed tag: INDI.SOUR (citations are not imported)");
    }
    if !individual.aliases.is_empty() {
        report.warn("unparsed tag: INDI.ALIA");
    }
    if !individual.lds_ordinances.is_empty() {
        report.warn("unparsed tag: INDI.LDS ordinance");
    }
    if !individual.associations.is_empty() {
        report.warn("unparsed tag: INDI.ASSO");
    }
    if !individual.non_events.is_empty() {
        report.warn("unparsed tag: INDI.NO");
    }
    if !individual.external_ids.is_empty() {
        if version.is_v7() {
            for value in &individual.external_ids {
                if let Some(value) = trimmed(Some(value.as_str())) {
                    person.external_ids.push(ExternalId {
                        source: SOURCE.to_owned(),
                        value,
                    });
                }
            }
            report.warn("INDI.EXID mapped to external ids; EXID.TYPE is not imported");
        } else {
            report.warn("unparsed tag: INDI.EXID");
        }
    }
    if individual.uid.is_some() {
        report.warn("unparsed tag: INDI.UID");
    }
    if individual.change_date.is_some() {
        report.warn("unparsed tag: INDI.CHAN");
    }
    if individual.restriction.is_some() {
        report.warn("unparsed tag: INDI.RESN");
    }
    for custom in &individual.custom_data {
        if custom.tag != MARRIED_NAME_TAG {
            preserve_custom(custom, report);
        }
    }

    if let Some(value) = trimmed(individual.user_reference_number.as_deref()) {
        let source =
            trimmed(individual.user_reference_type.as_deref()).unwrap_or_else(|| SOURCE.to_owned());
        person.external_ids.push(ExternalId { source, value });
    }
    if let Some(value) = trimmed(individual.automated_record_id.as_deref()) {
        person.external_ids.push(ExternalId {
            source: SOURCE.to_owned(),
            value,
        });
    }

    person.notes = notes_text(data, &individual.notes, report);

    // Nothing is dropped silently: an inconsistent person is reported and
    // still returned so the caller can decide what to do with it.
    if let Err(err) = person.validate() {
        report.issue(format!(
            "individual #{ordinal} failed validation ({}); imported as-is",
            err.code
        ));
    }
    Some(person)
}

fn convert_name(name: &GedcomName, report: &mut GEDCOMReport) -> Name {
    let (mut given, mut surname, mut suffix) = split_name(name.value.as_deref());
    if let Some(value) = trimmed(name.given.as_deref()) {
        given = Some(value);
    }
    if let Some(value) = trimmed(name.surname.as_deref()) {
        surname = Some(value);
    }
    if let Some(value) = trimmed(name.suffix.as_deref()) {
        suffix = Some(value);
    }
    let prefix = trimmed(name.prefix.as_deref());
    let patronymic = PATRONYMIC_TAGS
        .iter()
        .find_map(|tag| custom_values(&name.custom_data, tag).into_iter().next());

    if name
        .nickname
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        report.warn("unparsed tag: NAME.NICK");
    }
    if name
        .surname_prefix
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        report.warn("unparsed tag: NAME.SPFX");
    }
    for note in &name.notes {
        if trimmed(note.value.as_deref()).is_some() {
            report.warn("unparsed tag: NAME.NOTE");
        }
    }
    if !name.source.is_empty() {
        report.warn("unparsed tag: NAME.SOUR");
    }
    if !name.phonetic.is_empty() || !name.romanized.is_empty() {
        report.warn("unparsed tag: NAME.FONE/ROMN");
    }
    for custom in &name.custom_data {
        if custom.tag != MARRIED_NAME_TAG && !PATRONYMIC_TAGS.contains(&custom.tag.as_str()) {
            preserve_custom(custom, report);
        }
    }

    Name {
        given,
        patronymic,
        surname,
        prefix,
        suffix,
        name_type: map_name_type(name.name_type.as_ref()),
        is_primary: false,
    }
}

fn split_name(value: Option<&str>) -> (Option<String>, Option<String>, Option<String>) {
    let Some(text) = value.map(str::trim).filter(|text| !text.is_empty()) else {
        return (None, None, None);
    };
    let Some(start) = text.find('/') else {
        return (Some(text.to_owned()), None, None);
    };
    let given = text[..start].trim();
    let rest = &text[start + 1..];
    let (surname, suffix) = match rest.find('/') {
        Some(end) => (rest[..end].trim(), rest[end + 1..].trim()),
        None => (rest.trim(), ""),
    };
    (
        trimmed(Some(given)),
        trimmed(Some(surname)),
        trimmed(Some(suffix)),
    )
}

fn map_name_type(value: Option<&GedcomNameType>) -> NameType {
    match value {
        Some(GedcomNameType::Married) => NameType::Married,
        Some(GedcomNameType::Religious) => NameType::Religious,
        Some(GedcomNameType::Birth) | None => NameType::Birth,
        Some(_) => NameType::Other,
    }
}

fn convert_event(
    data: &GedcomData,
    event: &Detail,
    tag: &str,
    report: &mut GEDCOMReport,
) -> DateValue {
    let value = detail_date(event, tag, report);

    if event
        .place
        .as_ref()
        .and_then(|place| trimmed(place.value.as_deref()))
        .is_some()
    {
        report.warn(format!(
            "unparsed tag: {tag}.PLAC (no place field on Person)"
        ));
    }
    for note in &event.notes {
        if note_text(data, note, report).is_some() {
            report.warn(format!("unparsed tag: {tag}.NOTE"));
        }
    }
    if let Some(value) = trimmed(event.value.as_deref()) {
        if !value.eq_ignore_ascii_case("Y") {
            report.warn(format!("unparsed tag: {tag} value"));
        }
    }
    if !event.citations.is_empty() {
        report.warn(format!(
            "unparsed tag: {tag}.SOUR (citations are not imported)"
        ));
    }
    for (present, suffix) in [
        (event.age.is_some(), "AGE"),
        (event.restriction.is_some(), "RESN"),
        (event.religion.is_some(), "RELI"),
        (
            !event.phone.is_empty()
                || !event.email.is_empty()
                || !event.fax.is_empty()
                || !event.website.is_empty(),
            "contact details",
        ),
    ] {
        if present {
            report.warn(format!("unparsed tag: {tag}.{suffix}"));
        }
    }
    for custom in &event.custom_data {
        preserve_custom(custom, report);
    }
    value
}

fn preserve_custom(tag: &UserDefinedTag, report: &mut GEDCOMReport) {
    report.warn(format!("unparsed tag: {}", tag.tag));
}

fn custom_values(tags: &[Box<UserDefinedTag>], tag: &str) -> Vec<String> {
    tags.iter()
        .filter(|custom| custom.tag == tag)
        .filter_map(|custom| trimmed(custom.value.as_deref()))
        .collect()
}

/// Resolves every note and joins the texts with `\n`; `None` when none remain.
fn notes_text(
    data: &GedcomData,
    notes: &[GedcomNote],
    report: &mut GEDCOMReport,
) -> Option<String> {
    let parts: Vec<String> = notes
        .iter()
        .filter_map(|note| note_text(data, note, report))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn note_text(data: &GedcomData, note: &GedcomNote, report: &mut GEDCOMReport) -> Option<String> {
    if note.shared_note_xref().is_some() && data.resolve_note(note).is_none() {
        report.issue("NOTE points to a shared note that is not in the file");
        return None;
    }
    let text = data.resolve_note(note).or(note.value.as_deref())?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_owned())
    }
}

fn convert_families(
    data: &GedcomData,
    by_xref: &HashMap<String, PersonId>,
    events: &mut Vec<Event>,
    report: &mut GEDCOMReport,
) -> Vec<Relationship> {
    let mut set = RelationshipSet::default();
    let mut relationships = Vec::new();
    for family in &data.families {
        let husband = resolve(family.individual1.as_deref(), by_xref, report);
        let wife = resolve(family.individual2.as_deref(), by_xref, report);

        let notes = notes_text(data, &family.notes, report);
        for event in &family.events {
            let label = event.event.to_string();
            report.warn(format!("unparsed family event: {label}"));
        }
        if !family.sources.is_empty() {
            report.warn("unparsed tag: FAM.SOUR (citations are not imported)");
        }
        if !family.lds_ordinances.is_empty() {
            report.warn("unparsed tag: FAM.SLGS");
        }
        if !family.non_events.is_empty() {
            report.warn("unparsed tag: FAM.NO");
        }
        if family.num_children.is_some() {
            report.warn("unparsed tag: FAM.NCHI");
        }
        if family.change_date.is_some() {
            report.warn("unparsed tag: FAM.CHAN");
        }
        if family.user_reference_number.is_some() || family.automated_record_id.is_some() {
            report.warn("unparsed tag: FAM.REFN/RIN");
        }
        for custom in &family.custom_data {
            report.warn(format!("unparsed tag: FAM.{}", custom.tag));
        }

        if let (Some(husband), Some(wife)) = (husband, wife) {
            match Relationship::new(RelationshipType::Spouse, husband, wife) {
                Ok(mut relationship) => {
                    relationship.notes = notes.clone();
                    push_relationship(&mut set, &mut relationships, relationship, report);
                }
                Err(err) => report.issue(format!("family link skipped ({})", err.code)),
            }
        } else if notes.is_some() {
            report.warn("family notes or events have no spouse pair to attach to; not mapped");
        }

        // The domain event keeps one owning person; the other spouse is stored
        // as a co-participant, so the marriage appears on both cards without a
        // second copy of the event.
        if !family.events.is_empty() {
            match husband.or(wife) {
                Some(person_id) => {
                    report.warn(FAMILY_EVENT_WARNING);
                    // The husband, when present, is always the owner, so the
                    // co-participant is the wife. A WIFE-only family therefore
                    // has no other participant (see the follow-up on family
                    // events without a husband).
                    let spouse = wife;
                    for detail in &family.events {
                        let mut event = detail_event(data, detail, person_id, report);
                        if let Some(spouse) = spouse {
                            event.participant_ids = vec![spouse];
                        }
                        push_event(events, event, report);
                    }
                }
                None => report.issue("family event has no spouse to attach to; skipped"),
            }
        }

        for parent in [husband, wife].into_iter().flatten() {
            for child_ref in &family.children {
                let Some(child) = resolve(Some(child_ref), by_xref, report) else {
                    continue;
                };
                match Relationship::new(RelationshipType::ParentChild, parent, child) {
                    Ok(relationship) => {
                        push_relationship(&mut set, &mut relationships, relationship, report)
                    }
                    Err(err) => report.issue(format!("parent link skipped ({})", err.code)),
                }
            }
        }
    }
    relationships
}

fn resolve(
    xref: Option<&str>,
    by_xref: &HashMap<String, PersonId>,
    report: &mut GEDCOMReport,
) -> Option<PersonId> {
    let xref = xref?;
    let found = by_xref.get(xref).copied();
    if found.is_none() {
        report.issue("GEDCOM record points to an individual that was not imported");
    }
    found
}

fn push_relationship(
    set: &mut RelationshipSet,
    relationships: &mut Vec<Relationship>,
    relationship: Relationship,
    report: &mut GEDCOMReport,
) {
    match set.push(relationship.clone()) {
        Ok(()) => relationships.push(relationship),
        Err(err) => report.issue(format!("relationship skipped ({})", err.code)),
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted once when a `FAM` event is attached to one spouse and the other is
/// stored as a co-participant.
const FAMILY_EVENT_WARNING: &str =
    "family event attached to the first spouse; the second spouse is a co-participant";

/// Map the events and the `OCCU`/`EDUC`/`RESI` facts of one individual.
fn convert_individual_events(
    data: &GedcomData,
    individual: &Individual,
    person_id: PersonId,
    events: &mut Vec<Event>,
    report: &mut GEDCOMReport,
) {
    for detail in &individual.events {
        let event = detail_event(data, detail, person_id, report);
        push_event(events, event, report);
    }
    for attribute in &individual.attributes {
        let Some(event_type) = domain_attribute_type(&attribute.attribute) else {
            continue;
        };
        let tag = attribute_tag(&attribute.attribute);
        let (notes, mut details) = split_details_notes(data, &attribute.notes, report);
        fill_attribute_details(event_type, attribute, &mut details);
        let event = Event {
            id: Uuid::now_v7(),
            person_id,
            event_type,
            date: attribute_date(attribute, tag, report),
            place: attribute
                .place
                .as_ref()
                .and_then(|place| trimmed(place.value.as_deref())),
            place_geo: None,
            description: attribute_description(attribute, notes),
            source_ids: Vec::new(),
            original_type: None,
            participant_ids: Vec::new(),
            details: sanitize_details(details, report),
        };
        push_event(events, event, report);
    }
}

/// Build one [`Event`] from a GEDCOM event structure.
fn detail_event(
    data: &GedcomData,
    detail: &Detail,
    person_id: PersonId,
    report: &mut GEDCOMReport,
) -> Event {
    let tag = event_tag(&detail.event).unwrap_or("EVEN");
    let (event_type, original_type) = domain_event_type(&detail.event, tag, report);
    let (notes, mut details) = split_details_notes(data, &detail.notes, report);
    fill_event_details(event_type, detail, &mut details);
    Event {
        id: Uuid::now_v7(),
        person_id,
        event_type,
        date: detail_date(detail, tag, report),
        place: detail
            .place
            .as_ref()
            .and_then(|place| trimmed(place.value.as_deref())),
        place_geo: None,
        description: detail_description(event_type, detail, notes),
        source_ids: Vec::new(),
        original_type,
        participant_ids: Vec::new(),
        details: sanitize_details(details, report),
    }
}

/// Domain type for a GEDCOM event; unmapped tags keep their raw tag.
fn domain_event_type(
    event: &GedcomEvent,
    tag: &str,
    report: &mut GEDCOMReport,
) -> (EventType, Option<String>) {
    let mapped = match event {
        GedcomEvent::Birth => Some(EventType::Birth),
        GedcomEvent::Death => Some(EventType::Death),
        GedcomEvent::Marriage => Some(EventType::Marriage),
        GedcomEvent::Divorce => Some(EventType::Divorce),
        GedcomEvent::Burial => Some(EventType::Burial),
        GedcomEvent::Residence => Some(EventType::Residence),
        _ => None,
    };
    match mapped {
        Some(event_type) => (event_type, None),
        None => {
            report.warn(format!("event tag {tag} mapped to EventType::Other"));
            (EventType::Other, event_tag(event).map(str::to_owned))
        }
    }
}

/// The GEDCOM tag behind a parsed event, for [`Event::original_type`].
fn event_tag(event: &GedcomEvent) -> Option<&'static str> {
    let tag = match event {
        GedcomEvent::Adoption => "ADOP",
        GedcomEvent::AdultChristening => "CHRA",
        GedcomEvent::Annulment => "ANUL",
        GedcomEvent::Baptism => "BAPM",
        GedcomEvent::BarMitzvah => "BARM",
        GedcomEvent::BasMitzvah => "BASM",
        GedcomEvent::Birth => "BIRT",
        GedcomEvent::Blessing => "BLES",
        GedcomEvent::Burial => "BURI",
        GedcomEvent::Census => "CENS",
        GedcomEvent::Christening => "CHR",
        GedcomEvent::Confirmation => "CONF",
        GedcomEvent::Cremation => "CREM",
        GedcomEvent::Death => "DEAT",
        GedcomEvent::Divorce => "DIV",
        GedcomEvent::DivorceFiled => "DIVF",
        GedcomEvent::Emigration => "EMIG",
        GedcomEvent::Engagement => "ENGA",
        GedcomEvent::Event => "EVEN",
        GedcomEvent::FirstCommunion => "FCOM",
        GedcomEvent::Graduation => "GRAD",
        GedcomEvent::Immigration => "IMMI",
        GedcomEvent::Marriage => "MARR",
        GedcomEvent::MarriageBann => "MARB",
        GedcomEvent::MarriageContract => "MARC",
        GedcomEvent::MarriageLicense => "MARL",
        GedcomEvent::MarriageSettlement => "MARS",
        GedcomEvent::Naturalization => "NATU",
        GedcomEvent::Ordination => "ORDN",
        GedcomEvent::Probate => "PROB",
        GedcomEvent::Residence => "RESI",
        GedcomEvent::Retired => "RETI",
        GedcomEvent::Separated => "SEP",
        GedcomEvent::Will => "WILL",
        GedcomEvent::Other | GedcomEvent::SourceData(_) => return None,
    };
    Some(tag)
}

/// Domain type for an individual fact; the rest stays notes-and-warnings only.
fn domain_attribute_type(attribute: &IndividualAttribute) -> Option<EventType> {
    match attribute {
        IndividualAttribute::Occupation => Some(EventType::Occupation),
        IndividualAttribute::ScholasticAchievement => Some(EventType::Education),
        IndividualAttribute::ResidesAt => Some(EventType::Residence),
        _ => None,
    }
}

fn attribute_tag(attribute: &IndividualAttribute) -> &'static str {
    match attribute {
        IndividualAttribute::CastName => "CAST",
        IndividualAttribute::PhysicalDescription => "DSCR",
        IndividualAttribute::ScholasticAchievement => "EDUC",
        IndividualAttribute::NationalIDNumber => "IDNO",
        IndividualAttribute::NationalOrTribalOrigin => "NATI",
        IndividualAttribute::CountOfChildren => "NCHI",
        IndividualAttribute::CountOfMarriages => "NMR",
        IndividualAttribute::Occupation => "OCCU",
        IndividualAttribute::Possessions => "PROP",
        IndividualAttribute::ReligiousAffiliation => "RELI",
        IndividualAttribute::ResidesAt => "RESI",
        IndividualAttribute::SocialSecurityNumber => "SSN",
        IndividualAttribute::NobilityTypeTitle => "TITL",
        IndividualAttribute::Fact => "FACT",
    }
}

/// Splits note text into the human description and the `[gentree:details]`
/// payloads (ADR-0015). Later payload keys win. A malformed payload line stays
/// in the description and is reported once; its values are never logged.
fn split_details_notes(
    data: &GedcomData,
    notes: &[GedcomNote],
    report: &mut GEDCOMReport,
) -> (Option<String>, BTreeMap<String, String>) {
    let mut details = BTreeMap::new();
    let mut description_parts: Vec<String> = Vec::new();
    for note in notes {
        let Some(text) = note_text(data, note, report) else {
            continue;
        };
        let mut had_details = false;
        let mut kept: Vec<&str> = Vec::new();
        for line in text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(payload) = line.trim().strip_prefix(DETAILS_NOTE_PREFIX) {
                had_details = true;
                match parse_details_payload(payload.trim()) {
                    Some(found) => details.extend(found),
                    None => {
                        report.warn(DETAILS_NOTE_WARNING);
                        kept.push(line);
                    }
                }
            } else {
                kept.push(line);
            }
        }
        if had_details {
            let rest = kept.join("\n");
            let rest = rest.trim();
            if !rest.is_empty() {
                description_parts.push(rest.to_owned());
            }
        } else {
            description_parts.push(text);
        }
    }
    let description = (!description_parts.is_empty()).then(|| description_parts.join("\n"));
    (description, details)
}

/// A details NOTE payload is a JSON object of `key -> string`; any other shape
/// is malformed.
fn parse_details_payload(payload: &str) -> Option<BTreeMap<String, String>> {
    serde_json::from_str::<BTreeMap<String, String>>(payload).ok()
}

/// Maps a GEDCOM event's standard tags into detail keys. Keys already present
/// from a details NOTE win (`entry.or_insert`), so the note is authoritative.
fn fill_event_details(
    event_type: EventType,
    detail: &Detail,
    details: &mut BTreeMap<String, String>,
) {
    match event_type {
        EventType::Birth => insert_address_detail(details, "hospital", detail.address.as_ref()),
        EventType::Death => insert_detail(details, "cause", detail.cause.as_deref()),
        EventType::Marriage => {
            insert_detail(details, "marriage_rite", detail.event_type.as_deref());
            insert_detail(details, "officiant", detail.agency.as_deref());
        }
        EventType::Divorce => {
            insert_detail(details, "reason", detail.cause.as_deref());
            insert_detail(details, "court", detail.agency.as_deref());
        }
        EventType::Burial => insert_address_detail(details, "cemetery", detail.address.as_ref()),
        EventType::Residence => {
            let address = address_text(detail.address.as_ref())
                .or_else(|| event_value(detail.value.as_deref()));
            insert_detail(details, "address", address.as_deref());
        }
        EventType::Occupation => {
            let position = event_value(detail.value.as_deref());
            insert_detail(details, "position", position.as_deref());
        }
        EventType::Education => {
            let qualification = event_value(detail.value.as_deref());
            insert_detail(details, "qualification", qualification.as_deref());
        }
        EventType::Other => {}
    }
}

/// Maps `OCCU`/`EDUC`/`RESI` facts into detail keys. The fact value is consumed
/// here and is not repeated in the description.
fn fill_attribute_details(
    event_type: EventType,
    attribute: &AttributeDetail,
    details: &mut BTreeMap<String, String>,
) {
    match event_type {
        EventType::Occupation => {
            let position = event_value(attribute.value.as_deref());
            insert_detail(details, "position", position.as_deref());
            insert_detail(details, "employer", attribute.agency.as_deref());
        }
        EventType::Education => {
            let qualification = event_value(attribute.value.as_deref());
            insert_detail(details, "qualification", qualification.as_deref());
        }
        EventType::Residence => {
            let address = address_text(attribute.address.as_ref())
                .or_else(|| event_value(attribute.value.as_deref()));
            insert_detail(details, "address", address.as_deref());
        }
        _ => {}
    }
}

/// Inserts a standard-tag value only when the key is not already present and
/// the value is non-empty. No value is invented.
fn insert_detail(details: &mut BTreeMap<String, String>, key: &'static str, value: Option<&str>) {
    let Some(value) = trimmed(value) else {
        return;
    };
    details.entry(key.to_owned()).or_insert(value);
}

fn insert_address_detail(
    details: &mut BTreeMap<String, String>,
    key: &'static str,
    address: Option<&Address>,
) {
    let text = address_text(address);
    insert_detail(details, key, text.as_deref());
}

/// The `ADDR` value, or its structured parts joined with `", "` when the value
/// is empty. `None` when the structure carries no text at all.
fn address_text(address: Option<&Address>) -> Option<String> {
    let address = address?;
    if let Some(value) = trimmed(address.value.as_deref()) {
        return Some(value);
    }
    let parts: Vec<String> = [
        address.adr1.as_deref(),
        address.adr2.as_deref(),
        address.adr3.as_deref(),
        address.city.as_deref(),
        address.state.as_deref(),
        address.post.as_deref(),
        address.country.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|part| trimmed(Some(part)))
    .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// Keeps only entries that satisfy the generic `details` shape rules
/// (ADR-0015). Invalid entries are dropped with one warning; values are never
/// repeated in the report.
fn sanitize_details(
    details: BTreeMap<String, String>,
    report: &mut GEDCOMReport,
) -> BTreeMap<String, String> {
    let mut sanitized = BTreeMap::new();
    let mut dropped = false;
    for (key, value) in details {
        let value = value.trim();
        if !is_valid_event_detail_key(&key)
            || value.is_empty()
            || value.chars().count() > MAX_EVENT_DETAIL_VALUE
            || sanitized.len() >= MAX_EVENT_DETAILS
        {
            dropped = true;
            continue;
        }
        sanitized.insert(key, value.to_owned());
    }
    if dropped {
        report.warn(DETAILS_ENTRY_WARNING);
    }
    sanitized
}

/// `description`: notes (without the details note), else `TYPE` when it is not
/// consumed as a detail, else the event value when no detail tag consumed it.
fn detail_description(
    event_type: EventType,
    detail: &Detail,
    notes: Option<String>,
) -> Option<String> {
    notes
        .or_else(|| {
            // MARRIAGE.TYPE is the rite and lives in details, not here.
            if event_type == EventType::Marriage {
                None
            } else {
                trimmed(detail.event_type.as_deref())
            }
        })
        .or_else(|| {
            if detail_value_consumed(event_type) {
                None
            } else {
                event_value(detail.value.as_deref())
            }
        })
}

/// `true` when the event's own value is already mapped into `details`.
fn detail_value_consumed(event_type: EventType) -> bool {
    matches!(
        event_type,
        EventType::Occupation | EventType::Education | EventType::Residence
    )
}

/// `description` for a fact: notes (without the details note), else `TYPE`.
/// The fact value is mapped into `details` and is not repeated here.
fn attribute_description(attribute: &AttributeDetail, notes: Option<String>) -> Option<String> {
    notes.or_else(|| trimmed(attribute.attribute_type.as_deref()))
}

/// A bare `Y` only asserts that the event happened; it carries no text.
fn event_value(value: Option<&str>) -> Option<String> {
    trimmed(value).filter(|text| !text.eq_ignore_ascii_case("Y"))
}

fn detail_date(detail: &Detail, tag: &str, report: &mut GEDCOMReport) -> DateValue {
    let raw = detail.date.as_ref().and_then(|date| date.value.as_deref());
    event_date_value(raw, tag, report)
}

fn attribute_date(attribute: &AttributeDetail, tag: &str, report: &mut GEDCOMReport) -> DateValue {
    let raw = attribute
        .date
        .as_ref()
        .and_then(|date| date.value.as_deref());
    event_date_value(raw, tag, report)
}

fn event_date_value(raw: Option<&str>, tag: &str, report: &mut GEDCOMReport) -> DateValue {
    let Some(raw) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        report.warn(format!("{tag} has no DATE; date stays unknown"));
        return DateValue::default();
    };
    let value = parse_gedcom_date(raw);
    if value.precision == DatePrecision::Unknown {
        report.issue(format!(
            "unparsed {tag} date; kept in original with precision UNKNOWN"
        ));
    }
    value
}

fn push_event(events: &mut Vec<Event>, event: Event, report: &mut GEDCOMReport) {
    if let Err(err) = event.validate() {
        report.issue(format!("event skipped ({})", err.code));
        return;
    }
    if events.iter().any(|existing| same_event(existing, &event)) {
        return;
    }
    events.push(event);
}

/// Two events are the same when nothing but the id differs; a repeated
/// structure in the file must not become a second event.
fn same_event(left: &Event, right: &Event) -> bool {
    left.person_id == right.person_id
        && left.event_type == right.event_type
        && left.date == right.date
        && left.place == right.place
        && left.description == right.description
        && left.original_type == right.original_type
        && left.details == right.details
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/// Media folders to search, in order: `<file>.files` and `<stem>.files` next
/// to the GEDCOM file (an AT5-style export names the folder after the full
/// file, e.g. `ged.ged.files`), then every extra folder.
fn media_roots(path: &Path, extra: &[PathBuf]) -> Vec<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut names: Vec<String> = Vec::new();
    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        names.push(format!("{name}.files"));
    }
    if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
        names.push(format!("{stem}.files"));
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    for name in names {
        let candidate = parent.join(name);
        if candidate.is_dir() && !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
    for directory in extra {
        if directory.is_dir() && !roots.contains(directory) {
            roots.push(directory.clone());
        }
    }
    roots
}

/// Map every `OBJE` structure to a [`GedcomMediaFile`] with a sha256 checksum.
///
/// Bytes are not copied. An `OBJE` under `INDI` (or under an `INDI` event) gets
/// the id of the created person in [`Media::person_id`]; a shared top-level
/// record is attributed to the first individual that references it. `FAM`
/// structures and records nobody references stay unlinked. A file that cannot
/// be found is counted and reported once, without its name: a report must stay
/// loggable (ADR-0013).
fn convert_media(
    data: &GedcomData,
    by_xref: &HashMap<String, PersonId>,
    roots: &[PathBuf],
    report: &mut GEDCOMReport,
) -> Vec<GedcomMediaFile> {
    let by_xref_record: HashMap<&str, &Multimedia> = data
        .multimedia
        .iter()
        .filter_map(|record| record.xref.as_deref().map(|xref| (xref, record)))
        .collect();

    // Individuals come first so a shared `@M1@` record is attributed before the
    // unlinked top-level pass sees it.
    let mut structures: Vec<(Option<PersonId>, &Multimedia)> = Vec::new();
    for individual in &data.individuals {
        let person_id = individual
            .xref
            .as_deref()
            .and_then(|xref| by_xref.get(xref))
            .copied();
        structures.extend(
            individual
                .multimedia
                .iter()
                .map(|structure| (person_id, structure)),
        );
        for event in &individual.events {
            structures.extend(
                event
                    .multimedia
                    .iter()
                    .map(|structure| (person_id, structure)),
            );
        }
    }
    for family in &data.families {
        structures.extend(family.multimedia.iter().map(|structure| (None, structure)));
        for event in &family.events {
            structures.extend(event.multimedia.iter().map(|structure| (None, structure)));
        }
    }
    structures.extend(data.multimedia.iter().map(|record| (None, record)));

    let mut items: Vec<GedcomMediaFile> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut resolved: HashSet<PathBuf> = HashSet::new();
    let mut missing = 0usize;
    let mut refused = 0usize;
    for (person_id, structure) in structures {
        let record = match (structure.file.as_ref(), structure.xref.as_deref()) {
            (Some(_), _) => structure,
            (None, Some(xref)) => match by_xref_record.get(xref) {
                Some(record) => record,
                None => {
                    report.issue("OBJE points to a multimedia record that is not in the file");
                    continue;
                }
            },
            (None, None) => {
                report.issue("OBJE structure has no FILE; skipped");
                continue;
            }
        };
        let Some(file) = record.file.as_ref() else {
            report.issue("OBJE points to a multimedia record without FILE; skipped");
            continue;
        };
        let Some(raw) = trimmed(file.value.as_deref()) else {
            report.issue("OBJE.FILE is empty; skipped");
            continue;
        };
        let Some(relative) = safe_media_path(&raw) else {
            refused += 1;
            continue;
        };
        let Some(base_name) = media_base_name(&relative) else {
            refused += 1;
            continue;
        };
        let Some(path) = find_media_file(&relative, &base_name, roots) else {
            missing += 1;
            continue;
        };
        // The same file linked from several records is hashed once.
        if !resolved.insert(path.clone()) {
            continue;
        }
        let Ok(checksum) = sha256_file(&path) else {
            missing += 1;
            continue;
        };
        if !seen.insert((checksum.clone(), base_name.clone())) {
            continue;
        }
        let caption = trimmed(record.title.as_deref())
            .or_else(|| trimmed(file.title.as_deref()))
            .unwrap_or_else(|| base_name.clone());
        let item = Media {
            id: Uuid::now_v7(),
            file_name: base_name.clone(),
            mime_type: guess_mime(&base_name).to_owned(),
            checksum,
            caption: Some(caption),
            source_id: None,
            person_id,
            event_id: None,
            primary: false,
        };
        match item.validate() {
            Ok(()) => items.push(GedcomMediaFile {
                media: item,
                source: path,
            }),
            Err(err) => report.issue(format!("media skipped ({})", err.code)),
        }
    }
    if missing > 0 {
        report.issue(format!(
            "{missing} media file(s) referenced by OBJE were not found in the media folders; skipped"
        ));
    }
    if refused > 0 {
        report.issue(format!(
            "{refused} OBJE.FILE path(s) outside the media folders were refused; skipped"
        ));
    }
    items
}

/// Validate one `OBJE.FILE` value as a relative path inside a media folder.
///
/// Absolute paths, drive letters, `..` segments, NUL and control characters
/// are refused, so a crafted GEDCOM cannot make the importer read elsewhere.
fn safe_media_path(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.chars().any(char::is_control) {
        return None;
    }
    if normalized.starts_with('/') || normalized.as_bytes().get(1) == Some(&b':') {
        return None;
    }
    let segments: Vec<&str> = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| *segment == "." || *segment == "..")
    {
        return None;
    }
    Some(segments.join("/"))
}

fn media_base_name(relative: &str) -> Option<String> {
    let name = relative.rsplit('/').next()?;
    (!name.is_empty()).then(|| name.to_owned())
}

/// Relative path first, then its base name, in every media folder.
fn find_media_file(relative: &str, base_name: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        let candidate = root.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
        if base_name != relative {
            let candidate = root.join(base_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// Parse one GEDCOM 5.5.1 date value.
///
/// Recognised: `YYYY`, `MON YYYY`, `DD MON YYYY`, the `ABT`/`CAL`/`EST`
/// (approximate), `BEF`, `AFT`, `BET … AND …` and `FROM … TO …` forms, and a
/// parenthesised date phrase. Numeric forms (`YYYY-MM`, `YYYY-MM-DD`,
/// `DD.MM.YYYY`) fall back to the AT5 parser, so both importers share one set
/// of date rules. Everything else stays `UNKNOWN` with the text in
/// [`DateValue::original`]; no day is ever invented.
pub fn parse_gedcom_date(raw: &str) -> DateValue {
    let text = raw.trim();
    if text.is_empty() {
        return DateValue::unknown(None);
    }
    if let Some(inner) = text
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return DateValue::unknown(trimmed(Some(inner)));
    }
    let Some(body) = strip_calendar(text) else {
        return DateValue::unknown(Some(text.to_owned()));
    };
    let upper = body.to_ascii_uppercase();

    let value = if let Some(rest) = upper.strip_prefix("BET ") {
        rest.split_once(" AND ")
            .and_then(|(low, high)| range_value(low, high, text))
    } else if let Some(rest) = upper.strip_prefix("FROM ") {
        rest.split_once(" TO ")
            .and_then(|(low, high)| range_value(low, high, text))
    } else if let Some(rest) = upper.strip_prefix("BEF ") {
        bound_value(rest, DateQualifier::Before, text)
    } else if let Some(rest) = upper.strip_prefix("AFT ") {
        bound_value(rest, DateQualifier::After, text)
    } else if let Some(rest) = upper
        .strip_prefix("ABT ")
        .or_else(|| upper.strip_prefix("CAL "))
        .or_else(|| upper.strip_prefix("EST "))
    {
        bound_value(rest, DateQualifier::Approximate, text)
    } else {
        exact_value(&upper, text)
    };

    match value {
        Some(value) if value.validate().is_ok() => value,
        _ => DateValue::unknown(Some(text.to_owned())),
    }
}

/// Drops a GEDCOM calendar escape; only the Gregorian calendar is understood.
fn strip_calendar(text: &str) -> Option<&str> {
    let Some(rest) = text.strip_prefix("@#") else {
        return Some(text);
    };
    let end = rest.find('@')?;
    let calendar = rest[..end].to_ascii_uppercase();
    if calendar == "DGREGORIAN" {
        Some(rest[end + 1..].trim())
    } else {
        None
    }
}

fn exact_value(parts: &str, original: &str) -> Option<DateValue> {
    let parsed = parse_parts(parts)?;
    Some(with_original(
        DateValue {
            start: Some(parsed.start),
            end: Some(parsed.end),
            precision: parsed.precision,
            qualifier: DateQualifier::Exact,
            original: None,
        },
        original,
    ))
}

fn bound_value(parts: &str, qualifier: DateQualifier, original: &str) -> Option<DateValue> {
    let parsed = parse_parts(parts)?;
    let (start, end) = match qualifier {
        DateQualifier::Before => (None, Some(parsed.start)),
        DateQualifier::After => (Some(parsed.start), None),
        _ => (Some(parsed.start), Some(parsed.end)),
    };
    Some(with_original(
        DateValue {
            start,
            end,
            precision: parsed.precision,
            qualifier,
            original: None,
        },
        original,
    ))
}

fn range_value(low: &str, high: &str, original: &str) -> Option<DateValue> {
    let low = parse_parts(low)?;
    let high = parse_parts(high)?;
    Some(with_original(
        DateValue {
            start: Some(low.start),
            end: Some(period_end(high.start, high.precision)),
            precision: finer(low.precision, high.precision),
            qualifier: DateQualifier::Range,
            original: None,
        },
        original,
    ))
}

fn with_original(mut value: DateValue, original: &str) -> DateValue {
    value.original = Some(original.trim().to_owned());
    value
}

struct ParsedDate {
    start: CivilDate,
    end: CivilDate,
    precision: DatePrecision,
}

fn parse_parts(text: &str) -> Option<ParsedDate> {
    if let Some(parsed) = parse_gedcom_parts(text) {
        return Some(parsed);
    }
    // Shared with AT5: "YYYY", "YYYY-MM", "YYYY-MM-DD", "DD.MM.YYYY".
    let value = parse_at5_date(text);
    if value.precision == DatePrecision::Unknown {
        return None;
    }
    Some(ParsedDate {
        start: value.start?,
        end: value.end?,
        precision: value.precision,
    })
}

fn parse_gedcom_parts(text: &str) -> Option<ParsedDate> {
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    match tokens.as_slice() {
        [year] => year_parts(year),
        [month, year] => month_parts(month, year),
        [day, month, year] => day_parts(day, month, year),
        _ => None,
    }
}

fn year_parts(text: &str) -> Option<ParsedDate> {
    let year = year_value(text)?;
    let start = CivilDate::new(year, 1, 1).ok()?;
    Some(ParsedDate {
        start,
        end: start.next_year(),
        precision: DatePrecision::Year,
    })
}

fn month_parts(month: &str, year: &str) -> Option<ParsedDate> {
    let month = month_value(month)?;
    let year = year_value(year)?;
    let start = CivilDate::new(year, month, 1).ok()?;
    Some(ParsedDate {
        start,
        end: start.next_month(),
        precision: DatePrecision::Month,
    })
}

fn day_parts(day: &str, month: &str, year: &str) -> Option<ParsedDate> {
    let day = day_value(day)?;
    let month = month_value(month)?;
    let year = year_value(year)?;
    let start = CivilDate::new(year, month, day).ok()?;
    Some(ParsedDate {
        start,
        end: start.next_day(),
        precision: DatePrecision::Day,
    })
}

fn year_value(text: &str) -> Option<i32> {
    if text.is_empty() || text.len() > 4 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year: i32 = text.parse().ok()?;
    (1..=9999).contains(&year).then_some(year)
}

fn month_value(text: &str) -> Option<u8> {
    let month = MONTHS.iter().position(|month| {
        text.get(..3)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(month))
    })? + 1;
    u8::try_from(month).ok()
}

fn day_value(text: &str) -> Option<u8> {
    if text.is_empty() || text.len() > 2 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn period_end(start: CivilDate, precision: DatePrecision) -> CivilDate {
    match precision {
        DatePrecision::Day | DatePrecision::Unknown => start.next_day(),
        DatePrecision::Month => start.next_month(),
        DatePrecision::Year => start.next_year(),
    }
}

fn finer(left: DatePrecision, right: DatePrecision) -> DatePrecision {
    let rank = |precision: DatePrecision| match precision {
        DatePrecision::Unknown => 0,
        DatePrecision::Year => 1,
        DatePrecision::Month => 2,
        DatePrecision::Day => 3,
    };
    if rank(left) >= rank(right) {
        left
    } else {
        right
    }
}

/// Render a [`DateValue`] as a GEDCOM 5.5.1 date, without inventing precision.
fn format_gedcom_date(value: &DateValue) -> Option<String> {
    if value.precision == DatePrecision::Unknown {
        let original = value.original.as_deref().map(str::trim)?;
        if original.is_empty() {
            return None;
        }
        return Some(format!("({original})"));
    }
    let text = match value.qualifier {
        DateQualifier::Exact => format_partial(value.start?, value.precision)?,
        DateQualifier::Approximate => {
            format!("ABT {}", format_partial(value.start?, value.precision)?)
        }
        DateQualifier::Range => {
            let low = format_partial(value.start?, value.precision)?;
            let high = format_partial(previous_day(value.end?), value.precision)?;
            format!("BET {low} AND {high}")
        }
        DateQualifier::Before => format!("BEF {}", format_partial(value.end?, value.precision)?),
        DateQualifier::After => format!("AFT {}", format_partial(value.start?, value.precision)?),
        DateQualifier::Unknown => return None,
    };
    Some(text)
}

fn format_partial(date: CivilDate, precision: DatePrecision) -> Option<String> {
    if !(1..=9999).contains(&date.year) {
        return None;
    }
    match precision {
        DatePrecision::Day => {
            let month = month_name(date.month)?;
            Some(format!("{:02} {month} {:04}", date.day, date.year))
        }
        DatePrecision::Month => {
            let month = month_name(date.month)?;
            Some(format!("{month} {:04}", date.year))
        }
        DatePrecision::Year => Some(format!("{:04}", date.year)),
        DatePrecision::Unknown => None,
    }
}

fn month_name(month: u8) -> Option<&'static str> {
    MONTHS.get(usize::from(month).checked_sub(1)?).copied()
}

fn previous_day(date: CivilDate) -> CivilDate {
    if date.day > 1 {
        CivilDate {
            day: date.day - 1,
            ..date
        }
    } else if date.month > 1 {
        let month = date.month - 1;
        CivilDate {
            year: date.year,
            month,
            day: days_in_month(date.year, month),
        }
    } else {
        CivilDate {
            year: date.year - 1,
            month: 12,
            day: 31,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gedcom_dates() {
        let day = parse_gedcom_date("15 MAY 1950");
        assert_eq!(day.precision, DatePrecision::Day);
        assert_eq!(day.qualifier, DateQualifier::Exact);
        assert_eq!(day.start.unwrap().to_iso(), "1950-05-15");
        assert_eq!(day.end.unwrap().to_iso(), "1950-05-16");
        assert_eq!(day.original.as_deref(), Some("15 MAY 1950"));

        let month = parse_gedcom_date("MAY 1950");
        assert_eq!(month.precision, DatePrecision::Month);
        assert_eq!(month.start.unwrap().to_iso(), "1950-05-01");
        assert_eq!(month.end.unwrap().to_iso(), "1950-06-01");

        let year = parse_gedcom_date("1950");
        assert_eq!(year.precision, DatePrecision::Year);
        assert_eq!(year.start.unwrap().to_iso(), "1950-01-01");
        assert_eq!(year.end.unwrap().to_iso(), "1951-01-01");

        let approximate = parse_gedcom_date("ABT 1950");
        assert_eq!(approximate.precision, DatePrecision::Year);
        assert_eq!(approximate.qualifier, DateQualifier::Approximate);
        assert_eq!(approximate.start.unwrap().to_iso(), "1950-01-01");

        let before = parse_gedcom_date("BEF 1900");
        assert_eq!(before.qualifier, DateQualifier::Before);
        assert_eq!(before.precision, DatePrecision::Year);
        assert_eq!(before.start, None);
        assert_eq!(before.end.unwrap().to_iso(), "1900-01-01");

        let after = parse_gedcom_date("AFT MAY 1900");
        assert_eq!(after.qualifier, DateQualifier::After);
        assert_eq!(after.start.unwrap().to_iso(), "1900-05-01");
        assert_eq!(after.end, None);

        let range = parse_gedcom_date("BET 1900 AND 1910");
        assert_eq!(range.qualifier, DateQualifier::Range);
        assert_eq!(range.start.unwrap().to_iso(), "1900-01-01");
        assert_eq!(range.end.unwrap().to_iso(), "1911-01-01");

        let from_to = parse_gedcom_date("FROM MAY 1900 TO JUN 1900");
        assert_eq!(from_to.qualifier, DateQualifier::Range);
        assert_eq!(from_to.precision, DatePrecision::Month);
        assert_eq!(from_to.start.unwrap().to_iso(), "1900-05-01");
        assert_eq!(from_to.end.unwrap().to_iso(), "1900-07-01");

        // Shared AT5 rules for numeric forms.
        let iso = parse_gedcom_date("1950-05-06");
        assert_eq!(iso.precision, DatePrecision::Day);
        assert_eq!(iso.start.unwrap().to_iso(), "1950-05-06");

        let phrase = parse_gedcom_date("(около 1940)");
        assert_eq!(phrase.precision, DatePrecision::Unknown);
        assert_eq!(phrase.qualifier, DateQualifier::Unknown);
        assert_eq!(phrase.original.as_deref(), Some("около 1940"));

        for raw in ["около 1940", "@#DJULIAN@ 1700", "31 FEB 1950", "MAY", ""] {
            let value = parse_gedcom_date(raw);
            assert_eq!(value.precision, DatePrecision::Unknown, "raw: {raw}");
            value.validate().unwrap();
        }
        assert_eq!(parse_gedcom_date("MAY").original.as_deref(), Some("MAY"));
    }

    #[test]
    fn formats_dates_without_inventing_a_day() {
        assert_eq!(
            format_gedcom_date(&DateValue::exact_year(1950)).as_deref(),
            Some("1950")
        );
        assert_eq!(
            format_gedcom_date(&DateValue::exact_month(
                CivilDate::new(1950, 5, 31).unwrap()
            ))
            .as_deref(),
            Some("MAY 1950")
        );
        assert_eq!(
            format_gedcom_date(&DateValue::exact_day(CivilDate::new(1950, 5, 7).unwrap()))
                .as_deref(),
            Some("07 MAY 1950")
        );
        assert_eq!(
            format_gedcom_date(&DateValue::unknown(Some("около 1940".into()))).as_deref(),
            Some("(около 1940)")
        );
        assert_eq!(format_gedcom_date(&DateValue::default()), None);

        let range = parse_gedcom_date("BET 1900 AND 1910");
        assert_eq!(
            format_gedcom_date(&range).as_deref(),
            Some("BET 1900 AND 1910")
        );

        let year = parse_gedcom_date("1950");
        let formatted = format_gedcom_date(&year).unwrap();
        let reparsed = parse_gedcom_date(&formatted);
        assert_eq!(reparsed.precision, DatePrecision::Year);
        assert_eq!(reparsed.start.unwrap().to_iso(), "1950-01-01");
        assert_eq!(reparsed.end.unwrap().to_iso(), "1951-01-01");
    }

    #[test]
    fn media_paths_cannot_escape_the_media_folders() {
        for allowed in [
            "scan.jpg",
            "photos/scan.jpg",
            r"photos\scan.jpg",
            "photos//scan.jpg",
        ] {
            assert!(safe_media_path(allowed).is_some(), "raw: {allowed:?}");
        }
        assert_eq!(
            safe_media_path(r"photos\scan.jpg").as_deref(),
            Some("photos/scan.jpg")
        );
        for refused in [
            "",
            " ",
            "..",
            "../scan.jpg",
            r"..\scan.jpg",
            "photos/../../scan.jpg",
            "./scan.jpg",
            "/etc/passwd",
            r"C:\photos\scan.jpg",
            "C:/photos/scan.jpg",
            r"\\server\share\scan.jpg",
            "scan\0.jpg",
        ] {
            assert!(safe_media_path(refused).is_none(), "raw: {refused:?}");
        }
    }

    #[test]
    fn splits_personal_names() {
        assert_eq!(
            split_name(Some("Иван /Петров/")),
            (Some("Иван".to_owned()), Some("Петров".to_owned()), None)
        );
        assert_eq!(
            split_name(Some("John /Doe/ Jr.")),
            (
                Some("John".to_owned()),
                Some("Doe".to_owned()),
                Some("Jr.".to_owned())
            )
        );
        assert_eq!(
            split_name(Some("Иван")),
            (Some("Иван".to_owned()), None, None)
        );
        assert_eq!(split_name(Some("   ")), (None, None, None));
    }

    #[test]
    fn decodes_declared_charsets() {
        let utf8 =
            decode(b"0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Jos\xC3\xA9 /P\xC3\xA9rez/\n0 TRLR")
                .unwrap();
        assert!(utf8.contains("José /Pérez/"));

        let latin1 =
            decode(b"0 HEAD\n1 CHAR ISO-8859-1\n0 @I1@ INDI\n1 NAME Jos\xE9 /P\xE9rez/\n0 TRLR")
                .unwrap();
        assert!(latin1.contains("José /Pérez/"));

        let ansel =
            decode(b"0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI\n1 NAME \xA1ukasz /Garc\xE2ia/\n0 TRLR")
                .unwrap();
        assert!(ansel.contains("Łukasz /Garci\u{0301}a/"));

        let error = decode(b"0 HEAD\n1 CHAR CP1251\n0 TRLR").unwrap_err();
        assert!(error.contains("unsupported"), "{error}");
        assert!(error.contains("CP1251"), "{error}");

        let missing = decode(b"0 HEAD\n0 @I1@ INDI\n1 NAME Jos\xE9\n0 TRLR").unwrap_err();
        assert!(missing.contains("HEAD.CHAR"), "{missing}");
    }

    #[test]
    fn wraps_long_text_with_conc() {
        let mut out = String::new();
        let text = "щ".repeat(400);
        write_text(
            &mut out,
            1,
            "NOTE",
            &text,
            GedcomVersion::V5_5_1,
            &mut ExportReport::default(),
        );
        let joined = out
            .lines()
            .map(|line| {
                let value = line.splitn(3, ' ').nth(2).unwrap_or_default();
                (line, value)
            })
            .collect::<Vec<_>>();
        assert!(joined.iter().all(|(line, _)| line.len() <= LINE_LIMIT));
        let restored = joined.iter().map(|(_, value)| *value).collect::<String>();
        assert_eq!(restored, text);
        assert!(out.contains("2 CONC "));
    }
}
