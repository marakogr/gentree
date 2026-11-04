//! Project storage: folder layout, JSONL, atomic writes, lock, backup/restore.
//! Contracts: project storage format and backup/restore rules.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use atomicwrites::{AllowOverwrite, AtomicFile};
use fs2::FileExt;
use gentree_core::error::codes;
use gentree_core::person::Person;
use gentree_core::project::{
    normalize_project_name, project_names_equal, Counts, Manifest, ProjectId, FORMAT_VERSION,
    SCHEMA_VERSION,
};
use gentree_core::record::{Citation, Event, Media, Source};
use gentree_core::relationship::{Relationship, RelationshipSet};
use gentree_core::{now_rfc3339, AppError, AppResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub mod chat_history;

pub const PERSON_FILE: &str = "persons.jsonl";
pub const RELATIONSHIP_FILE: &str = "relationships.jsonl";
pub const EVENT_FILE: &str = "events.jsonl";
pub const SOURCE_FILE: &str = "sources.jsonl";
pub const CITATION_FILE: &str = "citations.jsonl";
pub const MEDIA_FILE: &str = "media.jsonl";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const LOCK_FILE: &str = ".lock";
pub const CHECKSUMS_FILE: &str = "checksums.sha256";
/// Suffix of a backup created by [`ProjectStore::backup`].
pub const BACKUP_SUFFIX: &str = ".gentree.zip";

const DATA_FILES: [&str; 6] = [
    PERSON_FILE,
    RELATIONSHIP_FILE,
    EVENT_FILE,
    SOURCE_FILE,
    CITATION_FILE,
    MEDIA_FILE,
];

/// Envelope of one JSONL line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row<T> {
    pub schema: u32,
    pub id: Uuid,
    pub created_at: String,
    pub updated_at: String,
    pub data: T,
}

impl<T> Row<T> {
    pub fn new(id: Uuid, data: T) -> Self {
        let now = now_rfc3339();
        Self {
            schema: SCHEMA_VERSION,
            id,
            created_at: now.clone(),
            updated_at: now,
            data,
        }
    }
}

/// Every public entry point refuses a path that is not an existing folder.
fn ensure_project_dir(project_dir: &Path) -> AppResult<()> {
    if project_dir.is_dir() {
        Ok(())
    } else {
        Err(
            AppError::new(codes::PROJECT_NOT_FOUND, "Project folder missing")
                .with_param("path", project_dir.display().to_string()),
        )
    }
}

/// Opens and exclusively locks `<project>/.lock`; the handle must outlive the
/// store, because the OS lock is released when it is dropped.
fn acquire_exclusive_lock(project_dir: &Path) -> AppResult<File> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(project_dir.join(LOCK_FILE))
        .map_err(|err| AppError::io("open lock", err))?;
    file.try_lock_exclusive().map_err(|_| {
        AppError::new(
            codes::PROJECT_LOCKED,
            "Project is locked by another process",
        )
        .with_param("path", project_dir.display().to_string())
    })?;
    Ok(file)
}

/// Validation + identity hook shared by every persisted collection.
trait Entity: Clone + Serialize {
    fn entity_id(&self) -> Uuid;
    fn validate_entity(&self) -> AppResult<()>;
}

/// Collections whose row id is `self.id` and whose validation is `validate()`.
macro_rules! impl_entity {
    ($($type:ty),+ $(,)?) => {
        $(
            impl Entity for $type {
                fn entity_id(&self) -> Uuid {
                    self.id
                }

                fn validate_entity(&self) -> AppResult<()> {
                    self.validate()
                }
            }
        )+
    };
}

impl_entity!(Person, Event, Source, Citation);

impl Entity for Relationship {
    fn entity_id(&self) -> Uuid {
        self.id
    }

    fn validate_entity(&self) -> AppResult<()> {
        self.validate_row()
    }
}

impl Entity for Media {
    fn entity_id(&self) -> Uuid {
        self.id
    }

    fn validate_entity(&self) -> AppResult<()> {
        self.validate()?;
        validate_media_file_name(&self.file_name)
    }
}

/// One layout problem found by [`validate_layout`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LayoutIssue {
    /// `manifest.json` is absent.
    MissingManifest,
    /// `manifest.json` exists but is not valid JSON.
    UnreadableManifest { message: String },
    /// `manifest.json` declares a newer folder format than this app supports.
    FormatVersionUnsupported { found: u32, supported: u32 },
    /// One of the six JSONL files is absent.
    MissingFile { file: String },
    /// A JSONL file exists but cannot be parsed (bad row, unknown row schema).
    UnreadableFile { file: String, message: String },
    /// Row count differs from the `counts` hint in the manifest.
    CountMismatch {
        file: String,
        expected: usize,
        actual: usize,
    },
    /// `contentHash` does not match the files on disk.
    ContentHashMismatch { expected: String, actual: String },
}

/// Result of [`validate_layout`]. `needsRepair` is computed, never stored in
/// the manifest (ADR-0009, open questions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairStatus {
    /// `true` when no issues were found.
    pub ok: bool,
    /// Deterministic, ordered list of issues; empty when `ok`.
    pub issues: Vec<LayoutIssue>,
}

impl RepairStatus {
    fn new(issues: Vec<LayoutIssue>) -> Self {
        Self {
            ok: issues.is_empty(),
            issues,
        }
    }

    pub fn needs_repair(&self) -> bool {
        !self.ok
    }
}

#[derive(Debug)]
pub struct ProjectStore {
    root: PathBuf,
    manifest: Manifest,
    writable: bool,
    _lock: Option<File>,
}

impl ProjectStore {
    /// Create a new project folder under `projects_dir`.
    pub fn create(projects_dir: &Path, name: &str) -> AppResult<Self> {
        let manifest = Manifest::new(name, now_rfc3339());
        let root = projects_dir.join(manifest.project_id.to_string());
        fs::create_dir_all(root.join("media"))
            .map_err(|err| AppError::io("create project dir", err))?;

        for file in DATA_FILES {
            write_bytes_atomic(&root.join(file), b"")?;
        }
        let mut store = Self {
            root,
            manifest,
            writable: false,
            _lock: None,
        };
        store.manifest.content_hash = compute_content_hash(&store.root, SCHEMA_VERSION)?;
        store.write_manifest()?;
        store.lock_exclusive()?;
        Ok(store)
    }

    /// Open an existing project. `writable=true` takes the exclusive lock.
    pub fn open(project_dir: &Path, writable: bool) -> AppResult<Self> {
        ensure_project_dir(project_dir)?;
        let manifest: Manifest = read_json(&project_dir.join(MANIFEST_FILE))?;
        if manifest.format_version > FORMAT_VERSION {
            return Err(AppError::new(
                codes::FORMAT_VERSION_UNSUPPORTED,
                "Project format is newer than this app",
            )
            .with_param("formatVersion", manifest.format_version.to_string()));
        }
        let mut store = Self {
            root: project_dir.to_path_buf(),
            manifest,
            writable,
            _lock: None,
        };
        if writable {
            store.lock_exclusive()?;
        }
        store.manifest.counts = store.counts()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn is_writable(&self) -> bool {
        self.writable
    }

    fn lock_exclusive(&mut self) -> AppResult<()> {
        self._lock = Some(acquire_exclusive_lock(&self.root)?);
        self.writable = true;
        Ok(())
    }

    fn ensure_writable(&self) -> AppResult<()> {
        if self.writable {
            Ok(())
        } else {
            Err(
                AppError::new(codes::PROJECT_LOCKED, "Project opened read-only")
                    .with_param("reason", "readOnly"),
            )
        }
    }

    pub fn persons(&self) -> AppResult<Vec<Person>> {
        read_rows::<Person>(&self.root.join(PERSON_FILE))
    }

    pub fn save_persons(&mut self, persons: &[Person]) -> AppResult<()> {
        self.save_collection(PERSON_FILE, persons)
    }

    pub fn events(&self) -> AppResult<Vec<Event>> {
        read_rows::<Event>(&self.root.join(EVENT_FILE))
    }

    pub fn save_events(&mut self, events: &[Event]) -> AppResult<()> {
        self.save_collection(EVENT_FILE, events)
    }

    pub fn relationships(&self) -> AppResult<Vec<Relationship>> {
        read_rows::<Relationship>(&self.root.join(RELATIONSHIP_FILE))
    }

    /// Validated view of all relationships (self-links, duplicates, cycles).
    pub fn relationship_set(&self) -> AppResult<RelationshipSet> {
        RelationshipSet::new(self.relationships()?)
    }

    pub fn save_relationships(&mut self, relationships: &[Relationship]) -> AppResult<()> {
        // Set-level invariants: self-link, duplicate, canonical spouse order
        // and parent cycles. Per-row checks run again in `save_collection`.
        RelationshipSet::new(relationships.to_vec())?;
        self.save_collection(RELATIONSHIP_FILE, relationships)
    }

    pub fn sources(&self) -> AppResult<Vec<Source>> {
        read_rows::<Source>(&self.root.join(SOURCE_FILE))
    }

    pub fn save_sources(&mut self, sources: &[Source]) -> AppResult<()> {
        self.save_collection(SOURCE_FILE, sources)
    }

    pub fn citations(&self) -> AppResult<Vec<Citation>> {
        read_rows::<Citation>(&self.root.join(CITATION_FILE))
    }

    pub fn save_citations(&mut self, citations: &[Citation]) -> AppResult<()> {
        self.save_collection(CITATION_FILE, citations)
    }

    pub fn media(&self) -> AppResult<Vec<Media>> {
        read_rows::<Media>(&self.root.join(MEDIA_FILE))
    }

    /// Store media metadata. The file itself is copied by [`store_media_file`].
    pub fn save_media(&mut self, media: &[Media]) -> AppResult<()> {
        self.save_collection(MEDIA_FILE, media)
    }

    /// Absolute path of one stored media file; see [`resolve_media_path`].
    pub fn resolve_media_path(&self, media: &Media) -> AppResult<PathBuf> {
        resolve_media_path(&self.root, media)
    }

    /// Per-entity optimistic-concurrency tokens: `id -> updatedAt` of every
    /// envelope in `file`. `file` must be one of the six JSONL collections.
    pub fn collection_versions(&self, file: &str) -> AppResult<BTreeMap<Uuid, String>> {
        ensure_data_file(file)?;
        read_envelope_versions(&self.root.join(file))
    }

    /// Compare `expected` with the stored `updatedAt` of `id`.
    ///
    /// Returns `STALE_WRITE` when both exist but differ, `NOT_FOUND` when the
    /// row is absent and `VALIDATION_ERROR` for an unknown collection name.
    pub fn check_version(&self, file: &str, id: Uuid, expected: &str) -> AppResult<()> {
        ensure_data_file(file)?;
        let versions = read_envelope_versions(&self.root.join(file))?;
        match versions.get(&id) {
            Some(actual) if actual == expected => Ok(()),
            Some(actual) => Err(AppError::new(codes::STALE_WRITE, "Entity was modified")
                .with_param("id", id.to_string())
                .with_param("expected", expected)
                .with_param("actual", actual.clone())),
            None => Err(AppError::new(codes::NOT_FOUND, "Entity not found")
                .with_param("id", id.to_string())
                .with_param("file", file.to_owned())),
        }
    }

    pub fn add_person(&mut self, person: Person) -> AppResult<Person> {
        self.ensure_writable()?;
        person.validate()?;
        let mut persons = self.persons()?;
        persons.push(person.clone());
        self.save_persons(&persons)?;
        Ok(person)
    }

    /// Point the project at a home person, or clear the pointer with `None`.
    /// A missing person is `NOT_FOUND`; the manifest is rewritten last
    /// (ADR-0009).
    pub fn set_home_person(&mut self, home: Option<Uuid>) -> AppResult<()> {
        self.ensure_writable()?;
        if let Some(id) = home {
            if !self.persons()?.iter().any(|person| person.id == id) {
                return Err(AppError::new(codes::NOT_FOUND, "Person not found")
                    .with_param("id", id.to_string()));
            }
        }
        self.manifest.home_person_id = home;
        self.finish_mutation()
    }

    /// Rename the project. The name is trimmed; blank, over-long and
    /// duplicate names are `VALIDATION_ERROR` on the `name` field. Only
    /// `manifest.json` changes, rewritten atomically; the in-memory manifest
    /// follows, so a caller holding this store sees the new name.
    ///
    /// A read-only store refuses with `PROJECT_LOCKED`, never panics.
    pub fn rename(&mut self, name: &str) -> AppResult<()> {
        self.ensure_writable()?;
        let name = normalize_project_name(name)?;
        if let Some(projects_dir) = self.root.parent() {
            ensure_unique_project_name(projects_dir, self.manifest.project_id, &name)?;
        }
        self.manifest.name = name;
        self.finish_mutation()
    }

    /// Validate every entity, then rewrite the collection atomically.
    fn save_collection<T: Entity>(&mut self, file: &str, items: &[T]) -> AppResult<()> {
        self.ensure_writable()?;
        for item in items {
            item.validate_entity()?;
        }
        let mut rows = Vec::with_capacity(items.len());
        let meta = read_envelope_meta(&self.root.join(file))?;
        for item in items {
            let id = item.entity_id();
            let mut row = Row::new(id, item.clone());
            if let Some(existing) = meta.get(&id) {
                row.created_at = existing.created_at.clone();
                let current = serde_json::to_value(item)
                    .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
                if existing.data == current {
                    // Unchanged entity: do not move its version, otherwise
                    // expectedVersion produces false STALE_WRITE conflicts.
                    row.updated_at = existing.updated_at.clone();
                }
            }
            rows.push(row);
        }
        write_rows(&self.root.join(file), &rows)?;
        self.finish_mutation()
    }

    /// Refresh `updatedAt`, recount all six collections and the content hash,
    /// then write the manifest last (two-phase write, ADR-0009).
    ///
    /// A writable project older than [`FORMAT_VERSION`] is upgraded in memory
    /// here, so its first successful mutation writes the current version
    /// (ADR-0015). Opening read-only never rewrites the manifest.
    fn finish_mutation(&mut self) -> AppResult<()> {
        self.manifest.updated_at = now_rfc3339();
        if self.manifest.format_version < FORMAT_VERSION {
            self.manifest.format_version = FORMAT_VERSION;
        }
        self.manifest.counts = self.counts()?;
        self.manifest.content_hash = compute_content_hash(&self.root, SCHEMA_VERSION)?;
        self.write_manifest()
    }

    fn write_manifest(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.manifest)
            .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
        write_bytes_atomic(&self.root.join(MANIFEST_FILE), &bytes)
    }

    /// Count every JSONL file. `counts` in the manifest is only a hint.
    pub fn counts(&self) -> AppResult<Counts> {
        Ok(Counts {
            persons: read_rows::<Person>(&self.root.join(PERSON_FILE))?.len(),
            relationships: read_rows::<Relationship>(&self.root.join(RELATIONSHIP_FILE))?.len(),
            events: read_rows::<Event>(&self.root.join(EVENT_FILE))?.len(),
            sources: read_rows::<Source>(&self.root.join(SOURCE_FILE))?.len(),
            citations: read_rows::<Citation>(&self.root.join(CITATION_FILE))?.len(),
            media: read_rows::<Media>(&self.root.join(MEDIA_FILE))?.len(),
        })
    }

    /// Layout check of the open project; see [`validate_layout`].
    pub fn validate_layout(&self) -> AppResult<RepairStatus> {
        self::validate_layout(&self.root)
    }

    /// Full project backup: manifest + JSONL + media + checksums.sha256.
    pub fn backup(&self, backups_dir: &Path) -> AppResult<PathBuf> {
        let dir = backups_dir.join(self.manifest.project_id.to_string());
        fs::create_dir_all(&dir).map_err(|err| AppError::io("create backups dir", err))?;
        let stamp = filesystem_timestamp();
        let target = dir.join(format!("{stamp}{BACKUP_SUFFIX}"));
        let tmp = target.with_extension("zip.tmp");

        let mut checksums = Vec::new();
        let file = File::create(&tmp).map_err(|err| AppError::io("create backup", err))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for relative in self.data_files_including_media()? {
            let path = self.root.join(&relative);
            let bytes = fs::read(&path).map_err(|err| AppError::io("read for backup", err))?;
            checksums.push(format!(
                "{}  {}",
                hex::encode(Sha256::digest(&bytes)),
                relative
            ));
            zip.start_file(relative, options)
                .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
            zip.write_all(&bytes)
                .map_err(|err| AppError::io("write zip entry", err))?;
        }
        let checksum_bytes = checksums.join("\n").into_bytes();
        zip.start_file(CHECKSUMS_FILE, options)
            .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
        zip.write_all(&checksum_bytes)
            .map_err(|err| AppError::io("write checksums", err))?;
        zip.finish()
            .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;

        fs::rename(&tmp, &target).map_err(|err| AppError::io("finalize backup", err))?;
        Ok(target)
    }

    fn data_files_including_media(&self) -> AppResult<Vec<String>> {
        let mut files = vec![MANIFEST_FILE.to_owned()];
        for file in DATA_FILES {
            if self.root.join(file).is_file() {
                files.push(file.to_owned());
            }
        }
        let media_root = self.root.join("media");
        if media_root.is_dir() {
            for entry in walkdir::WalkDir::new(&media_root).sort_by_file_name() {
                let entry = entry.map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
                if entry.file_type().is_file() {
                    let relative = entry
                        .path()
                        .strip_prefix(&self.root)
                        .map_err(|_| AppError::new(codes::IO_ERROR, "strip prefix"))?;
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        Ok(files)
    }

    /// Restore a backup into a brand-new project. Never overwrites an existing one.
    pub fn restore(backup_zip: &Path, projects_dir: &Path) -> AppResult<Self> {
        let file = File::open(backup_zip).map_err(|err| AppError::io("open backup", err))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|_| AppError::new(codes::IMPORT_PARSE_ERROR, "Invalid zip archive"))?;

        let new_id = ProjectId::now_v7();
        let staging = projects_dir.join(format!(".restore-{new_id}"));
        fs::create_dir_all(staging.join("media"))
            .map_err(|err| AppError::io("create staging", err))?;

        let mut declared: Vec<(String, String)> = Vec::new();
        let mut extracted = 0usize;
        let mut total_bytes: u64 = 0;

        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|_| AppError::new(codes::IMPORT_PARSE_ERROR, "Bad zip entry"))?;
            let name = entry.name().to_owned();
            if is_unsafe_path(&name) {
                cleanup(&staging);
                return Err(AppError::new(
                    codes::IMPORT_PARSE_ERROR,
                    "Zip entry escapes project folder",
                )
                .with_param("entry", name));
            }
            if name.ends_with('/') {
                continue;
            }
            if name == CHECKSUMS_FILE {
                let mut text = String::new();
                entry
                    .read_to_string(&mut text)
                    .map_err(|err| AppError::io("read checksums", err))?;
                declared = parse_checksums(&text);
                continue;
            }
            total_bytes += entry.size();
            if total_bytes > 2 * 1024 * 1024 * 1024 {
                cleanup(&staging);
                return Err(AppError::new(codes::IMPORT_PARSE_ERROR, "Backup too large"));
            }
            let target = staging.join(&name);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|err| AppError::io("create media dir", err))?;
            }
            let mut out =
                File::create(&target).map_err(|err| AppError::io("extract entry", err))?;
            std::io::copy(&mut entry, &mut out).map_err(|err| AppError::io("copy entry", err))?;
            extracted += 1;
        }

        for (expected, relative) in declared {
            let path = staging.join(&relative);
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    cleanup(&staging);
                    return Err(AppError::new(
                        codes::BACKUP_CHECKSUM_MISMATCH,
                        "File from checksums is missing",
                    )
                    .with_param("file", relative));
                }
            };
            let actual = hex::encode(Sha256::digest(&bytes));
            if actual != expected {
                cleanup(&staging);
                return Err(
                    AppError::new(codes::BACKUP_CHECKSUM_MISMATCH, "Checksum mismatch")
                        .with_param("file", relative),
                );
            }
        }
        if extracted == 0 {
            cleanup(&staging);
            return Err(AppError::new(codes::IMPORT_PARSE_ERROR, "Empty backup"));
        }

        let mut manifest: Manifest = read_json(&staging.join(MANIFEST_FILE))?;
        if manifest.format_version > FORMAT_VERSION {
            cleanup(&staging);
            return Err(AppError::new(
                codes::FORMAT_VERSION_UNSUPPORTED,
                "Backup format is newer than this app",
            ));
        }
        manifest.project_id = new_id;
        manifest.created_at = now_rfc3339();
        manifest.updated_at = now_rfc3339();
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
        fs::write(staging.join(MANIFEST_FILE), bytes)
            .map_err(|err| AppError::io("rewrite manifest", err))?;

        let target = projects_dir.join(new_id.to_string());
        fs::rename(&staging, &target).map_err(|err| AppError::io("finalize restore", err))?;
        Self::open(&target, true)
    }
}

/// List all readable projects in `projects_dir`, newest `updatedAt` first.
///
/// A directory whose `manifest.json` is missing, corrupt or from a newer
/// format is skipped; one broken project never hides the healthy ones.
pub fn list_projects(projects_dir: &Path) -> AppResult<Vec<Manifest>> {
    let entries = match fs::read_dir(projects_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(AppError::io("read projects dir", err)),
    };

    let mut manifests = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        if !matches!(entry.file_type(), Ok(kind) if kind.is_dir()) {
            continue;
        }
        // Hidden folders (`.trash`, `.restore-*`) are not projects.
        if matches!(entry.file_name().to_str(), Some(name) if name.starts_with('.')) {
            continue;
        }
        let Ok(manifest) = read_json::<Manifest>(&entry.path().join(MANIFEST_FILE)) else {
            continue;
        };
        if manifest.format_version > FORMAT_VERSION {
            continue;
        }
        manifests.push(manifest);
    }
    manifests.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.project_id.cmp(&b.project_id))
    });
    Ok(manifests)
}

/// Rename a closed project: takes the exclusive lock, rewrites
/// `manifest.json` atomically and releases the lock. A project held open for
/// writing elsewhere is refused with `PROJECT_LOCKED`.
pub fn rename_project(
    projects_dir: &Path,
    project_id: ProjectId,
    name: &str,
) -> AppResult<Manifest> {
    let name = normalize_project_name(name)?;
    ensure_unique_project_name(projects_dir, project_id, &name)?;
    let dir = projects_dir.join(project_id.to_string());
    let mut store = ProjectStore::open(&dir, true)?;
    store.manifest.name = name;
    store.finish_mutation()?;
    Ok(store.manifest.clone())
}

/// Reject a name already used by another project in the same folder.
/// The project's own name never conflicts with itself.
fn ensure_unique_project_name(
    projects_dir: &Path,
    project_id: ProjectId,
    name: &str,
) -> AppResult<()> {
    let duplicate = list_projects(projects_dir)?.into_iter().any(|manifest| {
        manifest.project_id != project_id && project_names_equal(&manifest.name, name)
    });
    if duplicate {
        return Err(AppError::validation("name", "duplicate"));
    }
    Ok(())
}

/// Move a project folder into `<trash_root>/<projectId>-<timestamp>`.
///
/// Files are never deleted; a human (or a later explicit command) empties the
/// trash. The project is locked before the move, so a project opened for
/// writing is refused with `PROJECT_LOCKED`; the OS lock is held through the
/// rename where the platform allows it.
///
/// When `manifest.json` cannot be read, the folder name is used as the project
/// id so a corrupt project stays deletable.
pub fn delete_project(project_dir: &Path, trash_root: &Path) -> AppResult<PathBuf> {
    ensure_project_dir(project_dir)?;

    let project_id = match read_json::<Manifest>(&project_dir.join(MANIFEST_FILE)) {
        Ok(manifest) => manifest.project_id,
        Err(err) => {
            let from_name = project_dir
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| Uuid::parse_str(name).ok());
            match from_name {
                Some(id) => id,
                None => return Err(err),
            }
        }
    };

    let mut lock_file = Some(acquire_exclusive_lock(project_dir)?);

    fs::create_dir_all(trash_root).map_err(|err| AppError::io("create trash dir", err))?;
    let stamp = filesystem_timestamp();
    let mut target = trash_root.join(format!("{project_id}-{stamp}"));
    let mut suffix = 1usize;
    while target.exists() {
        target = trash_root.join(format!("{project_id}-{stamp}-{suffix}"));
        suffix += 1;
    }

    // Windows refuses to rename a folder that still has an open handle inside
    // it, so the lock is released only for the retry. On POSIX the lock is held
    // through the move.
    let moved = match fs::rename(project_dir, &target) {
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            drop(lock_file.take());
            fs::rename(project_dir, &target)
        }
        other => other,
    };
    moved.map_err(|err| AppError::io("move project to trash", err))?;
    Ok(target)
}

/// Delete all but the newest `keep` backups of one project.
///
/// Backups live in `<backups_dir>/<projectId>/<timestamp>.gentree.zip` and are
/// ordered by file name; RFC 3339 timestamps sort lexicographically. The newest
/// backup is never removed, even when `keep` is `0`.
pub fn prune_backups(backups_dir: &Path, project_id: Uuid, keep: usize) -> AppResult<usize> {
    let dir = backups_dir.join(project_id.to_string());
    if !dir.is_dir() {
        return Ok(0);
    }

    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| AppError::io("read backups dir", err))? {
        let entry = entry.map_err(|err| AppError::io("read backups dir", err))?;
        let is_file = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if !is_file {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if name.ends_with(BACKUP_SUFFIX) {
                names.push(name.to_owned());
            }
        }
    }

    names.sort_unstable();
    let keep = keep.max(1);
    if names.len() <= keep {
        return Ok(0);
    }
    let removed = names.len() - keep;
    for name in names.iter().take(removed) {
        fs::remove_file(dir.join(name)).map_err(|err| AppError::io("remove backup", err))?;
    }
    Ok(removed)
}

/// Copy `source_path` into the project's `media/` folder and return
/// `(relativePath, sha256)`.
///
/// The file is stored at `media/<sha256 prefix>/<file name>`; the name must be
/// a plain file name — separators, `..`, hidden names and control characters
/// are refused. The copy goes through a temp file, so an interrupted copy never
/// leaves a truncated media file.
pub fn store_media_file(project_dir: &Path, source_path: &Path) -> AppResult<(String, String)> {
    ensure_project_dir(project_dir)?;
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::validation("fileName", "required"))?;
    validate_media_file_name(file_name)?;
    if !source_path.is_file() {
        return Err(AppError::new(codes::NOT_FOUND, "Media source file missing")
            .with_param("path", source_path.display().to_string()));
    }

    let checksum = sha256_file(source_path)?;
    let relative = media_relative_path(&checksum, file_name)?;
    let target = project_dir.join(&relative);
    write_media_atomic(&target, |file| {
        let mut source = File::open(source_path)?;
        std::io::copy(&mut source, file)?;
        file.sync_all()
    })?;

    Ok((relative, checksum))
}

/// Atomic write under `media/`; the hashed parent folder is created first.
fn write_media_atomic(
    target: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> AppResult<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| AppError::io("create media dir", err))?;
    }
    AtomicFile::new(target, AllowOverwrite)
        .write(write)
        .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))
}

/// Writes the bytes of an in-database media preview into the project and
/// returns `(relativePath, sha256)`. Same layout and name checks as
/// [`store_media_file`]; used by AT5 imports whose preview exists only as a
/// blob in the SQLite file.
pub fn store_media_bytes(
    project_dir: &Path,
    file_name: &str,
    bytes: &[u8],
) -> AppResult<(String, String)> {
    ensure_project_dir(project_dir)?;
    validate_media_file_name(file_name)?;
    let checksum = hex::encode(Sha256::digest(bytes));
    let relative = media_relative_path(&checksum, file_name)?;
    let target = project_dir.join(&relative);
    write_media_atomic(&target, |file| {
        file.write_all(bytes)?;
        file.sync_all()
    })?;
    Ok((relative, checksum))
}

/// Project-relative path of a media file: `media/<sha256[..2]>/<fileName>`.
pub fn media_relative_path(checksum: &str, file_name: &str) -> AppResult<String> {
    if checksum.len() < 2 {
        return Err(AppError::validation("checksum", "sha256"));
    }
    validate_media_file_name(file_name)?;
    Ok(format!("media/{}/{file_name}", &checksum[..2]))
}

/// Absolute path of a media file inside `project_dir`, with the same checks as
/// [`media_relative_path`].
///
/// The result is guaranteed to stay under the project's `media/` folder: the
/// checksum must be a sha256 hex digest and the joined path may not contain a
/// non-normal component (`..`, a root or a drive prefix). A record that fails
/// either check is `NOT_FOUND`, never a path outside the project.
pub fn resolve_media_path(project_dir: &Path, media: &Media) -> AppResult<PathBuf> {
    if media.checksum.len() != 64 || !media.checksum.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(
            AppError::new(codes::NOT_FOUND, "Media record has no valid checksum")
                .with_param("id", media.id.to_string()),
        );
    }
    let relative = media_relative_path(&media.checksum, &media.file_name)?;
    let media_dir = project_dir.join("media");
    let path = project_dir.join(relative);
    let inside = path
        .strip_prefix(&media_dir)
        .map(|rest| {
            !rest.as_os_str().is_empty()
                && rest
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
        })
        .unwrap_or(false);
    if !inside {
        return Err(AppError::new(
            codes::NOT_FOUND,
            "Media path is outside the project media folder",
        )
        .with_param("id", media.id.to_string()));
    }
    Ok(path)
}

/// Check the project folder against its manifest without writing anything.
///
/// Reports a missing/corrupt manifest, missing or unreadable JSONL files, row
/// counts that disagree with `counts`, and a stale `contentHash`. Nothing is
/// repaired here; the status is computed on demand and never stored in the
/// manifest.
pub fn validate_layout(project_dir: &Path) -> AppResult<RepairStatus> {
    ensure_project_dir(project_dir)?;

    let mut issues = Vec::new();
    let manifest_path = project_dir.join(MANIFEST_FILE);
    let manifest = if !manifest_path.is_file() {
        issues.push(LayoutIssue::MissingManifest);
        None
    } else {
        match read_json::<Manifest>(&manifest_path) {
            Ok(manifest) if manifest.format_version > FORMAT_VERSION => {
                issues.push(LayoutIssue::FormatVersionUnsupported {
                    found: manifest.format_version,
                    supported: FORMAT_VERSION,
                });
                None
            }
            Ok(manifest) => Some(manifest),
            Err(err) => {
                issues.push(LayoutIssue::UnreadableManifest {
                    message: err.message,
                });
                None
            }
        }
    };

    for file in DATA_FILES {
        let path = project_dir.join(file);
        if !path.is_file() {
            issues.push(LayoutIssue::MissingFile {
                file: file.to_owned(),
            });
            continue;
        }
        match read_rows::<serde_json::Value>(&path) {
            Ok(rows) => {
                let actual = rows.len();
                if let Some(manifest) = &manifest {
                    let expected = count_for(&manifest.counts, file);
                    if expected != actual {
                        issues.push(LayoutIssue::CountMismatch {
                            file: file.to_owned(),
                            expected,
                            actual,
                        });
                    }
                }
            }
            Err(err) => issues.push(LayoutIssue::UnreadableFile {
                file: file.to_owned(),
                message: err.message,
            }),
        }
    }

    if let Some(manifest) = &manifest {
        let actual = compute_content_hash(project_dir, manifest.schema_version)?;
        if actual != manifest.content_hash {
            issues.push(LayoutIssue::ContentHashMismatch {
                expected: manifest.content_hash.clone(),
                actual,
            });
        }
    }

    Ok(RepairStatus::new(issues))
}

fn count_for(counts: &Counts, file: &str) -> usize {
    match file {
        PERSON_FILE => counts.persons,
        RELATIONSHIP_FILE => counts.relationships,
        EVENT_FILE => counts.events,
        SOURCE_FILE => counts.sources,
        CITATION_FILE => counts.citations,
        MEDIA_FILE => counts.media,
        _ => 0,
    }
}

fn validate_media_file_name(name: &str) -> AppResult<()> {
    let unsafe_name = name.trim().is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\', ':', '\0'])
        || name.contains("..")
        || name.chars().any(char::is_control);
    if unsafe_name {
        return Err(AppError::validation("fileName", "pathTraversal"));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path).map_err(|err| AppError::io("open media", err))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| AppError::io("read media", err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// File-system-safe timestamp: RFC 3339 with `:` replaced (Windows forbids it
/// in file names). Lexicographic order still matches chronological order.
fn filesystem_timestamp() -> String {
    now_rfc3339().replace(':', "-")
}

fn parse_checksums(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            Some((hash.to_owned(), name.to_owned()))
        })
        .collect()
}

fn is_unsafe_path(name: &str) -> bool {
    name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains(':')
        || name.split(['/', '\\']).any(|part| part == "..")
}

fn cleanup(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn read_json<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let bytes = fs::read(path).map_err(|err| AppError::io("read json", err))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new(codes::PROJECT_CORRUPTED, "Invalid JSON file"))
}

fn ensure_data_file(file: &str) -> AppResult<()> {
    if DATA_FILES.contains(&file) {
        Ok(())
    } else {
        Err(AppError::validation("file", "unknownCollection"))
    }
}

/// Text of one JSONL file, `None` when it does not exist yet.
fn read_jsonl_text(path: &Path, context: &str) -> AppResult<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|err| AppError::io(context, err))
}

/// Non-empty JSONL lines with their 0-based index (the error adds 1).
fn jsonl_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
}

fn invalid_jsonl_row(path: &Path, index: usize) -> AppError {
    AppError::new(codes::PROJECT_CORRUPTED, "Invalid JSONL row")
        .with_param("file", path.display().to_string())
        .with_param("line", (index + 1).to_string())
}

/// Read only the envelope metadata (`id`, `updatedAt`) of one JSONL file.
fn read_envelope_versions(path: &Path) -> AppResult<BTreeMap<Uuid, String>> {
    let Some(text) = read_jsonl_text(path, "read jsonl meta")? else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    for (index, line) in jsonl_lines(&text) {
        let value: serde_json::Value =
            serde_json::from_str(line).map_err(|_| invalid_jsonl_row(path, index))?;
        let id = value.get("id").and_then(|item| item.as_str());
        let updated = value.get("updatedAt").and_then(|item| item.as_str());
        if let (Some(id), Some(updated)) = (id, updated) {
            if let Ok(id) = Uuid::parse_str(id) {
                out.insert(id, updated.to_owned());
            }
        }
    }
    Ok(out)
}

/// Envelope metadata needed to keep stable versions across a collection rewrite.
struct EnvelopeMeta {
    created_at: String,
    updated_at: String,
    data: serde_json::Value,
}

fn read_envelope_meta(path: &Path) -> AppResult<HashMap<Uuid, EnvelopeMeta>> {
    let Some(text) = read_jsonl_text(path, "read jsonl meta")? else {
        return Ok(HashMap::new());
    };
    let mut out = HashMap::new();
    for (index, line) in jsonl_lines(&text) {
        let value: serde_json::Value =
            serde_json::from_str(line).map_err(|_| invalid_jsonl_row(path, index))?;
        let id = value.get("id").and_then(|item| item.as_str());
        let created = value.get("createdAt").and_then(|item| item.as_str());
        let updated = value.get("updatedAt").and_then(|item| item.as_str());
        if let (Some(id), Some(created), Some(updated)) = (id, created, updated) {
            if let Ok(id) = Uuid::parse_str(id) {
                out.insert(
                    id,
                    EnvelopeMeta {
                        created_at: created.to_owned(),
                        updated_at: updated.to_owned(),
                        data: value
                            .get("data")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    },
                );
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
fn read_envelope_created_at(path: &Path) -> AppResult<HashMap<Uuid, String>> {
    Ok(read_envelope_meta(path)?
        .into_iter()
        .map(|(id, meta)| (id, meta.created_at))
        .collect())
}

pub fn read_rows<T: DeserializeOwned>(path: &Path) -> AppResult<Vec<T>> {
    let Some(text) = read_jsonl_text(path, "read jsonl")? else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for (index, line) in jsonl_lines(&text) {
        let row: Row<T> = serde_json::from_str(line).map_err(|_| invalid_jsonl_row(path, index))?;
        if row.schema > SCHEMA_VERSION {
            return Err(AppError::new(
                codes::FORMAT_VERSION_UNSUPPORTED,
                "Row schema is newer than this app",
            )
            .with_param("line", (index + 1).to_string()));
        }
        rows.push(row.data);
    }
    Ok(rows)
}

fn write_rows<T: Serialize>(path: &Path, rows: &[Row<T>]) -> AppResult<()> {
    let mut out = String::new();
    for row in rows {
        let line = serde_json::to_string(row)
            .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?;
        out.push_str(&line);
        out.push('\n');
    }
    write_bytes_atomic(path, out.as_bytes())
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let atomic = AtomicFile::new(path, AllowOverwrite);
    atomic
        .write(|file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))
}

/// sha256 over `schemaVersion` + (file name, line count, sha256(content)) for
/// every JSONL file + media.jsonl. See ADR-0009.
pub fn compute_content_hash(root: &Path, schema_version: u32) -> AppResult<String> {
    let mut hasher = Sha256::new();
    hasher.update(schema_version.to_le_bytes());
    for file in DATA_FILES {
        let path = root.join(file);
        let bytes = if path.exists() {
            fs::read(&path).map_err(|err| AppError::io("hash read", err))?
        } else {
            Vec::new()
        };
        let lines = bytes.iter().filter(|byte| **byte == b'\n').count();
        hasher.update(file.as_bytes());
        hasher.update((lines as u64).to_le_bytes());
        hasher.update(Sha256::digest(&bytes));
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::person::Name;
    use gentree_core::record::{CitationTarget, EventType};
    use gentree_core::relationship::RelationshipType;
    use gentree_core::{PlaceGeo, PlacePrecision, PlaceSource};

    fn store(dir: &Path) -> ProjectStore {
        ProjectStore::create(dir, "Тестовый проект").unwrap()
    }

    fn person(given: &str) -> Person {
        Person::new(vec![Name {
            given: Some(given.into()),
            surname: Some("Петров".into()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap()
    }

    fn event(person_id: Uuid) -> Event {
        let mut event = Event::new(person_id, EventType::Birth);
        event.place = Some("Москва".into());
        event
    }

    fn media_record(file_name: &str, checksum: &str) -> Media {
        Media {
            id: Uuid::now_v7(),
            file_name: file_name.into(),
            mime_type: "image/jpeg".into(),
            checksum: checksum.into(),
            caption: None,
            source_id: None,
            person_id: None,
            event_id: None,
            primary: false,
        }
    }

    #[test]
    fn create_write_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let id = project.manifest().project_id;
        project.add_person(person("Иван")).unwrap();
        project.add_person(person("Мария")).unwrap();
        drop(project);

        let reopened = ProjectStore::open(&tmp.path().join(id.to_string()), true).unwrap();
        let persons = reopened.persons().unwrap();
        assert_eq!(persons.len(), 2);
        assert_eq!(persons[0].display_name(), "Петров Иван");
        assert!(reopened.manifest().content_hash.starts_with("sha256:"));
    }

    #[test]
    fn home_person_is_persisted_in_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let id = project.manifest().project_id;
        let ivan = person("Иван");
        project.save_persons(std::slice::from_ref(&ivan)).unwrap();
        project.set_home_person(Some(ivan.id)).unwrap();
        assert_eq!(project.manifest().home_person_id, Some(ivan.id));

        let unknown = Uuid::now_v7();
        let err = project.set_home_person(Some(unknown)).unwrap_err();
        assert_eq!(err.code, codes::NOT_FOUND);
        assert_eq!(project.manifest().home_person_id, Some(ivan.id));
        drop(project);

        let mut reopened = ProjectStore::open(&tmp.path().join(id.to_string()), true).unwrap();
        assert_eq!(reopened.manifest().home_person_id, Some(ivan.id));
        reopened.set_home_person(None).unwrap();
        assert_eq!(reopened.manifest().home_person_id, None);
    }

    #[test]
    fn second_writer_is_locked() {
        let tmp = tempfile::tempdir().unwrap();
        let project = store(tmp.path());
        let dir = project.root().to_path_buf();
        let err = ProjectStore::open(&dir, true).unwrap_err();
        assert_eq!(err.code, codes::PROJECT_LOCKED);
        drop(project);
        ProjectStore::open(&dir, true).unwrap();
    }

    #[test]
    fn corrupt_line_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let project = store(tmp.path());
        let id = project.manifest().project_id;
        drop(project);
        let path = tmp.path().join(id.to_string()).join(PERSON_FILE);
        fs::write(&path, b"{not json}\n").unwrap();
        let err = ProjectStore::open(&tmp.path().join(id.to_string()), false).unwrap_err();
        assert_eq!(err.code, codes::PROJECT_CORRUPTED);
        assert_eq!(err.params.get("line").map(String::as_str), Some("1"));
    }

    #[test]
    fn all_collections_roundtrip_with_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());

        let ivan = person("Иван");
        let maria = person("Мария");
        project
            .save_persons(&[ivan.clone(), maria.clone()])
            .unwrap();

        let birth = event(ivan.id);
        project.save_events(std::slice::from_ref(&birth)).unwrap();

        let parenting =
            Relationship::new(RelationshipType::ParentChild, ivan.id, maria.id).unwrap();
        project
            .save_relationships(std::slice::from_ref(&parenting))
            .unwrap();

        let book = Source::new("Метрическая книга").unwrap();
        project.save_sources(std::slice::from_ref(&book)).unwrap();

        let citation = Citation::new(book.id, CitationTarget::Person, ivan.id);
        project
            .save_citations(std::slice::from_ref(&citation))
            .unwrap();

        let photo = media_record("scan.jpg", &"b".repeat(64));
        project.save_media(std::slice::from_ref(&photo)).unwrap();

        let counts = project.counts().unwrap();
        assert_eq!(
            counts,
            Counts {
                persons: 2,
                events: 1,
                relationships: 1,
                sources: 1,
                citations: 1,
                media: 1,
            }
        );
        assert_eq!(project.manifest().counts, counts);
        assert!(project.validate_layout().unwrap().ok);

        let id = project.manifest().project_id;
        drop(project);

        let reopened = ProjectStore::open(&tmp.path().join(id.to_string()), true).unwrap();
        assert_eq!(reopened.persons().unwrap(), vec![ivan, maria]);
        assert_eq!(reopened.events().unwrap(), vec![birth]);
        assert_eq!(reopened.relationships().unwrap(), vec![parenting]);
        assert_eq!(reopened.sources().unwrap(), vec![book]);
        assert_eq!(reopened.citations().unwrap(), vec![citation]);
        assert_eq!(reopened.media().unwrap(), vec![photo]);
        assert_eq!(reopened.manifest().counts, counts);
        assert_eq!(reopened.relationship_set().unwrap().rows().len(), 1);
    }

    #[test]
    fn invalid_entity_is_rejected_before_any_write() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());

        let good = Source::new("Книга").unwrap();
        project.save_sources(std::slice::from_ref(&good)).unwrap();

        let mut bad = good.clone();
        bad.title = "   ".into();
        let err = project.save_sources(&[good, bad]).unwrap_err();
        assert_eq!(err.code, codes::VALIDATION_ERROR);

        // The previously written collection is untouched.
        assert_eq!(project.sources().unwrap().len(), 1);
        assert_eq!(project.counts().unwrap().sources, 1);
    }

    #[test]
    fn relationship_invariants_are_enforced_on_save() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let a = person("Анна");
        let b = person("Борис");
        let c = person("Вера");
        project
            .save_persons(&[a.clone(), b.clone(), c.clone()])
            .unwrap();

        let ab = Relationship::new(RelationshipType::ParentChild, a.id, b.id).unwrap();
        let bc = Relationship::new(RelationshipType::ParentChild, b.id, c.id).unwrap();
        let ca = Relationship::new(RelationshipType::ParentChild, c.id, a.id).unwrap();
        let err = project
            .save_relationships(&[ab.clone(), bc.clone(), ca])
            .unwrap_err();
        assert_eq!(err.code, codes::RELATIONSHIP_CYCLE);
        assert!(project.relationships().unwrap().is_empty());

        project.save_relationships(&[ab, bc]).unwrap();
        assert_eq!(project.relationship_set().unwrap().rows().len(), 2);
    }

    #[test]
    fn list_projects_skips_corrupt_and_sorts_by_updated_at() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();

        let older = ProjectStore::create(&projects, "Старый").unwrap();
        let older_id = older.manifest().project_id;
        drop(older);
        let newer = ProjectStore::create(&projects, "Новый").unwrap();
        let newer_id = newer.manifest().project_id;
        drop(newer);

        set_updated_at(&projects.join(older_id.to_string()), "2026-01-01T00:00:00Z");
        set_updated_at(&projects.join(newer_id.to_string()), "2026-06-01T00:00:00Z");

        // Corrupt manifest: valid JSON is not required, the entry is skipped.
        let corrupt = projects.join(Uuid::now_v7().to_string());
        fs::create_dir_all(&corrupt).unwrap();
        fs::write(corrupt.join(MANIFEST_FILE), b"{not json}").unwrap();

        // Folder from a newer app version: skipped, not listed.
        let future = ProjectStore::create(&projects, "Будущий").unwrap();
        let future_id = future.manifest().project_id;
        drop(future);
        set_manifest_field(
            &projects.join(future_id.to_string()),
            "formatVersion",
            serde_json::Value::from(FORMAT_VERSION + 1),
        );

        // A plain file in the projects dir is ignored.
        fs::write(projects.join("readme.txt"), b"notes").unwrap();
        // Hidden folders are ignored too.
        fs::create_dir_all(projects.join(".trash")).unwrap();

        let listed = list_projects(&projects).unwrap();
        let names: Vec<&str> = listed.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Новый", "Старый"]);
        assert_eq!(listed[0].project_id, newer_id);

        // A missing projects dir is an empty list, not an error.
        assert!(list_projects(&tmp.path().join("absent"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn prune_backups_keeps_newest_n() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("backups");
        let project_id = Uuid::now_v7();
        let dir = backups.join(project_id.to_string());
        fs::create_dir_all(&dir).unwrap();

        let stamps = [
            "2026-01-01T00-00-00Z",
            "2026-01-02T00-00-00Z",
            "2026-01-03T00-00-00Z",
            "2026-01-04T00-00-00Z",
            "2026-01-05T00-00-00Z",
        ];
        for stamp in stamps {
            fs::write(
                dir.join(format!("{stamp}{BACKUP_SUFFIX}")),
                stamp.as_bytes(),
            )
            .unwrap();
        }
        fs::write(dir.join("notes.txt"), b"keep me").unwrap();

        assert_eq!(prune_backups(&backups, project_id, 2).unwrap(), 3);
        let mut remaining = backup_names(&dir);
        remaining.sort();
        assert_eq!(
            remaining,
            vec![
                format!("2026-01-04T00-00-00Z{BACKUP_SUFFIX}"),
                format!("2026-01-05T00-00-00Z{BACKUP_SUFFIX}"),
            ]
        );
        assert!(dir.join("notes.txt").is_file());

        // `keep` above the current count removes nothing.
        assert_eq!(prune_backups(&backups, project_id, 10).unwrap(), 0);

        // Even `keep = 0` keeps the newest backup.
        assert_eq!(prune_backups(&backups, project_id, 0).unwrap(), 1);
        assert!(dir
            .join(format!("2026-01-05T00-00-00Z{BACKUP_SUFFIX}"))
            .is_file());
        assert_eq!(prune_backups(&backups, project_id, 5).unwrap(), 0);

        // Unknown project: nothing to prune.
        assert_eq!(prune_backups(&backups, Uuid::now_v7(), 2).unwrap(), 0);
    }

    #[test]
    fn delete_project_moves_to_trash_and_refuses_while_locked() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();
        let mut project = ProjectStore::create(&projects, "Удаляемый").unwrap();
        let id = project.manifest().project_id;
        project.add_person(person("Иван")).unwrap();
        let dir = project.root().to_path_buf();
        let trash = tmp.path().join(".trash");

        let err = delete_project(&dir, &trash).unwrap_err();
        assert_eq!(err.code, codes::PROJECT_LOCKED);
        assert!(dir.is_dir());

        drop(project);
        let moved = delete_project(&dir, &trash).unwrap();
        assert!(!dir.exists());
        assert!(moved.is_dir());
        let moved_name = moved.file_name().unwrap().to_string_lossy().into_owned();
        assert!(moved_name.starts_with(&id.to_string()));
        let manifest: Manifest = read_json(&moved.join(MANIFEST_FILE)).unwrap();
        assert_eq!(manifest.name, "Удаляемый");
        assert_eq!(
            read_rows::<Person>(&moved.join(PERSON_FILE)).unwrap().len(),
            1
        );

        let err = delete_project(&dir, &trash).unwrap_err();
        assert_eq!(err.code, codes::PROJECT_NOT_FOUND);
    }

    #[test]
    fn media_file_roundtrip_through_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("backups");
        let mut project = store(tmp.path());
        let ivan = person("Иван");
        project.save_persons(std::slice::from_ref(&ivan)).unwrap();

        let bytes = b"\xff\xd8\xff\xe0 fake jpeg bytes".to_vec();
        let source_file = tmp.path().join("scan.jpg");
        fs::write(&source_file, &bytes).unwrap();

        let (relative, checksum) = store_media_file(project.root(), &source_file).unwrap();
        assert_eq!(
            checksum,
            hex::encode(Sha256::digest(&bytes)),
            "helper returns the sha256 of the file"
        );
        assert_eq!(relative, format!("media/{}/scan.jpg", &checksum[..2]));
        assert_eq!(fs::read(project.root().join(&relative)).unwrap(), bytes);

        let photo = media_record("scan.jpg", &checksum);
        project.save_media(std::slice::from_ref(&photo)).unwrap();
        assert_eq!(project.counts().unwrap().media, 1);

        let zip = project.backup(&backups).unwrap();
        drop(project);

        let restored = ProjectStore::restore(&zip, tmp.path()).unwrap();
        assert_eq!(restored.media().unwrap(), vec![photo.clone()]);
        assert_eq!(restored.persons().unwrap(), vec![ivan]);
        let restored_path = resolve_media_path(restored.root(), &photo).unwrap();
        assert_eq!(fs::read(&restored_path).unwrap(), bytes);
        assert!(restored.validate_layout().unwrap().ok);
    }

    #[test]
    fn media_file_names_must_not_traverse() {
        let tmp = tempfile::tempdir().unwrap();
        let project = store(tmp.path());

        for name in [
            "../evil.jpg",
            "..",
            ".",
            ".hidden",
            "dir/evil.jpg",
            "dir\\evil.jpg",
            "c:evil.jpg",
            "   ",
        ] {
            let err = validate_media_file_name(name).unwrap_err();
            assert_eq!(err.code, codes::VALIDATION_ERROR, "name: {name}");
        }
        validate_media_file_name("scan 01.jpg").unwrap();

        // A source path ending in `..` has no usable file name.
        let err = store_media_file(project.root(), Path::new("media/..")).unwrap_err();
        assert_eq!(err.code, codes::VALIDATION_ERROR);

        // Missing source file is NOT_FOUND.
        let err = store_media_file(project.root(), &tmp.path().join("absent.jpg")).unwrap_err();
        assert_eq!(err.code, codes::NOT_FOUND);
    }

    #[test]
    fn validate_layout_reports_repair_issues() {
        let tmp = tempfile::tempdir().unwrap();
        let project = store(tmp.path());
        let id = project.manifest().project_id;
        drop(project);
        let dir = tmp.path().join(id.to_string());
        assert!(
            ProjectStore::open(&dir, false)
                .unwrap()
                .validate_layout()
                .unwrap()
                .ok
        );

        fs::remove_file(dir.join(EVENT_FILE)).unwrap();
        let mut persons = fs::read_to_string(dir.join(PERSON_FILE)).unwrap();
        let extra = Row::new(Uuid::now_v7(), person("Пётр"));
        persons.push_str(&serde_json::to_string(&extra).unwrap());
        persons.push('\n');
        fs::write(dir.join(PERSON_FILE), persons).unwrap();

        let status = validate_layout(&dir).unwrap();
        assert!(status.needs_repair());
        assert!(status.issues.contains(&LayoutIssue::MissingFile {
            file: EVENT_FILE.to_owned()
        }));
        assert!(status.issues.iter().any(|issue| matches!(
            issue,
            LayoutIssue::CountMismatch { file, expected: 0, actual: 1 } if file == PERSON_FILE
        )));
        assert!(status
            .issues
            .iter()
            .any(|issue| matches!(issue, LayoutIssue::ContentHashMismatch { .. })));

        let bare = tmp.path().join("bare");
        fs::create_dir_all(&bare).unwrap();
        let status = validate_layout(&bare).unwrap();
        assert!(status.issues.contains(&LayoutIssue::MissingManifest));
        assert_eq!(
            status
                .issues
                .iter()
                .filter(|issue| matches!(issue, LayoutIssue::MissingFile { .. }))
                .count(),
            6
        );

        let broken = tmp.path().join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(MANIFEST_FILE), b"{oops").unwrap();
        let status = validate_layout(&broken).unwrap();
        assert!(matches!(
            status.issues.first(),
            Some(LayoutIssue::UnreadableManifest { .. })
        ));

        let absent = tmp.path().join("absent");
        let err = validate_layout(&absent).unwrap_err();
        assert_eq!(err.code, codes::PROJECT_NOT_FOUND);
    }

    fn set_updated_at(project_dir: &Path, stamp: &str) {
        set_manifest_field(
            project_dir,
            "updatedAt",
            serde_json::Value::String(stamp.to_owned()),
        );
    }

    fn set_manifest_field(project_dir: &Path, key: &str, value: serde_json::Value) {
        let path = project_dir.join(MANIFEST_FILE);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest[key] = value;
        fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn rename_open_project_updates_memory_and_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let dir = project.root().to_path_buf();
        let before_updated_at = project.manifest().updated_at.clone();

        project.rename("  Новая семья  ").unwrap();
        assert_eq!(project.manifest().name, "Новая семья");
        assert!(project.manifest().updated_at >= before_updated_at);
        assert_eq!(read_manifest_name(&dir), "Новая семья");
        // Only the name changed: identity and counts survive.
        assert_eq!(
            read_manifest(&dir).project_id,
            project.manifest().project_id
        );
        assert!(project.validate_layout().unwrap().ok);

        // The same name again is fine (idempotent).
        project.rename("Новая семья").unwrap();
        assert_eq!(read_manifest_name(&dir), "Новая семья");
    }

    #[test]
    fn rename_closed_project_rewrites_manifest_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();
        let project = ProjectStore::create(&projects, "Старое имя").unwrap();
        let id = project.manifest().project_id;
        let dir = project.root().to_path_buf();
        drop(project);

        let manifest = rename_project(&projects, id, "Новое имя").unwrap();
        assert_eq!(manifest.name, "Новое имя");
        assert_eq!(read_manifest_name(&dir), "Новое имя");

        let reopened = ProjectStore::open(&dir, false).unwrap();
        assert_eq!(reopened.manifest().name, "Новое имя");

        // An unknown project id is NOT_FOUND, not a silent no-op.
        let err = rename_project(&projects, Uuid::now_v7(), "Кто-то").unwrap_err();
        assert_eq!(err.code, codes::PROJECT_NOT_FOUND);
    }

    #[test]
    fn rename_rejects_blank_and_over_long_names() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let dir = project.root().to_path_buf();

        for raw in ["", "   ", "\t"] {
            let err = project.rename(raw).unwrap_err();
            assert_eq!(err.code, codes::VALIDATION_ERROR);
            assert_eq!(err.params.get("field").map(String::as_str), Some("name"));
            assert_eq!(err.params.get("rule").map(String::as_str), Some("required"));
        }
        // The manifest on disk is untouched by a rejected rename.
        assert_eq!(read_manifest_name(&dir), "Тестовый проект");

        let too_long = "я".repeat(201);
        let err = project.rename(&too_long).unwrap_err();
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        assert_eq!(
            err.params.get("rule").map(String::as_str),
            Some("maxLength")
        );
        assert_eq!(read_manifest_name(&dir), "Тестовый проект");

        // Exactly 200 characters is allowed.
        project.rename(&"я".repeat(200)).unwrap();
        assert_eq!(read_manifest_name(&dir).chars().count(), 200);
    }

    #[test]
    fn rename_rejects_duplicate_names_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();
        let first = ProjectStore::create(&projects, "Первый").unwrap();
        let second = ProjectStore::create(&projects, "Второй").unwrap();
        let first_id = first.manifest().project_id;
        let mut second = second;

        for raw in ["Первый", "  первый  ", "ПЕРВЫЙ"] {
            let err = second.rename(raw).unwrap_err();
            assert_eq!(err.code, codes::VALIDATION_ERROR, "name: {raw}");
            assert_eq!(err.params.get("field").map(String::as_str), Some("name"));
            assert_eq!(
                err.params.get("rule").map(String::as_str),
                Some("duplicate")
            );
        }
        assert_eq!(second.manifest().name, "Второй");
        assert_eq!(read_manifest_name(second.root()), "Второй");

        // A closed project is checked the same way; its own name is not a clash.
        drop(first);
        drop(second);
        let err = rename_project(&projects, first_id, "второй").unwrap_err();
        assert_eq!(err.code, codes::VALIDATION_ERROR);
        rename_project(&projects, first_id, "первый").unwrap();
        let manifest = read_manifest(&projects.join(first_id.to_string()));
        assert_eq!(manifest.name, "первый");
    }

    #[test]
    fn rename_of_a_read_only_store_is_project_locked() {
        let tmp = tempfile::tempdir().unwrap();
        let project = store(tmp.path());
        let dir = project.root().to_path_buf();
        let name = project.manifest().name.clone();
        drop(project);

        let mut read_only = ProjectStore::open(&dir, false).unwrap();
        assert!(!read_only.is_writable());
        let err = read_only.rename("Новое имя").unwrap_err();
        assert_eq!(err.code, codes::PROJECT_LOCKED);
        assert_eq!(
            err.params.get("reason").map(String::as_str),
            Some("readOnly")
        );
        assert_eq!(read_only.manifest().name, name);
        assert_eq!(read_manifest_name(&dir), name);

        // A project open for writing elsewhere refuses the closed-project path.
        let writer = ProjectStore::open(&dir, true).unwrap();
        let id = writer.manifest().project_id;
        let err = rename_project(tmp.path(), id, "Другое").unwrap_err();
        assert_eq!(err.code, codes::PROJECT_LOCKED);
    }

    fn read_manifest(project_dir: &Path) -> Manifest {
        read_json(&project_dir.join(MANIFEST_FILE)).unwrap()
    }

    fn read_manifest_name(project_dir: &Path) -> String {
        read_manifest(project_dir).name
    }

    fn backup_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| {
                let entry = entry.unwrap();
                let name = entry.file_name().to_str()?.to_owned();
                name.ends_with(BACKUP_SUFFIX).then_some(name)
            })
            .collect()
    }

    #[test]
    fn backup_roundtrip_gets_new_project_id() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("backups");
        let mut project = store(tmp.path());
        project.add_person(person("Иван")).unwrap();
        let original_id = project.manifest().project_id;
        let zip = project.backup(&backups).unwrap();
        assert!(zip.is_file());
        drop(project);

        let restored = ProjectStore::restore(&zip, tmp.path()).unwrap();
        assert_eq!(restored.persons().unwrap().len(), 1);
        assert_ne!(restored.manifest().project_id, original_id);
        assert!(!tmp.path().join(".restore").exists());
    }

    #[test]
    fn tampered_backup_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("backups");
        let mut project = store(tmp.path());
        project.add_person(person("Иван")).unwrap();
        let zip = project.backup(&backups).unwrap();
        drop(project);

        // rewrite persons.jsonl inside the zip without updating checksums
        let file = File::open(&zip).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entries = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            entries.push((name, bytes));
        }
        drop(archive);
        let tampered = backups.join("tampered.zip");
        let out = File::create(&tampered).unwrap();
        let mut writer = zip::ZipWriter::new(out);
        let options = zip::write::SimpleFileOptions::default();
        for (name, mut bytes) in entries {
            if name == PERSON_FILE {
                bytes.push(b'\n');
            }
            writer.start_file(name, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap();

        let err = ProjectStore::restore(&tampered, tmp.path()).unwrap_err();
        assert_eq!(err.code, codes::BACKUP_CHECKSUM_MISMATCH);
    }

    #[test]
    fn rewriting_a_collection_keeps_created_at() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let saved = project.add_person(person("Иван")).unwrap();
        let before = read_envelope_created_at(&project.root().join(PERSON_FILE)).unwrap();
        let created = before.get(&saved.id).cloned().expect("createdAt");

        let mut persons = project.persons().unwrap();
        persons[0].notes = Some("правка".into());
        project.save_persons(&persons).unwrap();

        let after = read_envelope_created_at(&project.root().join(PERSON_FILE)).unwrap();
        assert_eq!(after.get(&saved.id), Some(&created));
    }

    #[test]
    fn unchanged_entities_keep_their_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let first = project.add_person(person("Иван")).unwrap();
        let second = project.add_person(person("Мария")).unwrap();
        let before = project.collection_versions(PERSON_FILE).unwrap();

        let mut persons = project.persons().unwrap();
        let index = persons.iter().position(|item| item.id == first.id).unwrap();
        persons[index].notes = Some("правка".into());
        project.save_persons(&persons).unwrap();
        let after = project.collection_versions(PERSON_FILE).unwrap();

        assert_ne!(before.get(&first.id), after.get(&first.id));
        assert_eq!(before.get(&second.id), after.get(&second.id));
    }

    #[test]
    fn collection_versions_expose_envelope_updated_at() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let ivan = person("Иван");
        let maria = person("Мария");
        project
            .save_persons(&[ivan.clone(), maria.clone()])
            .unwrap();

        let versions = project.collection_versions(PERSON_FILE).unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions.contains_key(&ivan.id));
        assert!(versions.contains_key(&maria.id));
        let version = versions.get(&ivan.id).expect("version").clone();
        assert!(!version.is_empty());

        // The token round-trips through `check_version`.
        project
            .check_version(PERSON_FILE, ivan.id, &version)
            .unwrap();

        // Other collections are independent.
        assert!(project.collection_versions(EVENT_FILE).unwrap().is_empty());
    }

    #[test]
    fn check_version_reports_stale_and_missing_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let mut project = store(tmp.path());
        let ivan = person("Иван");
        project.save_persons(std::slice::from_ref(&ivan)).unwrap();

        // Rewrite the envelope with a fixed timestamp, so the comparison is
        // deterministic instead of clock-dependent.
        let row = Row {
            schema: SCHEMA_VERSION,
            id: ivan.id,
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-02T00:00:00Z".to_owned(),
            data: ivan.clone(),
        };
        write_rows(&project.root().join(PERSON_FILE), &[row]).unwrap();

        assert_eq!(
            project
                .collection_versions(PERSON_FILE)
                .unwrap()
                .get(&ivan.id)
                .map(String::as_str),
            Some("2026-01-02T00:00:00Z")
        );
        project
            .check_version(PERSON_FILE, ivan.id, "2026-01-02T00:00:00Z")
            .unwrap();

        let err = project
            .check_version(PERSON_FILE, ivan.id, "2025-01-01T00:00:00Z")
            .unwrap_err();
        assert_eq!(err.code, codes::STALE_WRITE);
        assert_eq!(
            err.params.get("expected").map(String::as_str),
            Some("2025-01-01T00:00:00Z")
        );
        assert_eq!(
            err.params.get("actual").map(String::as_str),
            Some("2026-01-02T00:00:00Z")
        );

        let err = project
            .check_version(PERSON_FILE, Uuid::now_v7(), "any")
            .unwrap_err();
        assert_eq!(err.code, codes::NOT_FOUND);
    }

    #[test]
    fn version_helpers_reject_unknown_collections() {
        let tmp = tempfile::tempdir().unwrap();
        let project = store(tmp.path());
        for file in ["../manifest.json", "notes.txt", ""] {
            let err = project.collection_versions(file).unwrap_err();
            assert_eq!(err.code, codes::VALIDATION_ERROR, "file: {file}");
            let err = project
                .check_version(file, Uuid::now_v7(), "any")
                .unwrap_err();
            assert_eq!(err.code, codes::VALIDATION_ERROR, "file: {file}");
        }
    }

    #[test]
    fn first_mutation_upgrades_a_legacy_format_but_read_only_open_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let created = store(tmp.path());
        let id = created.manifest().project_id;
        let dir = tmp.path().join(id.to_string());
        drop(created);

        // Simulate a project written by a build without event details.
        let mut manifest: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        manifest.format_version = 1;
        fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        // Read-only open neither upgrades the in-memory manifest nor the file.
        {
            let read_only = ProjectStore::open(&dir, false).unwrap();
            assert_eq!(read_only.manifest().format_version, 1);
        }
        let stored: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        assert_eq!(stored.format_version, 1);

        // The first successful mutation upgrades it to the current format.
        let mut project = ProjectStore::open(&dir, true).unwrap();
        project.add_person(person("Иван")).unwrap();
        assert_eq!(project.manifest().format_version, FORMAT_VERSION);
        assert!(project.validate_layout().unwrap().ok);
        drop(project);

        let stored: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        assert_eq!(stored.format_version, FORMAT_VERSION);
    }

    #[test]
    fn event_media_survives_a_legacy_format_upgrade() {
        let tmp = tempfile::tempdir().unwrap();
        let mut created = store(tmp.path());
        let event = Event::new(Uuid::now_v7(), EventType::Birth);
        created.save_events(std::slice::from_ref(&event)).unwrap();
        let mut attachment = media_record("certificate.pdf", &"e".repeat(64));
        attachment.event_id = Some(event.id);
        created
            .save_media(std::slice::from_ref(&attachment))
            .unwrap();
        let dir = created.root().to_path_buf();
        drop(created);

        // A project written by a build that knows only person media (v2).
        let mut manifest: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        manifest.format_version = 2;
        fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        // Read-only open reads the link and leaves both the manifest and the
        // rows byte-identical: opening never migrates.
        let stored_before = fs::read(dir.join(MEDIA_FILE)).unwrap();
        {
            let read_only = ProjectStore::open(&dir, false).unwrap();
            assert_eq!(read_only.manifest().format_version, 2);
            assert_eq!(read_only.media().unwrap(), vec![attachment.clone()]);
        }
        assert_eq!(fs::read(dir.join(MEDIA_FILE)).unwrap(), stored_before);
        let stored: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        assert_eq!(stored.format_version, 2);

        // The first mutation stamps the current format; the link is untouched.
        let mut project = ProjectStore::open(&dir, true).unwrap();
        project.save_media(&[attachment.clone()]).unwrap();
        assert_eq!(project.manifest().format_version, FORMAT_VERSION);
        project.add_person(person("Иван")).unwrap();
        drop(project);

        let stored: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        assert_eq!(stored.format_version, FORMAT_VERSION);
        let reopened = ProjectStore::open(&dir, false).unwrap();
        assert_eq!(reopened.media().unwrap(), vec![attachment]);
        assert!(fs::read_to_string(dir.join(MEDIA_FILE))
            .unwrap()
            .contains("eventId"));
    }

    #[test]
    fn event_place_point_survives_a_legacy_format_upgrade() {
        let tmp = tempfile::tempdir().unwrap();
        let mut created = store(tmp.path());
        let mut event = Event::new(Uuid::now_v7(), EventType::Residence);
        event.place = Some("Ivanovka".to_owned());
        event.place_geo = Some(PlaceGeo {
            lat: 57.4321,
            lon: 49.1234,
            precision: PlacePrecision::Settlement,
            source: PlaceSource::Photon,
            provider_ref: Some("N1".to_owned()),
            label: Some("Ivanovka, Kirov Oblast".to_owned()),
        });
        created.save_events(std::slice::from_ref(&event)).unwrap();
        let dir = created.root().to_path_buf();
        drop(created);

        // A project written before the map point existed (format 3).
        let mut manifest: Manifest = read_json(&dir.join(MANIFEST_FILE)).unwrap();
        manifest.format_version = 3;
        fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let before = fs::read(dir.join(EVENT_FILE)).unwrap();
        {
            let read_only = ProjectStore::open(&dir, false).unwrap();
            assert_eq!(read_only.manifest().format_version, 3);
            assert_eq!(read_only.events().unwrap(), vec![event.clone()]);
        }
        assert_eq!(fs::read(dir.join(EVENT_FILE)).unwrap(), before);

        let mut project = ProjectStore::open(&dir, true).unwrap();
        project.add_person(person("Ivan")).unwrap();
        assert_eq!(project.manifest().format_version, FORMAT_VERSION);
        assert_eq!(project.events().unwrap(), vec![event]);
        drop(project);

        assert!(fs::read_to_string(dir.join(EVENT_FILE))
            .unwrap()
            .contains("placeGeo"));
    }
}
