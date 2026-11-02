// Year range for the events filter: one track with two handles between the
// earliest dated event and the current year. The filter keeps `from`/`to` as
// `YYYY` strings, so an empty bound simply means "the end of the scale".
//
// Both handles are plain `role="slider"` elements over one shared track: the
// pointer is captured by the handle it grabbed, so a handle can never be
// dragged by the other one's zone, and every move is clamped against the
// opposite handle. All value rules live in ./yearRange.ts.

import { useId, useRef, useState } from "react";
import {
  moveHandle,
  normalizeYearRange,
  percentForYear,
  rangeFill,
  yearAtPointer,
  yearForKey,
  type YearRangeHandle,
} from "./yearRangeRules";
import "./filters.css";

/** Visual separator between the two current years: `1900 — 2026`. */
const RANGE_SEPARATOR = " \u2014 ";

export function YearRange({
  from,
  to,
  minYear,
  maxYear,
  disabled = false,
  disabledHint,
  onFromChange,
  onToChange,
  fromLabel,
  toLabel,
  groupLabel,
}: {
  /** Lower bound as a `YYYY` string; empty means `minYear`. */
  from: string;
  /** Upper bound as a `YYYY` string; empty means `maxYear`. */
  to: string;
  /** Earliest year on the scale (start of the track). */
  minYear: number;
  /** Latest year on the scale (end of the track). */
  maxYear: number;
  disabled?: boolean;
  /** Shown instead of an interactive slider when there is nothing to filter. */
  disabledHint?: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  fromLabel: string;
  toLabel: string;
  /** Accessible name of the whole range control. */
  groupLabel: string;
}) {
  const labelId = useId();
  // Both handles may meet on one spot; the handle that moved last keeps the
  // upper layer and stays grabbable.
  const [lastMoved, setLastMoved] = useState<YearRangeHandle | null>(null);
  const [dragging, setDragging] = useState<YearRangeHandle | null>(null);
  const draggingRef = useRef<YearRangeHandle | null>(null);
  // The handle-travel layer: its inline edges are the two handle centres, so
  // the same percentages place the handles and paint the fill.
  const travelRef = useRef<HTMLDivElement | null>(null);

  // A stored view state may hold an inverted ("1900" - "1950" typed backwards)
  // or out-of-scale pair; draw the nearest valid range and let the next move
  // write the valid value back.
  const range = normalizeYearRange(from, to, minYear, maxYear);
  const { lowest, highest, lower, upper } = range;

  const fill = rangeFill(lower, upper, lowest, highest);

  // When the handles meet, only the topmost one can be grabbed: the one moved
  // last stays on top, and a fresh state at the top end puts the lower handle
  // there because it still has room to move left.
  const fromOnTop =
    lastMoved === "from" ||
    (lastMoved === null && lower === upper && upper === highest);

  const applyYear = (handle: YearRangeHandle, year: number): void => {
    setLastMoved(handle);
    if (handle === "from") {
      const next = moveHandle("from", year, range);
      if (next !== lower) onFromChange(String(next));
      return;
    }
    const next = moveHandle("to", year, range);
    if (next !== upper) onToChange(String(next));
  };

  const yearAt = (clientX: number): number | null => {
    const travel = travelRef.current;
    if (!travel) return null;
    const rect = travel.getBoundingClientRect();
    const rtl = window.getComputedStyle(travel).direction === "rtl";
    return yearAtPointer(clientX, rect, lowest, highest, rtl);
  };

  const startDrag = (
    handle: YearRangeHandle,
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = handle;
    setDragging(handle);
    setLastMoved(handle);
    const year = yearAt(event.clientX);
    if (year !== null) applyYear(handle, year);
  };

  const moveDrag = (
    handle: YearRangeHandle,
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (draggingRef.current !== handle) return;
    event.preventDefault();
    const year = yearAt(event.clientX);
    if (year !== null) applyYear(handle, year);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = null;
    setDragging(null);
  };

  const handleKeyDown = (
    handle: YearRangeHandle,
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (disabled) return;
    const current = handle === "from" ? lower : upper;
    // Each handle only moves inside the segment the other one leaves free.
    const min = handle === "from" ? lowest : lower;
    const max = handle === "from" ? upper : highest;
    const next = yearForKey(event.key, current, min, max);
    if (next === null) return;
    event.preventDefault();
    applyYear(handle, next);
  };

  const renderHandle = (handle: YearRangeHandle): React.ReactNode => {
    const isFrom = handle === "from";
    const value = isFrom ? lower : upper;
    const percent = percentForYear(value, lowest, highest);
    const onTop = isFrom ? fromOnTop : !fromOnTop;

    return (
      <div
        role="slider"
        className="year-range-thumb"
        data-handle={handle}
        data-dragging={dragging === handle ? "true" : "false"}
        tabIndex={disabled ? -1 : 0}
        aria-label={isFrom ? fromLabel : toLabel}
        aria-orientation="horizontal"
        aria-valuemin={isFrom ? lowest : lower}
        aria-valuemax={isFrom ? upper : highest}
        aria-valuenow={value}
        aria-disabled={disabled || undefined}
        style={{
          insetInlineStart: `${percent}%`,
          zIndex: onTop ? 3 : 2,
        }}
        onPointerDown={(event) => startDrag(handle, event)}
        onPointerMove={(event) => moveDrag(handle, event)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          draggingRef.current = null;
          setDragging(null);
        }}
        onKeyDown={(event) => handleKeyDown(handle, event)}
      />
    );
  };

  // Nothing to filter: a dead track and two end labels are just noise, so the
  // control collapses to its caption and the hint.
  if (disabled && disabledHint) {
    return (
      <div
        className="year-range year-range-disabled"
        role="group"
        aria-labelledby={labelId}
      >
        <span className="year-range-head">
          <span id={labelId} className="year-range-label">
            {groupLabel}
          </span>
        </span>
        <span className="year-range-hint">{disabledHint}</span>
      </div>
    );
  }

  return (
    <div className="year-range" role="group" aria-labelledby={labelId}>
      <span className="year-range-head">
        <span id={labelId} className="year-range-label">
          {groupLabel}
        </span>
        <span className="year-range-values" aria-hidden="true">
          {`${lower}${RANGE_SEPARATOR}${upper}`}
        </span>
      </span>

      <div
        className="year-range-slider"
        data-disabled={disabled ? "true" : undefined}
      >
        <span className="year-range-track" aria-hidden="true">
          <span
            className="year-range-fill"
            style={{
              insetInlineStart: `${fill.start}%`,
              insetInlineEnd: `${100 - fill.end}%`,
            }}
          />
        </span>

        <div className="year-range-travel" ref={travelRef}>
          {renderHandle("from")}
          {renderHandle("to")}
        </div>
      </div>

      <div className="year-range-ends" aria-hidden="true">
        <span>{lowest}</span>
        <span>{highest}</span>
      </div>

      {disabledHint ? (
        <span className="year-range-hint">{disabledHint}</span>
      ) : null}
    </div>
  );
}
