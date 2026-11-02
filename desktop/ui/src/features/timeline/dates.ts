import type { Translate } from "../../lib/dates";
import type { ApiDate, TimelinePerson } from "./types";

export interface TimelineWindow {
  start: Date;
  end: Date;
}

export interface LifeInterval {
  start: Date;
  /** Exclusive end; null means the person's life is open-ended. */
  end: Date | null;
  openEnd: boolean;
  /** The person is known to be dead, but the death date is unknown. */
  deathUnknown: boolean;
}

/**
 * Projects a UTC API timestamp to a local-midnight `Date` with the same
 * calendar components, so a UTC midnight never shifts the visible day.
 * Accepts both `YYYY-MM-DD` and ISO timestamps.
 *
 * Returns null for missing or malformed values; no date is ever invented.
 */
export function toTimelineDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  // `new Date(year, ...)` treats 0-99 as 1900+year; setFullYear keeps the
  // literal calendar year (including years 1-99).
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * `[birth start, death end)`; only a known death start falls back as the life
 * start. A missing start means the person is undated. A missing death end is an
 * open end, never a fabricated death date.
 */
export function lifeInterval(
  person: Pick<TimelinePerson, "birthDate" | "deathDate" | "deceased">,
): LifeInterval | null {
  const start =
    toTimelineDate(person.birthDate?.start ?? null) ??
    toTimelineDate(person.deathDate?.start ?? null);
  if (start === null) {
    return null;
  }
  const end = toTimelineDate(person.deathDate?.end ?? null);
  if (end !== null) {
    return { start, end, openEnd: false, deathUnknown: false };
  }
  if (person.deceased) {
    const birthEnd = toTimelineDate(person.birthDate?.end ?? null);
    const visibleEnd =
      birthEnd !== null && birthEnd.getTime() > start.getTime()
        ? birthEnd
        : new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end: visibleEnd, openEnd: false, deathUnknown: true };
  }
  return { start, end: null, openEnd: true, deathUnknown: false };
}

export function isOpenEnd(interval: LifeInterval): boolean {
  return interval.end === null;
}

export function lifeMidpoint(interval: LifeInterval): Date {
  const start = interval.start.getTime();
  if (interval.end === null) {
    return new Date(start);
  }
  const end = interval.end.getTime();
  return new Date(start + Math.max(0, end - start) / 2);
}

export function overlapsWindow(
  interval: LifeInterval,
  window: TimelineWindow,
): boolean {
  if (interval.start.getTime() >= window.end.getTime()) {
    return false;
  }
  if (interval.end === null) {
    return true;
  }
  return interval.end.getTime() > window.start.getTime();
}

function startOfYear(year: number): Date {
  return new Date(year, 0, 1);
}

function endOfYear(year: number): Date {
  return new Date(year + 1, 0, 1);
}

/**
 * Fit to the loaded dated persons with a small padding. Open-ended lives force
 * the right edge to include the current year.
 */
export function computeInitialWindow(
  persons: TimelinePerson[],
  now: Date = new Date(),
): TimelineWindow {
  const intervals = persons
    .map((person) => lifeInterval(person))
    .filter((interval): interval is LifeInterval => interval !== null);

  if (intervals.length === 0) {
    const year = now.getFullYear();
    return { start: startOfYear(year - 50), end: endOfYear(year + 50) };
  }

  let minStart = intervals[0]?.start ?? now;
  let maxEnd = minStart;
  let hasOpenEnd = false;

  for (const interval of intervals) {
    if (interval.start.getTime() < minStart.getTime()) {
      minStart = interval.start;
    }
    if (interval.end === null) {
      hasOpenEnd = true;
      continue;
    }
    if (interval.end.getTime() > maxEnd.getTime()) {
      maxEnd = interval.end;
    }
  }

  if (hasOpenEnd) {
    const current = startOfYear(now.getFullYear() + 1);
    if (current.getTime() > maxEnd.getTime()) {
      maxEnd = current;
    }
  }

  const start = startOfYear(minStart.getFullYear() - 2);
  const end = endOfYear(maxEnd.getFullYear() + 2);
  return { start, end };
}

function formatPoint(
  date: Date,
  precision: ApiDate["precision"],
  t: Translate,
): string | null {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  switch (precision) {
    case "DAY":
      return t("date.day", {
        day,
        month: t(`months.genitive.${month + 1}`),
        year,
      });
    case "MONTH":
      return t("date.month", {
        month: t(`months.nominative.${month + 1}`),
        year,
      });
    case "YEAR":
      return String(year);
    case "UNKNOWN":
      return null;
  }
}

/**
 * Human-readable date that keeps precision/qualifier semantics and shows the
 * preserved `original` text when it adds information.
 */
export function formatTimelineDate(
  date: ApiDate | null,
  t: Translate,
  { includeOriginal = true }: { includeOriginal?: boolean } = {},
): string {
  const unknown = t("dateUnknown");
  const original = date?.original?.trim() ?? "";
  if (!date || date.precision === "UNKNOWN") {
    return original.length > 0 ? original : unknown;
  }

  const start = toTimelineDate(date.start);
  const end = toTimelineDate(date.end);
  const formattedStart =
    start === null ? null : formatPoint(start, date.precision, t);
  const formattedEnd = end === null ? null : formatPoint(end, date.precision, t);

  let value: string;
  switch (date.qualifier) {
    case "APPROXIMATE":
      value =
        formattedStart === null
          ? unknown
          : t("date.approximate", { date: formattedStart });
      break;
    case "BEFORE": {
      const boundary = formattedStart ?? formattedEnd;
      value = boundary === null ? unknown : t("date.before", { date: boundary });
      break;
    }
    case "AFTER":
      value =
        formattedStart === null
          ? unknown
          : t("date.after", { date: formattedStart });
      break;
    case "RANGE":
      if (formattedStart !== null && formattedEnd !== null) {
        value =
          formattedStart === formattedEnd
            ? formattedStart
            : t("date.range", {
                from: formattedStart,
                to: formattedEnd,
              });
      } else {
        value = formattedStart ?? formattedEnd ?? unknown;
      }
      break;
    case "UNKNOWN":
      value =
        formattedStart === null
          ? formattedEnd === null
            ? unknown
            : `${formattedEnd}?`
          : `${formattedStart}?`;
      break;
    case "EXACT":
      value = formattedStart ?? unknown;
      break;
  }

  if (includeOriginal && original.length > 0 && original !== value) {
    return `${value} (${original})`;
  }
  return value;
}
