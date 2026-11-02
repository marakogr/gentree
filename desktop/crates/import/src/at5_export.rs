//! AT5 export writer.
//!
//! The writer produces a small EAV database that the read-only [`crate::at5`]
//! importer understands: `Persons`, `Events`, `EventTypes`, `EventDetails`,
//! `ValuesStr`, `ValuesDates`, `Documents`, `DocumentDetails`, `Fields` and
//! `Global`. It is intentionally a *Gentree exchange* subset of AT5, not a
//! full Древо Жизни 5 database: the application has no verified writer for the
//! other 15 tables, their indexes and triggers.
//!
//! Relationships are encoded the way the importer derives them: a `BIRT` event
//! lists the child and the parents, and a `MARR` event lists both spouses.
//! Media files are written next to the database in `<stem>.files`; this module
//! only writes their names and person links, the archive writer copies bytes.
//!
//! Everything the subset cannot represent is reported in
//! [`ExportReport::warnings`]; no field value is repeated in a warning.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use gentree_core::date::{days_in_month, CivilDate, DatePrecision, DateQualifier, DateValue};
use gentree_core::person::{Gender, NameType, Person};
use gentree_core::record::{Event, EventType, Media};
use gentree_core::relationship::{Relationship, RelationshipType};
use rusqlite::{params, Connection, Transaction};
use uuid::Uuid;

use crate::gedcom::ExportReport;

/// All records use one database namespace; AT5 supports several linked files.
const DB_ID: i64 = 1;
/// `Fields.tablecode` for `Persons`.
const PERSON_TABLE: i64 = 13;
/// `ValuesDates.rec_table` for `Events`.
const EVENT_TABLE: i64 = 7;

const FIELD_SURNAME: i64 = 64;
const FIELD_MAIDEN: i64 = 65;
const FIELD_GIVEN: i64 = 66;
const FIELD_PATRONYMIC: i64 = 67;
const FIELD_BIOGRAPHY: i64 = 89;

/// AT5 preview length for long texts; the full value goes to `vblob`.
const PREVIEW_CHARS: usize = 150;
/// The importer skips person name values longer than this.
const NAME_CHARS: usize = 200;

const SCHEMA: &str = "
    CREATE TABLE Persons (
        id INTEGER, db_id INTEGER, sex INTEGER, lifespan TEXT,
        birth_id INTEGER, birth_db_id INTEGER,
        death_id INTEGER, death_db_id INTEGER, isfav INTEGER
    );
    CREATE TABLE Events (
        id INTEGER, db_id INTEGER, et_id INTEGER, et_db_id INTEGER,
        isfav INTEGER, alive INTEGER
    );
    CREATE TABLE EventTypes (
        id INTEGER, db_id INTEGER, namelocale TEXT, gedname TEXT,
        showoncreate INTEGER, ord INTEGER
    );
    CREATE TABLE EventDetails (
        id INTEGER, db_id INTEGER, p_id INTEGER, p_db_id INTEGER,
        e_id INTEGER, e_db_id INTEGER, er_id INTEGER, er_db_id INTEGER,
        e_ord INTEGER, p_ord INTEGER
    );
    CREATE TABLE ValuesStr (
        f_id INTEGER, f_db_id INTEGER, rec_id INTEGER, rec_db_id INTEGER,
        rec_table INTEGER, lang_id INTEGER, vstr TEXT, vblob BLOB,
        lconf INTEGER, ltrust INTEGER, comment TEXT
    );
    CREATE TABLE ValuesDates (
        f_id INTEGER, f_db_id INTEGER, rec_id INTEGER, rec_db_id INTEGER,
        rec_table INTEGER, d INTEGER, m INTEGER, y INTEGER,
        d2 INTEGER, m2 INTEGER, y2 INTEGER,
        isjulian INTEGER, isdateBC INTEGER, isdate2BC INTEGER, type INTEGER,
        sortdate INTEGER, sortdate2 INTEGER, sortdate3 INTEGER, sortdate4 INTEGER,
        lconf INTEGER, ltrust INTEGER, comment TEXT,
        unknownyeardigits INTEGER, id INTEGER
    );
    CREATE TABLE Documents (
        id INTEGER, db_id INTEGER, path TEXT, preview BLOB,
        previewage REAL, isfav INTEGER
    );
    CREATE TABLE DocumentDetails (
        id INTEGER, db_id INTEGER, d_id INTEGER, d_db_id INTEGER,
        rec_id INTEGER, rec_db_id INTEGER, rec_table INTEGER,
        d_ord INTEGER, r_ord INTEGER, x1 FLOAT, y1 FLOAT, x2 FLOAT, y2 FLOAT
    );
    CREATE TABLE Fields (
        id INTEGER, db_id INTEGER, tablecode INTEGER, ord INTEGER, datatype INTEGER
    );
    CREATE TABLE Global (
        id INTEGER, guid TEXT, mainlang_id INTEGER, version TEXT
    );
";

/// One event under construction. `participants` keeps the owner first, which is
/// the order the importer uses to choose the event owner.
struct PlannedEvent {
    tag: String,
    date: DateValue,
    participants: Vec<Uuid>,
}

/// Write a deterministic-enough AT5 exchange database to `path`.
///
/// `media_names` is parallel to `media`: `Some(name)` means the bytes were
/// copied to `<stem>.files/<name>` and the row should reference it; `None`
/// means the file is missing and the row is skipped.
pub(crate) fn write_at5(
    path: &Path,
    persons: &[Person],
    relationships: &[Relationship],
    events: &[Event],
    media: &[Media],
    media_names: &[Option<String>],
    report: &mut ExportReport,
) -> Result<(), String> {
    let person_index = index_persons(persons)?;
    let (planned, birth, death) =
        plan_events(persons, &person_index, relationships, events, report);

    let mut connection =
        Connection::open(path).map_err(|_| "cannot create AT5 database".to_owned())?;
    connection
        .execute_batch(SCHEMA)
        .map_err(|_| "cannot create AT5 schema".to_owned())?;

    let transaction = connection
        .transaction()
        .map_err(|_| "cannot start AT5 export".to_owned())?;

    write_fields(&transaction)?;
    write_global(&transaction)?;
    let tag_ids = write_event_types(&transaction, &planned)?;

    for (index, person) in persons.iter().enumerate() {
        write_person(
            &transaction,
            index as i64 + 1,
            person,
            birth.get(&person.id).map(|value| *value as i64 + 1),
            death.get(&person.id).map(|value| *value as i64 + 1),
            report,
        )?;
    }

    write_events(&transaction, &planned, &tag_ids, &person_index, report)?;
    write_media(&transaction, media, media_names, &person_index, report)?;

    transaction
        .commit()
        .map_err(|_| "cannot finish AT5 export".to_owned())?;
    connection
        .close()
        .map_err(|_| "cannot close AT5 export".to_owned())?;
    Ok(())
}

/// Index every person by id. Duplicate ids make the database ambiguous.
fn index_persons(persons: &[Person]) -> Result<HashMap<Uuid, usize>, String> {
    let mut index = HashMap::with_capacity(persons.len());
    for (position, person) in persons.iter().enumerate() {
        if index.insert(person.id, position).is_some() {
            return Err("duplicate person id in the export set".to_owned());
        }
    }
    Ok(index)
}

/// Build the event list and the person->birth/death event links.
///
/// The existing events keep their dates and tags. Synthetic events are added
/// only where the importer needs one to rebuild a relationship: a `BIRT` for a
/// child with parents and a `MARR` for a spouse pair without a marriage event.
fn plan_events(
    persons: &[Person],
    person_index: &HashMap<Uuid, usize>,
    relationships: &[Relationship],
    events: &[Event],
    report: &mut ExportReport,
) -> (
    Vec<PlannedEvent>,
    HashMap<Uuid, usize>,
    HashMap<Uuid, usize>,
) {
    let mut planned: Vec<PlannedEvent> = Vec::with_capacity(events.len());
    let mut birth: HashMap<Uuid, usize> = HashMap::new();
    let mut death: HashMap<Uuid, usize> = HashMap::new();
    let mut marriages: Vec<usize> = Vec::new();

    for event in events {
        if !person_index.contains_key(&event.person_id) {
            report.warn("event references a person outside the export; skipped");
            continue;
        }
        if event.place.is_some() || event.description.is_some() || !event.source_ids.is_empty() {
            report.warn("event places, descriptions and citations are not exported to AT5");
        }
        let tag = event_tag(event);
        let participants = event_participants(event, relationships, person_index, report);
        if event.event_type == EventType::Marriage
            && !has_spouse_pair(&participants, relationships, person_index)
        {
            report.warn("a marriage event without a spouse relationship is not exported to AT5");
            continue;
        }
        let position = planned.len();
        planned.push(PlannedEvent {
            tag,
            date: event.date.clone(),
            participants,
        });
        match event.event_type {
            EventType::Birth => {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    birth.entry(event.person_id)
                {
                    entry.insert(position);
                } else {
                    report.warn(
                        "a person has more than one birth event; only the first is linked in AT5",
                    );
                }
            }
            EventType::Death => {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    death.entry(event.person_id)
                {
                    entry.insert(position);
                } else {
                    report.warn(
                        "a person has more than one death event; only the first is linked in AT5",
                    );
                }
            }
            EventType::Marriage => marriages.push(position),
            _ => {}
        }
    }

    // A person date without an event still has to become an event, otherwise
    // the importer has no date to read.
    for person in persons {
        match birth.get(&person.id).copied() {
            Some(position) if has_date(&person.birth) => {
                // The person date is the field the UI edits; keep it
                // authoritative for the event the importer reads back.
                planned[position].date = person.birth.clone();
            }
            Some(_) => {}
            None if has_date(&person.birth) => {
                let position = planned.len();
                planned.push(PlannedEvent {
                    tag: "BIRT".to_owned(),
                    date: person.birth.clone(),
                    participants: vec![person.id],
                });
                birth.insert(person.id, position);
            }
            None => {}
        }
        match death.get(&person.id).copied() {
            Some(position) if has_date(&person.death) => {
                planned[position].date = person.death.clone();
            }
            Some(_) => {}
            None if has_date(&person.death) => {
                let position = planned.len();
                planned.push(PlannedEvent {
                    tag: "DEAT".to_owned(),
                    date: person.death.clone(),
                    participants: vec![person.id],
                });
                death.insert(person.id, position);
            }
            None => {}
        }
    }

    let mut parents_of: BTreeMap<Uuid, Vec<Uuid>> = BTreeMap::new();
    for relationship in relationships {
        if !relationship.rel_type.is_parent() {
            continue;
        }
        if !person_index.contains_key(&relationship.person_id)
            || !person_index.contains_key(&relationship.related_person_id)
        {
            report.warn("relationship references a person outside the export; skipped");
            continue;
        }
        if relationship.rel_type == RelationshipType::AdoptiveParentChild {
            report.warn(
                "adoptive parentage is exported as a parent-child link; AT5 has no adoption flag",
            );
        }
        let parents = parents_of
            .entry(relationship.related_person_id)
            .or_default();
        if !parents.contains(&relationship.person_id) {
            parents.push(relationship.person_id);
        }
    }

    for (child, parents) in &parents_of {
        let position = match birth.get(child) {
            Some(position) => *position,
            None => {
                let person = &persons[person_index[child]];
                let position = planned.len();
                planned.push(PlannedEvent {
                    tag: "BIRT".to_owned(),
                    date: person.birth.clone(),
                    participants: vec![*child],
                });
                birth.insert(*child, position);
                position
            }
        };
        let mut participants = vec![*child];
        for parent in parents {
            if !participants.contains(parent) {
                participants.push(*parent);
            }
        }
        if participants.len() > 3 {
            report
                .warn("a child has more than two parents; only the first two are exported to AT5");
            participants.truncate(3);
        }
        planned[position].participants = participants;
    }

    // The importer derives parent-child edges from the participants of a BIRT
    // event. Keep a plain birth event to the subject alone.
    for position in birth.values() {
        let subject = planned[*position].participants[0];
        if !parents_of.contains_key(&subject) {
            planned[*position].participants = vec![subject];
        }
    }

    let mut spouse_pairs: Vec<(Uuid, Uuid)> = Vec::new();
    for relationship in relationships {
        if !relationship.rel_type.is_spouse() {
            continue;
        }
        if !person_index.contains_key(&relationship.person_id)
            || !person_index.contains_key(&relationship.related_person_id)
        {
            report.warn("relationship references a person outside the export; skipped");
            continue;
        }
        if relationship.rel_type == RelationshipType::Partner {
            report.warn("partner relationships are exported as marriages; AT5 has no partner type");
        }
        let pair = ordered_pair(relationship.person_id, relationship.related_person_id);
        if !spouse_pairs.contains(&pair) {
            spouse_pairs.push(pair);
        }
    }

    let mut used_marriages: HashSet<usize> = HashSet::new();
    for (first, second) in spouse_pairs {
        let existing = marriages.iter().copied().find(|position| {
            !used_marriages.contains(position)
                && same_pair(&planned[*position].participants, first, second)
        });
        match existing {
            Some(position) => {
                used_marriages.insert(position);
            }
            None => {
                let position = planned.len();
                planned.push(PlannedEvent {
                    tag: "MARR".to_owned(),
                    date: DateValue::default(),
                    participants: vec![first, second],
                });
                marriages.push(position);
                used_marriages.insert(position);
                report.warn(
                    "a spouse relationship without a marriage event is exported as an undated marriage",
                );
            }
        }
    }

    (planned, birth, death)
}

/// Owner plus co-participants, filtered to the exported persons.
fn event_participants(
    event: &Event,
    relationships: &[Relationship],
    person_index: &HashMap<Uuid, usize>,
    report: &mut ExportReport,
) -> Vec<Uuid> {
    let mut participants = vec![event.person_id];
    match event.event_type {
        EventType::Birth | EventType::Death => {
            if !event.participant_ids.is_empty() {
                report.warn("participants on birth or death events are not exported to AT5");
            }
        }
        EventType::Marriage => {
            let partner = event
                .participant_ids
                .iter()
                .find(|participant| {
                    person_index.contains_key(participant)
                        && has_spouse_link(
                            &event.person_id,
                            participant,
                            relationships,
                            person_index,
                        )
                })
                .copied()
                .or_else(|| {
                    event
                        .participant_ids
                        .iter()
                        .find(|participant| person_index.contains_key(participant))
                        .copied()
                })
                .or_else(|| sole_spouse(&event.person_id, relationships, person_index));
            if let Some(partner) = partner {
                participants.push(partner);
            }
            if event.participant_ids.len() > 1 {
                report.warn(
                    "a marriage event has more than two participants; only one spouse is exported to AT5",
                );
            }
        }
        _ => {
            for participant in &event.participant_ids {
                if person_index.contains_key(participant) && !participants.contains(participant) {
                    participants.push(*participant);
                }
            }
        }
    }
    participants
}

fn has_spouse_link(
    person: &Uuid,
    partner: &Uuid,
    relationships: &[Relationship],
    person_index: &HashMap<Uuid, usize>,
) -> bool {
    relationships.iter().any(|relationship| {
        relationship.rel_type.is_spouse()
            && person_index.contains_key(&relationship.person_id)
            && person_index.contains_key(&relationship.related_person_id)
            && ((relationship.person_id == *person && relationship.related_person_id == *partner)
                || (relationship.person_id == *partner
                    && relationship.related_person_id == *person))
    })
}

fn sole_spouse(
    person: &Uuid,
    relationships: &[Relationship],
    person_index: &HashMap<Uuid, usize>,
) -> Option<Uuid> {
    let mut spouses = relationships
        .iter()
        .filter(|relationship| relationship.rel_type.is_spouse())
        .filter(|relationship| {
            person_index.contains_key(&relationship.person_id)
                && person_index.contains_key(&relationship.related_person_id)
        })
        .filter_map(|relationship| {
            if relationship.person_id == *person {
                Some(relationship.related_person_id)
            } else if relationship.related_person_id == *person {
                Some(relationship.person_id)
            } else {
                None
            }
        });
    let first = spouses.next()?;
    spouses.next().is_none().then_some(first)
}

fn has_spouse_pair(
    participants: &[Uuid],
    relationships: &[Relationship],
    person_index: &HashMap<Uuid, usize>,
) -> bool {
    participants.len() == 2
        && has_spouse_link(
            &participants[0],
            &participants[1],
            relationships,
            person_index,
        )
}

fn ordered_pair(first: Uuid, second: Uuid) -> (Uuid, Uuid) {
    if first < second {
        (first, second)
    } else {
        (second, first)
    }
}

fn same_pair(participants: &[Uuid], first: Uuid, second: Uuid) -> bool {
    participants.len() == 2
        && ((participants[0] == first && participants[1] == second)
            || (participants[0] == second && participants[1] == first))
}

fn event_tag(event: &Event) -> String {
    let tag = match event.event_type {
        EventType::Birth => "BIRT",
        EventType::Death => "DEAT",
        EventType::Marriage => "MARR",
        EventType::Divorce => "DIV",
        EventType::Burial => "BURI",
        EventType::Residence => "RESI",
        EventType::Occupation => "OCCU",
        EventType::Education => "EDUC",
        EventType::Other => event.original_type.as_deref().unwrap_or("EVENT"),
    };
    let tag = tag.trim().to_ascii_uppercase();
    if valid_tag(&tag) {
        tag
    } else {
        "EVENT".to_owned()
    }
}

fn valid_tag(tag: &str) -> bool {
    let mut characters = tag.chars();
    match characters.next() {
        Some(first) if first.is_ascii_uppercase() => {}
        _ => return false,
    }
    tag.len() <= 64
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn has_date(date: &DateValue) -> bool {
    date.start.is_some()
        || date.end.is_some()
        || date
            .original
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
}

/// Day, month, year and the AT5 qualifier code.
type DateComponents = (Option<i64>, Option<i64>, Option<i64>, i64);

/// AT5 date triple plus its qualifier code. Ranges keep their start only.
fn date_components(date: &DateValue) -> Option<DateComponents> {
    let point = bound_date(date)?;
    if !(1..=9999).contains(&point.year) {
        return None;
    }
    let (day, month) = match date.precision {
        DatePrecision::Day => (Some(i64::from(point.day)), Some(i64::from(point.month))),
        DatePrecision::Month => (None, Some(i64::from(point.month))),
        DatePrecision::Year => (None, None),
        DatePrecision::Unknown => return None,
    };
    let kind = match date.qualifier {
        DateQualifier::Exact => 0,
        DateQualifier::Approximate => 1,
        DateQualifier::Before => 2,
        DateQualifier::After => 3,
        DateQualifier::Range => 4,
        DateQualifier::Unknown => 1,
    };
    Some((day, month, Some(i64::from(point.year)), kind))
}

/// The single point AT5 can store. A `BEFORE` date is bounded by an exclusive
/// `end`, so step back by one day/month/year according to its precision.
fn bound_date(date: &DateValue) -> Option<CivilDate> {
    match date.qualifier {
        DateQualifier::Before => {
            let end = date.end?;
            match date.precision {
                DatePrecision::Day => Some(previous_day(end)),
                DatePrecision::Month => Some(previous_month(end)),
                DatePrecision::Year => Some(CivilDate {
                    year: end.year - 1,
                    month: 1,
                    day: 1,
                }),
                DatePrecision::Unknown => None,
            }
        }
        _ => date.start,
    }
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

fn previous_month(date: CivilDate) -> CivilDate {
    if date.month > 1 {
        CivilDate {
            month: date.month - 1,
            day: 1,
            ..date
        }
    } else {
        CivilDate {
            year: date.year - 1,
            month: 12,
            day: 1,
        }
    }
}

fn write_fields(transaction: &Transaction<'_>) -> Result<(), String> {
    for (ord, field) in [
        FIELD_SURNAME,
        FIELD_MAIDEN,
        FIELD_GIVEN,
        FIELD_PATRONYMIC,
        FIELD_BIOGRAPHY,
    ]
    .into_iter()
    .enumerate()
    {
        transaction
            .execute(
                "INSERT INTO Fields (id, db_id, tablecode, ord, datatype) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![field, DB_ID, PERSON_TABLE, ord as i64, 12],
            )
            .map_err(|_| "cannot write AT5 fields".to_owned())?;
    }
    Ok(())
}

fn write_global(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO Global (id, guid, mainlang_id, version) VALUES (1, ?1, 0, ?2)",
            params![Uuid::now_v7().to_string(), "gentree-export"],
        )
        .map_err(|_| "cannot write AT5 metadata".to_owned())?;
    Ok(())
}

fn write_event_types(
    transaction: &Transaction<'_>,
    events: &[PlannedEvent],
) -> Result<HashMap<String, i64>, String> {
    let mut ids: HashMap<String, i64> = HashMap::new();
    let mut next = 1i64;
    for event in events {
        if ids.contains_key(&event.tag) {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO EventTypes (id, db_id, namelocale, gedname, showoncreate, ord) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![next, DB_ID, event.tag, event.tag, next],
            )
            .map_err(|_| "cannot write AT5 event types".to_owned())?;
        ids.insert(event.tag.clone(), next);
        next += 1;
    }
    Ok(ids)
}

fn write_person(
    transaction: &Transaction<'_>,
    id: i64,
    person: &Person,
    birth_id: Option<i64>,
    death_id: Option<i64>,
    report: &mut ExportReport,
) -> Result<(), String> {
    let sex = match person.gender {
        Gender::Male => 1,
        Gender::Female => 2,
        Gender::Unknown => 0,
    };
    transaction
        .execute(
            "INSERT INTO Persons (id, db_id, sex, lifespan, birth_id, birth_db_id, death_id, death_db_id, isfav) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, 0)",
            params![
                id,
                DB_ID,
                sex,
                birth_id,
                birth_id.map(|_| DB_ID),
                death_id,
                death_id.map(|_| DB_ID)
            ],
        )
        .map_err(|_| "cannot write AT5 persons".to_owned())?;

    write_names(transaction, id, person, report)?;
    if let Some(notes) = trimmed(person.notes.as_deref()) {
        let preview = truncate_chars(notes, PREVIEW_CHARS);
        insert_text(
            transaction,
            FIELD_BIOGRAPHY,
            id,
            preview,
            Some(notes.as_bytes()),
        )?;
    }
    if !person.external_ids.is_empty() {
        report.warn("external IDs are not exported to AT5");
    }
    Ok(())
}

fn write_names(
    transaction: &Transaction<'_>,
    person_id: i64,
    person: &Person,
    report: &mut ExportReport,
) -> Result<(), String> {
    let Some(primary) = person
        .names
        .iter()
        .find(|name| name.is_primary)
        .or_else(|| person.names.first())
    else {
        return Ok(());
    };

    for (field, value) in [
        (FIELD_GIVEN, primary.given.as_deref()),
        (FIELD_SURNAME, primary.surname.as_deref()),
        (FIELD_PATRONYMIC, primary.patronymic.as_deref()),
    ] {
        let Some(value) = trimmed(value) else {
            continue;
        };
        let truncated = truncate_chars(value, NAME_CHARS);
        if truncated.len() != value.len() {
            report.warn("a name value is truncated to the AT5 limit");
        }
        insert_text(transaction, field, person_id, truncated, None)?;
    }
    if trimmed(primary.prefix.as_deref()).is_some() || trimmed(primary.suffix.as_deref()).is_some()
    {
        report.warn("name prefixes and suffixes are not exported to AT5");
    }

    let maiden = person.names.iter().find(|name| {
        !name.is_primary
            && name.name_type == NameType::Married
            && trimmed(name.surname.as_deref()).is_some()
    });
    if let Some(maiden) = maiden {
        if let Some(surname) = trimmed(maiden.surname.as_deref()) {
            let surname = truncate_chars(surname, NAME_CHARS);
            insert_text(transaction, FIELD_MAIDEN, person_id, surname, None)?;
        }
        if trimmed(maiden.given.as_deref()).is_some()
            || trimmed(maiden.patronymic.as_deref()).is_some()
        {
            report.warn("only the surname of a non-primary married name is exported to AT5");
        }
    }

    let additional = person.names.iter().filter(|name| {
        !name.is_primary
            && !std::ptr::eq(*name, maiden.unwrap_or(primary))
            && (trimmed(name.given.as_deref()).is_some()
                || trimmed(name.surname.as_deref()).is_some()
                || trimmed(name.patronymic.as_deref()).is_some())
    });
    if additional.count() > 0 {
        report.warn("additional names are not exported to AT5; only the primary name is kept");
    }
    Ok(())
}

fn write_events(
    transaction: &Transaction<'_>,
    events: &[PlannedEvent],
    tag_ids: &HashMap<String, i64>,
    person_index: &HashMap<Uuid, usize>,
    report: &mut ExportReport,
) -> Result<(), String> {
    let mut detail_id = 0i64;
    let mut date_id = 0i64;
    let mut unresolved_date = false;
    let mut range = false;

    for (position, event) in events.iter().enumerate() {
        let event_id = position as i64 + 1;
        let type_id = tag_ids
            .get(&event.tag)
            .copied()
            .ok_or_else(|| "missing AT5 event type".to_owned())?;
        transaction
            .execute(
                "INSERT INTO Events (id, db_id, et_id, et_db_id, isfav, alive) VALUES (?1, ?2, ?3, ?4, 0, 0)",
                params![event_id, DB_ID, type_id, DB_ID],
            )
            .map_err(|_| "cannot write AT5 events".to_owned())?;

        match date_components(&event.date) {
            Some((day, month, year, kind)) => {
                date_id += 1;
                transaction
                    .execute(
                        "INSERT INTO ValuesDates (f_id, f_db_id, rec_id, rec_db_id, rec_table, d, m, y, d2, m2, y2, isjulian, isdateBC, isdate2BC, type, sortdate, sortdate2, sortdate3, sortdate4, lconf, ltrust, comment, unknownyeardigits, id) VALUES (0, ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, 0, 0, 0, ?8, NULL, NULL, NULL, NULL, 0, 0, NULL, 0, ?9)",
                        params![DB_ID, event_id, DB_ID, EVENT_TABLE, day, month, year, kind, date_id],
                    )
                    .map_err(|_| "cannot write AT5 dates".to_owned())?;
                if event.date.qualifier == DateQualifier::Range {
                    range = true;
                }
            }
            None if has_date(&event.date) => unresolved_date = true,
            None => {}
        }

        let mut seen = HashSet::new();
        for (order, person) in event.participants.iter().enumerate() {
            if !seen.insert(*person) {
                continue;
            }
            let Some(index) = person_index.get(person).copied() else {
                report.warn("an event participant is outside the export; skipped");
                continue;
            };
            detail_id += 1;
            transaction
                .execute(
                    "INSERT INTO EventDetails (id, db_id, p_id, p_db_id, e_id, e_db_id, er_id, er_db_id, e_ord, p_ord) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
                    params![
                        detail_id,
                        DB_ID,
                        index as i64 + 1,
                        DB_ID,
                        event_id,
                        DB_ID,
                        DB_ID,
                        order as i64,
                        order as i64
                    ],
                )
                .map_err(|_| "cannot write AT5 participants".to_owned())?;
        }
    }

    if unresolved_date {
        report.warn("dates without a supported calendar value are omitted from AT5");
    }
    if range {
        report.warn("date ranges are exported with their start date only");
    }
    Ok(())
}

fn write_media(
    transaction: &Transaction<'_>,
    media: &[Media],
    media_names: &[Option<String>],
    person_index: &HashMap<Uuid, usize>,
    report: &mut ExportReport,
) -> Result<(), String> {
    let mut document_id = 0i64;
    let mut detail_id = 0i64;
    for (position, item) in media.iter().enumerate() {
        let Some(name) = media_names.get(position).and_then(Option::as_ref) else {
            continue;
        };
        if item
            .caption
            .as_deref()
            .is_some_and(|caption| !caption.trim().is_empty())
        {
            report.warn("media captions are not exported to AT5");
        }
        if item.primary {
            report.warn("profile photo flags are not exported to AT5");
        }
        document_id += 1;
        transaction
            .execute(
                "INSERT INTO Documents (id, db_id, path, preview, previewage, isfav) VALUES (?1, ?2, ?3, NULL, NULL, 0)",
                params![document_id, DB_ID, name],
            )
            .map_err(|_| "cannot write AT5 documents".to_owned())?;
        let Some(person_id) = item.person_id else {
            continue;
        };
        let Some(index) = person_index.get(&person_id).copied() else {
            report.warn("media linked to a person outside the export; link omitted");
            continue;
        };
        detail_id += 1;
        transaction
            .execute(
                "INSERT INTO DocumentDetails (id, db_id, d_id, d_db_id, rec_id, rec_db_id, rec_table, d_ord, r_ord, x1, y1, x2, y2) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, NULL, NULL, NULL, NULL)",
                params![
                    detail_id,
                    DB_ID,
                    document_id,
                    DB_ID,
                    index as i64 + 1,
                    DB_ID,
                    PERSON_TABLE
                ],
            )
            .map_err(|_| "cannot write AT5 media links".to_owned())?;
    }
    Ok(())
}

fn insert_text(
    transaction: &Transaction<'_>,
    field: i64,
    person_id: i64,
    value: &str,
    blob: Option<&[u8]>,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO ValuesStr (f_id, f_db_id, rec_id, rec_db_id, rec_table, lang_id, vstr, vblob, lconf, ltrust, comment) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, 0, 0, NULL)",
            params![field, DB_ID, person_id, DB_ID, PERSON_TABLE, value, blob],
        )
        .map_err(|_| "cannot write AT5 values".to_owned())?;
    Ok(())
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// At most `max` Unicode scalar values, never splitting a character.
fn truncate_chars(value: &str, max: usize) -> &str {
    match value.char_indices().nth(max) {
        Some((index, _)) => &value[..index],
        None => value,
    }
}
