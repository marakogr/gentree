// Civil-date parsing/formatting for DateValue. The wire format is an ISO
// `YYYY-MM-DD` string (CivilDate custom serde); Intl owns rendering, while the
// qualifier and precision decide which template/fields are shown (ADR-0010,
// ADR-0014).

import type {
  CivilDate,
  DatePrecision,
  DateQualifier,
  DateValue,
} from "../api/types";

export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

type Parts = { year: number; month: number; day: number };

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function isoOf(parts: Parts): CivilDate {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

function partsOf(date: CivilDate): Parts | null {
  const match = /^(-?\d{4,})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidParts(date: Parts): boolean {
  if (!Number.isInteger(date.year) || date.year < 1 || date.year > 9999) {
    return false;
  }
  if (!Number.isInteger(date.month) || date.month < 1 || date.month > 12) {
    return false;
  }
  return (
    Number.isInteger(date.day) &&
    date.day >= 1 &&
    date.day <= daysInMonth(date.year, date.month)
  );
}

/** Sortable integer key; also used by list filters. */
export function civilDateKey(date: CivilDate): number {
  const parts = partsOf(date);
  if (!parts) return 0;
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

/** Validates an ISO date and returns it in canonical zero-padded form. */
export function parseCivilDate(value: string): CivilDate | null {
  const parts = partsOf(value);
  return parts && isValidParts(parts) ? isoOf(parts) : null;
}

function toUtcDate(parts: Parts): Date {
  // `Date.UTC` maps years 0..99 to 1900..1999, so set the year explicitly.
  const date = new Date(Date.UTC(2000, parts.month - 1, parts.day));
  date.setUTCFullYear(parts.year);
  return date;
}

function fromUtcDate(date: Date): CivilDate {
  return isoOf({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

/** End-exclusive bound `[start, end)` for a precision. */
function nextBoundary(start: CivilDate, precision: DatePrecision): CivilDate {
  const parts = partsOf(start) ?? { year: 1, month: 1, day: 1 };
  if (precision === "YEAR") {
    return isoOf({ year: parts.year + 1, month: 1, day: 1 });
  }
  if (precision === "MONTH") {
    return parts.month === 12
      ? isoOf({ year: parts.year + 1, month: 1, day: 1 })
      : isoOf({ year: parts.year, month: parts.month + 1, day: 1 });
  }
  const next = toUtcDate(parts);
  next.setUTCDate(next.getUTCDate() + 1);
  return fromUtcDate(next);
}

/**
 * Turns the exclusive `end` of a range back into the last visible unit.
 * Shared with the timeline adapter, which speaks the same civil dates.
 */
export function inclusiveEnd(
  end: CivilDate,
  precision: DatePrecision,
): CivilDate {
  const parts = partsOf(end) ?? { year: 1, month: 1, day: 1 };
  if (precision === "YEAR") {
    return isoOf({ year: Math.max(1, parts.year - 1), month: 1, day: 1 });
  }
  if (precision === "MONTH") {
    if (parts.day !== 1) return isoOf(parts);
    const previous = new Date(Date.UTC(2000, parts.month - 2, 1));
    previous.setUTCFullYear(parts.month === 1 ? parts.year - 1 : parts.year);
    return fromUtcDate(previous);
  }
  const previous = toUtcDate(parts);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return fromUtcDate(previous);
}

export function formatCivilDate(
  date: CivilDate,
  precision: DatePrecision,
  locale: string,
): string {
  const parts = partsOf(date);
  if (!parts) return date;
  const options: Intl.DateTimeFormatOptions =
    precision === "YEAR"
      ? { year: "numeric" }
      : precision === "MONTH"
        ? { year: "numeric", month: "long" }
        : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: "UTC",
  }).format(toUtcDate(parts));
}

/**
 * Formats one `DateValue`. `UNKNOWN` never invents a day: the original text is
 * shown when present, otherwise the dictionary label.
 */
export function formatDateValue(
  value: DateValue,
  locale: string,
  t: Translate,
): string {
  const unknown = value.original?.trim();
  if (value.precision === "UNKNOWN" || (!value.start && !value.end)) {
    return unknown ? unknown : t("date.unknown");
  }

  const format = (date: CivilDate) =>
    formatCivilDate(date, value.precision, locale);

  switch (value.qualifier) {
    case "BEFORE": {
      const bound = value.end ?? value.start;
      return bound ? t("date.before", { date: format(bound) }) : t("date.unknown");
    }
    case "AFTER": {
      const bound = value.start ?? value.end;
      return bound ? t("date.after", { date: format(bound) }) : t("date.unknown");
    }
    case "RANGE": {
      const from = value.start;
      const to = value.end;
      if (from && !to) {
        return t("date.rangeOpen", { from: format(from) });
      }
      if (!from || !to) {
        const single = from ?? to;
        return single ? format(single) : t("date.unknown");
      }
      return t("date.range", {
        from: format(from),
        to: format(inclusiveEnd(to, value.precision)),
      });
    }
    case "APPROXIMATE": {
      const date = value.start ?? value.end;
      return date
        ? t("date.approximate", { date: format(date) })
        : t("date.unknown");
    }
    default: {
      const date = value.start ?? value.end;
      return date ? format(date) : t("date.unknown");
    }
  }
}

export type ParsedDateInput =
  | { ok: true; value: DateValue }
  | { ok: false; reason: "format" };

/** Parses a form input according to the chosen precision (ADR-0010). */
export function parseDateInput(
  raw: string,
  precision: DatePrecision,
  qualifier: DateQualifier = "EXACT",
): ParsedDateInput {
  const text = raw.trim();
  if (precision === "UNKNOWN") {
    return {
      ok: true,
      value: {
        start: null,
        end: null,
        precision: "UNKNOWN",
        qualifier: "UNKNOWN",
        original: text === "" ? null : text,
      },
    };
  }

  const pattern =
    precision === "YEAR"
      ? /^(\d{1,4})$/
      : precision === "MONTH"
        ? /^(\d{1,4})-(\d{1,2})$/
        : /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/;
  const match = pattern.exec(text);
  if (!match) return { ok: false, reason: "format" };

  const parts: Parts = {
    year: Number(match[1]),
    month: precision === "YEAR" ? 1 : Number(match[2]),
    day: precision === "DAY" ? Number(match[3]) : 1,
  };
  if (!isValidParts(parts)) return { ok: false, reason: "format" };

  const start = isoOf(parts);
  return {
    ok: true,
    value: {
      start,
      end: nextBoundary(start, precision),
      precision,
      qualifier: qualifier === "UNKNOWN" ? "EXACT" : qualifier,
      original: null,
    },
  };
}

/**
 * Parses text typed directly into a date field. Accepts the canonical shape for
 * the precision (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) and the dotted day form
 * (`DD.MM.YYYY`, DAY only); returns the canonical value or `null` when the text
 * is incomplete or the date does not exist. `null` means "leave the committed
 * value alone": no timestamp is invented for partial input.
 */
export function parseManualDateInput(
  raw: string,
  precision: DatePrecision,
): string | null {
  if (precision === "UNKNOWN") return null;
  const text = raw.trim();
  if (text === "") return null;

  let parts: Parts | null = null;
  if (precision === "DAY") {
    const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{1,4})$/.exec(text);
    if (dotted) {
      parts = {
        year: Number(dotted[3]),
        month: Number(dotted[2]),
        day: Number(dotted[1]),
      };
    } else {
      const iso = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(text);
      if (iso) {
        parts = {
          year: Number(iso[1]),
          month: Number(iso[2]),
          day: Number(iso[3]),
        };
      }
    }
  } else if (precision === "MONTH") {
    const match = /^(\d{1,4})-(\d{1,2})$/.exec(text);
    if (match) {
      parts = { year: Number(match[1]), month: Number(match[2]), day: 1 };
    }
  } else {
    const match = /^(\d{1,4})$/.exec(text);
    if (match) parts = { year: Number(match[1]), month: 1, day: 1 };
  }

  if (!parts || !isValidParts(parts)) return null;
  const iso = isoOf(parts);
  if (precision === "YEAR") return iso.slice(0, 4);
  if (precision === "MONTH") return iso.slice(0, 7);
  return iso;
}

/**
 * Formats a date while it is being typed: separators are inserted for the
 * user, so `19800512` becomes `1980-05-12` (and `198005` becomes `1980-05`).
 * A dotted day entry (`12.05.1980`) is left alone: `parseManualDateInput`
 * already understands it and regrouping the digits mid-word would reorder it.
 */
export function formatDateTyping(
  raw: string,
  precision: DatePrecision,
): string {
  if (precision === "UNKNOWN") return raw;
  if (/[./]/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return "";
  const max = precision === "YEAR" ? 4 : precision === "MONTH" ? 6 : 8;
  const cut = digits.slice(0, max);
  if (precision === "YEAR") return cut;
  const year = cut.slice(0, 4);
  if (cut.length <= 4) return year;
  const month = cut.slice(4, 6);
  if (precision === "MONTH" || cut.length <= 6) return `${year}-${month}`;
  return `${year}-${month}-${cut.slice(6, 8)}`;
}

/** Value shown in the edit form for the current precision. */
export function dateValueToInput(value: DateValue): string {
  const start = value.start;
  if (value.precision === "UNKNOWN" || !start) {
    return value.original ?? "";
  }
  if (value.precision === "YEAR") return start.slice(0, 4);
  if (value.precision === "MONTH") return start.slice(0, 7);
  return start.slice(0, 10);
}

export function emptyDateValue(): DateValue {
  return {
    start: null,
    end: null,
    precision: "UNKNOWN",
    qualifier: "UNKNOWN",
    original: null,
  };
}
