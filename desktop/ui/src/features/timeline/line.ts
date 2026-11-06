import type { Gender } from "../../api/types";
import type { Translate } from "../../lib/dates";
import { toTimelineDate, type TimelineWindow } from "./dates";
import { eventTypeLabel } from "./format";
import { mainParticipants } from "./mainParticipant";
import type { ApiDate, TimelineEvent, TimelineParticipant } from "./types";

/** Icon family for a marker; the page maps it to a lucide component. */
export type LineIconKind = "birth" | "marriage" | "death" | "other";

/**
 * Unknown event types fall back to a generic "page" icon, never to an empty or
 * invented glyph.
 */
export function lineIconKind(type: string): LineIconKind {
  if (type === "BIRT" || type === "BIRTH" || type === "BAPTISM" || type === "BAPM") {
    return "birth";
  }
  if (type === "MARR" || type === "MARRIAGE") {
    return "marriage";
  }
  if (type === "DEAT" || type === "DEATH" || type === "BURIAL" || type === "BURI") {
    return "death";
  }
  return "other";
}

/**
 * Exact vs approximate distinction. Only an explicit `EXACT` qualifier is
 * exact; approximate/before/after/unknown and a missing date are all rendered
 * as approximate so the marker never claims more certainty than the data
 * holds. A `RANGE` is exact only inside its stated boundaries and gets its own
 * visual kind.
 */
export type LineDateKind = "exact" | "approximate" | "range";

export function lineDateKind(date: ApiDate | null): LineDateKind {
  if (date === null) {
    return "approximate";
  }
  if (date.qualifier === "RANGE") {
    return "range";
  }
  return date.qualifier === "EXACT" ? "exact" : "approximate";
}

export type LinePrecision = "day" | "month" | "year" | "unknown";

export function linePrecision(date: ApiDate | null): LinePrecision {
  switch (date?.precision) {
    case "DAY":
      return "day";
    case "MONTH":
      return "month";
    case "YEAR":
      return "year";
    default:
      return "unknown";
  }
}

function shortMonth(month: number, t: Translate): string {
  return t(`months.short.${month + 1}`);
}

function startOfYear(year: number): Date {
  const date = new Date(0);
  date.setFullYear(year, 0, 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfYear(year: number): Date {
  return startOfYear(year + 1);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function formatPoint(date: Date, precision: LinePrecision, t: Translate): string {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  switch (precision) {
    case "day":
      return t("date.day", { day, month: shortMonth(month, t), year });
    case "month":
      return t("date.shortMonth", { month: shortMonth(month, t), year });
    case "year":
      return String(year);
    case "unknown":
      return "";
  }
}

/**
 * Human-readable line date: "25 Jan 1938", "Jan 1938", "1938", "~1912",
 * "1910-1915". It never prints an ISO timestamp. The precision still decides
 * whether a day, month or only a year is shown.
 */
export function formatLineDate(date: ApiDate | null, t: Translate): string {
  const unknown = t("dateUnknown");
  if (date === null) {
    return unknown;
  }
  const precision = linePrecision(date);
  const start = toTimelineDate(date.start);
  const end = toTimelineDate(date.end);
  if (precision === "unknown" || start === null) {
    const original = date.original?.trim() ?? "";
    return original.length > 0 ? original : unknown;
  }

  const startText = formatPoint(start, precision, t);
  const endText = end === null ? "" : formatPoint(end, precision, t);
  const rangeText =
    endText.length > 0 && endText !== startText
      ? `${startText}–${endText}`
      : startText;

  switch (date.qualifier) {
    case "APPROXIMATE":
      return t("dateApproximate", { date: rangeText });
    case "BEFORE": {
      const boundary = endText.length > 0 ? endText : startText;
      return t("dateBefore", { date: boundary });
    }
    case "AFTER":
      return t("dateAfter", { date: startText });
    case "RANGE":
      return rangeText;
    case "UNKNOWN":
      return `${rangeText}?`;
    case "EXACT":
    default:
      return rangeText;
  }
}

/**
 * Visual interval for month/year/range precision. Positions always use
 * `date.start`; the interval only communicates how wide the known period is.
 */
export function lineIntervalEnd(
  date: ApiDate | null,
  start: Date,
): Date | null {
  if (date === null) {
    return null;
  }
  const end = toTimelineDate(date.end);
  if (end !== null && end.getTime() > start.getTime()) {
    return end;
  }
  switch (date.precision) {
    case "DAY":
      return addDays(start, 1);
    case "MONTH":
      return addMonths(start, 1);
    case "YEAR":
      return endOfYear(start.getFullYear());
    default:
      return null;
  }
}

export interface LineMarker {
  event: TimelineEvent;
  /** Marker position: the event's `date.start`, or the event is skipped. */
  time: Date;
  /** Visual interval end for month/year/range/approximate precision. */
  end: Date | null;
  icon: LineIconKind;
  dateKind: LineDateKind;
  precision: LinePrecision;
  label: string;
  mainParticipant: TimelineParticipant | null;
  /** Subject gender; drives the birth marker glyph and colour. */
  gender: Gender;
}

/** Stable unique events by id, keeping API order. */
export function dedupeEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const result: TimelineEvent[] = [];
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      result.push(event);
    }
  }
  return result;
}

/**
 * Partitions the two API arrays without ever putting one event in both. The
 * dated array is authoritative: an event whose `date.start` cannot be parsed
 * is moved to the undated list instead of disappearing from both counters.
 */
export function partitionLineEvents(
  dated: readonly TimelineEvent[],
  undated: readonly TimelineEvent[],
): { dated: TimelineEvent[]; undated: TimelineEvent[] } {
  const seen = new Set<string>();
  const datedEvents: TimelineEvent[] = [];
  const undatedEvents: TimelineEvent[] = [];

  for (const event of dated) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    if (toTimelineDate(event.date?.start ?? null) === null) {
      undatedEvents.push(event);
    } else {
      datedEvents.push(event);
    }
  }
  for (const event of undated) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    undatedEvents.push(event);
  }

  return { dated: datedEvents, undated: undatedEvents };
}

/**
 * One marker per dated event, positioned at `date.start`. Undated events and
 * events without a parsable start are skipped - no position is invented - and
 * duplicate ids are collapsed. Markers are ordered by time, then id.
 */
export function buildLineMarkers(
  events: readonly TimelineEvent[],
  t: Translate,
): LineMarker[] {
  const seen = new Set<string>();
  const markers: LineMarker[] = [];
  for (const event of events) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    const time = toTimelineDate(event.date?.start ?? null);
    if (time === null) {
      continue;
    }
    const main = mainParticipants(event);
    markers.push({
      event,
      time,
      end: lineIntervalEnd(event.date, time),
      icon: lineIconKind(event.type),
      dateKind: lineDateKind(event.date),
      precision: linePrecision(event.date),
      label: formatLineDate(event.date, t),
      mainParticipant: main[0] ?? null,
      gender:
        main[0]?.gender ??
        event.participants.find((participant) => participant.gender)?.gender ??
        "UNKNOWN",
    });
  }
  return markers.sort((a, b) => {
    const byTime = a.time.getTime() - b.time.getTime();
    return byTime !== 0 ? byTime : a.event.id.localeCompare(b.event.id);
  });
}

/** Fraction in `[0, 1]` for a time inside the window, or null when outside. */
export function positionOnLine(
  time: Date,
  window: TimelineWindow,
): number | null {
  const start = window.start.getTime();
  const end = window.end.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const value = time.getTime();
  if (!Number.isFinite(value) || value < start || value > end) {
    return null;
  }
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
}

/**
 * Edge padding of the initial fit window, as a fraction of the data span.
 * It gives the first and last markers breathing room; it is not a navigation
 * limit, so panning may move the window further as long as events stay visible.
 */
export const LINE_EDGE_PADDING = 0.1;

/**
 * Fallback span of the initial fit window when the data has no measurable span
 * (a single marker without a known interval), so the axis never collapses onto
 * a point.
 */
export const LINE_EMPTY_DATA_SPAN = 2 * 366 * 24 * 3600_000;

const DAY_MS = 24 * 3600_000;

/**
 * First marker start and last known marker end, used by the initial fit so a
 * long period is fully visible. Only marker starts render markers, so this is
 * not the navigation reference.
 */
function markerBounds(
  markers: readonly LineMarker[],
): { min: number; max: number } | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const marker of markers) {
    const start = marker.time.getTime();
    if (!Number.isFinite(start)) {
      continue;
    }
    const end = marker.end?.getTime() ?? start;
    min = min === null ? start : Math.min(min, start);
    max = max === null ? end : Math.max(max, end);
  }
  if (min === null || max === null) {
    return null;
  }
  return { min, max };
}

/** First and last marker start times; null when none is usable. */
function markerStartBounds(
  markers: readonly LineMarker[],
): { min: number; max: number } | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const marker of markers) {
    const start = marker.time.getTime();
    if (!Number.isFinite(start)) {
      continue;
    }
    min = min === null ? start : Math.min(min, start);
    max = max === null ? start : Math.max(max, start);
  }
  if (min === null || max === null) {
    return null;
  }
  return { min, max };
}

/**
 * Navigable range of the loaded markers: the earliest to the latest marker
 * start, the positions that actually render a marker. Interval ends are left
 * out so a long period cannot leave a window that overlaps only its tail while
 * no marker is visible. Returns null when no marker carries a usable date, so
 * the empty state never shows an arbitrary range.
 */
export function markerDomain(
  markers: readonly LineMarker[],
): TimelineWindow | null {
  const bounds = markerStartBounds(markers);
  if (bounds === null) {
    return null;
  }
  const { min, max } = bounds;
  // A single start has no extent; keep a non-empty reference range.
  return {
    start: new Date(min),
    end: new Date(max > min ? max : min + DAY_MS),
  };
}

/**
 * Stop a window that has lost all contact with the markers at the nearest edge
 * where at least one marker start stays in view. A window that still overlaps
 * the marker starts is returned unchanged, however empty the rest of it looks:
 * the single navigation rule is that at least one marker start remains visible.
 */
function clampToEventOverlap(
  window: TimelineWindow,
  domain: TimelineWindow | null,
): TimelineWindow {
  if (domain === null) {
    return window;
  }
  const domainStart = domain.start.getTime();
  const domainEnd = domain.end.getTime();
  if (
    !Number.isFinite(domainStart) ||
    !Number.isFinite(domainEnd) ||
    domainEnd <= domainStart
  ) {
    return window;
  }
  const start = window.start.getTime();
  const end = window.end.getTime();
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) {
    return window;
  }
  const overlap = Math.min(span, DAY_MS);
  if (end <= domainStart) {
    // Entirely before the first event: slide right until its start enters.
    const shift = domainStart + overlap - end;
    return {
      start: new Date(start + shift),
      end: new Date(end + shift),
    };
  }
  if (start >= domainEnd) {
    // Entirely after the last event: slide left until its end enters.
    const shift = start - (domainEnd - overlap);
    return {
      start: new Date(start - shift),
      end: new Date(end - shift),
    };
  }
  return window;
}

/**
 * Initial window covering all loaded dated events plus the edge padding. The
 * padding is only the starting view: navigation may move the window further,
 * as long as it keeps overlapping the events.
 */
export function computeLineWindow(
  events: readonly TimelineEvent[],
  t: Translate,
  paddingFraction = LINE_EDGE_PADDING,
): TimelineWindow | null {
  return computeMarkerWindow(buildLineMarkers(events, t), paddingFraction);
}

/** Same rule as `computeLineWindow`, over already built markers. */
export function computeMarkerWindow(
  markers: readonly LineMarker[],
  paddingFraction = LINE_EDGE_PADDING,
): TimelineWindow | null {
  const bounds = markerBounds(markers);
  if (bounds === null) {
    return null;
  }
  const { min, max } = bounds;
  const span = Math.max(max - min, 0);
  if (span <= 0) {
    // No measurable interval: centre the fallback span on the only marker.
    const half = LINE_EMPTY_DATA_SPAN / 2;
    return { start: new Date(min - half), end: new Date(min + half) };
  }
  const fraction = Number.isFinite(paddingFraction)
    ? clamp(paddingFraction, 0, 0.25)
    : LINE_EDGE_PADDING;
  const padding = span * fraction;
  return { start: new Date(min - padding), end: new Date(max + padding) };
}

/** Window around the events of one person; null when the person has none. */
export function computePersonWindow(
  markers: readonly LineMarker[],
  personId: string | null,
): TimelineWindow | null {
  if (personId === null) {
    return null;
  }
  const personMarkers = markers.filter((marker) =>
    marker.event.participants.some(
      (participant) => participant.personId === personId,
    ),
  );
  return computeMarkerWindow(personMarkers);
}

/** Shift the window by a fraction of its own span (positive = later). */
export function panWindow(
  window: TimelineWindow,
  deltaFraction: number,
  domain: TimelineWindow | null = null,
): TimelineWindow {
  const span = window.end.getTime() - window.start.getTime();
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(deltaFraction)) {
    return window;
  }
  const delta = span * deltaFraction;
  return clampWindow(
    {
      start: new Date(window.start.getTime() + delta),
      end: new Date(window.end.getTime() + delta),
    },
    domain,
  );
}

/**
 * Keep the span between one day and 5000 years and, when a `domain` is given,
 * keep the window overlapping the events: panning and zooming stop as soon as
 * no event would stay in view. A window that already overlaps is returned
 * unchanged, even if most of it lies outside the data. No negative/NaN windows.
 */
export function clampWindow(
  window: TimelineWindow,
  domain: TimelineWindow | null = null,
): TimelineWindow {
  const start = window.start.getTime();
  const end = window.end.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return window;
  }
  const minSpan = DAY_MS;
  const maxSpan = 5000 * 366 * DAY_MS;
  const span = end - start;
  let next = window;
  if (span < minSpan) {
    const middle = start + span / 2;
    next = {
      start: new Date(middle - minSpan / 2),
      end: new Date(middle + minSpan / 2),
    };
  } else if (span > maxSpan) {
    const middle = start + span / 2;
    next = {
      start: new Date(middle - maxSpan / 2),
      end: new Date(middle + maxSpan / 2),
    };
  }
  return clampToEventOverlap(next, domain);
}

/** Zoom by `factor` around a fraction along the window (0 = left, 1 = right). */
export function zoomWindow(
  window: TimelineWindow,
  factor: number,
  anchorFraction = 0.5,
  domain: TimelineWindow | null = null,
): TimelineWindow {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const span = end - start;
  if (
    !Number.isFinite(span) ||
    span <= 0 ||
    !Number.isFinite(factor) ||
    factor <= 0
  ) {
    return window;
  }
  const clamped = Math.min(1, Math.max(0, anchorFraction));
  const anchor = start + span * clamped;
  const nextSpan = span * factor;
  const nextStart = anchor - nextSpan * clamped;
  return clampWindow(
    {
      start: new Date(nextStart),
      end: new Date(nextStart + nextSpan),
    },
    domain,
  );
}

/** Brush window from two fractions of the full range, minimum 2% wide. */
export function brushWindow(
  window: TimelineWindow,
  fromFraction: number,
  toFraction: number,
): TimelineWindow {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) {
    return window;
  }
  let from = clamp(Math.min(fromFraction, toFraction), 0, 1);
  let to = clamp(Math.max(fromFraction, toFraction), 0, 1);
  if (to - from < 0.02) {
    const middle = (from + to) / 2;
    from = clamp(middle - 0.01, 0, 0.98);
    to = from + 0.02;
  }
  return {
    start: new Date(start + span * from),
    end: new Date(start + span * to),
  };
}

/**
 * Other events sharing at least one participant with the selected event. This
 * is the line view's "participant highlight": the events a person also appears
 * in are the visible link.
 */
export function relatedEventIds(
  events: readonly TimelineEvent[],
  selectedId: string | null,
): Set<string> {
  if (selectedId === null) {
    return new Set();
  }
  const selected = events.find((event) => event.id === selectedId);
  if (selected === undefined) {
    return new Set();
  }
  const participantIds = new Set(
    selected.participants.map((participant) => participant.personId),
  );
  const related = new Set<string>();
  for (const event of events) {
    if (event.id === selectedId) {
      continue;
    }
    if (event.participants.some((p) => participantIds.has(p.personId))) {
      related.add(event.id);
    }
  }
  return related;
}

/** Events of the current person. */
export function personEventIds(
  events: readonly TimelineEvent[],
  personId: string | null,
): Set<string> {
  if (personId === null) {
    return new Set();
  }
  return new Set(
    events
      .filter((event) =>
        event.participants.some(
          (participant) => participant.personId === personId,
        ),
      )
      .map((event) => event.id),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Axis ticks
// ---------------------------------------------------------------------------

export type LineTickUnit = "year" | "month" | "day";

export interface LineTick {
  time: Date;
  label: string;
  unit: LineTickUnit;
  major: boolean;
}

interface TickCandidate {
  unit: LineTickUnit;
  step: number;
}

const TICK_CANDIDATES: TickCandidate[] = [
  { unit: "year", step: 1000 },
  { unit: "year", step: 500 },
  { unit: "year", step: 200 },
  { unit: "year", step: 100 },
  { unit: "year", step: 50 },
  { unit: "year", step: 25 },
  { unit: "year", step: 10 },
  { unit: "year", step: 5 },
  { unit: "year", step: 2 },
  { unit: "year", step: 1 },
  { unit: "month", step: 6 },
  { unit: "month", step: 3 },
  { unit: "month", step: 1 },
  { unit: "day", step: 14 },
  { unit: "day", step: 7 },
  { unit: "day", step: 1 },
];

function candidatePixels(candidate: TickCandidate, pxPerMs: number): number {
  if (candidate.unit === "year") {
    return candidate.step * 366 * 24 * 3600_000 * pxPerMs;
  }
  if (candidate.unit === "month") {
    return candidate.step * 30.5 * 24 * 3600_000 * pxPerMs;
  }
  return candidate.step * 24 * 3600_000 * pxPerMs;
}

function tickLabel(
  time: Date,
  unit: LineTickUnit,
  major: boolean,
  t: Translate,
): string {
  if (unit === "year") {
    return String(time.getFullYear());
  }
  if (unit === "month") {
    return major
      ? t("date.shortMonth", {
          month: shortMonth(time.getMonth(), t),
          year: time.getFullYear(),
        })
      : shortMonth(time.getMonth(), t);
  }
  return t("date.dayShort", {
    day: time.getDate(),
    month: shortMonth(time.getMonth(), t),
  });
}

/**
 * Adaptive time axis. Decades/centuries on a wide range, years on a medium one
 * and months/days when zoomed in. The chosen step is the smallest one whose
 * labels stay at least `minGapPx` apart, so year labels never collide.
 */
export function buildAxisTicks(
  window: TimelineWindow,
  widthPx: number,
  t: Translate,
  minGapPx = 58,
): LineTick[] {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const width = Math.max(1, widthPx);
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) {
    return [];
  }
  const pxPerMs = width / span;
  const minGap =
    span / width > 365 * 24 * 3600_000 ? minGapPx : Math.max(minGapPx, 66);
  // Candidates are ordered from the coarsest to the finest step. Pick the
  // finest step whose labels still have `minGap` pixels between them.
  let candidate = TICK_CANDIDATES[TICK_CANDIDATES.length - 1] as TickCandidate;
  for (let index = TICK_CANDIDATES.length - 1; index >= 0; index -= 1) {
    const value = TICK_CANDIDATES[index];
    if (value !== undefined && candidatePixels(value, pxPerMs) >= minGap) {
      candidate = value;
      break;
    }
  }

  const ticks: LineTick[] = [];
  if (candidate.unit === "year") {
    const startYear = window.start.getFullYear();
    const endYear = window.end.getFullYear();
    const firstYear = Math.ceil(startYear / candidate.step) * candidate.step;
    for (let year = firstYear; year <= endYear; year += candidate.step) {
      const time = startOfYear(year);
      if (time.getTime() < start || time.getTime() > end) {
        continue;
      }
      const major =
        candidate.step >= 10
          ? year % candidate.step === 0
          : year % 10 === 0;
      ticks.push({
        time,
        label: tickLabel(time, "year", major, t),
        unit: "year",
        major,
      });
    }
  } else if (candidate.unit === "month") {
    const cursor = new Date(window.start.getTime());
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getMonth() % candidate.step !== 0) {
      cursor.setMonth(cursor.getMonth() + 1);
    }
    while (cursor.getTime() <= end) {
      if (cursor.getTime() >= start) {
        const major = cursor.getMonth() === 0;
        ticks.push({
          time: new Date(cursor.getTime()),
          label: tickLabel(cursor, "month", major, t),
          unit: "month",
          major,
        });
      }
      cursor.setMonth(cursor.getMonth() + candidate.step);
    }
  } else {
    const cursor = new Date(window.start.getTime());
    cursor.setHours(0, 0, 0, 0);
    // Anchor day ticks on whole steps from the epoch day to keep them stable.
    const epochDay = Math.floor(cursor.getTime() / (24 * 3600_000));
    const firstDay = Math.ceil(epochDay / candidate.step) * candidate.step;
    cursor.setTime(firstDay * 24 * 3600_000);
    while (cursor.getTime() <= end) {
      if (cursor.getTime() >= start) {
        ticks.push({
          time: new Date(cursor.getTime()),
          label: tickLabel(cursor, "day", false, t),
          unit: "day",
          major: false,
        });
      }
      cursor.setDate(cursor.getDate() + candidate.step);
    }
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Density curve and clustering
// ---------------------------------------------------------------------------

export interface LineDensityBin {
  index: number;
  start: Date;
  end: Date;
  count: number;
  /** Count divided by the busiest bin, in `[0, 1]`. */
  weight: number;
}

/** Aggregates markers into equal time bins for the density/minimap curve. */
export function buildDensityBins(
  markers: readonly LineMarker[],
  window: TimelineWindow,
  binCount = 64,
): LineDensityBin[] {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const count = Math.max(1, Math.floor(binCount));
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) {
    return [];
  }
  const buckets = new Array<number>(count).fill(0);
  for (const marker of markers) {
    const value = marker.time.getTime();
    if (!Number.isFinite(value) || value < start || value > end) {
      continue;
    }
    const index = Math.min(
      count - 1,
      Math.max(0, Math.floor(((value - start) / span) * count)),
    );
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  const max = Math.max(1, ...buckets);
  return buckets.map((bucket, index) => ({
    index,
    start: new Date(start + (span * index) / count),
    end: new Date(start + (span * (index + 1)) / count),
    count: bucket,
    weight: bucket / max,
  }));
}

export interface LineCluster {
  /** Stable key derived from member ids; safe for React keys. */
  id: string;
  markers: LineMarker[];
  count: number;
  from: Date;
  to: Date;
  fraction: number;
  icon: LineIconKind;
  dateKind: LineDateKind;
}

const ICON_PRIORITY: Record<LineIconKind, number> = {
  birth: 4,
  marriage: 3,
  death: 2,
  other: 1,
};

/**
 * Greedy pixel clustering. Markers closer than `thresholdPx` share a cluster;
 * the component renders "+N" and expands the list on click. `isolateId` keeps
 * a selected/deep-linked event as its own marker so its panel is reachable.
 */
export function clusterLineMarkers(
  markers: readonly LineMarker[],
  window: TimelineWindow,
  widthPx: number,
  { thresholdPx = 16, isolateId = null }: {
    thresholdPx?: number;
    isolateId?: string | null;
  } = {},
): LineCluster[] {
  const width = Math.max(1, widthPx);
  const positioned = markers
    .map((marker) => ({
      marker,
      fraction: positionOnLine(marker.time, window),
    }))
    .filter(
      (entry): entry is { marker: LineMarker; fraction: number } =>
        entry.fraction !== null,
    )
    .sort((a, b) => {
      if (a.fraction !== b.fraction) {
        return a.fraction - b.fraction;
      }
      return a.marker.event.id.localeCompare(b.marker.event.id);
    });

  const groups: { marker: LineMarker; fraction: number }[][] = [];
  for (const entry of positioned) {
    const isolated = isolateId !== null && entry.marker.event.id === isolateId;
    const current = groups[groups.length - 1];
    const last = current?.[current.length - 1];
    if (
      !isolated &&
      current !== undefined &&
      last !== undefined &&
      (entry.fraction - last.fraction) * width < thresholdPx &&
      !(isolateId !== null && last.marker.event.id === isolateId)
    ) {
      current.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  return groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error("empty cluster");
    }
    const fraction =
      group.reduce((sum, entry) => sum + entry.fraction, 0) / group.length;
    const icon = group.reduce<LineIconKind>((best, entry) => {
      return ICON_PRIORITY[entry.marker.icon] > ICON_PRIORITY[best]
        ? entry.marker.icon
        : best;
    }, "other");
    const dateKind = group.some((entry) => entry.marker.dateKind !== "exact")
      ? "approximate"
      : "exact";
    return {
      id: group.map((entry) => entry.marker.event.id).join("|"),
      markers: group.map((entry) => entry.marker),
      count: group.length,
      from: first.marker.time,
      to: last.marker.time,
      fraction,
      icon,
      dateKind,
    };
  });
}

// ---------------------------------------------------------------------------
// Label layout
// ---------------------------------------------------------------------------

export type LineLabelSide = "top" | "bottom";

export interface LineLabelLeader {
  /** Marker point on the axis. */
  x: number;
  y: number;
  /** Elbow between the marker and the label box. */
  midX: number;
  midY: number;
  /** Anchor on the label box edge. */
  endX: number;
  endY: number;
}

export interface LineLabel {
  clusterId: string;
  eventId: string | null;
  side: LineLabelSide;
  /** Box in canvas coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  date: string;
  /** Text was shortened with an ellipsis; the full text is in `fullTitle`. */
  truncated: boolean;
  fullTitle: string;
  priority: number;
  leader: LineLabelLeader;
}

export interface LabelCandidate {
  cluster: LineCluster;
  priority: number;
  title: string;
  date: string;
}

export interface LabelLayoutOptions {
  /** Axis position; labels are placed above/below it. */
  axisY: number;
  /** Canvas height; used to keep labels away from the density strip. */
  height?: number;
  /** Space reserved for the legend at the top. */
  topInset?: number;
  /** Space reserved for the density strip at the bottom. */
  bottomInset?: number;
  /**
   * Height of the axis tick labels drawn under the axis line. Bottom labels
   * start below this band, so the date axis stays readable.
   */
  axisLabelHeight?: number;
  /** Maximum label rows per side. */
  maxRows?: number;
  /** Width reserved for the whole label box. */
  maxWidth?: number;
  /** Horizontal margin at the canvas edges. */
  marginX?: number;
  /** Translation function for cluster titles. */
  t: Translate;
}

function estimateTextWidth(text: string, fontSizePx = 11): number {
  // A deterministic approximation is enough for avoiding collisions and keeps
  // the layout testable without a canvas. It errs on the wide side.
  let width = 0;
  for (const char of text) {
    if (char === " ") {
      width += fontSizePx * 0.32;
    } else if (/\p{Lu}/u.test(char)) {
      width += fontSizePx * 0.68;
    } else if (/[\p{Ll}\p{Nd}]/u.test(char)) {
      width += fontSizePx * 0.56;
    } else {
      width += fontSizePx * 0.4;
    }
  }
  return width;
}

function defaultLabelTitle(cluster: LineCluster, t: Translate): string {
  if (cluster.count > 1) {
    return t("clusterCount", { count: cluster.count });
  }
  const marker = cluster.markers[0];
  if (marker === undefined) {
    return t("eventFallback");
  }
  const type = eventTypeLabel(marker.event.type, t);
  const name =
    marker.mainParticipant === null
      ? ""
      : [marker.mainParticipant.firstName, marker.mainParticipant.lastName]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(" ");
  return name.length > 0 ? `${type} — ${name}` : type;
}

/** Priority for label placement: selected -> root -> key types. */
export function labelPriority(
  marker: LineMarker,
  selectedEventId: string | null,
  rootPersonId: string | null,
  focusPersonId: string | null,
  clusterCount = 1,
): number {
  if (selectedEventId !== null && marker.event.id === selectedEventId) {
    return 10_000;
  }
  const participantIds = marker.event.participants.map((p) => p.personId);
  if (rootPersonId !== null && participantIds.includes(rootPersonId)) {
    return 8_000 + ICON_PRIORITY[marker.icon];
  }
  if (focusPersonId !== null && participantIds.includes(focusPersonId)) {
    return 7_000 + ICON_PRIORITY[marker.icon];
  }
  return ICON_PRIORITY[marker.icon] * 100 + Math.min(90, clusterCount);
}

/**
 * Places labels on both sides of the axis without intersections. A candidate
 * that cannot fit in the available rows is dropped rather than overlapping a
 * neighbour; the selected event and root person are considered first.
 */
export function layoutLineLabels(
  clusters: readonly LineCluster[],
  widthPx: number,
  options: LabelLayoutOptions & {
    selectedEventId?: string | null;
    rootPersonId?: string | null;
    focusPersonId?: string | null;
  },
): LineLabel[] {
  const width = Math.max(1, widthPx);
  const axisY = options.axisY;
  const maxRows = options.maxRows ?? 3;
  const marginX = options.marginX ?? 8;
  const topInset = options.topInset ?? 0;
  const bottomInset = options.bottomInset ?? 0;
  const axisLabelHeight = options.axisLabelHeight ?? 0;
  const canvasHeight = options.height ?? axisY * 2;
  const maxWidth = Math.min(options.maxWidth ?? 240, width - marginX * 2);
  const gap = 18;

  const candidates: LabelCandidate[] = clusters.map((cluster) => {
    const priority = Math.max(
      ...cluster.markers.map((marker) =>
        labelPriority(
          marker,
          options.selectedEventId ?? null,
          options.rootPersonId ?? null,
          options.focusPersonId ?? null,
          cluster.count,
        ),
      ),
    );
    const first = cluster.markers[0];
    const selected = cluster.markers.find(
      (marker) => marker.event.id === options.selectedEventId,
    );
    const marker = selected ?? first;
    return {
      cluster,
      priority,
      title: defaultLabelTitle(cluster, options.t),
      date:
        marker === undefined
          ? ""
          : cluster.count > 1
            ? `${marker.label}–${cluster.markers[cluster.markers.length - 1]?.label ?? marker.label}`
            : marker.label,
    };
  });
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.cluster.fraction - b.cluster.fraction;
  });

  const rows: Record<LineLabelSide, Array<Array<[number, number]>>> = {
    top: [],
    bottom: [],
  };
  const labels: LineLabel[] = [];
  let index = 0;

  for (const candidate of candidates) {
    if (labels.length >= maxRows * 2) {
      break;
    }
    const preferred: LineLabelSide[] =
      index % 2 === 0 ? ["top", "bottom"] : ["bottom", "top"];
    index += 1;

    const titleWidth = estimateTextWidth(candidate.title, 10);
    const dateWidth = estimateTextWidth(candidate.date, 10);
    const boxWidth = Math.min(
      maxWidth,
      Math.max(110, titleWidth + 16, dateWidth + 16),
    );
    // Full names are never shortened: the box wraps instead and grows by line.
    const titleLines = Math.max(
      1,
      Math.ceil(titleWidth / Math.max(1, boxWidth - 12)),
    );
    const boxHeight = 4 + titleLines * 13 + 13;
    const fullTitle = candidate.title;
    const title = fullTitle;
    const truncated = false;
    const center = candidate.cluster.fraction * width;
    const left = clamp(center - boxWidth / 2, marginX, width - boxWidth - marginX);
    const right = left + boxWidth;

    let placed: { side: LineLabelSide; row: number; y: number } | null = null;
    for (const side of preferred) {
      for (let row = 0; row < maxRows; row += 1) {
        const y =
          side === "top"
            ? axisY - gap - boxHeight - row * (boxHeight + 6)
            : axisY + gap + axisLabelHeight + row * (boxHeight + 6);
        if (y < topInset || y + boxHeight > canvasHeight - bottomInset) {
          continue;
        }
        const sideRows = rows[side];
        while (sideRows.length <= row) {
          sideRows.push([]);
        }
        const occupied = sideRows[row] ?? [];
        const overlaps = occupied.some(
          ([start, end]) => left < end + 6 && right > start - 6,
        );
        if (!overlaps) {
          occupied.push([left, right]);
          placed = { side, row, y };
          break;
        }
      }
      if (placed !== null) {
        break;
      }
    }
    if (placed === null) {
      continue;
    }

    const y = placed.y;
    const midY = placed.side === "top" ? y + boxHeight : y;
    const endX = clamp(center, left + 8, right - 8);
    const leaderY =
      placed.side === "bottom" ? axisY + axisLabelHeight : axisY;
    const label: LineLabel = {
      clusterId: candidate.cluster.id,
      eventId:
        candidate.cluster.count === 1
          ? (candidate.cluster.markers[0]?.event.id ?? null)
          : null,
      side: placed.side,
      x: left,
      y,
      width: boxWidth,
      height: boxHeight,
      title,
      date: candidate.date,
      truncated,
      fullTitle,
      priority: candidate.priority,
      leader: {
        x: center,
        y: leaderY,
        midX: center,
        midY,
        endX,
        endY: midY,
      },
    };
    labels.push(label);
  }

  return labels;
}
