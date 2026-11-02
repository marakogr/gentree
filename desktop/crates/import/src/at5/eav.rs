//! EAV reader for real AT5 exports.
//!
//! A real AT5 database keeps person names and event dates in entity-attribute-
//! value tables instead of person columns:
//!
//! * `Persons` carries only `id`, `db_id`, `sex` and the `birth_id`/`death_id`
//!   links to `Events`;
//! * `ValuesStr` carries text values keyed by
//!   `(rec_table, rec_id, rec_db_id, f_id)`, where `rec_table = 13` means
//!   `Persons` and `f_id` 64/65/66/67/89 are last, maiden, first, patronymic and
//!   biography;
//! * `ValuesDates` carries dates keyed the same way, where `rec_table = 7`
//!   means `Events`;
//! * `EventDetails` links persons to events, `EventTypes.gedname` supplies the
//!   GEDCOM tag, `Documents` supplies media metadata.
//!
//! The mapping follows the legacy AT5 EAV import rules; the
//! differences are listed in the change evidence. This module only runs when
//! `is_eav_schema` recognises the shape, so the simplified person-table path
//! keeps working unchanged.
//!
//! Everything is read-only. Diagnostics never repeat field values: messages
//! carry table names, row numbers and EAV field ids only.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use gentree_core::date::{CivilDate, DatePrecision, DateQualifier, DateValue};
use gentree_core::error::{codes, AppError};
use gentree_core::person::{ExternalId, Gender, Name, NameType, Person, PersonId};
use gentree_core::record::{Event, EventType};
use gentree_core::relationship::{Relationship, RelationshipSet, RelationshipType};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, Row};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::At5Bundle;
use super::{
    at5_media, error_reason, find_media_file, for_each_row, guess_mime, media_roots, parse_error,
    quote_ident, sanitize_file_name, sha256_file, trimmed, At5MediaFile, Mapping, RowValues, Table,
    SOURCE,
};
use crate::report::ImportReport;

/// `rec_table` code for `Persons` (see `ownerTable` in the TypeScript service).
const PERSON_TABLE_CODE: i64 = 13;
/// `rec_table` code for `Events`.
const EVENT_TABLE_CODE: i64 = 7;

const FIELD_LAST_NAME: i64 = 64;
const FIELD_MAIDEN_NAME: i64 = 65;
const FIELD_FIRST_NAME: i64 = 66;
const FIELD_PATRONYMIC: i64 = 67;
const FIELD_BIOGRAPHY: i64 = 89;

/// Exactly the 25 physical AT5 tables (`AT5_TABLES` in `schema.ts`).
const AT5_TABLES: [&str; 25] = [
    "DocumentDetails",
    "Documents",
    "EventDetails",
    "EventRoles",
    "EventTypes",
    "Events",
    "Families",
    "FieldAreas",
    "Fields",
    "Global",
    "Languages",
    "Log",
    "Notes",
    "Persons",
    "Places",
    "SourceDetails",
    "Sources",
    "ValuesCoords",
    "ValuesDates",
    "ValuesLinks",
    "ValuesNum",
    "ValuesStr",
    "__Ids",
    "__Logs",
    "__Recs",
];

/// True when the database is a real EAV export rather than the simplified
/// person-table shape: `Fields` and `ValuesStr` exist and `Persons` has no name
/// columns of its own.
pub(super) fn is_eav_schema(tables: &[Table]) -> bool {
    let has = |name: &str| {
        tables
            .iter()
            .any(|table| table.name.eq_ignore_ascii_case(name))
    };
    if !(has("Fields") && has("ValuesStr")) {
        return false;
    }
    let Some(persons) = find_table(tables, "Persons") else {
        return false;
    };
    let mapping = Mapping::detect(&persons.columns);
    mapping.given.is_none() && mapping.surname.is_none()
}

/// Read the full EAV bundle. Read-only and side-effect free.
pub(super) fn read_eav(
    connection: &Connection,
    path: &Path,
    file: &str,
    tables: &[Table],
    media_dirs: &[PathBuf],
) -> Result<At5Bundle, AppError> {
    let mut report = ImportReport::default();
    warn_unknown_tables(tables, &mut report);

    let Some(persons_table) = find_table(tables, "Persons") else {
        return Err(parse_error(file, "AT5 database has no Persons table"));
    };
    let events_table = find_table(tables, "Events");
    let event_types_table = find_table(tables, "EventTypes");
    let event_details_table = find_table(tables, "EventDetails");
    let values_str_table = find_table(tables, "ValuesStr");
    let values_dates_table = find_table(tables, "ValuesDates");
    let documents_table = find_table(tables, "Documents");
    let document_details_table = find_table(tables, "DocumentDetails");

    if events_table.is_none() {
        report.warn("no Events table; person dates and events are not imported");
    }
    if values_dates_table.is_none() {
        report.warn("no ValuesDates table; event dates are not imported");
    }

    let event_tags = read_event_tags(connection, event_types_table, file)?;
    let event_dates = read_event_dates(connection, values_dates_table, file, &mut report)?;
    let raw_events = read_events(
        connection,
        events_table,
        &event_tags,
        &event_dates,
        file,
        &mut report,
    )?;
    let event_keys = raw_events
        .iter()
        .map(|event| event.key.clone())
        .collect::<HashSet<_>>();

    let person_names = read_person_names(connection, values_str_table, file, &mut report)?;
    let PersonsRead {
        persons,
        ids: person_ids,
        birth_subjects,
        death_subjects,
    } = read_persons(
        PersonInputs {
            connection,
            table: persons_table,
            names: &person_names,
            event_dates: &event_dates,
            event_keys: &event_keys,
            has_events_table: events_table.is_some(),
            file,
        },
        &mut report,
    )?;
    report.persons = persons.len();

    let participants = read_participants(
        connection,
        event_details_table,
        &event_keys,
        &person_ids,
        file,
        &mut report,
    )?;

    let relationships = build_relationships(
        &raw_events,
        &participants,
        &birth_subjects,
        &person_ids,
        &mut report,
    );
    report.relationships = relationships.len();

    let events = build_events(
        &raw_events,
        &participants,
        &birth_subjects,
        &death_subjects,
        &person_ids,
        &mut report,
    );
    report.events = events.len();

    let MediaRead {
        items: mut media_items,
        by_key: media_by_key,
    } = read_media(
        connection,
        documents_table,
        &media_roots(path, media_dirs),
        file,
        &mut report,
    )?;
    read_document_links(
        connection,
        document_details_table,
        &person_ids,
        &media_by_key,
        &mut media_items,
        file,
        &mut report,
    )?;
    report.media = media_items.len();

    Ok(At5Bundle {
        persons,
        relationships,
        events,
        media: media_items.iter().map(|file| file.media.clone()).collect(),
        media_files: media_items,
        report,
    })
}

fn warn_unknown_tables(tables: &[Table], report: &mut ImportReport) {
    for table in tables {
        let known = AT5_TABLES
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&table.name));
        if !known {
            report.warn(format!("unknown table: {}", table.name));
        }
    }
}

fn find_table<'a>(tables: &'a [Table], name: &str) -> Option<&'a Table> {
    tables
        .iter()
        .find(|table| table.name.eq_ignore_ascii_case(name))
}

fn actual_column<'a>(table: &'a Table, name: &str) -> Option<&'a str> {
    table
        .columns
        .iter()
        .find(|column| column.eq_ignore_ascii_case(name))
        .map(String::as_str)
}

/// Actual column names for the wanted roles, in `wanted` order.
fn selected(table: &Table, wanted: &[&str]) -> Vec<String> {
    wanted
        .iter()
        .filter_map(|name| actual_column(table, name).map(str::to_owned))
        .collect()
}

fn number_of(values: &RowValues<'_>, column: Option<&str>) -> Option<i64> {
    let raw = values.get(column?)?.trim();
    if raw.is_empty() {
        return None;
    }
    raw.parse::<i64>().ok()
}

fn non_negative(value: Option<i64>) -> Option<i64> {
    value.filter(|value| *value >= 0)
}

fn text<'a>(values: &'a RowValues<'_>, column: Option<&str>) -> Option<&'a str> {
    values.get(column?)
}

fn record_key(id: i64, db_id: i64) -> String {
    format!("{id}:{db_id}")
}

// ---------------------------------------------------------------------------
// EventTypes -> GEDCOM tag
// ---------------------------------------------------------------------------

fn read_event_tags(
    connection: &Connection,
    table: Option<&Table>,
    file: &str,
) -> Result<HashMap<String, String>, AppError> {
    let mut tags = HashMap::new();
    let Some(table) = table else {
        return Ok(tags);
    };
    let id = actual_column(table, "id").map(str::to_owned);
    let db_id = actual_column(table, "db_id").map(str::to_owned);
    let gedname = actual_column(table, "gedname").map(str::to_owned);
    let columns = selected(table, &["id", "db_id", "gedname"]);

    for_each_row(
        connection,
        &table.name,
        &columns,
        file,
        |_number, values| {
            let (Some(id_value), Some(db_value)) = (
                non_negative(number_of(values, id.as_deref())),
                number_of(values, db_id.as_deref()),
            ) else {
                return Ok(());
            };
            let Some(raw) = text(values, gedname.as_deref()) else {
                return Ok(());
            };
            let tag = raw.trim().to_uppercase();
            if !tag.is_empty() {
                tags.insert(record_key(id_value, db_value), tag);
            }
            Ok(())
        },
    )?;
    Ok(tags)
}

// ---------------------------------------------------------------------------
// ValuesDates -> event dates
// ---------------------------------------------------------------------------

/// Column names of the AT5 date triple plus its accuracy flags.
#[derive(Debug, Default)]
struct DateColumns {
    kind: Option<String>,
    d: Option<String>,
    m: Option<String>,
    y: Option<String>,
    d2: Option<String>,
    m2: Option<String>,
    y2: Option<String>,
    julian: Option<String>,
    bc: Option<String>,
    bc2: Option<String>,
    unknown_digits: Option<String>,
}

impl DateColumns {
    fn detect(table: &Table) -> Self {
        let column = |name: &str| actual_column(table, name).map(str::to_owned);
        Self {
            kind: column("type"),
            d: column("d"),
            m: column("m"),
            y: column("y"),
            d2: column("d2"),
            m2: column("m2"),
            y2: column("y2"),
            julian: column("isjulian"),
            bc: column("isdateBC"),
            bc2: column("isdate2BC"),
            unknown_digits: column("unknownyeardigits"),
        }
    }
}

fn read_event_dates(
    connection: &Connection,
    table: Option<&Table>,
    file: &str,
    report: &mut ImportReport,
) -> Result<HashMap<String, DateValue>, AppError> {
    let mut dates = HashMap::new();
    let Some(table) = table else {
        return Ok(dates);
    };
    let rec_table = actual_column(table, "rec_table").map(str::to_owned);
    let rec_id = actual_column(table, "rec_id").map(str::to_owned);
    let rec_db_id = actual_column(table, "rec_db_id").map(str::to_owned);
    let date_columns = DateColumns::detect(table);
    let columns = selected(
        table,
        &[
            "rec_table",
            "rec_id",
            "rec_db_id",
            "type",
            "d",
            "m",
            "y",
            "d2",
            "m2",
            "y2",
            "isjulian",
            "isdateBC",
            "isdate2BC",
            "unknownyeardigits",
        ],
    );

    for_each_row(connection, &table.name, &columns, file, |number, values| {
        if number_of(values, rec_table.as_deref()) != Some(EVENT_TABLE_CODE) {
            return Ok(());
        }
        let (Some(id), Some(db_id)) = (
            non_negative(number_of(values, rec_id.as_deref())),
            number_of(values, rec_db_id.as_deref()),
        ) else {
            report.warn(format!(
                "event date at row {number} in {} has no owner reference; skipped",
                table.name
            ));
            return Ok(());
        };
        let (date, problems) = parse_event_date(values, &date_columns);
        for problem in problems {
            report.warn(format!(
                "event date at row {number} in {}: {problem}",
                table.name
            ));
        }
        dates.entry(record_key(id, db_id)).or_insert(date);
        Ok(())
    })?;
    Ok(dates)
}

/// Port of `parseAt5Date` (`service.ts`).
///
/// `type` 0 is an exact date; any other type keeps the parsed precision but
/// loses the qualifier. Julian/BC dates, ranges, partial years and unusable
/// triples are never guessed: they return an empty [`DateValue`] with
/// precision and qualifier `UNKNOWN` and no `original`.
fn parse_event_date(
    values: &RowValues<'_>,
    columns: &DateColumns,
) -> (DateValue, Vec<&'static str>) {
    let mut problems = Vec::new();
    let unknown = |problems: Vec<&'static str>| (DateValue::unknown(None), problems);

    let kind = number_of(values, columns.kind.as_deref());
    let d = number_of(values, columns.d.as_deref());
    let m = number_of(values, columns.m.as_deref());
    let y = number_of(values, columns.y.as_deref());
    let d2 = number_of(values, columns.d2.as_deref());
    let m2 = number_of(values, columns.m2.as_deref());
    let y2 = number_of(values, columns.y2.as_deref());
    let julian = number_of(values, columns.julian.as_deref()) == Some(1);
    let bc = number_of(values, columns.bc.as_deref()) == Some(1);
    let bc2 = number_of(values, columns.bc2.as_deref()) == Some(1);
    let unknown_digits = number_of(values, columns.unknown_digits.as_deref()).unwrap_or(0);

    if julian || bc || bc2 {
        problems.push("unsupported calendar, date kept UNKNOWN");
        return unknown(problems);
    }
    if d2.is_some() || m2.is_some() || y2.is_some() {
        problems.push("date ranges are not supported, date kept UNKNOWN");
        return unknown(problems);
    }
    if kind.is_some_and(|value| value != 0) {
        problems.push("unknown date qualifier, qualifier kept UNKNOWN");
    }
    let Some(year) = y.filter(|value| (1..=9999).contains(value)) else {
        problems.push("incomplete date, date kept UNKNOWN");
        return unknown(problems);
    };
    if unknown_digits > 0 {
        problems.push("partial year is not supported, date kept UNKNOWN");
        return unknown(problems);
    }

    let mut precision = DatePrecision::Year;
    let mut month = 1u8;
    let mut day = 1u8;
    match m {
        Some(value) if (1..=12).contains(&value) => {
            month = value as u8;
            if let Some(raw_day) = d {
                let Ok(converted) = u8::try_from(raw_day) else {
                    problems.push("invalid calendar date, date kept UNKNOWN");
                    return unknown(problems);
                };
                precision = DatePrecision::Day;
                day = converted;
            } else {
                precision = DatePrecision::Month;
            }
        }
        _ => {
            if d.is_some() {
                problems.push("day without month, only the year is kept");
            }
        }
    }

    let year = i32::try_from(year).unwrap_or_default();
    let Ok(start) = CivilDate::new(year, month, day) else {
        problems.push("invalid calendar date, date kept UNKNOWN");
        return unknown(problems);
    };
    let end = match precision {
        DatePrecision::Day => start.next_day(),
        DatePrecision::Month => start.first_of_month().next_month(),
        _ => start.first_of_year().next_year(),
    };
    if end.year > 9999 {
        problems.push("invalid calendar date, date kept UNKNOWN");
        return unknown(problems);
    }

    let original = match precision {
        DatePrecision::Day => format!("{year:04}-{month:02}-{day:02}"),
        DatePrecision::Month => format!("{year:04}-{month:02}"),
        _ => format!("{year:04}"),
    };
    let qualifier = if kind == Some(0) {
        DateQualifier::Exact
    } else {
        DateQualifier::Unknown
    };
    let value = DateValue {
        start: Some(start),
        end: Some(end),
        precision,
        qualifier,
        original: Some(original),
    };
    if value.validate().is_err() {
        problems.push("invalid calendar date, date kept UNKNOWN");
        return unknown(problems);
    }
    (value, problems)
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

struct RawEvent {
    key: String,
    row: usize,
    tag: String,
    event_type: EventType,
    original_type: Option<String>,
    date: DateValue,
}

fn read_events(
    connection: &Connection,
    table: Option<&Table>,
    tags: &HashMap<String, String>,
    dates: &HashMap<String, DateValue>,
    file: &str,
    report: &mut ImportReport,
) -> Result<Vec<RawEvent>, AppError> {
    let mut events = Vec::new();
    let Some(table) = table else {
        return Ok(events);
    };
    let id = actual_column(table, "id").map(str::to_owned);
    let db_id = actual_column(table, "db_id").map(str::to_owned);
    let type_id = actual_column(table, "et_id").map(str::to_owned);
    let type_db_id = actual_column(table, "et_db_id").map(str::to_owned);
    let columns = selected(table, &["id", "db_id", "et_id", "et_db_id"]);

    let mut seen = HashSet::new();
    let mut unsupported_warned = false;
    for_each_row(connection, &table.name, &columns, file, |number, values| {
        let (Some(id_value), Some(db_value)) = (
            non_negative(number_of(values, id.as_deref())),
            number_of(values, db_id.as_deref()),
        ) else {
            report.warn(format!(
                "event at row {number} in {} has no identifier; skipped",
                table.name
            ));
            return Ok(());
        };
        let key = record_key(id_value, db_value);
        if !seen.insert(key.clone()) {
            report.warn(format!(
                "duplicate event identifier at row {number} in {}; skipped",
                table.name
            ));
            return Ok(());
        }

        let raw_tag = match (
            non_negative(number_of(values, type_id.as_deref())),
            number_of(values, type_db_id.as_deref()),
        ) {
            (Some(id), Some(db)) => tags.get(&record_key(id, db)).cloned(),
            _ => None,
        };
        let valid_tag = raw_tag.as_deref().filter(|tag| is_valid_tag(tag));
        let tag = valid_tag.unwrap_or("EVENT").to_owned();
        if valid_tag.is_none() {
            report.warn(format!(
                "event at row {number} in {} has no usable type tag; imported as OTHER",
                table.name
            ));
        }
        let event_type = map_event_type(&tag);
        if event_type.is_none() && !unsupported_warned {
            report.warn(format!(
                "events in {} use type tags the importer does not map; imported as OTHER",
                table.name
            ));
            unsupported_warned = true;
        }
        let original_type = event_type
            .is_none()
            .then(|| valid_tag.map(str::to_owned))
            .flatten();
        events.push(RawEvent {
            date: dates.get(&key).cloned().unwrap_or_default(),
            key,
            row: number,
            tag,
            event_type: event_type.unwrap_or(EventType::Other),
            original_type,
        });
        Ok(())
    })?;
    Ok(events)
}

/// `^[A-Z][A-Z0-9_]{0,63}$`, applied after trimming and upper-casing.
fn is_valid_tag(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 64 {
        return false;
    }
    let mut characters = tag.chars();
    match characters.next() {
        Some(first) if first.is_ascii_uppercase() => {}
        _ => return false,
    }
    characters.all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
    })
}

fn map_event_type(tag: &str) -> Option<EventType> {
    match tag {
        "BIRT" => Some(EventType::Birth),
        "DEAT" => Some(EventType::Death),
        "MARR" => Some(EventType::Marriage),
        "DIV" => Some(EventType::Divorce),
        "BURI" => Some(EventType::Burial),
        "RESI" => Some(EventType::Residence),
        "OCCU" => Some(EventType::Occupation),
        "EDUC" => Some(EventType::Education),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// ValuesStr -> names and biography
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct PersonNames {
    first_name: Option<String>,
    last_name: Option<String>,
    maiden_name: Option<String>,
    patronymic: Option<String>,
    biography: Option<String>,
}

fn read_person_names(
    connection: &Connection,
    table: Option<&Table>,
    file: &str,
    report: &mut ImportReport,
) -> Result<HashMap<String, PersonNames>, AppError> {
    let mut names: HashMap<String, PersonNames> = HashMap::new();
    let Some(table) = table else {
        return Ok(names);
    };
    let rec_table = actual_column(table, "rec_table").map(str::to_owned);
    let rec_id = actual_column(table, "rec_id").map(str::to_owned);
    let rec_db_id = actual_column(table, "rec_db_id").map(str::to_owned);
    let field_id = actual_column(table, "f_id").map(str::to_owned);
    let value_column = actual_column(table, "vstr").map(str::to_owned);
    let blob_column = actual_column(table, "vblob").map(str::to_owned);
    let columns = selected(
        table,
        &["rec_table", "rec_id", "rec_db_id", "f_id", "vstr", "vblob"],
    );

    let mut unmapped_person_fields: HashSet<i64> = HashSet::new();
    let mut unmapped_owner_fields: HashSet<(String, i64)> = HashSet::new();

    for_each_row(connection, &table.name, &columns, file, |number, values| {
        let owner = number_of(values, rec_table.as_deref());
        let field = non_negative(number_of(values, field_id.as_deref()));
        if owner != Some(PERSON_TABLE_CODE) {
            if let Some(field) = field {
                let owner_label = owner
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_owned());
                if unmapped_owner_fields.insert((owner_label.clone(), field)) {
                    report.warn(format!(
                        "EAV values for table code {owner_label} are not mapped (field {field})"
                    ));
                }
            }
            return Ok(());
        }
        let Some(field) = field else {
            if unmapped_owner_fields.insert(("13".to_owned(), -1)) {
                report.warn("EAV values without a field id for Persons are not mapped");
            }
            return Ok(());
        };
        if !matches!(
            field,
            FIELD_LAST_NAME
                | FIELD_MAIDEN_NAME
                | FIELD_FIRST_NAME
                | FIELD_PATRONYMIC
                | FIELD_BIOGRAPHY
        ) {
            if unmapped_person_fields.insert(field) {
                report.warn(format!(
                    "unrecognised EAV field {field} for Persons; value not imported"
                ));
            }
            return Ok(());
        }

        let (Some(id), Some(db_id)) = (
            non_negative(number_of(values, rec_id.as_deref())),
            number_of(values, rec_db_id.as_deref()),
        ) else {
            report.warn(format!(
                "EAV value at row {number} in {} has no owner reference; skipped",
                table.name
            ));
            return Ok(());
        };
        // Long AT5 texts (person biographies) are stored in full in `vblob`
        // (UTF-8) while `vstr` keeps a 150-character preview. Prefer the blob
        // and fall back to `vstr` when it is absent or not text.
        let raw = [blob_column.as_deref(), value_column.as_deref()]
            .into_iter()
            .filter_map(|column| text(values, column))
            .map(str::trim)
            .find(|value| !value.is_empty());
        let Some(trimmed) = raw else {
            report.warn(format!(
                "EAV value at row {number} in {} is empty; skipped",
                table.name
            ));
            return Ok(());
        };
        if field != FIELD_BIOGRAPHY && trimmed.chars().count() > 200 {
            report.warn(format!(
                "EAV name value at row {number} in {} is longer than 200 characters; skipped",
                table.name
            ));
            return Ok(());
        }

        let entry = names.entry(record_key(id, db_id)).or_default();
        let value = trimmed.to_owned();
        match field {
            FIELD_LAST_NAME => {
                entry.last_name.get_or_insert(value);
            }
            FIELD_MAIDEN_NAME => {
                entry.maiden_name.get_or_insert(value);
            }
            FIELD_FIRST_NAME => {
                entry.first_name.get_or_insert(value);
            }
            FIELD_PATRONYMIC => {
                entry.patronymic.get_or_insert(value);
            }
            FIELD_BIOGRAPHY => {
                // `persons.biography` is TEXT in the reference importer and the
                // last biography row wins.
                entry.biography = Some(value);
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(names)
}

fn cleaned(value: &Option<String>) -> Option<String> {
    trimmed(value.as_deref())
}

/// Primary name plus (when present) the maiden name as a second, non-primary
/// `MARRIED` name. The domain `Name` has no separate maiden field, so this is
/// the closest lossless representation.
fn build_names(source: &PersonNames) -> Vec<Name> {
    let first = cleaned(&source.first_name);
    let last = cleaned(&source.last_name);
    let patronymic = cleaned(&source.patronymic);
    let maiden = cleaned(&source.maiden_name);

    let mut names = Vec::new();
    if first.is_some() || last.is_some() || patronymic.is_some() {
        names.push(Name {
            given: first,
            patronymic,
            surname: last,
            name_type: NameType::Birth,
            is_primary: true,
            ..Name::default()
        });
    }
    if let Some(maiden) = maiden {
        names.push(Name {
            surname: Some(maiden),
            name_type: NameType::Married,
            ..Name::default()
        });
    }
    if names.is_empty() {
        return names;
    }
    if !names.iter().any(|name| name.is_primary) {
        if let Some(name) = names.first_mut() {
            name.is_primary = true;
        }
    }
    names
}

// ---------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------

/// Inputs of [`read_persons`], grouped so the signature stays readable.
struct PersonInputs<'a> {
    connection: &'a Connection,
    table: &'a Table,
    names: &'a HashMap<String, PersonNames>,
    event_dates: &'a HashMap<String, DateValue>,
    event_keys: &'a HashSet<String>,
    has_events_table: bool,
    file: &'a str,
}

/// Everything the later phases need from the person pass.
struct PersonsRead {
    persons: Vec<Person>,
    ids: HashMap<String, PersonId>,
    birth_subjects: HashMap<String, Vec<String>>,
    death_subjects: HashMap<String, Vec<String>>,
}

fn read_persons(
    inputs: PersonInputs<'_>,
    report: &mut ImportReport,
) -> Result<PersonsRead, AppError> {
    let PersonInputs {
        connection,
        table,
        names,
        event_dates,
        event_keys,
        has_events_table,
        file,
    } = inputs;
    let id = actual_column(table, "id").map(str::to_owned);
    let db_id = actual_column(table, "db_id").map(str::to_owned);
    let sex = actual_column(table, "sex").map(str::to_owned);
    let birth_id = actual_column(table, "birth_id").map(str::to_owned);
    let birth_db_id = actual_column(table, "birth_db_id").map(str::to_owned);
    let death_id = actual_column(table, "death_id").map(str::to_owned);
    let death_db_id = actual_column(table, "death_db_id").map(str::to_owned);
    let columns = selected(
        table,
        &[
            "id",
            "db_id",
            "sex",
            "birth_id",
            "birth_db_id",
            "death_id",
            "death_db_id",
        ],
    );

    let mut persons = Vec::new();
    let mut person_ids: HashMap<String, PersonId> = HashMap::new();
    let mut birth_subjects: HashMap<String, Vec<String>> = HashMap::new();
    let mut death_subjects: HashMap<String, Vec<String>> = HashMap::new();

    for_each_row(connection, &table.name, &columns, file, |number, values| {
        let (Some(id_value), Some(db_value)) = (
            non_negative(number_of(values, id.as_deref())),
            number_of(values, db_id.as_deref()),
        ) else {
            report.warn(format!(
                "person at row {number} in {} has no identifier; skipped",
                table.name
            ));
            return Ok(());
        };
        let key = record_key(id_value, db_value);
        if person_ids.contains_key(&key) {
            report.warn(format!(
                "duplicate person identifier at row {number} in {}; skipped",
                table.name
            ));
            return Ok(());
        }

        let source_names = names.get(&key).cloned().unwrap_or_default();
        let person_names = build_names(&source_names);
        if person_names.is_empty() {
            report.warn(format!(
                "person at row {number} in {} has no name values; imported without a name",
                table.name
            ));
        }
        let mut person = Person {
            id: Uuid::now_v7(),
            gender: Gender::Unknown,
            names: person_names,
            birth: DateValue::default(),
            death: DateValue::default(),
            notes: None,
            external_ids: Vec::new(),
        };

        let sex_value = number_of(values, sex.as_deref());
        person.gender = match sex_value {
            Some(1) => Gender::Male,
            Some(2) => Gender::Female,
            _ => {
                report.warn(format!(
                    "person at row {number} in {} has an unsupported sex code; kept UNKNOWN",
                    table.name
                ));
                Gender::Unknown
            }
        };

        let birth_key = match (
            non_negative(number_of(values, birth_id.as_deref())),
            number_of(values, birth_db_id.as_deref()),
        ) {
            (Some(id), Some(db)) => Some(record_key(id, db)),
            _ => None,
        };
        let death_key = match (
            non_negative(number_of(values, death_id.as_deref())),
            number_of(values, death_db_id.as_deref()),
        ) {
            (Some(id), Some(db)) => Some(record_key(id, db)),
            _ => None,
        };

        if let Some(birth_key) = &birth_key {
            birth_subjects
                .entry(birth_key.clone())
                .or_default()
                .push(key.clone());
            match event_dates.get(birth_key) {
                Some(date) => person.birth = date.clone(),
                None if has_events_table && !event_keys.contains(birth_key) => {
                    report.warn(format!(
                        "person at row {number} in {} references a birth event that is not in Events; date left empty",
                        table.name
                    ));
                }
                None if has_events_table => {
                    report.warn(format!(
                        "birth event of the person at row {number} in {} has no date; date left empty",
                        table.name
                    ));
                }
                None => {}
            }
        }
        if let Some(death_key) = &death_key {
            death_subjects
                .entry(death_key.clone())
                .or_default()
                .push(key.clone());
            match event_dates.get(death_key) {
                Some(date) => person.death = date.clone(),
                None if has_events_table && !event_keys.contains(death_key) => {
                    report.warn(format!(
                        "person at row {number} in {} references a death event that is not in Events; date left empty",
                        table.name
                    ));
                }
                None if has_events_table => {
                    report.warn(format!(
                        "death event of the person at row {number} in {} has no date; date left empty",
                        table.name
                    ));
                }
                None => {}
            }
        }

        person.notes = cleaned(&source_names.biography);
        person.external_ids.push(ExternalId {
            source: SOURCE.to_owned(),
            value: key.clone(),
        });

        if let Err(err) = person.validate() {
            let missing_name = err.params.get("field").map(String::as_str) == Some("name")
                && err.params.get("rule").map(String::as_str) == Some("required");
            if !missing_name {
                report.warn(format!(
                    "person at row {number} in {} failed validation ({}); imported as-is",
                    table.name, err.code
                ));
            }
        }
        person_ids.insert(key, person.id);
        persons.push(person);
        Ok(())
    })?;

    Ok(PersonsRead {
        persons,
        ids: person_ids,
        birth_subjects,
        death_subjects,
    })
}

// ---------------------------------------------------------------------------
// EventDetails -> participants
// ---------------------------------------------------------------------------

fn read_participants(
    connection: &Connection,
    table: Option<&Table>,
    event_keys: &HashSet<String>,
    person_ids: &HashMap<String, PersonId>,
    file: &str,
    report: &mut ImportReport,
) -> Result<HashMap<String, Vec<String>>, AppError> {
    let mut participants: HashMap<String, Vec<String>> = HashMap::new();
    let Some(table) = table else {
        return Ok(participants);
    };
    let event_id = actual_column(table, "e_id").map(str::to_owned);
    let event_db_id = actual_column(table, "e_db_id").map(str::to_owned);
    let person_id = actual_column(table, "p_id").map(str::to_owned);
    let person_db_id = actual_column(table, "p_db_id").map(str::to_owned);
    let columns = selected(table, &["e_id", "e_db_id", "p_id", "p_db_id"]);

    for_each_row(connection, &table.name, &columns, file, |number, values| {
        let reference = (
            non_negative(number_of(values, event_id.as_deref())),
            number_of(values, event_db_id.as_deref()),
            non_negative(number_of(values, person_id.as_deref())),
            number_of(values, person_db_id.as_deref()),
        );
        let (Some(event_id), Some(event_db), Some(person_id), Some(person_db)) = reference else {
            report.issue(format!(
                "participant at row {number} in {} has an incomplete reference; skipped",
                table.name
            ));
            return Ok(());
        };
        let event_key = record_key(event_id, event_db);
        let person_key = record_key(person_id, person_db);
        if !event_keys.contains(&event_key) {
            report.issue(format!(
                "participant at row {number} in {} references an event that was not imported; skipped",
                table.name
            ));
            return Ok(());
        }
        if !person_ids.contains_key(&person_key) {
            report.issue(format!(
                "participant at row {number} in {} references a person that was not imported; skipped",
                table.name
            ));
            return Ok(());
        }
        let list = participants.entry(event_key).or_default();
        if !list.contains(&person_key) {
            list.push(person_key);
        }
        Ok(())
    })?;
    Ok(participants)
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

fn build_relationships(
    events: &[RawEvent],
    participants: &HashMap<String, Vec<String>>,
    birth_subjects: &HashMap<String, Vec<String>>,
    person_ids: &HashMap<String, PersonId>,
    report: &mut ImportReport,
) -> Vec<Relationship> {
    let mut set = RelationshipSet::default();

    for event in events {
        match event.tag.as_str() {
            "MARR" => {
                let list = participants
                    .get(&event.key)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                if list.len() < 2 {
                    report.warn(format!(
                        "marriage event at row {} in Events has fewer than 2 participants; no spouse link",
                        event.row
                    ));
                    continue;
                }
                if list.len() > 2 {
                    report.issue(format!(
                        "marriage event at row {} in Events has more than 2 participants; no spouse link",
                        event.row
                    ));
                    continue;
                }
                let (Some(first), Some(second)) = (
                    person_ids.get(&list[0]).copied(),
                    person_ids.get(&list[1]).copied(),
                ) else {
                    continue;
                };
                push_edge(
                    &mut set,
                    RelationshipType::Spouse,
                    first,
                    second,
                    &format!("spouse link of the marriage event at row {}", event.row),
                    report,
                );
            }
            "BIRT" => {
                let subjects = birth_subjects
                    .get(&event.key)
                    .map(|list| unique(list))
                    .unwrap_or_default();
                if subjects.len() > 1 {
                    report.issue(format!(
                        "birth event at row {} in Events has more than one subject; no parent links",
                        event.row
                    ));
                    continue;
                }
                let list = participants
                    .get(&event.key)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let subject_key = match subjects.first() {
                    Some(subject) => Some(subject.clone()),
                    None if list.len() == 1 => Some(list[0].clone()),
                    None => None,
                };
                let Some(subject_key) = subject_key else {
                    report.issue(format!(
                        "birth event at row {} in Events has no unambiguous subject; no parent links",
                        event.row
                    ));
                    continue;
                };
                if !list.contains(&subject_key) {
                    report.issue(format!(
                        "birth event at row {} in Events does not list its subject as a participant; no parent links",
                        event.row
                    ));
                    continue;
                }
                let parents = list
                    .iter()
                    .filter(|participant| **participant != subject_key)
                    .collect::<Vec<_>>();
                if parents.len() > 2 {
                    report.issue(format!(
                        "birth event at row {} in Events has more than 2 parents; no parent links",
                        event.row
                    ));
                    continue;
                }
                let Some(child) = person_ids.get(&subject_key).copied() else {
                    continue;
                };
                for parent_key in parents {
                    let Some(parent) = person_ids.get(parent_key).copied() else {
                        report.issue(format!(
                            "parent link of the birth event at row {} references a person that was not imported; skipped",
                            event.row
                        ));
                        continue;
                    };
                    push_edge(
                        &mut set,
                        RelationshipType::ParentChild,
                        parent,
                        child,
                        &format!("parent link of the birth event at row {}", event.row),
                        report,
                    );
                }
            }
            _ => {}
        }
    }

    set.rows().to_vec()
}

fn unique(values: &[String]) -> Vec<String> {
    let mut unique = Vec::with_capacity(values.len());
    for value in values {
        if !unique.contains(value) {
            unique.push(value.clone());
        }
    }
    unique
}

/// Add an edge, ignoring an exact duplicate (the reference importer treats
/// `ON CONFLICT DO NOTHING` as success) and reporting self-links and cycles.
fn push_edge(
    set: &mut RelationshipSet,
    rel_type: RelationshipType,
    person: Uuid,
    related: Uuid,
    context: &str,
    report: &mut ImportReport,
) {
    let result = Relationship::new(rel_type, person, related).and_then(|row| set.push(row));
    if let Err(err) = result {
        if err.code == codes::DUPLICATE_RELATIONSHIP {
            return;
        }
        report.issue(format!("{context} skipped ({})", error_reason(&err)));
    }
}

// ---------------------------------------------------------------------------
// Events bound to persons
// ---------------------------------------------------------------------------

fn build_events(
    events: &[RawEvent],
    participants: &HashMap<String, Vec<String>>,
    birth_subjects: &HashMap<String, Vec<String>>,
    death_subjects: &HashMap<String, Vec<String>>,
    person_ids: &HashMap<String, PersonId>,
    report: &mut ImportReport,
) -> Vec<Event> {
    let mut mapped = Vec::new();
    for raw in events {
        let subject = match raw.tag.as_str() {
            "BIRT" => birth_subjects.get(&raw.key).and_then(|list| list.first()),
            "DEAT" => death_subjects.get(&raw.key).and_then(|list| list.first()),
            _ => None,
        };
        let person_key =
            subject.or_else(|| participants.get(&raw.key).and_then(|list| list.first()));
        let Some(person_id) = person_key.and_then(|key| person_ids.get(key)).copied() else {
            report.warn(format!(
                "event at row {} in Events has no participant to attach it to; skipped",
                raw.row
            ));
            continue;
        };

        let mut event = Event::new(person_id, raw.event_type);
        event.date = raw.date.clone();
        event.original_type = raw.original_type.clone();
        // A marriage keeps the other spouse as a co-participant, so the same
        // event is visible on both cards. Other events stay single-owner until
        // their participant roles are modelled.
        if raw.event_type == EventType::Marriage {
            if let Some(list) = participants.get(&raw.key) {
                event.participant_ids = list
                    .iter()
                    .filter_map(|key| person_ids.get(key).copied())
                    .filter(|id| *id != person_id)
                    .collect();
            }
        }
        if let Err(err) = event.validate() {
            report.warn(format!(
                "event at row {} in Events failed validation ({}); imported as-is",
                raw.row, err.code
            ));
        }
        mapped.push(event);
    }
    mapped
}

// ---------------------------------------------------------------------------
// Documents -> media metadata
// ---------------------------------------------------------------------------

/// Media rows plus `"<id>:<db_id>" -> index` so `DocumentDetails` can point at
/// the row it links.
struct MediaRead {
    items: Vec<At5MediaFile>,
    by_key: HashMap<String, usize>,
}

/// Attach each `DocumentDetails` row to the media and person it references.
///
/// `rec_table` 13 is `Persons`; any other owner (place, event, family, source)
/// has no single person in this domain model, so the media row stays unlinked.
/// A link whose document or person was not imported is counted and reported
/// once, by row kind only (never by value).
fn read_document_links(
    connection: &Connection,
    table: Option<&Table>,
    person_ids: &HashMap<String, PersonId>,
    media_by_key: &HashMap<String, usize>,
    media: &mut [At5MediaFile],
    file: &str,
    report: &mut ImportReport,
) -> Result<(), AppError> {
    let Some(table) = table else {
        return Ok(());
    };
    let (Some(document_id), Some(document_db)) = (
        actual_column(table, "d_id"),
        actual_column(table, "d_db_id"),
    ) else {
        report.warn(format!(
            "{} has no document columns; media links are not imported",
            table.name
        ));
        return Ok(());
    };
    let rec_table = actual_column(table, "rec_table");
    let rec_id = actual_column(table, "rec_id");
    let rec_db_id = actual_column(table, "rec_db_id");
    let columns = selected(
        table,
        &["d_id", "d_db_id", "rec_id", "rec_db_id", "rec_table"],
    );

    let mut broken = 0usize;
    for_each_row(connection, &table.name, &columns, file, |number, values| {
        let Some(document) = non_negative(number_of(values, Some(document_id))) else {
            report.warn(format!(
                "document link at row {number} in {} has no document; skipped",
                table.name
            ));
            return Ok(());
        };
        let Some(document_db) = number_of(values, Some(document_db)) else {
            report.warn(format!(
                "document link at row {number} in {} has no document; skipped",
                table.name
            ));
            return Ok(());
        };
        let Some(&index) = media_by_key.get(&record_key(document, document_db)) else {
            broken += 1;
            return Ok(());
        };
        if number_of(values, rec_table) != Some(PERSON_TABLE_CODE) {
            return Ok(());
        }
        let Some(target) = non_negative(number_of(values, rec_id)) else {
            broken += 1;
            return Ok(());
        };
        let Some(target_db) = number_of(values, rec_db_id) else {
            broken += 1;
            return Ok(());
        };
        let Some(person_id) = person_ids.get(&record_key(target, target_db)).copied() else {
            broken += 1;
            return Ok(());
        };
        // The first link wins: a document shared by two persons keeps one
        // owner, matching the one-person media record.
        if media[index].media.person_id.is_none() {
            media[index].media.person_id = Some(person_id);
        }
        Ok(())
    })?;
    if broken > 0 {
        report.warn(format!(
            "{broken} DocumentDetails link(s) reference a record that was not imported; ignored"
        ));
    }
    Ok(())
}

fn read_media(
    connection: &Connection,
    table: Option<&Table>,
    roots: &[PathBuf],
    file: &str,
    report: &mut ImportReport,
) -> Result<MediaRead, AppError> {
    let mut media_items = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let Some(table) = table else {
        return Ok(MediaRead {
            items: media_items,
            by_key,
        });
    };
    let (Some(id_column), Some(db_column)) =
        (actual_column(table, "id"), actual_column(table, "db_id"))
    else {
        report.warn(format!(
            "{} has no identity columns; document rows are not imported",
            table.name
        ));
        return Ok(MediaRead {
            items: media_items,
            by_key,
        });
    };
    let path_column = actual_column(table, "path");
    let preview_column = actual_column(table, "preview");

    let mut selection = vec![quote_ident(id_column), quote_ident(db_column)];
    if let Some(column) = path_column {
        selection.push(quote_ident(column));
    }
    if let Some(column) = preview_column {
        selection.push(quote_ident(column));
    }
    let sql = format!(
        "SELECT {} FROM {}",
        selection.join(", "),
        quote_ident(&table.name)
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|err| parse_error(file, format!("cannot read table {}: {err}", table.name)))?;
    let mut rows = statement
        .query([])
        .map_err(|err| parse_error(file, format!("cannot read table {}: {err}", table.name)))?;

    let mut number = 0usize;
    loop {
        let row = rows
            .next()
            .map_err(|err| parse_error(file, format!("cannot read table {}: {err}", table.name)))?;
        let Some(row) = row else { break };
        number += 1;

        let id = integer_cell(row, 0, &table.name, file)?;
        let db_id = integer_cell(row, 1, &table.name, file)?;
        let (Some(id), Some(db_id)) = (id, db_id) else {
            report.warn(format!(
                "document at row {number} in {} has no identifier; skipped",
                table.name
            ));
            continue;
        };

        let mut index = 2usize;
        let path_value = if path_column.is_some() {
            let value = text_cell(row, index, &table.name, file)?;
            index += 1;
            value
        } else {
            None
        };
        let preview = if preview_column.is_some() {
            blob_cell(row, index, &table.name, file)?
        } else {
            None
        };

        let sanitized = path_value.as_deref().and_then(sanitize_file_name);
        let from_disk = sanitized
            .as_ref()
            .and_then(|name| find_media_file(name, roots).map(|path| (name, path)));

        let (name, mime_type, checksum, source, bytes) = if let Some((name, path)) = from_disk {
            let Ok(checksum) = sha256_file(&path) else {
                report.warn(format!(
                    "document file referenced by row {number} in {} cannot be read; skipped",
                    table.name
                ));
                continue;
            };
            (
                name.clone(),
                guess_mime(name).to_owned(),
                checksum,
                Some(path),
                None,
            )
        } else if let Some(bytes) = preview {
            // A real export also stores the preview JPEG inside the database.
            // The reference importer hashes those bytes; the `.files` copy
            // above wins when it exists.
            if !looks_like_jpeg(&bytes) {
                report.warn(format!(
                    "document preview at row {number} in {} is not a JPEG; skipped",
                    table.name
                ));
                continue;
            }
            let name = sanitized.unwrap_or_else(|| format!("at5-preview-{id}.jpg"));
            let checksum = sha256_bytes(&bytes);
            (name, "image/jpeg".to_owned(), checksum, None, Some(bytes))
        } else {
            report.warn(format!(
                "document at row {number} in {} has neither a file nor a preview; skipped",
                table.name
            ));
            continue;
        };

        let item = at5_media(name, checksum, mime_type, None);
        if let Err(err) = item.validate() {
            report.warn(format!(
                "document at row {number} in {} failed validation ({}); skipped",
                table.name, err.code
            ));
            continue;
        }
        by_key.insert(record_key(id, db_id), media_items.len());
        media_items.push(At5MediaFile {
            media: item,
            source,
            bytes,
        });
    }
    Ok(MediaRead {
        items: media_items,
        by_key,
    })
}

fn integer_cell(
    row: &Row<'_>,
    index: usize,
    table: &str,
    file: &str,
) -> Result<Option<i64>, AppError> {
    match row.get_ref(index) {
        Ok(ValueRef::Integer(value)) => Ok(Some(value)),
        Ok(ValueRef::Real(value)) => Ok(value.to_string().parse().ok()),
        Ok(ValueRef::Text(bytes)) => Ok(String::from_utf8_lossy(bytes).trim().parse().ok()),
        Ok(ValueRef::Null | ValueRef::Blob(_)) => Ok(None),
        Err(err) => Err(parse_error(
            file,
            format!("cannot read {table} column {index}: {err}"),
        )),
    }
}

fn text_cell(
    row: &Row<'_>,
    index: usize,
    table: &str,
    file: &str,
) -> Result<Option<String>, AppError> {
    match row.get_ref(index) {
        Ok(ValueRef::Text(bytes)) => Ok(Some(String::from_utf8_lossy(bytes).into_owned())),
        Ok(ValueRef::Integer(value)) => Ok(Some(value.to_string())),
        Ok(ValueRef::Real(value)) => Ok(Some(value.to_string())),
        Ok(ValueRef::Null | ValueRef::Blob(_)) => Ok(None),
        Err(err) => Err(parse_error(
            file,
            format!("cannot read {table} column {index}: {err}"),
        )),
    }
}

fn blob_cell(
    row: &Row<'_>,
    index: usize,
    table: &str,
    file: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    match row.get_ref(index) {
        Ok(ValueRef::Blob(bytes)) => Ok(Some(bytes.to_vec())),
        Ok(_) => Ok(None),
        Err(err) => Err(parse_error(
            file,
            format!("cannot read {table} column {index}: {err}"),
        )),
    }
}

/// Same check as `looksLikeJpeg` in the reference service.
fn looks_like_jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == 0xff
        && bytes[1] == 0xd8
        && bytes[2] == 0xff
        && bytes[bytes.len() - 2] == 0xff
        && bytes[bytes.len() - 1] == 0xd9
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date_row(values: &[(&str, &str)]) -> (Vec<String>, Vec<Option<String>>) {
        let mut columns = Vec::new();
        let mut cells = Vec::new();
        for (name, value) in values {
            columns.push((*name).to_owned());
            cells.push(Some((*value).to_owned()));
        }
        (columns, cells)
    }

    #[test]
    fn exact_year_keeps_precision_and_original() {
        let (columns, cells) = date_row(&[("type", "0"), ("y", "1950")]);
        let row = RowValues {
            columns: &columns,
            values: cells,
        };
        let date_columns = DateColumns {
            kind: Some("type".into()),
            y: Some("y".into()),
            ..DateColumns::default()
        };
        let (date, problems) = parse_event_date(&row, &date_columns);
        assert!(problems.is_empty());
        assert_eq!(date.precision, DatePrecision::Year);
        assert_eq!(date.qualifier, DateQualifier::Exact);
        assert_eq!(date.original.as_deref(), Some("1950"));
        date.validate().unwrap();
    }

    #[test]
    fn non_zero_type_loses_the_qualifier() {
        let (columns, cells) = date_row(&[("type", "2"), ("y", "1950"), ("m", "5")]);
        let row = RowValues {
            columns: &columns,
            values: cells,
        };
        let date_columns = DateColumns {
            kind: Some("type".into()),
            y: Some("y".into()),
            m: Some("m".into()),
            ..DateColumns::default()
        };
        let (date, problems) = parse_event_date(&row, &date_columns);
        assert_eq!(date.qualifier, DateQualifier::Unknown);
        assert_eq!(date.precision, DatePrecision::Month);
        assert_eq!(problems.len(), 1);
        date.validate().unwrap();
    }

    #[test]
    fn julian_range_and_partial_year_are_unknown() {
        for (values, column) in [
            (vec![("isjulian", "1"), ("y", "1950")], "julian"),
            (
                vec![("y", "1950"), ("d2", "1"), ("m2", "2"), ("y2", "1951")],
                "range",
            ),
            (vec![("y", "1950"), ("unknownyeardigits", "2")], "partial"),
        ] {
            let (columns, cells) = date_row(&values);
            let row = RowValues {
                columns: &columns,
                values: cells,
            };
            let date_columns = DateColumns {
                y: Some("y".into()),
                d2: Some("d2".into()),
                m2: Some("m2".into()),
                y2: Some("y2".into()),
                julian: Some("isjulian".into()),
                unknown_digits: Some("unknownyeardigits".into()),
                ..DateColumns::default()
            };
            let (date, problems) = parse_event_date(&row, &date_columns);
            assert_eq!(date, DateValue::unknown(None), "{column}");
            assert_eq!(date.precision, DatePrecision::Unknown, "{column}");
            assert!(!problems.is_empty(), "{column}");
            let _ = column;
        }
    }
}
