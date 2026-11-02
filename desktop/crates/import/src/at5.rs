//! AT5 (SQLite) reader: read-only introspection, no schema assumptions.
//! Contract: design.md §12, ADR-0013.
//!
//! The file is opened with [`OpenFlags::SQLITE_OPEN_READ_ONLY`] and is never
//! written. Column names are resolved through alias tables instead of a fixed
//! layout; everything the importer does not recognise ends up in
//! [`ImportReport::warnings`], every unparsed date stays in
//! [`DateValue::original`] with precision `UNKNOWN`.
//!
//! [`read_at5_bundle`] is the full read path: persons, parent/child and spouse
//! relationships, events and media metadata from the `.files` folder next to
//! the database, then from any extra media folders the user picked
//! ([`read_at5_bundle_with_media_dirs`]). Media bytes are hashed here and copied
//! by the import command; this module stays read-only, so [`plan_at5`] is a dry
//! run that shares exactly the same code path.
//!
//! Two shapes are supported. A real export stores names and dates as EAV rows;
//! `eav` recognises it by `Fields` + `ValuesStr` + a `Persons` table without
//! name columns. Anything else falls back to the simplified person-table
//! mapping below, which is also what the synthetic fixtures use.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use gentree_core::date::{CivilDate, DatePrecision, DateValue};
use gentree_core::error::{codes, AppError};
use gentree_core::person::{ExternalId, Gender, Name, Person, PersonId};
use gentree_core::record::{Event, EventType, Media};
use gentree_core::relationship::{Relationship, RelationshipSet, RelationshipType};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::report::ImportReport;

mod eav;

/// Source label stored in [`ExternalId::source`] for rows read from AT5.
pub const SOURCE: &str = "AT5";

/// One imported media row plus the `.files` source it was hashed from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct At5MediaFile {
    pub media: Media,
    /// `.files` source, when the bytes live on disk.
    pub source: Option<PathBuf>,
    /// Preview bytes stored inside the database, when there is no file.
    pub bytes: Option<Vec<u8>>,
}

/// Everything one AT5 database yields, plus the import report.
///
/// Media entries carry metadata and a checksum; [`At5Bundle::media_files`]
/// points at the hashed `.files` source so the caller can copy the bytes into
/// the project. `report.conflicts` is empty here: conflicts are computed by
/// [`crate::dedupe::dedupe_persons`] against an existing project.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct At5Bundle {
    pub persons: Vec<Person>,
    pub relationships: Vec<Relationship>,
    pub events: Vec<Event>,
    pub media: Vec<Media>,
    /// Parallel to [`At5Bundle::media`] by index; used only to copy bytes.
    pub media_files: Vec<At5MediaFile>,
    pub report: ImportReport,
}

/// Read an AT5 database into [`At5Bundle`] without modifying anything.
///
/// The connection is read-only. A real export — `Fields` + `ValuesStr` + a
/// `Persons` table without name columns — is mapped through its EAV tables
/// (`ValuesStr`, `ValuesDates`, `EventDetails`, `Documents`); see `eav`.
/// Any other database is mapped by person-table column aliases; every other
/// table and column is reported as a warning. Problems inside a row (unparsed
/// date, unnamed person, unknown link target, missing media file) become
/// issues and never abort the import. Errors are returned only for structural
/// failures: a missing file, an unreadable database, no tables, or no
/// person-like table. Errors carry the file name, never an absolute path.
pub fn read_at5_bundle(path: &Path) -> Result<At5Bundle, AppError> {
    read_at5_bundle_with_media_dirs(path, &[])
}

/// [`read_at5_bundle`] with extra media folders, searched after `.files`.
///
/// A referenced file is looked up by its bare file name: first in the `.files`
/// folder next to the database, then in `media_dirs` in the given order. Only a
/// sanitised base name is ever joined to a folder, so a database value or a
/// folder entry cannot traverse outside it. Nothing is created or written.
pub fn read_at5_bundle_with_media_dirs(
    path: &Path,
    media_dirs: &[PathBuf],
) -> Result<At5Bundle, AppError> {
    let file = file_label(path);
    if !path.is_file() {
        return Err(
            AppError::new(codes::IO_ERROR, "AT5 database not found").with_param("file", file)
        );
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| parse_error(&file, format!("cannot open AT5 database read-only: {err}")))?;
    read_at5_connection(&connection, path, &file, media_dirs)
}

/// Dry-run variant of [`read_at5_bundle`]: counts, warnings and issues only.
///
/// This is the same read-only code path, so it creates, modifies and locks
/// nothing. It only knows the source file, so `conflicts` is always empty;
/// callers compare the bundle against an existing project with
/// [`crate::dedupe::dedupe_persons`] and write new entities only after the user
/// confirms the report.
pub fn plan_at5(path: &Path) -> Result<ImportReport, AppError> {
    plan_at5_with_media_dirs(path, &[])
}

/// [`plan_at5`] with the same extra media folders as
/// [`read_at5_bundle_with_media_dirs`].
pub fn plan_at5_with_media_dirs(
    path: &Path,
    media_dirs: &[PathBuf],
) -> Result<ImportReport, AppError> {
    Ok(read_at5_bundle_with_media_dirs(path, media_dirs)?.report)
}

/// Read every person from an AT5 database without modifying it.
///
/// # Deprecated
///
/// Use [`read_at5_bundle`], which also returns relationships, events and media.
/// This wrapper stays for callers that only need persons.
pub fn read_at5(path: &Path) -> Result<(Vec<Person>, ImportReport), AppError> {
    let bundle = read_at5_bundle(path)?;
    Ok((bundle.persons, bundle.report))
}

fn read_at5_connection(
    connection: &Connection,
    path: &Path,
    file: &str,
    media_dirs: &[PathBuf],
) -> Result<At5Bundle, AppError> {
    let mut report = ImportReport::default();
    let tables = list_tables(connection, file)?;
    if tables.is_empty() {
        return Err(parse_error(file, "AT5 database has no tables"));
    }
    if eav::is_eav_schema(&tables) {
        return eav::read_eav(connection, path, file, &tables, media_dirs);
    }

    let Some((chosen, mapping)) = pick_person_table(&tables) else {
        let names = tables
            .iter()
            .map(|table| table.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(parse_error(
            file,
            format!("no person table found in AT5 database (tables: {names})"),
        ));
    };
    let person_table = &tables[chosen];

    // Detect the auxiliary tables before the warnings, so a table the importer
    // understands is not reported as unknown.
    let relationship_tables = tables
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != chosen)
        .filter_map(|(index, table)| {
            RelationshipLayout::detect(&table.columns).map(|layout| (index, layout))
        })
        .collect::<Vec<_>>();
    let relationship_indices = relationship_tables
        .iter()
        .map(|(index, _)| *index)
        .collect::<HashSet<_>>();

    let event_tables = tables
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != chosen && !relationship_indices.contains(index))
        .filter_map(|(index, table)| {
            EventMapping::detect(&table.columns).map(|mapping| (index, mapping))
        })
        .collect::<Vec<_>>();
    let event_indices = event_tables
        .iter()
        .map(|(index, _)| *index)
        .collect::<HashSet<_>>();

    let media_tables = tables
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            *index != chosen
                && !relationship_indices.contains(index)
                && !event_indices.contains(index)
        })
        .filter_map(|(index, table)| {
            MediaMapping::detect(&table.columns).map(|mapping| (index, mapping))
        })
        .collect::<Vec<_>>();
    let media_indices = media_tables
        .iter()
        .map(|(index, _)| *index)
        .collect::<HashSet<_>>();

    let mut known = HashSet::from([chosen]);
    known.extend(relationship_indices.iter().copied());
    known.extend(event_indices.iter().copied());
    known.extend(media_indices.iter().copied());
    for (index, table) in tables.iter().enumerate() {
        if !known.contains(&index) {
            report.warn(format!("unknown table: {}", table.name));
        }
    }

    for column in person_table
        .columns
        .iter()
        .filter(|column| !mapping.uses(column))
    {
        report.warn(format!("unknown column: {}.{column}", person_table.name));
    }
    for (index, layout) in &relationship_tables {
        warn_unknown_columns(&tables[*index], &layout.columns(), &mut report);
    }
    for (index, event_mapping) in &event_tables {
        warn_unknown_columns(&tables[*index], &event_mapping.columns(), &mut report);
    }
    for (index, media_mapping) in &media_tables {
        warn_unknown_columns(&tables[*index], &media_mapping.columns(), &mut report);
    }
    if mapping.id.is_none() {
        report.warn(format!(
            "no identifier column in {}; persons get no external ids",
            person_table.name
        ));
    }

    let (persons, person_ids) =
        read_persons(connection, &person_table.name, &mapping, file, &mut report)?;
    report.persons = persons.len();

    let mut relationship_set = RelationshipSet::default();
    for (index, layout) in &relationship_tables {
        read_relationships(
            connection,
            &tables[*index].name,
            layout,
            &person_ids,
            file,
            &mut relationship_set,
            &mut report,
        )?;
    }
    let relationships = relationship_set.rows().to_vec();
    report.relationships = relationships.len();

    let mut events = Vec::new();
    for (index, event_mapping) in &event_tables {
        events.extend(read_events(
            connection,
            &tables[*index].name,
            event_mapping,
            &person_ids,
            file,
            &mut report,
        )?);
    }
    report.events = events.len();

    let roots = media_roots(path, media_dirs);
    let mut media_files = Vec::new();
    for (index, media_mapping) in &media_tables {
        media_files.extend(read_media_rows(
            connection,
            &tables[*index].name,
            media_mapping,
            &roots,
            file,
            &mut report,
        )?);
    }
    if media_tables.is_empty() {
        media_files = scan_media_roots(&roots, &mut report)?;
    }
    report.media = media_files.len();

    Ok(At5Bundle {
        persons,
        relationships,
        events,
        media: media_files.iter().map(|file| file.media.clone()).collect(),
        media_files,
        report,
    })
}

/// One table discovered in `sqlite_master`, ordered by name.
struct Table {
    name: String,
    columns: Vec<String>,
}

fn list_tables(connection: &Connection, file: &str) -> Result<Vec<Table>, AppError> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|err| parse_error(file, format!("cannot read sqlite_master: {err}")))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| parse_error(file, format!("cannot read sqlite_master: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| parse_error(file, format!("cannot read sqlite_master: {err}")))?;

    let mut tables = Vec::with_capacity(names.len());
    for name in names {
        let columns = table_columns(connection, &name, file)?;
        tables.push(Table { name, columns });
    }
    Ok(tables)
}

fn table_columns(
    connection: &Connection,
    table: &str,
    file: &str,
) -> Result<Vec<String>, AppError> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|err| parse_error(file, format!("cannot read columns of {table}: {err}")))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| parse_error(file, format!("cannot read columns of {table}: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| parse_error(file, format!("cannot read columns of {table}: {err}")))?;
    Ok(columns)
}

/// Pick the most person-like table: the one that maps the most column roles.
/// Ties resolve to the alphabetically first table (`list_tables` is ordered).
fn pick_person_table(tables: &[Table]) -> Option<(usize, Mapping)> {
    let mut best: Option<(usize, Mapping, usize)> = None;
    for (index, table) in tables.iter().enumerate() {
        let mapping = Mapping::detect(&table.columns);
        if mapping.given.is_none() && mapping.surname.is_none() {
            continue;
        }
        let score = mapping.matched();
        let better = match best.as_ref() {
            Some((_, _, best_score)) => score > *best_score,
            None => true,
        };
        if better {
            best = Some((index, mapping, score));
        }
    }
    best.map(|(index, mapping, _)| (index, mapping))
}

/// Column roles of a person that the importer knows how to map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Id,
    Given,
    Patronymic,
    Surname,
    Gender,
    Birth,
    Death,
    Notes,
}

/// Column aliases per role. Aliases are matched against [`normalize`]d column
/// names, so they are written lowercase and without separators. Order matters:
/// the first alias present in the table wins, which is why explicit names
/// (`given`) come before generic ones (`name`).
const ALIASES: [(Role, &[&str]); 8] = [
    (
        Role::Id,
        &[
            "id",
            "personid",
            "individualid",
            "recordid",
            "externalid",
            "key",
            "номер",
        ],
    ),
    (
        Role::Given,
        &[
            "given",
            "givenname",
            "firstname",
            "forename",
            "name",
            "imya",
            "имя",
        ],
    ),
    (
        Role::Patronymic,
        &["patronymic", "middlename", "otchestvo", "отчество"],
    ),
    (
        Role::Surname,
        &["surname", "lastname", "familyname", "familia", "фамилия"],
    ),
    (Role::Gender, &["sex", "gender", "пол"]),
    (
        Role::Birth,
        &[
            "birth",
            "birthdate",
            "datebirth",
            "birthday",
            "born",
            "датарождения",
            "рождение",
        ],
    ),
    (
        Role::Death,
        &[
            "death",
            "deathdate",
            "datedeath",
            "deathday",
            "died",
            "датасмерти",
            "смерть",
        ],
    ),
    (
        Role::Notes,
        &[
            "notes",
            "note",
            "comment",
            "comments",
            "remark",
            "заметки",
            "примечание",
        ],
    ),
];

/// Lowercase, letters and digits only: `Birth_Date`, `birth date` and
/// `BirthDate` all become `birthdate`; Cyrillic survives unchanged.
fn normalize(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// First column of `columns` that matches one of `aliases`, in alias order.
fn find_column(columns: &[String], aliases: &[&str]) -> Option<String> {
    let normalized = columns
        .iter()
        .map(|column| normalize(column))
        .collect::<Vec<_>>();
    aliases.iter().find_map(|alias| {
        normalized
            .iter()
            .position(|column| column == alias)
            .map(|index| columns[index].clone())
    })
}

/// Row identifier columns carry no domain data and are never reported.
fn is_row_identifier(column: &str) -> bool {
    matches!(normalize(column).as_str(), "id" | "rowid" | "uuid" | "key")
}

/// Drop repeated column names while keeping the detection order.
fn unique_columns(columns: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for column in columns {
        if !unique.contains(&column) {
            unique.push(column);
        }
    }
    unique
}

fn warn_unknown_columns(table: &Table, used: &[String], report: &mut ImportReport) {
    for column in &table.columns {
        if is_row_identifier(column) || used.iter().any(|candidate| candidate == column) {
            continue;
        }
        report.warn(format!("unknown column: {}.{column}", table.name));
    }
}

/// Resolved column per role for one table.
#[derive(Debug, Clone, Default)]
struct Mapping {
    id: Option<String>,
    given: Option<String>,
    patronymic: Option<String>,
    surname: Option<String>,
    gender: Option<String>,
    birth: Option<String>,
    death: Option<String>,
    notes: Option<String>,
}

impl Mapping {
    fn detect(columns: &[String]) -> Self {
        let normalized = columns
            .iter()
            .map(|column| normalize(column))
            .collect::<Vec<_>>();
        let mut mapping = Self::default();
        for (role, aliases) in ALIASES {
            let found = normalized
                .iter()
                .position(|column| aliases.contains(&column.as_str()));
            mapping.assign(role, found.map(|index| columns[index].clone()));
        }
        mapping
    }

    fn assign(&mut self, role: Role, column: Option<String>) {
        match role {
            Role::Id => self.id = column,
            Role::Given => self.given = column,
            Role::Patronymic => self.patronymic = column,
            Role::Surname => self.surname = column,
            Role::Gender => self.gender = column,
            Role::Birth => self.birth = column,
            Role::Death => self.death = column,
            Role::Notes => self.notes = column,
        }
    }

    fn column(&self, role: Role) -> Option<&str> {
        match role {
            Role::Id => self.id.as_deref(),
            Role::Given => self.given.as_deref(),
            Role::Patronymic => self.patronymic.as_deref(),
            Role::Surname => self.surname.as_deref(),
            Role::Gender => self.gender.as_deref(),
            Role::Birth => self.birth.as_deref(),
            Role::Death => self.death.as_deref(),
            Role::Notes => self.notes.as_deref(),
        }
    }

    /// Mapped roles in the fixed [`ALIASES`] order; also the SELECT order.
    fn pairs(&self) -> Vec<(Role, &str)> {
        ALIASES
            .iter()
            .filter_map(|(role, _)| self.column(*role).map(|column| (*role, column)))
            .collect()
    }

    fn matched(&self) -> usize {
        self.pairs().len()
    }

    fn uses(&self, column: &str) -> bool {
        self.pairs().iter().any(|(_, used)| *used == column)
    }
}

/// One row with its selected columns, so role lookups do not depend on SELECT
/// order.
struct RowValues<'a> {
    columns: &'a [String],
    values: Vec<Option<String>>,
}

impl RowValues<'_> {
    fn get(&self, column: &str) -> Option<&str> {
        let index = self
            .columns
            .iter()
            .position(|candidate| candidate == column)?;
        self.values.get(index).and_then(|value| value.as_deref())
    }
}

/// Stream every row of `table` through `visit`.
///
/// `row N` in [`ImportReport::issues`] is the 1-based position among the rows
/// returned by the generated SELECT.
fn for_each_row(
    connection: &Connection,
    table: &str,
    columns: &[String],
    file: &str,
    mut visit: impl FnMut(usize, &RowValues<'_>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if columns.is_empty() {
        return Ok(());
    }
    let select_list = columns
        .iter()
        .map(|column| quote_ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {select_list} FROM {}", quote_ident(table));

    let mut statement = connection
        .prepare(&sql)
        .map_err(|err| parse_error(file, format!("cannot read table {table}: {err}")))?;
    let mut rows = statement
        .query([])
        .map_err(|err| parse_error(file, format!("cannot read table {table}: {err}")))?;

    let mut number = 0usize;
    loop {
        let row = rows
            .next()
            .map_err(|err| parse_error(file, format!("cannot read table {table}: {err}")))?;
        let Some(row) = row else { break };
        number += 1;

        let mut values = Vec::with_capacity(columns.len());
        for (position, column) in columns.iter().enumerate() {
            values.push(cell_text(row, position, table, column, file)?);
        }
        visit(number, &RowValues { columns, values })?;
    }
    Ok(())
}

/// Map every row of the person table to a [`Person`].
///
/// Returns the persons and the `external id -> PersonId` map used by
/// relationships and events. Persons without a name are reported and skipped;
/// an inconsistent person is reported and still returned so the caller can
/// decide what to do with it.
fn read_persons(
    connection: &Connection,
    table: &str,
    mapping: &Mapping,
    file: &str,
    report: &mut ImportReport,
) -> Result<(Vec<Person>, HashMap<String, PersonId>), AppError> {
    let columns = mapping
        .pairs()
        .into_iter()
        .map(|(_, column)| column.to_owned())
        .collect::<Vec<_>>();
    // Qualified names for issue messages (`persons.death`).
    let birth_column = mapping
        .birth
        .as_deref()
        .map(|column| format!("{table}.{column}"));
    let death_column = mapping
        .death
        .as_deref()
        .map(|column| format!("{table}.{column}"));

    let mut persons = Vec::new();
    let mut by_external: HashMap<String, PersonId> = HashMap::new();
    for_each_row(connection, table, &columns, file, |number, values| {
        let cell = |role: Role| -> Option<String> {
            mapping
                .column(role)
                .and_then(|column| values.get(column))
                .map(str::to_owned)
        };

        let name = Name {
            given: cell(Role::Given),
            patronymic: cell(Role::Patronymic),
            surname: cell(Role::Surname),
            is_primary: true,
            ..Name::default()
        };
        if name.display().trim().is_empty() {
            report.issue(format!("row {number} in {table} has no name; skipped"));
            return Ok(());
        }
        let mut person = match Person::new(vec![name]) {
            Ok(person) => person,
            Err(err) => {
                report.issue(format!(
                    "row {number} in {table} rejected ({}); skipped",
                    err.code
                ));
                return Ok(());
            }
        };

        let gender = cell(Role::Gender);
        person.gender = map_gender(gender.as_deref());
        if person.gender == Gender::Unknown {
            if let Some(column) = mapping.gender.as_deref() {
                if gender
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    report.issue(format!(
                        "unrecognised sex value in {table}.{column} (row {number}); kept as UNKNOWN"
                    ));
                }
            }
        }

        person.birth = read_date(cell(Role::Birth), birth_column.as_deref(), number, report);
        person.death = read_date(cell(Role::Death), death_column.as_deref(), number, report);

        person.notes = cell(Role::Notes)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());

        if let Some(value) = cell(Role::Id).map(|value| value.trim().to_owned()) {
            if !value.is_empty() {
                if by_external.contains_key(&value) {
                    report.issue(format!(
                        "duplicate external id in {table} (row {number}); the first row wins"
                    ));
                } else {
                    by_external.insert(value.clone(), person.id);
                }
                person.external_ids.push(ExternalId {
                    source: SOURCE.to_owned(),
                    value,
                });
            }
        }

        if let Err(err) = person.validate() {
            report.issue(format!(
                "person at row {number} in {table} failed validation ({}); imported as-is",
                err.code
            ));
        }
        persons.push(person);
        Ok(())
    })?;
    Ok((persons, by_external))
}

/// Relationship tables are recognised by their column names; a table with a
/// `type` column is classified per row, everything unknown is skipped and
/// reported.
#[derive(Debug, Clone)]
enum RelationshipLayout {
    ParentChild {
        parent: String,
        child: String,
        kind: Option<String>,
    },
    Spouses {
        a: String,
        b: String,
    },
    Typed {
        a: String,
        b: String,
        kind: String,
    },
}

const RELATION_PARENT_ALIASES: &[&str] = &[
    "parent",
    "parentid",
    "parentpersonid",
    "parentkey",
    "father",
    "fatherid",
    "mother",
    "motherid",
];
const RELATION_CHILD_ALIASES: &[&str] = &[
    "child",
    "childid",
    "childpersonid",
    "childkey",
    "son",
    "sonid",
    "daughter",
    "daughterid",
];
const RELATION_A_ALIASES: &[&str] = &[
    "personid",
    "person",
    "individualid",
    "individual",
    "fromid",
    "from",
    "husband",
    "husbandid",
    "spouse1",
    "partner1",
    "first",
    "firstid",
    "id1",
];
const RELATION_B_ALIASES: &[&str] = &[
    "relatedpersonid",
    "relatedperson",
    "relatedid",
    "related",
    "toid",
    "to",
    "wife",
    "wifeid",
    "spouse",
    "spouseid",
    "spouse2",
    "partner",
    "partnerid",
    "second",
    "secondid",
    "id2",
];
const RELATION_KIND_ALIASES: &[&str] = &[
    "type",
    "reltype",
    "relationtype",
    "relationshiptype",
    "relationship",
    "kind",
    "relation",
];

const SPOUSE_COLUMN_ALIASES: &[&str] = &[
    "spouse",
    "spouseid",
    "spouse1",
    "spouse2",
    "husband",
    "husbandid",
    "wife",
    "wifeid",
    "partner",
    "partnerid",
    "partner1",
    "partner2",
];

impl RelationshipLayout {
    fn detect(columns: &[String]) -> Option<Self> {
        let kind = find_column(columns, RELATION_KIND_ALIASES);
        let parent = find_column(columns, RELATION_PARENT_ALIASES);
        let child = find_column(columns, RELATION_CHILD_ALIASES);
        if let (Some(parent), Some(child)) = (&parent, &child) {
            if parent != child {
                return Some(Self::ParentChild {
                    parent: parent.clone(),
                    child: child.clone(),
                    kind,
                });
            }
        }

        let a = find_column(columns, RELATION_A_ALIASES);
        let b = find_column(columns, RELATION_B_ALIASES);
        let (Some(a), Some(b)) = (a, b) else {
            return None;
        };
        if a == b {
            return None;
        }
        match kind {
            Some(kind) => Some(Self::Typed { a, b, kind }),
            // Without a type column the pair is only a relationship when one
            // side is explicitly a spouse; a generic `(person, related)` pair
            // has no knowable direction.
            None if [&a, &b]
                .iter()
                .any(|column| SPOUSE_COLUMN_ALIASES.contains(&normalize(column).as_str())) =>
            {
                Some(Self::Spouses { a, b })
            }
            None => None,
        }
    }

    fn columns(&self) -> Vec<String> {
        match self {
            Self::ParentChild {
                parent,
                child,
                kind,
            } => unique_columns(
                [Some(parent.clone()), Some(child.clone()), kind.clone()]
                    .into_iter()
                    .flatten(),
            ),
            Self::Spouses { a, b } => unique_columns([a.clone(), b.clone()]),
            Self::Typed { a, b, kind } => unique_columns([a.clone(), b.clone(), kind.clone()]),
        }
    }
}

fn read_relationships(
    connection: &Connection,
    table: &str,
    layout: &RelationshipLayout,
    by_external: &HashMap<String, PersonId>,
    file: &str,
    set: &mut RelationshipSet,
    report: &mut ImportReport,
) -> Result<(), AppError> {
    let columns = layout.columns();
    for_each_row(connection, table, &columns, file, |number, values| {
        let (left, right, rel_type) = match layout {
            RelationshipLayout::ParentChild {
                parent,
                child,
                kind,
            } => {
                let rel_type = if kind
                    .as_deref()
                    .and_then(|column| values.get(column))
                    .is_some_and(is_adoptive_type)
                {
                    RelationshipType::AdoptiveParentChild
                } else {
                    RelationshipType::ParentChild
                };
                (values.get(parent), values.get(child), rel_type)
            }
            RelationshipLayout::Spouses { a, b } => {
                (values.get(a), values.get(b), RelationshipType::Spouse)
            }
            RelationshipLayout::Typed { a, b, kind } => {
                let Some(raw) = values.get(kind) else {
                    report.issue(format!(
                        "relationship row {number} in {table} has no type; skipped"
                    ));
                    return Ok(());
                };
                let Some(rel_type) = map_relationship_type(raw) else {
                    report.issue(format!(
                        "unrecognised relationship type in {table}.{kind} (row {number}); skipped"
                    ));
                    return Ok(());
                };
                (values.get(a), values.get(b), rel_type)
            }
        };

        let Some(left) = resolve_person(by_external, left) else {
            report.issue(format!(
                "relationship row {number} in {table} references an unknown person; skipped"
            ));
            return Ok(());
        };
        let Some(right) = resolve_person(by_external, right) else {
            report.issue(format!(
                "relationship row {number} in {table} references an unknown person; skipped"
            ));
            return Ok(());
        };

        match Relationship::new(rel_type, left, right).and_then(|row| set.push(row)) {
            Ok(()) => {}
            Err(err) => {
                report.issue(format!(
                    "relationship row {number} in {table} skipped ({})",
                    error_reason(&err)
                ));
            }
        }
        Ok(())
    })
}

/// `CODE:rule` when the validation error carries a rule, `CODE` otherwise.
/// Kept value-free: it is copied into import reports.
fn error_reason(err: &AppError) -> String {
    err.params
        .get("rule")
        .map(|rule| format!("{}:{rule}", err.code))
        .unwrap_or_else(|| err.code.clone())
}

fn map_relationship_type(raw: &str) -> Option<RelationshipType> {
    if is_adoptive_type(raw) {
        return Some(RelationshipType::AdoptiveParentChild);
    }
    if is_partner_type(raw) {
        return Some(RelationshipType::Partner);
    }
    let key = normalize(raw);
    match key.as_str() {
        "parentchild" | "parent" | "father" | "mother" | "birthparent" | "biologicalparent" => {
            Some(RelationshipType::ParentChild)
        }
        "spouse" | "spousepair" | "husband" | "wife" | "marriage" | "married" | "couple" => {
            Some(RelationshipType::Spouse)
        }
        _ => None,
    }
}

fn is_adoptive_type(raw: &str) -> bool {
    let key = normalize(raw);
    matches!(
        key.as_str(),
        "adoptive" | "adoptiveparentchild" | "adopted" | "adoption" | "adopt"
    )
}

fn is_partner_type(raw: &str) -> bool {
    let key = normalize(raw);
    matches!(key.as_str(), "partner" | "partners" | "unmarried")
}

fn resolve_person(by_external: &HashMap<String, PersonId>, raw: Option<&str>) -> Option<PersonId> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    by_external.get(raw).copied()
}

/// Event columns recognised by the importer.
#[derive(Debug, Clone)]
struct EventMapping {
    person: String,
    kind: Option<String>,
    date: Option<String>,
    place: Option<String>,
    description: Option<String>,
    source: Option<String>,
}

const EVENT_PERSON_ALIASES: &[&str] = &[
    "personid",
    "person",
    "individualid",
    "individual",
    "ownerid",
    "owner",
    "personkey",
];
const EVENT_TYPE_ALIASES: &[&str] = &["eventtype", "type", "event", "kind", "eventkind"];
const EVENT_DATE_ALIASES: &[&str] = &["eventdate", "date", "datevalue", "when", "happened"];
const EVENT_PLACE_ALIASES: &[&str] = &["place", "placevalue", "location", "city", "address"];
const EVENT_DESCRIPTION_ALIASES: &[&str] = &[
    "description",
    "value",
    "text",
    "note",
    "notes",
    "comment",
    "details",
];
const EVENT_SOURCE_ALIASES: &[&str] = &["sourceid", "source", "sources", "citationid", "citation"];

impl EventMapping {
    fn detect(columns: &[String]) -> Option<Self> {
        let person = find_column(columns, EVENT_PERSON_ALIASES)?;
        let kind = find_column(columns, EVENT_TYPE_ALIASES);
        let date = find_column(columns, EVENT_DATE_ALIASES);
        if kind.is_none() && date.is_none() {
            return None;
        }
        Some(Self {
            person,
            kind,
            date,
            place: find_column(columns, EVENT_PLACE_ALIASES),
            description: find_column(columns, EVENT_DESCRIPTION_ALIASES),
            source: find_column(columns, EVENT_SOURCE_ALIASES),
        })
    }

    fn columns(&self) -> Vec<String> {
        unique_columns(
            [
                Some(self.person.clone()),
                self.kind.clone(),
                self.date.clone(),
                self.place.clone(),
                self.description.clone(),
                self.source.clone(),
            ]
            .into_iter()
            .flatten(),
        )
    }
}

fn read_events(
    connection: &Connection,
    table: &str,
    mapping: &EventMapping,
    by_external: &HashMap<String, PersonId>,
    file: &str,
    report: &mut ImportReport,
) -> Result<Vec<Event>, AppError> {
    let columns = mapping.columns();
    let date_column = mapping
        .date
        .as_deref()
        .map(|column| format!("{table}.{column}"));
    let mut events = Vec::new();
    let mut source_warned = false;
    if mapping.kind.is_none() {
        report.warn(format!(
            "events in {table} have no type column; imported as OTHER"
        ));
    }

    for_each_row(connection, table, &columns, file, |number, values| {
        let Some(person_id) = resolve_person(by_external, values.get(&mapping.person)) else {
            report.issue(format!(
                "event row {number} in {table} references an unknown person; skipped"
            ));
            return Ok(());
        };

        let raw_type = mapping
            .kind
            .as_deref()
            .and_then(|column| values.get(column))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let (event_type, original_type) = match raw_type {
            Some(raw) => match map_event_type(raw) {
                Some(event_type) => (event_type, None),
                None => {
                    report.issue(format!(
                        "unrecognised event type in {table}.{} (row {number}); kept as OTHER",
                        mapping.kind.as_deref().unwrap_or("-")
                    ));
                    (EventType::Other, Some(raw.to_owned()))
                }
            },
            None => (EventType::Other, None),
        };

        let mut event = Event::new(person_id, event_type);
        event.original_type = original_type;
        event.date = read_date(
            mapping
                .date
                .as_deref()
                .and_then(|column| values.get(column))
                .map(str::to_owned),
            date_column.as_deref(),
            number,
            report,
        );
        event.place = mapping
            .place
            .as_deref()
            .and_then(|column| trimmed(values.get(column)));
        event.description = mapping
            .description
            .as_deref()
            .and_then(|column| trimmed(values.get(column)));

        if mapping.source.is_some() && !source_warned {
            report.warn(format!(
                "event sources in {table}.{} are not mapped: no unambiguous sources table",
                mapping.source.as_deref().unwrap_or("-")
            ));
            source_warned = true;
        }

        if let Err(err) = event.validate() {
            report.issue(format!(
                "event at row {number} in {table} failed validation ({}); imported as-is",
                err.code
            ));
        }
        events.push(event);
        Ok(())
    })?;
    Ok(events)
}

fn map_event_type(raw: &str) -> Option<EventType> {
    match normalize(raw).as_str() {
        "birth" | "birt" | "born" | "birthday" | "рождение" => Some(EventType::Birth),
        "death" | "deat" | "died" | "deathday" | "смерть" => Some(EventType::Death),
        "marriage" | "marr" | "married" | "wedding" | "брак" | "бракосочетание" => {
            Some(EventType::Marriage)
        }
        "divorce" | "div" | "divorced" | "развод" => Some(EventType::Divorce),
        "burial" | "buri" | "funeral" | "погребение" | "похороны" => {
            Some(EventType::Burial)
        }
        "residence" | "resi" | "living" | "проживание" => Some(EventType::Residence),
        "occupation" | "occu" | "work" | "job" | "profession" | "профессия" | "работа" => {
            Some(EventType::Occupation)
        }
        "education" | "educ" | "study" | "school" | "образование" => {
            Some(EventType::Education)
        }
        "other" => Some(EventType::Other),
        _ => None,
    }
}

/// Trims an optional text cell and drops the empty result.
pub(crate) fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// A media row discovered in AT5; the caller attaches source/bytes and keeps
/// its own `validate()` reporting.
pub(crate) fn at5_media(
    file_name: String,
    checksum: String,
    mime_type: String,
    caption: Option<String>,
) -> Media {
    Media {
        id: Uuid::now_v7(),
        mime_type,
        file_name,
        checksum,
        caption,
        source_id: None,
        person_id: None,
        event_id: None,
        primary: false,
    }
}

/// Media columns recognised by the importer.
#[derive(Debug, Clone)]
struct MediaMapping {
    file: String,
    caption: Option<String>,
}

const MEDIA_FILE_ALIASES: &[&str] = &[
    "filename",
    "file",
    "files",
    "filepath",
    "media",
    "photo",
    "picture",
    "image",
    "scan",
    "attachment",
];
const MEDIA_CAPTION_ALIASES: &[&str] = &[
    "caption",
    "title",
    "description",
    "note",
    "notes",
    "comment",
];

impl MediaMapping {
    fn detect(columns: &[String]) -> Option<Self> {
        let file = find_column(columns, MEDIA_FILE_ALIASES)?;
        Some(Self {
            file,
            caption: find_column(columns, MEDIA_CAPTION_ALIASES),
        })
    }

    fn columns(&self) -> Vec<String> {
        unique_columns(
            [Some(self.file.clone()), self.caption.clone()]
                .into_iter()
                .flatten(),
        )
    }
}

fn read_media_rows(
    connection: &Connection,
    table: &str,
    mapping: &MediaMapping,
    roots: &[PathBuf],
    file: &str,
    report: &mut ImportReport,
) -> Result<Vec<At5MediaFile>, AppError> {
    let columns = mapping.columns();
    let mut media_items = Vec::new();
    for_each_row(connection, table, &columns, file, |number, values| {
        let Some(raw) = values.get(&mapping.file) else {
            report.issue(format!(
                "media row {number} in {table} has no file name; skipped"
            ));
            return Ok(());
        };
        let Some(name) = sanitize_file_name(raw) else {
            report.issue(format!(
                "media row {number} in {table} has an unsafe file name; skipped"
            ));
            return Ok(());
        };
        if roots.is_empty() {
            report.issue(format!(
                "media row {number} in {table} has no .files folder to read; skipped"
            ));
            return Ok(());
        }
        let Some(path) = find_media_file(&name, roots) else {
            report.issue(format!(
                "media file referenced by row {number} in {table} is missing; skipped"
            ));
            return Ok(());
        };
        let Ok(checksum) = sha256_file(&path) else {
            report.issue(format!(
                "media file referenced by row {number} in {table} cannot be read; skipped"
            ));
            return Ok(());
        };
        let caption = mapping
            .caption
            .as_deref()
            .and_then(|column| values.get(column))
            .and_then(|value| trimmed(Some(value)));
        let mime_type = guess_mime(&name).to_owned();
        let item = at5_media(name, checksum, mime_type, caption);
        if let Err(err) = item.validate() {
            report.issue(format!(
                "media row {number} in {table} failed validation ({}); skipped",
                err.code
            ));
            return Ok(());
        }
        media_items.push(At5MediaFile {
            media: item,
            source: Some(path),
            bytes: None,
        });
        Ok(())
    })?;
    Ok(media_items)
}

/// Scan every media root when the database has no media table: the `.files`
/// folder first, then the extra folders. A name found in an earlier root wins.
fn scan_media_roots(
    roots: &[PathBuf],
    report: &mut ImportReport,
) -> Result<Vec<At5MediaFile>, AppError> {
    let mut media_items = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for directory in roots {
        for item in scan_media_dir(directory, report)? {
            if seen.insert(item.media.file_name.clone()) {
                media_items.push(item);
            }
        }
    }
    Ok(media_items)
}

/// Read every regular file in one media folder.
fn scan_media_dir(
    directory: &Path,
    report: &mut ImportReport,
) -> Result<Vec<At5MediaFile>, AppError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|err| AppError::io("read AT5 media folder", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| AppError::io("read AT5 media folder", err))?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut media_items = Vec::new();
    let mut skipped_folders = 0usize;
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            report.issue("cannot inspect an entry in the media folder; skipped");
            continue;
        };
        if !file_type.is_file() {
            skipped_folders += 1;
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(name) = sanitize_file_name(&name) else {
            report.issue("unsafe file name in the media folder; skipped");
            continue;
        };
        let Ok(checksum) = sha256_file(&entry.path()) else {
            report.issue("a file in the media folder cannot be read; skipped");
            continue;
        };
        let mime_type = guess_mime(&name).to_owned();
        let item = at5_media(name, checksum, mime_type, None);
        match item.validate() {
            Ok(()) => media_items.push(At5MediaFile {
                media: item,
                source: Some(entry.path()),
                bytes: None,
            }),
            Err(err) => report.issue(format!(
                "media file in the media folder failed validation ({}); skipped",
                err.code
            )),
        }
    }
    if skipped_folders > 0 {
        report.warn(format!(
            "{skipped_folders} folder(s) inside a media folder are not imported"
        ));
    }
    Ok(media_items)
}

/// Media search order: `<stem>.files`/`.files` next to the database first, then
/// the extra folders in the order the user picked them. Folders that do not
/// exist are ignored: a stale folder is not an import error.
fn media_roots(path: &Path, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(files) = files_dir(path) {
        roots.push(files);
    }
    for directory in extra {
        if directory.is_dir() && !roots.contains(directory) {
            roots.push(directory.clone());
        }
    }
    roots
}

/// Find a sanitised bare `name` in the roots, in order.
///
/// Only the base name is joined: nothing in a folder entry or a database value
/// can add a path component or escape the folder.
fn find_media_file(name: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join(name))
        .find(|candidate| candidate.is_file())
}

/// `.files` folder next to the database: `<stem>.files`, else `.files`.
fn files_dir(path: &Path) -> Option<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
        let candidate = parent.join(format!("{stem}.files"));
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    let fallback = parent.join(".files");
    fallback.is_dir().then_some(fallback)
}

/// Keep the last path component only and refuse anything that could escape the
/// `.files` folder. File names are never used as identifiers.
fn sanitize_file_name(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty()
        || normalized.contains("..")
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized.starts_with('/')
    {
        return None;
    }
    let name = normalized.rsplit('/').next()?;
    let unsafe_name = name.is_empty()
        || name == "."
        || name.starts_with('.')
        || name.chars().any(char::is_control);
    (!unsafe_name).then(|| name.to_owned())
}

pub(crate) fn guess_mime(file_name: &str) -> &'static str {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path).map_err(|err| AppError::io("open media file", err))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| AppError::io("read media file", err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn read_date(
    raw: Option<String>,
    column: Option<&str>,
    number: usize,
    report: &mut ImportReport,
) -> DateValue {
    let Some(raw) = raw else {
        return DateValue::default();
    };
    let value = parse_date(&raw);
    if value.precision == DatePrecision::Unknown && !raw.trim().is_empty() {
        if let Some(column) = column {
            report.issue(format!(
                "unparsed date in {column} (row {number}); kept in original with precision UNKNOWN"
            ));
        }
    }
    value
}

/// Parse one AT5 date cell.
///
/// Recognised: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `DD.MM.YYYY`. Everything else
/// is never normalised: bounds stay empty, precision and qualifier are
/// `UNKNOWN`, and the cell text is preserved in [`DateValue::original`].
pub fn parse_date(raw: &str) -> DateValue {
    let text = raw.trim();
    if text.is_empty() {
        return DateValue::unknown(None);
    }
    let mut value = parse_known_date(text).unwrap_or_else(|| DateValue::unknown(None));
    value.original = Some(text.to_owned());
    value
}

fn parse_known_date(text: &str) -> Option<DateValue> {
    if text.bytes().all(|byte| byte.is_ascii_digit()) {
        return year_value(parse_digits(text)?);
    }

    let (parts, separator) = if text.contains('-') {
        (text.split('-').collect::<Vec<_>>(), '-')
    } else if text.contains('.') {
        (text.split('.').collect::<Vec<_>>(), '.')
    } else {
        return None;
    };
    let numbers = parts
        .iter()
        .map(|part| parse_digits(part))
        .collect::<Option<Vec<_>>>()?;

    match (separator, numbers.as_slice(), parts.as_slice()) {
        ('-', [year, month], [year_text, _]) if year_text.len() == 4 => month_value(*year, *month),
        ('-', [year, month, day], [year_text, _, _]) if year_text.len() == 4 => {
            day_value(*year, *month, *day)
        }
        ('.', [day, month, year], [_, _, year_text]) if year_text.len() == 4 => {
            day_value(*year, *month, *day)
        }
        _ => None,
    }
}

fn parse_digits(part: &str) -> Option<u32> {
    if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

/// Civil years are limited to 1..=9999: anything outside is not a date we are
/// willing to guess about.
fn civil_year(year: u32) -> Option<i32> {
    let year = i32::try_from(year).ok()?;
    (1..=9999).contains(&year).then_some(year)
}

fn year_value(year: u32) -> Option<DateValue> {
    Some(DateValue::exact_year(civil_year(year)?))
}

fn month_value(year: u32, month: u32) -> Option<DateValue> {
    let month = u8::try_from(month).ok()?;
    CivilDate::new(civil_year(year)?, month, 1)
        .ok()
        .map(DateValue::exact_month)
}

fn day_value(year: u32, month: u32, day: u32) -> Option<DateValue> {
    let month = u8::try_from(month).ok()?;
    let day = u8::try_from(day).ok()?;
    CivilDate::new(civil_year(year)?, month, day)
        .ok()
        .map(DateValue::exact_day)
}

fn map_gender(raw: Option<&str>) -> Gender {
    let Some(raw) = raw else {
        return Gender::Unknown;
    };
    match raw.trim().to_lowercase().as_str() {
        "m" | "male" | "man" | "м" | "муж" | "мужской" | "мужчина" => {
            Gender::Male
        }
        "f" | "female" | "woman" | "ж" | "жен" | "женский" | "женщина" => {
            Gender::Female
        }
        _ => Gender::Unknown,
    }
}

fn cell_text(
    row: &Row<'_>,
    index: usize,
    table: &str,
    column: &str,
    file: &str,
) -> Result<Option<String>, AppError> {
    let value = row.get_ref(index).map_err(|err| {
        parse_error(
            file,
            format!("cannot read {table}.{column} (column {index}): {err}"),
        )
        .with_param("field", format!("{table}.{column}"))
    })?;
    Ok(match value {
        ValueRef::Null => None,
        ValueRef::Integer(number) => Some(number.to_string()),
        ValueRef::Real(number) => Some(number.to_string()),
        ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        // AT5 stores long texts (for example a person biography) in `vblob`
        // as UTF-8, while `vstr` keeps only a truncated preview. Binary blobs
        // (images, previews) are not valid UTF-8 and stay `None` as before.
        ValueRef::Blob(bytes) => std::str::from_utf8(bytes).ok().map(str::to_owned),
    })
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// File name only: errors never carry an absolute path (ADR-0013).
fn file_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("at5")
        .to_owned()
}

fn parse_error(file: &str, message: impl Into<String>) -> AppError {
    AppError::new(codes::IMPORT_PARSE_ERROR, message).with_param("file", file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use gentree_core::date::DateQualifier;
    use rusqlite::params;

    const SCHEMA: &str = "
        CREATE TABLE persons (
            id INTEGER PRIMARY KEY,
            name TEXT,
            surname TEXT,
            sex TEXT,
            birth TEXT,
            death TEXT,
            notes TEXT,
            nickname TEXT
        );
        CREATE TABLE places (
            id INTEGER PRIMARY KEY,
            title TEXT
        );
    ";

    /// Synthetic AT5-shaped database: no real AT5 data is ever used. Returns
    /// the path after the writing connection is closed.
    fn fixture(dir: &Path) -> PathBuf {
        let path = dir.join("at5.db");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA).unwrap();
            let insert = "INSERT INTO persons \
                          (id, name, surname, sex, birth, death, notes, nickname) \
                          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";
            connection
                .execute(
                    insert,
                    params![
                        1,
                        "Иван",
                        "Петров",
                        "м",
                        "1950",
                        None::<String>,
                        "первая запись",
                        "Ваня"
                    ],
                )
                .unwrap();
            connection
                .execute(
                    insert,
                    params![
                        2,
                        "Мария",
                        "Иванова",
                        "ж",
                        "06.05.1951",
                        "около 1940",
                        "",
                        "Маша"
                    ],
                )
                .unwrap();
            connection
                .execute(
                    insert,
                    params![
                        3,
                        "Пётр",
                        "Сидоров",
                        "",
                        "1899-12",
                        "1899-12-31",
                        None::<String>,
                        None::<String>
                    ],
                )
                .unwrap();
        }
        path
    }

    #[test]
    fn reads_synthetic_at5() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path());
        let bundle = read_at5_bundle(&path).unwrap();
        let persons = &bundle.persons;
        let report = &bundle.report;

        assert_eq!(persons.len(), 3);
        assert_eq!(report.persons, 3);
        assert_eq!(report.relationships, 0);
        assert_eq!(report.events, 0);
        assert_eq!(report.media, 0);
        assert_eq!(
            report.warnings,
            vec!["unknown table: places", "unknown column: persons.nickname"]
        );
        assert_eq!(
            report.issues,
            vec!["unparsed date in persons.death (row 2); kept in original with precision UNKNOWN"]
        );

        // Aliased columns, Cyrillic text, gender, notes and the source id.
        let ivan = &persons[0];
        assert_eq!(ivan.display_name(), "Петров Иван");
        assert_eq!(ivan.names[0].given.as_deref(), Some("Иван"));
        assert_eq!(ivan.names[0].surname.as_deref(), Some("Петров"));
        assert!(ivan.names[0].is_primary);
        assert_eq!(ivan.gender, Gender::Male);
        assert_eq!(ivan.notes.as_deref(), Some("первая запись"));
        assert_eq!(
            ivan.external_ids,
            vec![ExternalId {
                source: "AT5".to_owned(),
                value: "1".to_owned(),
            }]
        );

        // "1950" becomes the whole year, the original text is kept.
        assert_eq!(ivan.birth.precision, DatePrecision::Year);
        assert_eq!(ivan.birth.qualifier, DateQualifier::Exact);
        assert_eq!(ivan.birth.original.as_deref(), Some("1950"));
        assert_eq!(ivan.birth.start.unwrap().to_iso(), "1950-01-01");
        assert_eq!(ivan.birth.end.unwrap().to_iso(), "1951-01-01");
        // No death cell at all: nothing is invented.
        assert_eq!(ivan.death, DateValue::unknown(None));

        let maria = &persons[1];
        assert_eq!(maria.gender, Gender::Female);
        assert_eq!(maria.birth.precision, DatePrecision::Day);
        assert_eq!(maria.birth.start.unwrap().to_iso(), "1951-05-06");
        assert_eq!(maria.birth.original.as_deref(), Some("06.05.1951"));
        // "около 1940" is not a date we can bound.
        assert_eq!(maria.death.precision, DatePrecision::Unknown);
        assert_eq!(maria.death.qualifier, DateQualifier::Unknown);
        assert_eq!(maria.death.start, None);
        assert_eq!(maria.death.end, None);
        assert_eq!(maria.death.original.as_deref(), Some("около 1940"));
        // Empty text is absence, not a value.
        assert_eq!(maria.notes, None);

        let peter = &persons[2];
        assert_eq!(peter.gender, Gender::Unknown);
        assert_eq!(peter.birth.precision, DatePrecision::Month);
        assert_eq!(peter.birth.start.unwrap().to_iso(), "1899-12-01");
        assert_eq!(peter.birth.end.unwrap().to_iso(), "1900-01-01");
        assert_eq!(peter.death.precision, DatePrecision::Day);
        assert_eq!(peter.death.start.unwrap().to_iso(), "1899-12-31");
        assert_eq!(peter.death.end.unwrap().to_iso(), "1900-01-01");
    }

    #[test]
    fn read_at5_never_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path());
        let before_bytes = fs::read(&path).unwrap();
        let before_modified = fs::metadata(&path).unwrap().modified().unwrap();

        let (persons, _) = read_at5(&path).unwrap();
        assert_eq!(persons.len(), 3);

        let after_bytes = fs::read(&path).unwrap();
        let after_modified = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before_bytes, after_bytes, "database bytes changed");
        assert_eq!(before_modified, after_modified, "database mtime changed");

        // The same flags read_at5 uses refuse writes.
        let connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let error = connection
            .execute("CREATE TABLE probe (id INTEGER)", [])
            .unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("readonly"),
            "unexpected error: {error}"
        );
        drop(connection);

        // No journal or WAL file is left behind next to the fixture.
        let mut entries = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(entries, vec!["at5.db"]);
    }

    #[test]
    fn parses_known_and_unknown_dates() {
        let year = parse_date("1950");
        assert_eq!(year.precision, DatePrecision::Year);
        assert_eq!(year.original.as_deref(), Some("1950"));

        let month = parse_date("1950-05");
        assert_eq!(month.precision, DatePrecision::Month);
        assert_eq!(month.start.unwrap().to_iso(), "1950-05-01");
        assert_eq!(month.end.unwrap().to_iso(), "1950-06-01");

        let iso = parse_date("1950-05-06");
        assert_eq!(iso.precision, DatePrecision::Day);
        assert_eq!(iso.start.unwrap().to_iso(), "1950-05-06");
        assert_eq!(iso.end.unwrap().to_iso(), "1950-05-07");

        let dotted = parse_date("06.05.1950");
        assert_eq!(dotted.precision, DatePrecision::Day);
        assert_eq!(dotted.start.unwrap().to_iso(), "1950-05-06");

        let padded = parse_date("  1950  ");
        assert_eq!(padded.precision, DatePrecision::Year);
        assert_eq!(padded.original.as_deref(), Some("1950"));

        for raw in ["около 1940", "1950-13", "1950-02-30", "1940/1950", "5.1950"] {
            let value = parse_date(raw);
            assert_eq!(value.precision, DatePrecision::Unknown, "raw: {raw}");
            assert_eq!(value.qualifier, DateQualifier::Unknown, "raw: {raw}");
            assert_eq!(value.start, None, "raw: {raw}");
            assert_eq!(value.end, None, "raw: {raw}");
            assert_eq!(value.original.as_deref(), Some(raw.trim()), "raw: {raw}");
            value.validate().unwrap();
        }

        assert_eq!(parse_date("   "), DateValue::unknown(None));
    }

    #[test]
    fn aliases_are_normalized() {
        for (role, aliases) in ALIASES {
            assert!(!aliases.is_empty(), "{role:?} has no aliases");
            for alias in aliases {
                assert_eq!(
                    normalize(alias),
                    *alias,
                    "{role:?} alias {alias} is not normalized"
                );
            }
        }
    }

    #[test]
    fn reports_missing_person_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.db");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch("CREATE TABLE places (id INTEGER PRIMARY KEY, title TEXT)")
                .unwrap();
        }
        let error = read_at5_bundle(&path).unwrap_err();
        assert_eq!(error.code, codes::IMPORT_PARSE_ERROR);
        assert!(error.message.contains("no person table"), "{error}");
        assert!(error.message.contains("places"), "{error}");
        assert_eq!(
            error.params.get("file").map(String::as_str),
            Some("empty.db")
        );
    }

    #[test]
    fn reports_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_at5_bundle(&dir.path().join("absent.db")).unwrap_err();
        assert_eq!(error.code, codes::IO_ERROR);
        assert!(error.message.contains("not found"), "{error}");
        assert_eq!(
            error.params.get("file").map(String::as_str),
            Some("absent.db")
        );
        assert!(!error.message.contains("absent.db"), "path leaked: {error}");
    }

    #[test]
    fn reports_non_sqlite_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.at5");
        fs::write(&path, b"this is not a database").unwrap();
        let error = read_at5_bundle(&path).unwrap_err();
        assert_eq!(error.code, codes::IMPORT_PARSE_ERROR);
        assert!(error.message.contains("sqlite_master"), "{error}");
        assert_eq!(
            error.params.get("file").map(String::as_str),
            Some("broken.at5")
        );
    }

    #[test]
    fn warns_without_identifier_and_skips_unnamed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("noid.db");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE people (surname TEXT, given TEXT);
                     INSERT INTO people (surname, given) VALUES ('Петров', 'Иван');
                     INSERT INTO people (surname, given) VALUES ('', '   ');",
                )
                .unwrap();
        }
        let bundle = read_at5_bundle(&path).unwrap();
        assert_eq!(bundle.persons.len(), 1);
        assert_eq!(bundle.report.persons, 1);
        assert_eq!(bundle.persons[0].display_name(), "Петров Иван");
        assert!(bundle.persons[0].external_ids.is_empty());
        assert_eq!(
            bundle.report.warnings,
            vec!["no identifier column in people; persons get no external ids"]
        );
        assert_eq!(
            bundle.report.issues,
            vec!["row 2 in people has no name; skipped"]
        );
    }

    #[test]
    fn sanitizes_media_file_names() {
        assert_eq!(
            sanitize_file_name(" scan.jpg ").as_deref(),
            Some("scan.jpg")
        );
        assert_eq!(
            sanitize_file_name("photos/scan.jpg").as_deref(),
            Some("scan.jpg")
        );
        assert_eq!(
            sanitize_file_name(r"photos\scan.jpg").as_deref(),
            Some("scan.jpg")
        );
        for raw in [
            "",
            "..",
            "../scan.jpg",
            "photos/../scan.jpg",
            "/etc/passwd",
            "C:/scan.jpg",
            ".hidden",
            "scan\0.jpg",
        ] {
            assert_eq!(sanitize_file_name(raw), None, "raw: {raw:?}");
        }
    }

    #[test]
    fn guesses_mime_by_extension() {
        assert_eq!(guess_mime("scan.JPG"), "image/jpeg");
        assert_eq!(guess_mime("scan.jpeg"), "image/jpeg");
        assert_eq!(guess_mime("scan.png"), "image/png");
        assert_eq!(guess_mime("scan.gif"), "image/gif");
        assert_eq!(guess_mime("scan.webp"), "image/webp");
        assert_eq!(guess_mime("scan.pdf"), "application/pdf");
        assert_eq!(guess_mime("scan.txt"), "application/octet-stream");
        assert_eq!(guess_mime("scan"), "application/octet-stream");
    }
}
