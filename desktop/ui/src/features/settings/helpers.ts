// Pure helpers for the settings screen: no DOM, no IPC. Contract: design.md
// §7, §10; ADR-0012. Config keys stay snake_case (the YAML contract).

import type { Locale } from "../../i18n/locale";
import type { EventType, GeocoderProvider, MapBasemap } from "../../api/types";
import {
  BUILTIN_EVENT_FIELDS,
  type CustomEventFieldGroup,
} from "../events/fields";

/** `system` follows the OS language; every other value is a supported locale. */
export type Language = "system" | Locale;
export type Theme = "system" | "light" | "dark";
/** `classic` is the shipping look; `swiss` is the opt-in design system. */
export type Style = "classic" | "swiss";

export type AppConfig = {
  app: {
    language: Language;
    theme: Theme;
    style: Style;
    /** Feature flag for the rootless "whole tree" graph mode. */
    graph_whole_tree: boolean;
  };
  /** Built-in types live in the schema; `custom` holds extra display names. */
  event_types: { custom: string[] };
  /** Extra detail fields per event type (ADR-0015). */
  event_fields: { custom: CustomEventFieldGroup[] };
  storage: { projects_dir: string; backups_dir: string; autosave_ms: number };
  search: { index_dir: string };
  chat: {
    enabled: boolean;
    provider: string;
    base_url: string;
    model: string;
    api_key_env: string;
    temperature: number;
    max_tokens: number;
    timeout_seconds: number;
    stream: boolean;
    show_tools: boolean;
    allow_person_edits: boolean;
  };
  /** Opt-in online address suggestions; off unless the user turns it on. */
  geocoder: {
    enabled: boolean;
    provider: GeocoderProvider;
    photon_base_url: string;
    dadata_base_url: string;
    api_key_env: string;
    timeout_seconds: number;
  };
  /** Historical names through Wikidata (ADR-0021). */
  historical_geocoder: {
    enabled: boolean;
    api_url: string;
    timeout_seconds: number;
  };
  /** Basemap for the event map (ADR-0020). */
  map: { basemap: MapBasemap; tile_url: string };
  backup: { enabled: boolean; on_close: boolean; daily: boolean; keep: number };
  /** Opt-in startup update checks; the endpoint lives in tauri.conf.json. */
  updates: { auto_check: boolean };
};

export type AppErrorEnvelope = {
  code: string;
  params?: Record<string, string>;
  message?: string;
};

export type SettingsSnapshot = {
  config: AppConfig;
  warnings: string[];
  error: AppErrorEnvelope | null;
  configPath: string;
  chatApiKeyPresent: boolean;
  /** Presence only; the DaData key itself never reaches the UI (ADR-0016). */
  geocoderApiKeyPresent: boolean;
};

/** Editable subset of the config. Counts stay strings while typing. */
export type SettingsDraft = {
  language: Language;
  theme: Theme;
  style: Style;
  /** Off by default: the rootless whole-project tree stays hidden. */
  graphWholeTree: boolean;
  customEventTypes: string[];
  /** Editable copy of `event_fields.custom`, saved with the same button. */
  eventFieldGroups: CustomEventFieldGroup[];
  chatEnabled: boolean;
  chatBaseUrl: string;
  chatModel: string;
  chatApiKeyEnv: string;
  chatShowTools: boolean;
  chatAllowPersonEdits: boolean;
  geocoderEnabled: boolean;
  geocoderProvider: GeocoderProvider;
  /** Variable *name* only; the key value is never stored or displayed. */
  geocoderApiKeyEnv: string;
  historicalEnabled: boolean;
  mapBasemap: MapBasemap;
  mapTileUrl: string;
  /** Off by default: no update request until the user turns this on. */
  updatesAutoCheck: boolean;
  backupKeep: string;
};

/** Partial patch in the config contract (snake_case), never a full document. */
export type SettingsPatch = {
  app?: {
    language?: Language;
    theme?: Theme;
    style?: Style;
    graph_whole_tree?: boolean;
  };
  event_types?: { custom?: string[] };
  event_fields?: { custom?: CustomEventFieldGroup[] };
  chat?: {
    enabled?: boolean;
    base_url?: string;
    model?: string;
    api_key_env?: string;
    show_tools?: boolean;
    allow_person_edits?: boolean;
  };
  geocoder?: {
    enabled?: boolean;
    provider?: GeocoderProvider;
    api_key_env?: string;
  };
  historical_geocoder?: { enabled?: boolean };
  map?: { basemap?: MapBasemap; tile_url?: string };
  updates?: { auto_check?: boolean };
  backup?: { keep?: number };
};

export function draftFromSnapshot(snapshot: SettingsSnapshot): SettingsDraft {
  return {
    language: snapshot.config.app.language,
    theme: snapshot.config.app.theme,
    style: snapshot.config.app.style,
    graphWholeTree: snapshot.config.app.graph_whole_tree === true,
    customEventTypes: [...snapshot.config.event_types.custom],
    eventFieldGroups: snapshot.config.event_fields.custom.map((group) => ({
      type: group.type,
      fields: group.fields.map((field) => ({ ...field })),
    })),
    chatEnabled: snapshot.config.chat.enabled,
    chatBaseUrl: snapshot.config.chat.base_url,
    chatModel: snapshot.config.chat.model,
    chatApiKeyEnv: snapshot.config.chat.api_key_env,
    chatShowTools: snapshot.config.chat.show_tools,
    chatAllowPersonEdits: snapshot.config.chat.allow_person_edits,
    geocoderEnabled: snapshot.config.geocoder.enabled,
    geocoderProvider: snapshot.config.geocoder.provider,
    geocoderApiKeyEnv: snapshot.config.geocoder.api_key_env,
    historicalEnabled: snapshot.config.historical_geocoder.enabled,
    mapBasemap: snapshot.config.map.basemap,
    mapTileUrl: snapshot.config.map.tile_url,
    updatesAutoCheck: snapshot.config.updates.auto_check,
    backupKeep: String(snapshot.config.backup.keep),
  };
}

/** True for a non-empty http(s) URL; the backend applies the same rule. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/.test(value.trim());
}

/** Parses a non-negative integer typed into a number input. */
export function parseCount(value: string): number | null {  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Mirrors the Rust config limits for `event_types.custom`. */
export const MAX_CUSTOM_EVENT_TYPES = 50;
export const MAX_EVENT_TYPE_NAME = 60;

/** Why a custom event type cannot be added; `null` when it can. */
export type CustomEventTypeError = "empty" | "tooLong" | "duplicate" | "limit";

/**
 * Case-insensitive lookup of a custom type name, returning the stored spelling.
 * The backend rejects duplicates ignoring case, so the UI checks the same way.
 */
export function findCustomEventType(
  name: string,
  customTypes: readonly string[],
): string | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return null;
  return (
    customTypes.find((item) => item.trim().toLowerCase() === wanted) ?? null
  );
}

/** Validation shared by the Add button and the submit guard. */
export function customEventTypeError(
  customTypes: readonly string[],
  value: string,
): CustomEventTypeError | null {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  if (Array.from(trimmed).length > MAX_EVENT_TYPE_NAME) return "tooLong";
  if (findCustomEventType(trimmed, customTypes) !== null) return "duplicate";
  if (customTypes.length >= MAX_CUSTOM_EVENT_TYPES) return "limit";
  return null;
}

/** Appends a trimmed valid name; `null` means the value was rejected. */
export function appendCustomEventType(
  customTypes: readonly string[],
  value: string,
): string[] | null {
  if (customEventTypeError(customTypes, value) !== null) return null;
  return [...customTypes, value.trim()];
}

/** Removes one name, leaving the list untouched when it is absent. */
export function removeCustomEventType(
  customTypes: readonly string[],
  name: string,
): string[] {
  return customTypes.filter((item) => item !== name);
}

/** Order-sensitive comparison used to keep the patch minimal. */
export function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Builds a minimal patch: only changed values, strings trimmed, empty patch
 * when nothing changed. Invalid counts are omitted and the caller must keep
 * Save disabled (`parseCount` returns null).
 */
export function buildSettingsPatch(
  draft: SettingsDraft,
  config: AppConfig,
): SettingsPatch {
  const patch: SettingsPatch = {};

  const app: NonNullable<SettingsPatch["app"]> = {};
  if (draft.language !== config.app.language) app.language = draft.language;
  if (draft.theme !== config.app.theme) app.theme = draft.theme;
  if (draft.style !== config.app.style) app.style = draft.style;
  if (draft.graphWholeTree !== config.app.graph_whole_tree)
    app.graph_whole_tree = draft.graphWholeTree;
  if (Object.keys(app).length > 0) patch.app = app;

  if (!sameStringList(draft.customEventTypes, config.event_types.custom)) {
    patch.event_types = { custom: [...draft.customEventTypes] };
  }

  if (
    JSON.stringify(draft.eventFieldGroups) !==
    JSON.stringify(config.event_fields.custom)
  ) {
    patch.event_fields = {
      custom: draft.eventFieldGroups.map((group) => ({
        type: group.type.trim(),
        fields: group.fields.map((field) => ({
          key: field.key.trim(),
          label: field.label.trim(),
          multiline: field.multiline ?? false,
        })),
      })),
    };
  }

  const chat: NonNullable<SettingsPatch["chat"]> = {};
  const baseUrl = draft.chatBaseUrl.trim();
  const model = draft.chatModel.trim();
  const apiKeyEnv = draft.chatApiKeyEnv.trim();
  if (draft.chatEnabled !== config.chat.enabled) chat.enabled = draft.chatEnabled;
  if (baseUrl !== config.chat.base_url) chat.base_url = baseUrl;
  if (model !== config.chat.model) chat.model = model;
  if (apiKeyEnv !== config.chat.api_key_env) chat.api_key_env = apiKeyEnv;
  if (draft.chatShowTools !== config.chat.show_tools)
    chat.show_tools = draft.chatShowTools;
  if (draft.chatAllowPersonEdits !== config.chat.allow_person_edits)
    chat.allow_person_edits = draft.chatAllowPersonEdits;
  if (Object.keys(chat).length > 0) patch.chat = chat;

  const geocoder: NonNullable<SettingsPatch["geocoder"]> = {};
  const geocoderApiKeyEnv = draft.geocoderApiKeyEnv.trim();
  if (draft.geocoderEnabled !== config.geocoder.enabled)
    geocoder.enabled = draft.geocoderEnabled;
  if (draft.geocoderProvider !== config.geocoder.provider)
    geocoder.provider = draft.geocoderProvider;
  if (geocoderApiKeyEnv !== config.geocoder.api_key_env)
    geocoder.api_key_env = geocoderApiKeyEnv;
  if (Object.keys(geocoder).length > 0) patch.geocoder = geocoder;

  if (draft.historicalEnabled !== config.historical_geocoder.enabled) {
    patch.historical_geocoder = { enabled: draft.historicalEnabled };
  }

  const map: NonNullable<SettingsPatch["map"]> = {};
  const mapTileUrl = draft.mapTileUrl.trim();
  if (draft.mapBasemap !== config.map.basemap) map.basemap = draft.mapBasemap;
  if (mapTileUrl !== config.map.tile_url) map.tile_url = mapTileUrl;
  if (Object.keys(map).length > 0) patch.map = map;

  if (draft.updatesAutoCheck !== config.updates.auto_check) {
    patch.updates = { auto_check: draft.updatesAutoCheck };
  }

  const backup: NonNullable<SettingsPatch["backup"]> = {};
  const keep = parseCount(draft.backupKeep);
  if (keep !== null && keep >= 1 && keep !== config.backup.keep) backup.keep = keep;
  if (Object.keys(backup).length > 0) patch.backup = backup;

  return patch;
}

/* ------------------------------------------------------------------------- */
/* Event field editor (ADR-0015)                                              */
/* ------------------------------------------------------------------------- */

export const MAX_EVENT_FIELD_GROUPS = 50;
export const MAX_CUSTOM_EVENT_FIELDS = 20;
export const MAX_EVENT_FIELD_LABEL = 80;
export const MAX_EVENT_DETAIL_KEY = 64;

/** Keys owned by the event shape; the backend rejects them as detail keys. */
export const RESERVED_EVENT_DETAIL_KEYS = [
  "id",
  "type",
  "date",
  "place",
  "description",
  "details",
] as const;

/** Mirrors `gentree_core::event_fields::is_valid_event_detail_key`. */
export function isEventDetailKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key) && key.length <= MAX_EVENT_DETAIL_KEY;
}

/** First validation problem of `event_fields.custom`, or `null` when usable. */
export function eventFieldGroupsError(
  groups: readonly CustomEventFieldGroup[],
): string | null {
  if (groups.length > MAX_EVENT_FIELD_GROUPS) return "tooManyGroups";
  const types = new Set<string>();
  for (const group of groups) {
    const type = group.type.trim();
    if (type === "") return "typeRequired";
    if (Array.from(type).length > MAX_EVENT_TYPE_NAME) return "typeTooLong";
    const lower = type.toLowerCase();
    if (types.has(lower)) return "typeDuplicate";
    types.add(lower);
    if (group.fields.length > MAX_CUSTOM_EVENT_FIELDS) return "tooManyFields";
    const builtin = BUILTIN_EVENT_FIELDS[type as EventType] ?? [];
    const keys = new Set<string>();
    for (const field of group.fields) {
      if (field.label.trim() === "") return "labelRequired";
      if (Array.from(field.label.trim()).length > MAX_EVENT_FIELD_LABEL) {
        return "labelTooLong";
      }
      const key = field.key.trim();
      if (!isEventDetailKey(key)) return "keyInvalid";
      if (keys.has(key)) return "keyDuplicate";
      keys.add(key);
      if (
        (RESERVED_EVENT_DETAIL_KEYS as readonly string[]).includes(key) ||
        builtin.some((spec) => spec.key === key)
      ) {
        return "keyReserved";
      }
    }
  }
  return null;
}

/** New group type that is not in use yet, or `""` when every type is taken. */
export function nextEventFieldType(
  groups: readonly CustomEventFieldGroup[],
  customTypes: readonly string[],
  builtinTypes: readonly string[],
): string {
  const used = new Set(groups.map((group) => group.type.trim().toLowerCase()));
  return (
    [...builtinTypes, ...customTypes].find(
      (type) => !used.has(type.trim().toLowerCase()),
    ) ?? ""
  );
}

/** Trims, drops empty entries and de-duplicates warnings, keeping order. */
export function formatWarnings(warnings: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const warning of warnings ?? []) {
    const text = warning.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
