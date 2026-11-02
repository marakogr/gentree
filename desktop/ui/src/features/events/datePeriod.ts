// Date periods for the event form (ADR-0010). A period is a `DateValue` with
// `qualifier = RANGE`: `start` is the inclusive first unit and `end` is the
// exclusive boundary produced by `parseDateInput`, exactly like a single date.
// No bound is invented: both ends must be typed and ordered.

import type { DatePrecision, DateValue, EventType } from "../../api/types";
import {
  dateValueToInput,
  emptyDateValue,
  inclusiveEnd,
  parseDateInput,
} from "../../lib/dates";

/** Event types whose date is naturally a span, not a single point. */
const RANGE_EVENT_TYPES: readonly EventType[] = [
  "RESIDENCE",
  "OCCUPATION",
  "EDUCATION",
];

export function supportsDateRange(type: EventType): boolean {
  return RANGE_EVENT_TYPES.includes(type);
}

export type PeriodInput = { from: string; to: string };

export type PeriodParseResult =
  | { ok: true; value: DateValue }
  | { ok: false; reason: "format" | "incomplete" | "order" };

/**
 * A stored `DateValue` expressed as the two form inputs. Only a real range with
 * both bounds is represented: a single date, an unknown date or a partial
 * legacy range keeps the one-field mode and is never guessed at.
 */
export function periodFromDate(value: DateValue): PeriodInput | null {
  if (
    value.qualifier !== "RANGE" ||
    value.precision === "UNKNOWN" ||
    value.start === null ||
    value.end === null
  ) {
    return null;
  }
  const start = dateValueToInput(value);
  const lastUnit = inclusiveEnd(value.end, value.precision);
  const end = dateValueToInput({ ...value, start: lastUnit, end: null });
  return { from: start, to: end };
}

/**
 * `from`/`to` text -> one `RANGE` date. Both bounds must parse under the chosen
 * precision and the start must not be later than the end. Two blank fields mean
 * "no date" and stay an unknown date, so an optional period is never invented.
 */
export function parsePeriodInput(
  from: string,
  to: string,
  precision: DatePrecision,
): PeriodParseResult {
  const startText = from.trim();
  const endText = to.trim();
  if (startText === "" && endText === "") {
    return { ok: true, value: emptyDateValue() };
  }
  if (startText === "" || endText === "") {
    return { ok: false, reason: "incomplete" };
  }
  if (precision === "UNKNOWN") return { ok: false, reason: "format" };

  const start = parseDateInput(startText, precision, "RANGE");
  const end = parseDateInput(endText, precision, "RANGE");
  if (!start.ok || !end.ok) return { ok: false, reason: "format" };
  if (
    start.value.start === null ||
    end.value.start === null ||
    end.value.end === null
  ) {
    return { ok: false, reason: "format" };
  }
  // ISO civil dates compare correctly as strings.
  if (start.value.start > end.value.start) {
    return { ok: false, reason: "order" };
  }
  return {
    ok: true,
    value: {
      start: start.value.start,
      end: end.value.end,
      precision,
      qualifier: "RANGE",
      original: null,
    },
  };
}
