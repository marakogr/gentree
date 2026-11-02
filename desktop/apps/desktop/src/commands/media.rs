//! Media commands: listing, opening and attaching files, plus the event
//! attachments introduced by ADR-0018.
//!
//! The path is resolved by [`ProjectStore::resolve_media_path`], which refuses
//! a bad checksum or a path that would leave the project's `media/` folder.
//! Files are not read here: an AT5 import stores metadata only, so a listed
//! row may point at a file that the project never copied.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use gentree_core::error::codes;
use gentree_core::record::Media;
use gentree_core::{AppError, AppResult};
use gentree_storage::{store_media_file, ProjectStore};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use super::with_store;
use crate::AppState;

/// Extensions the UI can render inline. Everything else (pdf, docx, …) is a
/// document the UI links to instead of showing.
const IMAGE_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];

/// Upper bound for a file picked in the UI. The import pipeline can copy larger
/// bundles, but an interactive attach must not freeze the app on a huge file.
const MAX_MEDIA_BYTES: u64 = 200 * 1024 * 1024;

/// Longest accepted caption, in characters. Values are trimmed; an empty
/// caption clears the field instead of storing whitespace.
const MAX_MEDIA_CAPTION: usize = 500;

/// One media row ready for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub checksum: String,
    pub caption: Option<String>,
    pub person_id: Option<String>,
    /// Event the row documents (ADR-0018); never set together with `personId`.
    pub event_id: Option<String>,
    /// `true` for the person's profile photo.
    pub primary: bool,
    /// Absolute path inside the project `media/` folder; never outside it.
    pub path: String,
    pub is_image: bool,
}

impl MediaItem {
    fn new(media: &Media, path: PathBuf) -> Self {
        Self {
            id: media.id.to_string(),
            file_name: media.file_name.clone(),
            mime_type: media.mime_type.clone(),
            checksum: media.checksum.clone(),
            caption: media.caption.clone(),
            person_id: media.person_id.map(|id| id.to_string()),
            event_id: media.event_id.map(|id| id.to_string()),
            primary: media.primary,
            path: path.to_string_lossy().into_owned(),
            is_image: is_image_file(&media.file_name),
        }
    }
}

/// List media of the open project, optionally only the rows linked to one
/// person. An unknown or malformed `personId` is `NOT_FOUND`; no open project
/// is `PROJECT_NOT_FOUND`.
#[tauri::command]
pub fn media_list(
    state: State<'_, AppState>,
    person_id: Option<String>,
) -> AppResult<Vec<MediaItem>> {
    with_store(&state, |store| media_items(store, person_id.as_deref()))
}

/// Open a media file with the system default application.
#[tauri::command]
pub fn media_open(state: State<'_, AppState>, id: String) -> AppResult<()> {
    with_store(&state, |store| {
        let path = media_path_by_id(store, &id)?;
        open_with_system(&path)
    })
}

/// Copy a media file to a user-selected destination (Save as…).
#[tauri::command]
pub fn media_save_as(state: State<'_, AppState>, id: String, target: String) -> AppResult<String> {
    with_store(&state, |store| {
        let source = media_path_by_id(store, &id)?;
        let target = PathBuf::from(target.trim());
        if target.as_os_str().is_empty() {
            return Err(
                AppError::new(codes::VALIDATION_ERROR, "Target path is empty")
                    .with_param("field", "target"),
            );
        }
        if target.is_dir() {
            return Err(
                AppError::new(codes::VALIDATION_ERROR, "Target is a directory")
                    .with_param("field", "target"),
            );
        }
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() && !parent.is_dir() {
                return Err(
                    AppError::new(codes::VALIDATION_ERROR, "Target folder is missing")
                        .with_param("field", "target"),
                );
            }
        }
        fs::copy(&source, &target).map_err(|err| AppError::io("copy media", err))?;
        Ok(target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_owned()))
    })
}

/// Copy a user-selected file into the project `media/` folder and link it to a
/// person. The metadata row is created after the bytes are stored, so a failed
/// copy never leaves a dangling link. Re-attaching the same file is allowed and
/// produces a second row; the bytes are shared by checksum.
///
/// `primary` also makes the new row the person's profile photo, clearing the
/// flag on their other rows.
#[tauri::command]
pub fn media_attach(
    state: State<'_, AppState>,
    person_id: String,
    source_path: String,
    primary: Option<bool>,
) -> AppResult<MediaItem> {
    with_store(&state, |store| {
        attach_media(
            store,
            &person_id,
            &source_path,
            MAX_MEDIA_BYTES,
            primary.unwrap_or(false),
        )
    })
}

/// Make one media row the person's profile photo. The row must be attached to
/// this person and be an image; every other row of the person loses the flag.
#[tauri::command]
pub fn media_set_primary(
    state: State<'_, AppState>,
    person_id: String,
    media_id: String,
) -> AppResult<MediaItem> {
    with_store(&state, |store| {
        set_primary_media(store, &person_id, &media_id)
    })
}

/// List media attached to one event (ADR-0018), oldest row first.
#[tauri::command]
pub fn media_event_list(state: State<'_, AppState>, event_id: String) -> AppResult<Vec<MediaItem>> {
    with_store(&state, |store| event_media_items(store, &event_id))
}

/// Attachment counts per event, for the list indicator. Counts only: no paths,
/// no captions, so the payload stays small on a large project.
#[tauri::command]
pub fn media_event_counts(
    state: State<'_, AppState>,
) -> AppResult<std::collections::BTreeMap<String, usize>> {
    with_store(&state, |store| event_media_counts(store))
}

/// Copy a user-selected file into the project `media/` folder and link it to an
/// event. Bytes are stored before the row, so a failed copy never leaves a
/// dangling link. Re-attaching the same file is allowed; bytes are shared.
#[tauri::command]
pub fn media_attach_to_event(
    state: State<'_, AppState>,
    event_id: String,
    source_path: String,
) -> AppResult<MediaItem> {
    with_store(&state, |store| {
        attach_media_to_event(store, &event_id, &source_path, MAX_MEDIA_BYTES)
    })
}

/// Unlink one file from an event. The metadata row and the file bytes are kept
/// (ADR-0009: a media link is not the file) and become an unlinked row.
#[tauri::command]
pub fn media_event_detach(
    state: State<'_, AppState>,
    event_id: String,
    media_id: String,
) -> AppResult<MediaItem> {
    with_store(&state, |store| {
        detach_event_media(store, &event_id, &media_id)
    })
}

/// Set or clear the caption of one media row. The caption is free text; it is
/// trimmed, an empty value clears it.
#[tauri::command]
pub fn media_set_caption(
    state: State<'_, AppState>,
    media_id: String,
    caption: Option<String>,
) -> AppResult<MediaItem> {
    with_store(&state, |store| {
        set_media_caption(store, &media_id, caption.as_deref())
    })
}

/// Pure part of [`media_attach`], testable without Tauri state.
fn attach_media(
    store: &mut ProjectStore,
    person_id: &str,
    source_path: &str,
    max_bytes: u64,
    primary: bool,
) -> AppResult<MediaItem> {
    let person_id = require_person(store, person_id)?;

    let source = PathBuf::from(source_path.trim());
    if source.as_os_str().is_empty() || !source.is_absolute() {
        return Err(AppError::validation("sourcePath", "absolutePathRequired"));
    }
    validate_media_source(&source, max_bytes)?;

    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| AppError::validation("sourcePath", "fileNameRequired"))?;

    let (_, checksum) = store_media_file(store.root(), &source)?;
    let mut media = Media {
        id: Uuid::now_v7(),
        mime_type: mime_for(&file_name).to_owned(),
        file_name,
        checksum,
        caption: None,
        source_id: None,
        person_id: Some(person_id),
        event_id: None,
        primary: false,
    };
    media.validate()?;
    media.primary = primary && is_image_file(&media.file_name);

    let mut rows = store.media()?;
    if media.primary {
        clear_primary(&mut rows, person_id);
    }
    rows.push(media.clone());
    store.save_media(&rows)?;
    let path = store.resolve_media_path(&media)?;
    Ok(MediaItem::new(&media, path))
}

/// Pure part of [`media_set_primary`], testable without Tauri state.
fn set_primary_media(
    store: &mut ProjectStore,
    person_id: &str,
    media_id: &str,
) -> AppResult<MediaItem> {
    let person_id = require_person(store, person_id)?;
    let media_id = Uuid::parse_str(media_id.trim()).map_err(|_| {
        AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
    })?;

    let mut rows = store.media()?;
    let index = rows
        .iter()
        .position(|row| row.id == media_id)
        .ok_or_else(|| {
            AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
        })?;
    if rows[index].person_id != Some(person_id) {
        return Err(
            AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
        );
    }
    if !is_image_file(&rows[index].file_name) {
        return Err(AppError::validation("mediaId", "imageRequired"));
    }

    clear_primary(&mut rows, person_id);
    rows[index].primary = true;
    let media = rows[index].clone();
    store.save_media(&rows)?;
    let path = store.resolve_media_path(&media)?;
    Ok(MediaItem::new(&media, path))
}

/// Resolve a person id the media commands accept; an unknown or malformed id is
/// `NOT_FOUND` rather than a validation error, matching `media_list`.
fn require_person(store: &ProjectStore, person_id: &str) -> AppResult<Uuid> {
    let person_id = Uuid::parse_str(person_id.trim()).map_err(|_| {
        AppError::new(codes::NOT_FOUND, "Person not found").with_param("field", "personId")
    })?;
    if !store.persons()?.iter().any(|person| person.id == person_id) {
        return Err(
            AppError::new(codes::NOT_FOUND, "Person not found").with_param("field", "personId")
        );
    }
    Ok(person_id)
}

/// Drop the profile-photo flag from every media row of one person.
fn clear_primary(rows: &mut [Media], person_id: Uuid) {
    for row in rows.iter_mut() {
        if row.person_id == Some(person_id) {
            row.primary = false;
        }
    }
}

/// Resolve an event id the media commands accept; an unknown or malformed id is
/// `NOT_FOUND` on `eventId`, matching [`media_event_list`].
fn require_event(store: &ProjectStore, event_id: &str) -> AppResult<Uuid> {
    let event_id = Uuid::parse_str(event_id.trim()).map_err(|_| {
        AppError::new(codes::NOT_FOUND, "Event not found").with_param("field", "eventId")
    })?;
    if !store.events()?.iter().any(|event| event.id == event_id) {
        return Err(
            AppError::new(codes::NOT_FOUND, "Event not found").with_param("field", "eventId")
        );
    }
    Ok(event_id)
}

/// Pure part of [`media_event_counts`], testable without Tauri state.
fn event_media_counts(
    store: &ProjectStore,
) -> AppResult<std::collections::BTreeMap<String, usize>> {
    let mut counts = std::collections::BTreeMap::new();
    for row in store.media()? {
        if let Some(event_id) = row.event_id {
            *counts.entry(event_id.to_string()).or_insert(0) += 1;
        }
    }
    Ok(counts)
}

/// Pure part of [`media_event_list`], testable without Tauri state.
fn event_media_items(store: &ProjectStore, event_id: &str) -> AppResult<Vec<MediaItem>> {
    let event_id = require_event(store, event_id)?;
    let mut items = Vec::new();
    for media in store
        .media()?
        .into_iter()
        .filter(|row| row.event_id == Some(event_id))
    {
        let path = store.resolve_media_path(&media)?;
        items.push(MediaItem::new(&media, path));
    }
    Ok(items)
}

/// Pure part of [`media_attach_to_event`], testable without Tauri state.
fn attach_media_to_event(
    store: &mut ProjectStore,
    event_id: &str,
    source_path: &str,
    max_bytes: u64,
) -> AppResult<MediaItem> {
    let event_id = require_event(store, event_id)?;

    let source = PathBuf::from(source_path.trim());
    if source.as_os_str().is_empty() || !source.is_absolute() {
        return Err(AppError::validation("sourcePath", "absolutePathRequired"));
    }
    validate_media_source(&source, max_bytes)?;

    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| AppError::validation("sourcePath", "fileNameRequired"))?;

    let (_, checksum) = store_media_file(store.root(), &source)?;
    let media = Media {
        id: Uuid::now_v7(),
        mime_type: mime_for(&file_name).to_owned(),
        file_name,
        checksum,
        caption: None,
        source_id: None,
        person_id: None,
        event_id: Some(event_id),
        primary: false,
    };
    media.validate()?;

    let mut rows = store.media()?;
    rows.push(media.clone());
    store.save_media(&rows)?;
    let path = store.resolve_media_path(&media)?;
    Ok(MediaItem::new(&media, path))
}

/// Clear the event link on every attachment of an event that is being removed.
/// Rows and bytes stay: the file is not the link (ADR-0009). Returns `true`
/// when a row changed, so the caller writes the collection only if needed.
pub(crate) fn unlink_event_media(store: &mut ProjectStore, event_id: Uuid) -> AppResult<bool> {
    let mut rows = store.media()?;
    let mut changed = false;
    for row in rows.iter_mut() {
        if row.event_id == Some(event_id) {
            row.event_id = None;
            changed = true;
        }
    }
    if changed {
        store.save_media(&rows)?;
    }
    Ok(changed)
}

/// Pure part of [`media_event_detach`], testable without Tauri state.
fn detach_event_media(
    store: &mut ProjectStore,
    event_id: &str,
    media_id: &str,
) -> AppResult<MediaItem> {
    let event_id = require_event(store, event_id)?;
    let media_id = Uuid::parse_str(media_id.trim()).map_err(|_| {
        AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
    })?;

    let mut rows = store.media()?;
    let index = rows
        .iter()
        .position(|row| row.id == media_id && row.event_id == Some(event_id))
        .ok_or_else(|| {
            AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
        })?;
    rows[index].event_id = None;
    let media = rows[index].clone();
    store.save_media(&rows)?;
    let path = store.resolve_media_path(&media)?;
    Ok(MediaItem::new(&media, path))
}

/// Pure part of [`media_set_caption`], testable without Tauri state.
fn set_media_caption(
    store: &mut ProjectStore,
    media_id: &str,
    caption: Option<&str>,
) -> AppResult<MediaItem> {
    let media_id = Uuid::parse_str(media_id.trim()).map_err(|_| {
        AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
    })?;
    let caption = caption.map(str::trim).filter(|value| !value.is_empty());
    if caption.is_some_and(|value| value.chars().count() > MAX_MEDIA_CAPTION) {
        return Err(AppError::validation("caption", "maxLength")
            .with_param("max", MAX_MEDIA_CAPTION.to_string()));
    }

    let mut rows = store.media()?;
    let index = rows
        .iter()
        .position(|row| row.id == media_id)
        .ok_or_else(|| {
            AppError::new(codes::NOT_FOUND, "Media not found").with_param("field", "mediaId")
        })?;
    rows[index].caption = caption.map(str::to_owned);
    let media = rows[index].clone();
    store.save_media(&rows)?;
    let path = store.resolve_media_path(&media)?;
    Ok(MediaItem::new(&media, path))
}

/// Reject a path that is not a regular, non-empty file within `max_bytes`.
fn validate_media_source(source: &Path, max_bytes: u64) -> AppResult<()> {
    let metadata = fs::metadata(source).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::new(codes::NOT_FOUND, "Media source file missing")
                .with_param("field", "sourcePath")
        }
        _ => AppError::io("stat media source", err),
    })?;
    if !metadata.is_file() {
        return Err(AppError::validation("sourcePath", "fileExpected"));
    }
    if metadata.len() == 0 {
        return Err(AppError::validation("sourcePath", "emptyFile"));
    }
    if metadata.len() > max_bytes {
        return Err(AppError::validation("sourcePath", "fileTooLarge"));
    }
    Ok(())
}

fn media_path_by_id(store: &ProjectStore, id: &str) -> AppResult<PathBuf> {
    let media_id = Uuid::parse_str(id.trim())
        .map_err(|_| AppError::new(codes::NOT_FOUND, "Media not found").with_param("id", id))?;
    let media = store
        .media()?
        .into_iter()
        .find(|item| item.id == media_id)
        .ok_or_else(|| AppError::new(codes::NOT_FOUND, "Media not found").with_param("id", id))?;
    store.resolve_media_path(&media)
}

fn open_with_system(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(path)
            .spawn()
            .map_err(|err| AppError::io("open media", err))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| AppError::io("open media", err))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|err| AppError::io("open media", err))?;
    }
    Ok(())
}

/// Pure part of [`media_list`], testable without Tauri state.
fn media_items(store: &ProjectStore, person_id: Option<&str>) -> AppResult<Vec<MediaItem>> {
    let filter = person_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| {
                AppError::new(codes::NOT_FOUND, "Person not found").with_param("personId", value)
            })
        })
        .transpose()?;

    let mut items = Vec::new();
    for media in store.media()? {
        // A blank `personId` means "all media"; a real id excludes unlinked rows.
        if filter.is_some_and(|filter| media.person_id != Some(filter)) {
            continue;
        }
        let path = store.resolve_media_path(&media)?;
        items.push(MediaItem::new(&media, path));
    }
    Ok(items)
}

fn is_image_file(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
}

/// MIME type for the extensions the card can attach. Anything unknown is
/// served as an opaque binary rather than guessed from its bytes.
fn mime_for(file_name: &str) -> &'static str {
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
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "odt" => "application/vnd.oasis.opendocument.text",
        "rtf" => "application/rtf",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use gentree_core::person::Person;
    use uuid::Uuid;

    fn record(file_name: &str, checksum: String, person_id: Option<Uuid>) -> Media {
        Media {
            id: Uuid::now_v7(),
            file_name: file_name.to_owned(),
            mime_type: if is_image_file(file_name) {
                "image/jpeg".to_owned()
            } else {
                "application/pdf".to_owned()
            },
            checksum,
            caption: Some("synthetic caption".to_owned()),
            source_id: None,
            person_id,
            event_id: None,
            primary: false,
        }
    }

    /// One project with a linked photo, an unlinked document and a second
    /// photo linked to another person.
    fn fixture(root: &Path) -> (ProjectStore, Uuid, Uuid) {
        let projects = root.join("projects");
        let mut store = ProjectStore::create(&projects, "Media").unwrap();
        let ivan = Uuid::now_v7();
        let maria = Uuid::now_v7();

        let mut media = Vec::new();
        for (name, bytes, person) in [
            ("photo.jpg", b"photo-bytes".as_slice(), Some(ivan)),
            ("scan.png", b"scan-bytes".as_slice(), Some(maria)),
            ("letter.pdf", b"pdf-bytes".as_slice(), None),
        ] {
            let source = root.join(name);
            fs::write(&source, bytes).unwrap();
            let (_, checksum) = store_media_file(store.root(), &source).unwrap();
            media.push(record(name, checksum, person));
        }
        store.save_media(&media).unwrap();
        (store, ivan, maria)
    }

    #[test]
    fn lists_all_media_with_paths_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ivan, maria) = fixture(dir.path());

        let items = media_items(&store, None).unwrap();

        assert_eq!(items.len(), 3);
        assert_eq!(items[0].file_name, "photo.jpg");
        assert_eq!(items[0].person_id, Some(ivan.to_string()));
        assert!(items[0].is_image);
        assert!(!items[2].is_image);
        assert_eq!(items[2].person_id, None);
        for item in &items {
            let path = PathBuf::from(&item.path);
            assert!(path.is_absolute(), "{path:?}");
            assert!(path.starts_with(store.root().join("media")), "{path:?}");
            assert!(path.is_file(), "{path:?}");
        }
        assert!(items
            .iter()
            .any(|item| item.person_id == Some(maria.to_string())));
    }

    #[test]
    fn filters_by_person_and_by_blank_value() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ivan, _) = fixture(dir.path());

        let linked = media_items(&store, Some(&ivan.to_string())).unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].file_name, "photo.jpg");

        let unknown = Uuid::now_v7().to_string();
        assert!(media_items(&store, Some(&unknown)).unwrap().is_empty());
        // Blank and whitespace behave like "no filter".
        assert_eq!(media_items(&store, Some("  ")).unwrap().len(), 3);
    }

    #[test]
    fn rejects_a_malformed_person_id() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _, _) = fixture(dir.path());

        let error = media_items(&store, Some("not-a-uuid")).unwrap_err();

        assert_eq!(error.code, codes::NOT_FOUND);
    }

    #[test]
    fn refuses_a_path_outside_the_media_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _, _) = fixture(dir.path());
        let project = store.root().to_path_buf();

        // A sha256-shaped but non-hex checksum cannot address `media/`.
        let broken = record("photo.jpg", "..".repeat(32), None);
        let error = store.resolve_media_path(&broken).unwrap_err();
        assert_eq!(error.code, codes::NOT_FOUND);
        assert_eq!(
            gentree_storage::resolve_media_path(&project, &broken)
                .unwrap_err()
                .code,
            codes::NOT_FOUND
        );

        // A traversing file name is refused by the path helper as well.
        let traversing = record("../../escape.jpg", "a".repeat(64), None);
        assert!(store.resolve_media_path(&traversing).is_err());
    }

    #[test]
    fn image_detection_is_case_insensitive_and_ignores_other_types() {
        for name in ["a.jpg", "a.JPEG", "a.png", "a.gif", "a.webp", "a.bmp"] {
            assert!(is_image_file(name), "{name}");
        }
        for name in ["a.pdf", "a.docx", "a", "a.jpg.txt"] {
            assert!(!is_image_file(name), "{name}");
        }
    }

    fn store_with_person(root: &Path) -> (ProjectStore, Uuid) {
        let projects = root.join("projects");
        let mut store = ProjectStore::create(&projects, "Attach").unwrap();
        let mut person = Person::new(Vec::new()).unwrap();
        person.id = Uuid::now_v7();
        let id = person.id;
        store.save_persons(&[person]).unwrap();
        (store, id)
    }

    #[test]
    fn attach_copies_the_file_and_links_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let source = dir.path().join("portrait.PNG");
        fs::write(&source, b"image-bytes").unwrap();

        let item = attach_media(
            &mut store,
            &person_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap();

        assert_eq!(item.file_name, "portrait.PNG");
        assert_eq!(item.mime_type, "image/png");
        assert!(item.is_image);
        assert_eq!(item.person_id, Some(person_id.to_string()));
        assert_eq!(item.caption, None);

        let rows = store.media().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id.to_string(), item.id);
        assert_eq!(rows[0].checksum, item.checksum);

        let stored = PathBuf::from(&item.path);
        assert!(stored.is_file(), "{stored:?}");
        assert!(stored.starts_with(store.root().join("media")), "{stored:?}");
        assert_eq!(fs::read(&stored).unwrap(), b"image-bytes");
    }

    #[test]
    fn attach_accepts_documents_and_keeps_unknown_types_binary() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let source = dir.path().join("letter.docx");
        fs::write(&source, b"docx-bytes").unwrap();

        let item = attach_media(
            &mut store,
            &person_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap();

        assert_eq!(
            item.mime_type,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert!(!item.is_image);
    }

    #[test]
    fn attach_rejects_an_unknown_or_malformed_person() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, _) = store_with_person(dir.path());
        let source = dir.path().join("photo.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        let path = source.to_str().unwrap().to_owned();

        let unknown = attach_media(
            &mut store,
            &Uuid::now_v7().to_string(),
            &path,
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap_err();
        assert_eq!(unknown.code, codes::NOT_FOUND);

        let malformed =
            attach_media(&mut store, "not-a-uuid", &path, MAX_MEDIA_BYTES, false).unwrap_err();
        assert_eq!(malformed.code, codes::NOT_FOUND);
        assert!(store.media().unwrap().is_empty());
    }

    #[test]
    fn attach_rejects_a_missing_relative_or_directory_source() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let person = person_id.to_string();

        let missing = dir.path().join("missing.jpg");
        let error = attach_media(
            &mut store,
            &person,
            missing.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, codes::NOT_FOUND);

        let relative =
            attach_media(&mut store, &person, "photo.jpg", MAX_MEDIA_BYTES, false).unwrap_err();
        assert_eq!(relative.code, codes::VALIDATION_ERROR);

        let directory = attach_media(
            &mut store,
            &person,
            dir.path().to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap_err();
        assert_eq!(directory.code, codes::VALIDATION_ERROR);

        assert!(store.media().unwrap().is_empty());
    }

    #[test]
    fn attach_rejects_empty_and_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let person = person_id.to_string();

        let empty = dir.path().join("empty.txt");
        fs::write(&empty, b"").unwrap();
        let error = attach_media(
            &mut store,
            &person,
            empty.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("emptyFile")
        );

        let big = dir.path().join("big.bin");
        fs::write(&big, b"0123456789").unwrap();
        let error = attach_media(&mut store, &person, big.to_str().unwrap(), 4, false).unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("fileTooLarge")
        );

        assert!(store.media().unwrap().is_empty());
    }

    #[test]
    fn attaching_the_same_file_twice_keeps_one_stored_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let source = dir.path().join("photo.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        let path = source.to_str().unwrap();
        let person = person_id.to_string();

        let first = attach_media(&mut store, &person, path, MAX_MEDIA_BYTES, false).unwrap();
        let second = attach_media(&mut store, &person, path, MAX_MEDIA_BYTES, false).unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(first.checksum, second.checksum);
        assert_eq!(first.path, second.path);
        assert_eq!(store.media().unwrap().len(), 2);
        assert!(PathBuf::from(&second.path).is_file());
    }

    #[test]
    fn attach_with_primary_marks_only_the_new_photo() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let person = person_id.to_string();
        let first_source = dir.path().join("first.jpg");
        let second_source = dir.path().join("second.jpg");
        fs::write(&first_source, b"first-bytes").unwrap();
        fs::write(&second_source, b"second-bytes").unwrap();

        let first = attach_media(
            &mut store,
            &person,
            first_source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            true,
        )
        .unwrap();
        assert!(first.primary);

        let second = attach_media(
            &mut store,
            &person,
            second_source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            true,
        )
        .unwrap();
        assert!(second.primary);

        let rows = store.media().unwrap();
        assert_eq!(rows.iter().filter(|row| row.primary).count(), 1);
        let marked = rows.iter().find(|row| row.primary).unwrap();
        assert_eq!(marked.id.to_string(), second.id);

        let items = media_items(&store, Some(&person)).unwrap();
        assert_eq!(items.iter().filter(|item| item.primary).count(), 1);
        assert_eq!(
            items.iter().find(|item| item.primary).unwrap().id,
            second.id
        );
    }

    #[test]
    fn set_primary_removes_the_previous_flag_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let person = person_id.to_string();
        let first_source = dir.path().join("first.jpg");
        let second_source = dir.path().join("second.jpg");
        fs::write(&first_source, b"first-bytes").unwrap();
        fs::write(&second_source, b"second-bytes").unwrap();

        let first = attach_media(
            &mut store,
            &person,
            first_source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap();
        let second = attach_media(
            &mut store,
            &person,
            second_source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
            false,
        )
        .unwrap();
        assert!(!first.primary);
        assert!(!second.primary);

        let chosen = set_primary_media(&mut store, &person, &second.id).unwrap();
        assert!(chosen.primary);
        let replaced = set_primary_media(&mut store, &person, &first.id).unwrap();
        assert!(replaced.primary);

        let rows = store.media().unwrap();
        assert_eq!(rows.iter().filter(|row| row.primary).count(), 1);
        assert_eq!(
            rows.iter().find(|row| row.primary).unwrap().id.to_string(),
            first.id
        );

        // The flag belongs to the stored row, not to the list response.
        let root = store.root().to_path_buf();
        drop(store);
        let reopened = ProjectStore::open(&root, true).unwrap();
        let rows = reopened.media().unwrap();
        assert_eq!(rows.iter().filter(|row| row.primary).count(), 1);
        assert_eq!(
            rows.iter().find(|row| row.primary).unwrap().id.to_string(),
            first.id
        );
    }

    #[test]
    fn set_primary_rejects_foreign_and_non_image_rows() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, person_id) = store_with_person(dir.path());
        let person = person_id.to_string();
        let other = Uuid::now_v7();
        let rows = vec![
            record("own.jpg", "a".repeat(64), Some(person_id)),
            record("foreign.jpg", "b".repeat(64), Some(other)),
            record("orphan.jpg", "c".repeat(64), None),
            record("letter.pdf", "d".repeat(64), Some(person_id)),
        ];
        let ids: Vec<String> = rows.iter().map(|row| row.id.to_string()).collect();
        store.save_media(&rows).unwrap();

        let foreign = set_primary_media(&mut store, &person, &ids[1]).unwrap_err();
        assert_eq!(foreign.code, codes::NOT_FOUND);

        let orphan = set_primary_media(&mut store, &person, &ids[2]).unwrap_err();
        assert_eq!(orphan.code, codes::NOT_FOUND);

        let document = set_primary_media(&mut store, &person, &ids[3]).unwrap_err();
        assert_eq!(document.code, codes::VALIDATION_ERROR);
        assert_eq!(
            document.params.get("field").map(String::as_str),
            Some("mediaId")
        );

        let unknown =
            set_primary_media(&mut store, &person, &Uuid::now_v7().to_string()).unwrap_err();
        assert_eq!(unknown.code, codes::NOT_FOUND);

        let malformed = set_primary_media(&mut store, &person, "not-a-uuid").unwrap_err();
        assert_eq!(malformed.code, codes::NOT_FOUND);

        let no_person =
            set_primary_media(&mut store, &Uuid::now_v7().to_string(), &ids[0]).unwrap_err();
        assert_eq!(no_person.code, codes::NOT_FOUND);

        assert!(store.media().unwrap().iter().all(|row| !row.primary));
    }

    fn store_with_event(root: &Path) -> (ProjectStore, Uuid) {
        let projects = root.join("projects");
        let mut store = ProjectStore::create(&projects, "EventMedia").unwrap();
        let mut person = Person::new(Vec::new()).unwrap();
        person.id = Uuid::now_v7();
        let event =
            gentree_core::record::Event::new(person.id, gentree_core::record::EventType::Birth);
        let event_id = event.id;
        store.save_persons(&[person]).unwrap();
        store.save_events(&[event]).unwrap();
        (store, event_id)
    }

    #[test]
    fn attach_to_event_copies_the_file_and_links_only_the_event() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let source = dir.path().join("certificate.pdf");
        fs::write(&source, b"pdf-bytes").unwrap();

        let item = attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();

        assert_eq!(item.event_id, Some(event_id.to_string()));
        assert_eq!(item.person_id, None);
        assert!(!item.primary);
        assert_eq!(item.file_name, "certificate.pdf");
        assert_eq!(item.mime_type, "application/pdf");
        assert!(!item.is_image);
        assert_eq!(item.caption, None);

        let stored = PathBuf::from(&item.path);
        assert!(stored.starts_with(store.root().join("media")), "{stored:?}");
        assert_eq!(fs::read(&stored).unwrap(), b"pdf-bytes");

        let rows = store.media().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_id, Some(event_id));
        assert_eq!(rows[0].person_id, None);

        // Person media listing does not attribute the row to a person.
        assert!(media_items(&store, None).unwrap()[0].person_id.is_none());
        assert_eq!(
            event_media_items(&store, &event_id.to_string()).unwrap(),
            vec![item]
        );
    }

    #[test]
    fn event_media_is_scoped_to_its_event() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let other = gentree_core::record::Event::new(
            store.persons().unwrap()[0].id,
            gentree_core::record::EventType::Residence,
        );
        let other_id = other.id;
        let mut events = store.events().unwrap();
        events.push(other);
        store.save_events(&events).unwrap();

        let source = dir.path().join("scan.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();

        assert_eq!(
            event_media_items(&store, &event_id.to_string())
                .unwrap()
                .len(),
            1
        );
        assert!(event_media_items(&store, &other_id.to_string())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn event_counts_ignore_unlinked_rows() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let other = gentree_core::record::Event::new(
            store.persons().unwrap()[0].id,
            gentree_core::record::EventType::Residence,
        );
        let other_id = other.id;
        let mut events = store.events().unwrap();
        events.push(other);
        store.save_events(&events).unwrap();

        let first = dir.path().join("first.jpg");
        let second = dir.path().join("second.jpg");
        let third = dir.path().join("third.jpg");
        fs::write(&first, b"first-bytes").unwrap();
        fs::write(&second, b"second-bytes").unwrap();
        fs::write(&third, b"third-bytes").unwrap();
        attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            first.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();
        let detached = attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            second.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();
        attach_media_to_event(
            &mut store,
            &other_id.to_string(),
            third.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();
        detach_event_media(&mut store, &event_id.to_string(), &detached.id).unwrap();

        let counts = event_media_counts(&store).unwrap();
        assert_eq!(counts.get(&event_id.to_string()), Some(&1));
        assert_eq!(counts.get(&other_id.to_string()), Some(&1));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn attach_to_event_rejects_unknown_or_malformed_ids() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, _) = store_with_event(dir.path());
        let source = dir.path().join("scan.jpg");
        fs::write(&source, b"photo-bytes").unwrap();

        let unknown = attach_media_to_event(
            &mut store,
            &Uuid::now_v7().to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap_err();
        assert_eq!(unknown.code, codes::NOT_FOUND);
        assert_eq!(
            unknown.params.get("field").map(String::as_str),
            Some("eventId")
        );

        let malformed = attach_media_to_event(
            &mut store,
            "nope",
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap_err();
        assert_eq!(malformed.code, codes::NOT_FOUND);

        // No bytes and no row are left behind.
        assert!(store.media().unwrap().is_empty());
        assert_eq!(fs::read_dir(store.root().join("media")).unwrap().count(), 0);
    }

    #[test]
    fn detach_keeps_the_row_and_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let source = dir.path().join("scan.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        let item = attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();

        let detached = detach_event_media(&mut store, &event_id.to_string(), &item.id).unwrap();

        assert_eq!(detached.event_id, None);
        assert_eq!(detached.id, item.id);
        let rows = store.media().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_id, None);
        assert!(PathBuf::from(&detached.path).is_file());
        assert!(event_media_items(&store, &event_id.to_string())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn detach_refuses_a_row_of_another_event() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let other = gentree_core::record::Event::new(
            store.persons().unwrap()[0].id,
            gentree_core::record::EventType::Residence,
        );
        let other_id = other.id;
        let mut events = store.events().unwrap();
        events.push(other);
        store.save_events(&events).unwrap();

        let source = dir.path().join("scan.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        let item = attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();

        let error = detach_event_media(&mut store, &other_id.to_string(), &item.id).unwrap_err();
        assert_eq!(error.code, codes::NOT_FOUND);
        assert_eq!(store.media().unwrap()[0].event_id, Some(event_id));
    }

    #[test]
    fn unlink_event_media_keeps_rows_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let source = dir.path().join("scan.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        let item = attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();

        assert!(unlink_event_media(&mut store, event_id).unwrap());

        let rows = store.media().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_id, None);
        assert!(PathBuf::from(&item.path).is_file());
        // A second call is a no-op and changes nothing.
        assert!(!unlink_event_media(&mut store, event_id).unwrap());
    }

    #[test]
    fn caption_is_trimmed_cleared_and_length_limited() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, event_id) = store_with_event(dir.path());
        let source = dir.path().join("scan.jpg");
        fs::write(&source, b"photo-bytes").unwrap();
        let item = attach_media_to_event(
            &mut store,
            &event_id.to_string(),
            source.to_str().unwrap(),
            MAX_MEDIA_BYTES,
        )
        .unwrap();

        let captioned =
            set_media_caption(&mut store, &item.id, Some("  Marriage record  ")).unwrap();
        assert_eq!(captioned.caption.as_deref(), Some("Marriage record"));
        assert_eq!(
            store.media().unwrap()[0].caption.as_deref(),
            Some("Marriage record")
        );

        let cleared = set_media_caption(&mut store, &item.id, Some("   ")).unwrap();
        assert_eq!(cleared.caption, None);
        let cleared = set_media_caption(&mut store, &item.id, None).unwrap();
        assert_eq!(cleared.caption, None);

        let long = "x".repeat(MAX_MEDIA_CAPTION + 1);
        let error = set_media_caption(&mut store, &item.id, Some(&long)).unwrap_err();
        assert_eq!(error.code, codes::VALIDATION_ERROR);
        assert_eq!(
            error.params.get("field").map(String::as_str),
            Some("caption")
        );
        assert_eq!(
            error.params.get("rule").map(String::as_str),
            Some("maxLength")
        );
        let allowed = "x".repeat(MAX_MEDIA_CAPTION);
        assert_eq!(
            set_media_caption(&mut store, &item.id, Some(&allowed))
                .unwrap()
                .caption
                .map(|value| value.chars().count()),
            Some(MAX_MEDIA_CAPTION)
        );
    }

    #[test]
    fn mime_types_follow_the_extension() {
        for (name, expected) in [
            ("a.JPG", "image/jpeg"),
            ("a.jpeg", "image/jpeg"),
            ("a.bmp", "image/bmp"),
            ("a.txt", "text/plain"),
            ("a.doc", "application/msword"),
            ("a.odt", "application/vnd.oasis.opendocument.text"),
            ("a.rtf", "application/rtf"),
            ("a.zip", "application/zip"),
            ("a.mp4", "video/mp4"),
            ("a.mp3", "audio/mpeg"),
            ("a.unknown", "application/octet-stream"),
            ("a", "application/octet-stream"),
        ] {
            assert_eq!(mime_for(name), expected, "{name}");
        }
    }
}
