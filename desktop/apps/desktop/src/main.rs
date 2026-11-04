#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use gentree_core::error::codes;
use gentree_core::person::{Name, Person};
use gentree_core::record::backfill_marriage_participants;
use gentree_core::{AppError, AppResult, Manifest, ValidationReport};
use gentree_mcp::BackupInfo;
use gentree_storage::chat_history::ChatHistoryStore;
use gentree_storage::{
    delete_project, list_projects, prune_backups, rename_project, ProjectStore, BACKUP_SUFFIX,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

mod commands;
mod envvars;
mod logging;
mod project_access;
mod settings;
mod updates;

/// Backups kept per project; shared by `project.close`, `project.backup` and
/// the chat `backup_project` tool.
pub(crate) const BACKUP_KEEP: usize = 10;

/// Locks a state mutex. A poisoned lock is a programming error, reported as
/// `UNKNOWN` with the caller's message instead of panicking.
pub(crate) fn lock_or<'a, T>(mutex: &'a Mutex<T>, message: &str) -> AppResult<MutexGuard<'a, T>> {
    mutex
        .lock()
        .map_err(|_| AppError::new(codes::UNKNOWN, message))
}

#[derive(Default)]
struct AppState {
    /// Shared with the chat tool backend, which must see the same open store.
    project: Arc<Mutex<Option<ProjectStore>>>,
    projects_dir: Mutex<Option<PathBuf>>,
    backups_dir: Mutex<Option<PathBuf>>,
    /// App-data `chat/` root: conversation history is auxiliary, not project data.
    chat_dir: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    project_id: String,
    name: String,
    persons: usize,
    content_hash: String,
    locked: bool,
    read_only: bool,
    updated_at: String,
    /// Default graph root; the UI falls back the same way when it is `null`.
    home_person_id: Option<String>,
}

fn project_info(store: &ProjectStore) -> ProjectInfo {
    project_info_from_manifest(store.manifest(), !store.is_writable())
}

fn project_info_from_manifest(manifest: &Manifest, read_only: bool) -> ProjectInfo {
    ProjectInfo {
        project_id: manifest.project_id.to_string(),
        name: manifest.name.clone(),
        persons: manifest.counts.persons,
        content_hash: manifest.content_hash.clone(),
        locked: false,
        read_only,
        updated_at: manifest.updated_at.clone(),
        home_person_id: manifest.home_person_id.map(|id| id.to_string()),
    }
}

/// Allow the webview asset protocol to read this project's media folder.
/// Projects normally live under `$APPDATA` (already in the static scope), but a
/// custom project location must work too; the scope is narrowed to `media/`.
pub(crate) fn allow_media_scope(app: &AppHandle, project_root: &std::path::Path) {
    let _ = app
        .asset_protocol_scope()
        .allow_directory(project_root.join("media"), true);
}

/// One-time repair for projects created before marriage events carried the
/// other spouse as a co-participant. Writable projects only; a project with
/// several spouse links for the same person is left untouched.
fn repair_legacy_marriages(store: &mut ProjectStore) -> AppResult<()> {
    if !store.is_writable() {
        return Ok(());
    }
    let mut events = store.events()?;
    let relationships = store.relationships()?;
    if backfill_marriage_participants(&mut events, &relationships) > 0 {
        store.save_events(&events)?;
    }
    Ok(())
}

/// Resolves (and caches) one app-data subdirectory, creating it on first use.
fn cached_app_dir(
    app: &AppHandle,
    slot: &Mutex<Option<PathBuf>>,
    leaf: &str,
) -> AppResult<PathBuf> {
    let mut slot = lock_or(slot, "state poisoned")?;
    if let Some(dir) = slot.as_ref() {
        return Ok(dir.clone());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::new(codes::IO_ERROR, err.to_string()))?
        .join(leaf);
    std::fs::create_dir_all(&dir).map_err(|err| AppError::io(format!("create {leaf} dir"), err))?;
    *slot = Some(dir.clone());
    Ok(dir)
}

fn projects_dir(app: &AppHandle, state: &AppState) -> AppResult<PathBuf> {
    cached_app_dir(app, &state.projects_dir, "projects")
}

fn backups_dir(app: &AppHandle, state: &AppState) -> AppResult<PathBuf> {
    cached_app_dir(app, &state.backups_dir, "backups")
}

/// App-data `chat/` root, created on first use and cached like the other
/// app-data directories.
pub(crate) fn chat_dir(app: &AppHandle, state: &AppState) -> AppResult<PathBuf> {
    cached_app_dir(app, &state.chat_dir, "chat")
}

/// Best-effort history cleanup after a project folder has moved to `.trash`.
/// A failure is metadata-only: it must never fail the project deletion.
fn cleanup_project_history(chat_root: &Path, project_id: &str) {
    let Ok(project_id) = uuid::Uuid::parse_str(project_id.trim()) else {
        logging::warn(
            "chat.history",
            "op=deleteProject code=VALIDATION_ERROR reason=invalidProjectId",
        );
        return;
    };
    match ChatHistoryStore::new(chat_root).delete_project(project_id) {
        Ok(removed) => logging::info(
            "chat.history",
            format!("op=deleteProject project={project_id} removed={removed} code=OK"),
        ),
        Err(error) => logging::warn(
            "chat.history",
            format!("op=deleteProject project={project_id} code={}", error.code),
        ),
    }
}

/// Writes one backup and applies the retention policy.
fn backup_and_prune(store: &ProjectStore, dir: &Path) -> AppResult<PathBuf> {
    let path = store.backup(dir)?;
    prune_backups(dir, store.manifest().project_id, BACKUP_KEEP)?;
    Ok(path)
}

#[tauri::command]
fn project_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<ProjectInfo, AppError> {
    let dir = projects_dir(&app, &state)?;
    let store = ProjectStore::create(&dir, &name)?;
    let info = project_info(&store);
    *lock_or(&state.project, "state poisoned")? = Some(store);
    Ok(info)
}

#[tauri::command]
fn project_list(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<ProjectInfo>, AppError> {
    let dir = projects_dir(&app, &state)?;
    let manifests = list_projects(&dir)?;
    Ok(manifests
        .into_iter()
        .map(|manifest| project_info_from_manifest(&manifest, false))
        .collect())
}

#[tauri::command]
fn project_open(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectInfo, AppError> {
    {
        let guard = lock_or(&state.project, "state poisoned")?;
        if let Some(store) = guard.as_ref() {
            if store.manifest().project_id.to_string() == project_id {
                return Ok(project_info(store));
            }
        }
    }
    let dir = projects_dir(&app, &state)?.join(&project_id);
    let mut store = ProjectStore::open(&dir, true)?;
    repair_legacy_marriages(&mut store)?;
    allow_media_scope(&app, store.root());
    let info = project_info(&store);
    *lock_or(&state.project, "state poisoned")? = Some(store);
    Ok(info)
}

/// Rename an open or closed project. The name is trimmed; a blank name, one
/// longer than 200 characters, or another project's name (case-insensitive) is
/// `VALIDATION_ERROR` on the `name` field. A read-only project is
/// `PROJECT_LOCKED`, never a panic.
#[tauri::command]
fn project_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<ProjectInfo, AppError> {
    let dir = projects_dir(&app, &state)?;
    let id = commands::parse_uuid("projectId", &project_id)?;

    {
        let mut guard = lock_or(&state.project, "state poisoned")?;
        if let Some(store) = guard.as_mut() {
            if store.manifest().project_id == id {
                // The open store persists the rename and keeps its state in
                // sync; a read-only store refuses inside `rename`.
                store.rename(&name)?;
                return Ok(project_info(store));
            }
        }
    }

    let manifest = rename_project(&dir, id, &name)?;
    Ok(project_info_from_manifest(&manifest, false))
}

#[tauri::command]
fn project_close(app: AppHandle, state: State<'_, AppState>) -> Result<bool, AppError> {
    let mut guard = lock_or(&state.project, "state poisoned")?;
    if let Some(store) = guard.take() {
        let dir = backups_dir(&app, &state)?;
        backup_and_prune(&store, &dir)?;
    }
    Ok(true)
}

#[tauri::command]
fn project_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<bool, AppError> {
    {
        let guard = lock_or(&state.project, "state poisoned")?;
        if let Some(store) = guard.as_ref() {
            if store.manifest().project_id.to_string() == project_id {
                return Err(AppError::new(
                    codes::PROJECT_LOCKED,
                    "Close the project before deleting it",
                )
                .with_param("reason", "open"));
            }
        }
    }
    let dir = projects_dir(&app, &state)?;
    let trash = dir.join(".trash");
    std::fs::create_dir_all(&trash).map_err(|err| AppError::io("create trash dir", err))?;
    delete_project(&dir.join(&project_id), &trash)?;
    // The folder is gone; history cleanup is best-effort and path-free.
    if let Ok(chat_root) = chat_dir(&app, &state) {
        cleanup_project_history(&chat_root, &project_id);
    }
    Ok(true)
}

#[tauri::command]
fn project_backup(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppError> {
    let guard = lock_or(&state.project, "state poisoned")?;
    let store = guard
        .as_ref()
        .ok_or_else(|| AppError::new(codes::PROJECT_NOT_FOUND, "No project is open"))?;
    let dir = backups_dir(&app, &state)?;
    let path = backup_and_prune(store, &dir)?;
    // The UI shows this as a clickable address and hands it back to
    // `project_backup_reveal`, so the full path is returned, not just the name.
    Ok(path.to_string_lossy().into_owned())
}

/// Show a backup archive in the OS file manager with the file selected.
///
/// The path comes back from the renderer, so it is treated as untrusted input:
/// only an existing `*.gentree.zip` directly inside one project folder of the
/// backups root is accepted.
#[tauri::command]
fn project_backup_reveal(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<bool, AppError> {
    let dir = backups_dir(&app, &state)?;
    let target = backup_path_in_dir(&dir, &path)?;
    reveal_in_file_manager(&target)?;
    Ok(true)
}

/// One project's backups, newest first. `project_id` must be a UUID; the
/// backups directory is derived from it, so the renderer cannot list another
/// folder.
#[tauri::command]
fn project_list_backups(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<BackupInfo>, AppError> {
    let id = commands::parse_uuid("projectId", &project_id)?;
    let dir = backups_dir(&app, &state)?.join(id.to_string());
    Ok(project_access::list_backup_infos(&dir, id))
}

/// Restore one backup into a **new** project and open it. The source project is
/// left untouched; the renderer receives the new project's metadata.
#[tauri::command]
fn project_restore_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup_id: String,
) -> Result<ProjectInfo, AppError> {
    let (project_id, file_name) = project_access::parse_backup_id(&backup_id)?;
    let path = backups_dir(&app, &state)?
        .join(project_id.to_string())
        .join(file_name);
    if !path.is_file() {
        return Err(
            AppError::new(codes::NOT_FOUND, "Backup not found").with_param("backupId", backup_id)
        );
    }
    let projects = projects_dir(&app, &state)?;
    let mut store = ProjectStore::restore(&path, &projects)?;
    repair_legacy_marriages(&mut store)?;
    allow_media_scope(&app, store.root());
    let info = project_info(&store);
    *lock_or(&state.project, "state poisoned")? = Some(store);
    Ok(info)
}

fn backup_path_in_dir(dir: &Path, raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid_backup_path("empty"));
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(invalid_backup_path("notAbsolute"));
    }
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !file_name.ends_with(BACKUP_SUFFIX) {
        return Err(invalid_backup_path("notBackup"));
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| invalid_backup_path("noParent"))?;
    let root = std::fs::canonicalize(dir).map_err(|err| AppError::io("read backups dir", err))?;
    let project_dir = std::fs::canonicalize(parent)
        .map_err(|_| AppError::new(codes::NOT_FOUND, "Backup folder not found"))?;
    if project_dir.parent() != Some(root.as_path()) {
        return Err(invalid_backup_path("outsideBackupsDir"));
    }
    if !candidate.is_file() {
        return Err(AppError::new(codes::NOT_FOUND, "Backup file not found"));
    }
    Ok(candidate)
}

fn invalid_backup_path(rule: &str) -> AppError {
    AppError::validation("path", rule)
}

/// Open `path` in the OS file manager.
///
/// With `select` the containing folder opens with the entry highlighted where
/// the platform supports it; without it a directory (or file) opens as is.
pub(crate) fn open_in_file_manager(path: &Path, select: bool) -> AppResult<()> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("explorer");
        if select {
            // `explorer` only understands the raw `/select,<path>` switch; passing
            // it as a normal argument would add quotes around the whole switch.
            command.raw_arg(format!("/select,\"{}\"", path.display()));
        } else {
            command.arg(path);
        }
        command
            .spawn()
            .map_err(|err| AppError::io("open in file manager", err))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if select {
            command.arg("-R");
        }
        command
            .arg(path)
            .spawn()
            .map_err(|err| AppError::io("open in file manager", err))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Most Linux file managers have no portable "select this file" flag, so
        // selecting falls back to opening the containing folder.
        let target = if select {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|err| AppError::io("open in file manager", err))?;
    }
    Ok(())
}

/// Show an entry in the OS file manager with that entry selected.
pub(crate) fn reveal_in_file_manager(path: &Path) -> AppResult<()> {
    open_in_file_manager(path, true)
}

#[tauri::command]
fn project_validate(state: State<'_, AppState>) -> Result<ValidationReport, AppError> {
    let guard = lock_or(&state.project, "state poisoned")?;
    let store = guard
        .as_ref()
        .ok_or_else(|| AppError::new(codes::PROJECT_NOT_FOUND, "No project is open"))?;
    commands::validate_store(store)
}

#[tauri::command]
fn person_add(
    state: State<'_, AppState>,
    given: String,
    surname: String,
) -> Result<Person, AppError> {
    let person = Person::new(vec![Name {
        given: Some(given),
        surname: Some(surname),
        is_primary: true,
        ..Name::default()
    }])?;
    commands::with_store(&state, |store| store.add_person(person))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(Mutex::new(settings::ConfigState::initial()))
        .manage(commands::chat::ChatState::default())
        .manage(updates::UpdateState::default())
        .setup(|app| {
            logging::init(app.handle());
            // Only reads the config and the release settings; it spawns a
            // request only when `updates.auto_check` is on and the build is
            // configured.
            updates::spawn_auto_check(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_create,
            project_list,
            project_open,
            project_rename,
            project_close,
            project_backup,
            project_backup_reveal,
            project_list_backups,
            project_restore_backup,
            commands::export::project_export,
            project_validate,
            project_delete,
            person_add,
            commands::person::person_list,
            commands::person::person_parents,
            commands::person::person_get,
            commands::person::person_create,
            commands::person::person_update,
            commands::person::person_delete,
            commands::person::person_set_home,
            commands::graph::graph_ancestors,
            commands::graph::graph_descendants,
            commands::graph::graph_kinship,
            commands::path::path_find,
            commands::path::kinship_get,
            commands::event::event_list,
            commands::event::event_create,
            commands::event::event_update,
            commands::event::event_place_geo_apply,
            commands::event::event_delete,
            commands::geocode::place_suggest,
            commands::media::media_list,
            commands::media::media_open,
            commands::media::media_save_as,
            commands::media::media_attach,
            commands::media::media_set_primary,
            commands::media::media_event_list,
            commands::media::media_event_counts,
            commands::media::media_attach_to_event,
            commands::media::media_event_detach,
            commands::media::media_set_caption,
            commands::timeline::timeline_list,
            commands::relationship::relationship_list,
            commands::relationship::relationship_create,
            commands::relationship::relationship_delete,
            commands::import::import_probe,
            commands::import::import_preview_at5,
            commands::import::import_at5,
            commands::import::import_preview_gedcom,
            commands::import::import_gedcom,
            commands::merge::merge_preview,
            commands::merge::merge_apply,
            commands::search::search_query,
            commands::search::search_rebuild,
            commands::search::search_source_details,
            commands::chat::chat_status,
            commands::chat::chat_send,
            commands::chat::chat_cancel,
            commands::chat::chat_confirm,
            commands::chat_history::chat_history_list,
            commands::chat_history::chat_history_load,
            commands::chat_history::chat_history_save,
            commands::chat_history::chat_history_delete,
            commands::chat_history::chat_history_clear,
            settings::settings_get,
            settings::settings_update,
            settings::settings_reload,
            settings::settings_locale,
            settings::settings_open_path,
            updates::update_status,
            updates::update_check,
            updates::update_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gentree");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backups_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn write_backup(root: &Path) -> PathBuf {
        let project = root.join("01a16880-e6ef-7540-babe-e8d8b41c39c5");
        std::fs::create_dir_all(&project).expect("project dir");
        let file = project.join("2026-10-23T11-50-57.6363545Z.gentree.zip");
        std::fs::write(&file, b"zip").expect("backup file");
        file
    }

    fn rule(error: &AppError) -> &str {
        error
            .params
            .get("rule")
            .map(String::as_str)
            .unwrap_or_default()
    }

    #[test]
    fn backup_path_accepts_a_generated_archive() {
        let root = backups_root();
        let file = write_backup(root.path());

        let resolved = backup_path_in_dir(root.path(), &file.to_string_lossy()).expect("valid");

        assert_eq!(resolved, file);
    }

    #[test]
    fn backup_path_rejects_traversal_and_foreign_files() {
        let root = backups_root();
        let file = write_backup(root.path());
        let outside = root.path().join("outside.gentree.zip");
        std::fs::write(&outside, b"zip").expect("outside file");
        let nested_dir = file.parent().expect("parent").join("sub");
        std::fs::create_dir_all(&nested_dir).expect("nested dir");
        let nested = nested_dir.join("nested.gentree.zip");
        std::fs::write(&nested, b"zip").expect("nested file");

        let traversal = format!(
            "{}{}{}",
            root.path().display(),
            std::path::MAIN_SEPARATOR,
            "../escape.gentree.zip"
        );
        assert_eq!(
            rule(&backup_path_in_dir(root.path(), &traversal).expect_err("traversal")),
            "notAbsolute"
        );
        assert_eq!(
            rule(
                &backup_path_in_dir(root.path(), &outside.to_string_lossy()).expect_err("outside")
            ),
            "outsideBackupsDir"
        );
        assert_eq!(
            rule(&backup_path_in_dir(root.path(), &nested.to_string_lossy()).expect_err("nested")),
            "outsideBackupsDir"
        );
        assert_eq!(
            rule(&backup_path_in_dir(root.path(), "").expect_err("empty")),
            "empty"
        );
        assert_eq!(
            rule(
                &backup_path_in_dir(root.path(), &file.with_extension("txt").to_string_lossy())
                    .expect_err("not a backup")
            ),
            "notBackup"
        );
    }

    #[test]
    fn backup_path_reports_a_missing_archive() {
        let root = backups_root();
        let project = root.path().join("01a16880-e6ef-7540-babe-e8d8b41c39c5");
        std::fs::create_dir_all(&project).expect("project dir");
        let missing = project.join("gone.gentree.zip");

        let error =
            backup_path_in_dir(root.path(), &missing.to_string_lossy()).expect_err("missing");

        assert_eq!(error.code, codes::NOT_FOUND);
    }

    #[test]
    fn history_cleanup_removes_the_project_directory() {
        let root = backups_root();
        let project_id = uuid::Uuid::now_v7();
        let dir = root.path().join(project_id.to_string());
        std::fs::create_dir_all(&dir).expect("history dir");
        std::fs::write(dir.join("conversation.jsonl"), b"row").expect("history file");

        cleanup_project_history(root.path(), &project_id.to_string());

        assert!(!dir.exists());
    }

    #[test]
    fn history_cleanup_failure_does_not_panic() {
        let root = backups_root();
        let project_id = uuid::Uuid::now_v7();
        // A file where the directory is expected makes `remove_dir_all` fail.
        let path = root.path().join(project_id.to_string());
        std::fs::write(&path, b"not a directory").expect("blocking file");

        cleanup_project_history(root.path(), &project_id.to_string());
        cleanup_project_history(root.path(), "not-a-uuid");

        assert!(path.exists());
    }
}
