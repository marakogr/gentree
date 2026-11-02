// Thin typed wrappers over Tauri commands. Every data path goes through IPC;
// the UI never talks to an HTTP API.

import { invoke } from "@tauri-apps/api/core";
import type {
  AncestorGraph,
  BackupInfo,
  ChatMessage,
  ChatStatus,
  DescendantGraph,
  EventEntity,
  EventInput,
  EventListParams,
  ImportPreview,
  ImportProbe,
  ImportResult,
  KinshipDescriptor,
  MediaItem,
  MergeApplyRequest,
  MergeApplyResult,
  MergePreview,
  Page,
  PathResult,
  ParentRef,
  Person,
  PlaceGeoApplyInput,
  PlaceGeoApplyResult,
  PlaceSuggestion,
  PersonDetail,
  PersonInput,
  PersonListParams,
  ProjectExportFormat,
  ProjectExportGedcomVersion,
  ProjectExportResult,
  ProjectInfo,
  RelationshipEntity,
  RelationshipInput,
  RemovalPlan,
  SearchResponse,
  SourceEntity,
  TimelineListParams,
  TimelineResult,
  UpdateStatus,
  ValidationReport,
  Versioned,
} from "./types";

export const projectsApi = {
  list: () => invoke<ProjectInfo[]>("project_list"),
  create: (name: string) => invoke<ProjectInfo>("project_create", { name }),
  open: (projectId: string) => invoke<ProjectInfo>("project_open", { projectId }),
  /** Writes a backup and returns its absolute path. */
  backup: () => invoke<string>("project_backup"),
  /** Opens the file manager with the backup archive selected. */
  revealBackup: (path: string) =>
    invoke<boolean>("project_backup_reveal", { path }),
  /** Backups of one project, newest first; works for closed projects too. */
  listBackups: (projectId: string) =>
    invoke<BackupInfo[]>("project_list_backups", { projectId }),
  /**
   * Restores one backup into a new project and opens it. The source project is
   * left untouched; the returned project is the restored copy.
   */
  restoreBackup: (backupId: string) =>
    invoke<ProjectInfo>("project_restore_backup", { backupId }),
  close: () => invoke<boolean>("project_close"),
  validate: () => invoke<ValidationReport>("project_validate"),
  remove: (projectId: string) => invoke<boolean>("project_delete", { projectId }),
  /** Renames an open or closed project; rejects blank and duplicate names. */
  rename: (projectId: string, name: string) =>
    invoke<ProjectInfo>("project_rename", { projectId, name }),
  /**
   * Writes a ZIP with an AT5 or GEDCOM file and a sibling media folder.
   * `destination` is the absolute path chosen by the native save dialog.
   * `gedcomVersion` is only meaningful for GEDCOM; absent means 5.5.1.
   */
  export: (
    projectId: string,
    format: ProjectExportFormat,
    destination: string,
    gedcomVersion?: ProjectExportGedcomVersion,
  ) =>
    invoke<ProjectExportResult>("project_export", {
      projectId,
      format,
      destination,
      gedcomVersion: format === "GEDCOM" ? (gedcomVersion ?? "5.5.1") : null,
    }),
  /**
   * Dry run for merging two projects (ADR-0017). Nothing is written; the
   * returned suggestions still need an explicit decision per pair.
   */
  mergePreview: (leftProjectId: string, rightProjectId: string) =>
    invoke<MergePreview>("merge_preview", { leftProjectId, rightProjectId }),
  /**
   * Creates the merged project from the confirmed decisions, opens it and
   * returns it with the core report. The source projects stay untouched.
   */
  mergeApply: (request: MergeApplyRequest) =>
    invoke<MergeApplyResult>("merge_apply", { request }),
};

export const personsApi = {
  list: (params: PersonListParams) =>
    invoke<Page<Versioned<Person>>>("person_list", { ...params }),
  /**
   * Every matching person (1000 per IPC call) so screens can filter, sort and
   * page locally. Capped by `maxPages`; `truncated` tells the caller it hit it.
   */
  listAll: async (
    params: Omit<PersonListParams, "limit" | "offset"> = {},
    maxPages = 20,
  ): Promise<Page<Versioned<Person>> & { truncated: boolean }> => {
    const pageSize = 1000;
    const items: Versioned<Person>[] = [];
    let total = 0;
    for (let index = 0; index < maxPages; index += 1) {
      const page = await invoke<Page<Versioned<Person>>>("person_list", {
        ...params,
        limit: pageSize,
        offset: index * pageSize,
      });
      total = page.total;
      items.push(...page.items);
      if (items.length >= total || page.items.length === 0) break;
    }
    return { items, total, truncated: items.length < total };
  },
  get: (id: string) => invoke<PersonDetail>("person_get", { id }),
  create: (person: PersonInput) =>
    invoke<Versioned<Person>>("person_create", { person }),
  update: (person: PersonInput, expectedVersion: string) =>
    invoke<Versioned<Person>>("person_update", { person, expectedVersion }),
  delete: (id: string, expectedVersion: string) =>
    invoke<RemovalPlan>("person_delete", { id, expectedVersion }),
  setHome: (personId: string) =>
    invoke<void>("person_set_home", { personId }),
  /** Parents for a page of rows, keyed by person id (batch, no extra list shape). */
  parents: (ids: string[]) =>
    invoke<Record<string, ParentRef[]>>("person_parents", { ids }),
};

export const eventsApi = {
  list: (params: EventListParams) =>
    invoke<Versioned<EventEntity>[]>("event_list", { ...params }),
  create: (event: EventInput) =>
    invoke<Versioned<EventEntity>>("event_create", { event }),
  update: (event: EventInput, expectedVersion: string) =>
    invoke<Versioned<EventEntity>>("event_update", { event, expectedVersion }),
  delete: (id: string, expectedVersion: string) =>
    invoke<void>("event_delete", { id, expectedVersion }),
  applyPlaceGeo: (input: PlaceGeoApplyInput) =>
    invoke<PlaceGeoApplyResult>("event_place_geo_apply", { input }),
};

export const placesApi = {
  /**
   * Opt-in online address suggestions (ADR-0016). Returns `[]` while the
   * geocoder is disabled or the query is shorter than three characters; the
   * backend never echoes the query in an error.
   */
  suggest: (query: string) =>
    invoke<PlaceSuggestion[]>("place_suggest", { query }),
};

export const timelineApi = {
  list: (params: TimelineListParams = {}) =>
    invoke<TimelineResult>("timeline_list", { ...params }),
};

export const relationshipsApi = {
  list: (personId?: string) =>
    invoke<Versioned<RelationshipEntity>[]>("relationship_list", {
      ...(personId ? { personId } : {}),
    }),
  create: (relationship: RelationshipInput) =>
    invoke<Versioned<RelationshipEntity>>("relationship_create", {
      relationship,
    }),
  delete: (id: string, expectedVersion: string) =>
    invoke<void>("relationship_delete", { id, expectedVersion }),
};

export const graphApi = {
  /** Without `rootPersonId` the backend uses `homePersonId`, then the fallback. */
  ancestors: (params: { rootPersonId?: string; generations?: number } = {}) =>
    invoke<AncestorGraph>("graph_ancestors", { ...params }),
  /** Root plus descendant levels; the backend caps the requested depth at 8. */
  descendants: (params: { rootPersonId?: string; generations?: number } = {}) =>
    invoke<DescendantGraph>("graph_descendants", { ...params }),
  /** Kinship terms relative to one root for several graph nodes in one call. */
  kinship: (rootPersonId: string, targetPersonIds: string[]) =>
    invoke<Record<string, KinshipDescriptor>>("graph_kinship", {
      rootPersonId,
      targetPersonIds,
    }),
};

export const pathApi = {
  /** Shortest path over parent/child/spouse edges; `found=false` when none. */
  find: (fromPersonId: string, toPersonId: string) =>
    invoke<PathResult>("path_find", { fromPersonId, toPersonId }),
  /** Structural descriptor; the UI renders it through `formatKinship`. */
  kinship: (fromPersonId: string, toPersonId: string) =>
    invoke<KinshipDescriptor>("kinship_get", { fromPersonId, toPersonId }),
};

export const searchApi = {
  query: (query: string, limit = 20) =>
    invoke<SearchResponse>("search_query", { query, limit }),
  /** Rebuilds the project index and returns the number of indexed documents. */
  rebuild: () => invoke<number>("search_rebuild"),
  /** Source metadata for the expandable details panel. */
  sourceDetails: (sourceId: string) =>
    invoke<SourceEntity>("search_source_details", { sourceId }),
};

export const chatApi = {
  /** Enabled/model/key facts; the key value is never returned. */
  status: () => invoke<ChatStatus>("chat_status"),
  /** Registers the request; the answer arrives as `chat-delta|done|error`. */
  send: (params: {
    requestId: string;
    locale: string;
    messages: ChatMessage[];
    /** Localized built-in guide; appended to the system prompt. */
    guide?: string;
  }) => invoke<void>("chat_send", { ...params }),
  /** Stops an in-flight stream; unknown ids are `CHAT_CANCELLED`. */
  cancel: (requestId: string) =>
    invoke<boolean>("chat_cancel", { requestId }),
  /** Resolves a pending `update_person` confirmation; nothing is written here. */
  confirm: (confirmationId: string, approve: boolean) =>
    invoke<boolean>("chat_confirm", { confirmationId, approve }),
};

export const mediaApi = {
  /** Media rows for one person, or the whole project when `personId` is omitted. */
  list: (personId?: string) =>
    invoke<MediaItem[]>("media_list", {
      ...(personId ? { personId } : {}),
    }),
  open: (id: string) => invoke<void>("media_open", { id }),
  saveAs: (id: string, target: string) =>
    invoke<string>("media_save_as", { id, target }),
  /** Copies a local file into the project and links it to the person. */
  attach: (personId: string, sourcePath: string, primary = false) =>
    invoke<MediaItem>("media_attach", { personId, sourcePath, primary }),
  /** Makes one attached image the person's profile photo. */
  setPrimary: (personId: string, mediaId: string) =>
    invoke<MediaItem>("media_set_primary", { personId, mediaId }),
  /** Files attached to one event (ADR-0018). */
  listForEvent: (eventId: string) =>
    invoke<MediaItem[]>("media_event_list", { eventId }),
  /** Attachment count per event id, for the list indicator. */
  eventCounts: () => invoke<Record<string, number>>("media_event_counts"),
  /** Copies a local file into the project and links it to the event. */
  attachToEvent: (eventId: string, sourcePath: string) =>
    invoke<MediaItem>("media_attach_to_event", { eventId, sourcePath }),
  /** Clears the link; the row and the file bytes are kept. */
  detachFromEvent: (eventId: string, mediaId: string) =>
    invoke<MediaItem>("media_event_detach", { eventId, mediaId }),
  /** Sets or clears the caption of one row; `null` clears it. */
  setCaption: (mediaId: string, caption: string | null) =>
    invoke<MediaItem>("media_set_caption", { mediaId, caption }),
};

/** Configured locations the settings screen can reveal in the file manager. */
export type SettingsPathKind = "projects" | "backups" | "index" | "config";

export const settingsApi = {
  /**
   * Full settings snapshot. Screens read only the flags they own; the settings
   * screen uses the same command through its richer local type.
   */
  get: () =>
    invoke<{ config: { app: { graph_whole_tree?: boolean } } }>("settings_get"),
  /**
   * Opens a configured location in the OS file manager. The renderer sends the
   * location name only; the backend resolves the path from the config.
   */
  openPath: (kind: SettingsPathKind) =>
    invoke<boolean>("settings_open_path", { kind }),
};

/**
 * In-app updates. `status` never touches the network; `check` and `install`
 * refuse a build whose endpoint or public key is still a placeholder.
 */
export const updatesApi = {
  status: () => invoke<UpdateStatus>("update_status"),
  check: () => invoke<UpdateStatus>("update_check"),
  install: () => invoke<UpdateStatus>("update_install"),
};

/** Optional project name; the backend falls back to the file name. */
function nameArgument(name: string | undefined): { name?: string } {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" ? {} : { name: trimmed };
}

export const importApi = {
  /** Classifies a dropped/picked path before choosing the AT5 or GEDCOM reader. */
  probe: (path: string) => invoke<ImportProbe>("import_probe", { path }),
  /** Dry run over the read-only AT5 reader with extra media folders. */
  previewAt5: (path: string, mediaDirs: string[]) =>
    invoke<ImportPreview>("import_preview_at5", { path, mediaDirs }),
  /** Creates a new project, writes the bundle and opens it. */
  importAt5: (path: string, mediaDirs: string[], name?: string) =>
    invoke<ImportResult>("import_at5", {
      path,
      mediaDirs,
      ...nameArgument(name),
    }),
  /** Dry run over the read-only GEDCOM reader with extra media folders. */
  previewGedcom: (path: string, mediaDirs: string[]) =>
    invoke<ImportPreview>("import_preview_gedcom", { path, mediaDirs }),
  /** Creates a new project, copies the media bytes and opens it. */
  importGedcom: (path: string, mediaDirs: string[], name?: string) =>
    invoke<ImportResult>("import_gedcom", {
      path,
      mediaDirs,
      ...nameArgument(name),
    }),
};
