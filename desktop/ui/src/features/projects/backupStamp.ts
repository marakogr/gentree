// "Last backup" stamp: a purely local UI label, not a server fact. The backend
// `project_backup()` returns the created file path; the app remembers when it
// last ran so the projects screen can show a date. Nothing is written into the
// project manifest, so deleting `localStorage` only loses the label.

/** ISO 8601 timestamp with an explicit zone (`Z` or `+hh:mm`). */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export const LAST_BACKUP_KEY_PREFIX = "gentree.lastBackup.";
/** Same local-only contract as the backup label, for the validation button. */
export const LAST_CHECK_KEY_PREFIX = "gentree.lastCheck.";

/** Minimum surface of `Storage` needed here, so tests stay DOM-free. */
export type BackupStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function stampKey(prefix: string, projectId: string): string {
  return `${prefix}${projectId}`;
}

export function backupStorageKey(projectId: string): string {
  return stampKey(LAST_BACKUP_KEY_PREFIX, projectId);
}

export function checkStorageKey(projectId: string): string {
  return stampKey(LAST_CHECK_KEY_PREFIX, projectId);
}

function defaultStorage(): BackupStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Private mode / disabled storage: the label simply stays unknown.
    return null;
  }
}

function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function readStamp(
  key: string,
  storage: BackupStorage | null = defaultStorage(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw || !isIsoTimestamp(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeStamp(
  key: string,
  at: Date | string,
  storage: BackupStorage | null,
): string | null {
  const iso = typeof at === "string" ? at.trim() : at.toISOString();
  if (!isIsoTimestamp(iso)) return null;
  if (!storage) return null;
  try {
    storage.setItem(key, iso);
    return iso;
  } catch {
    return null;
  }
}

/** Stored value for `projectId`, or `null` when absent/malformed. */
export function readLastBackup(
  projectId: string,
  storage: BackupStorage | null = defaultStorage(),
): string | null {
  return readStamp(backupStorageKey(projectId), storage);
}

/** Persists the stamp and returns what was stored, or `null` on failure. */
export function writeLastBackup(
  projectId: string,
  at: Date | string = new Date(),
  storage: BackupStorage | null = defaultStorage(),
): string | null {
  return writeStamp(backupStorageKey(projectId), at, storage);
}

/** Last successful validation timestamp for `projectId`, if any. */
export function readLastCheck(
  projectId: string,
  storage: BackupStorage | null = defaultStorage(),
): string | null {
  return readStamp(checkStorageKey(projectId), storage);
}

/** Persists the last-check timestamp and returns what was stored, or `null`. */
export function writeLastCheck(
  projectId: string,
  at: Date | string = new Date(),
  storage: BackupStorage | null = defaultStorage(),
): string | null {
  return writeStamp(checkStorageKey(projectId), at, storage);
}

/** Human-readable archive size in binary units; invalid input is an em dash. */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Locale-aware stamp; `emptyLabel` is shown for a missing/invalid date. */
export function formatBackupStamp(
  iso: string | null | undefined,
  locale: string,
  emptyLabel = "\u2014",
): string {
  if (!iso || !isIsoTimestamp(iso)) return emptyLabel;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return emptyLabel;
  }
}
