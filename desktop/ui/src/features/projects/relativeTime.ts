// Human labels for locally stored project stamps (last backup, last check).
// The timestamps are app-side labels, not project data; see `backupStamp.ts`.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A backup older than this is highlighted as stale. */
export const STALE_BACKUP_DAYS = 7;

/** True when `iso` is a valid timestamp older than `days` relative to `now`. */
export function isStaleStamp(
  iso: string | null | undefined,
  now: Date,
  days = STALE_BACKUP_DAYS,
): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return now.getTime() - time > days * DAY;
}

/**
 * "just now" / "5 minutes ago" / "3 days ago" in the active locale.
 * Invalid or missing stamps fall back to `emptyLabel`; `justNowLabel` keeps the
 * sub-minute case in the dictionaries instead of relying on Intl wording.
 */
export function formatRelativeStamp(
  iso: string | null | undefined,
  locale: string,
  now: Date,
  justNowLabel: string,
  emptyLabel: string,
): string {
  if (!iso) return emptyLabel;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return emptyLabel;

  const diff = now.getTime() - time;
  if (diff < MINUTE) return justNowLabel;

  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    return emptyLabel;
  }

  if (diff < HOUR) {
    return formatter.format(-Math.floor(diff / MINUTE), "minute");
  }
  if (diff < DAY) {
    return formatter.format(-Math.floor(diff / HOUR), "hour");
  }
  return formatter.format(-Math.floor(diff / DAY), "day");
}
