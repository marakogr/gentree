// User-adjustable column widths for the list tables (People, Events).
//
// The pure half (bounds, stored-value validation, key layout) has no React or
// DOM dependency and is covered by tableColumns.test.ts. The hook only keeps
// the widths in component state and writes them to localStorage per project
// and screen, so hiding/showing a column never loses its width.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Screens that keep their own set of column widths. */
export type ColumnScreen = "persons" | "events";

/** Persisted widths in CSS pixels, keyed by column id. */
export type ColumnWidths = Record<string, number>;

/** A pointer drag cannot make a column narrower or wider than this. */
export const COLUMN_WIDTH_MIN = 72;
export const COLUMN_WIDTH_MAX = 640;

/** Arrow keys resize by a normal step, Shift+Arrow by a coarse one. */
export const COLUMN_WIDTH_STEP = 8;
export const COLUMN_WIDTH_STEP_LARGE = 32;

export const COLUMN_WIDTHS_STORAGE_PREFIX = "gentree.columns.v1.";

/** Minimal storage surface: tests pass a plain object, the browser `localStorage`. */
export type ColumnWidthStorage = Pick<Storage, "getItem" | "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserStorage(): ColumnWidthStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // Access to localStorage can throw in hardened webviews.
    return null;
  }
}

/** Clamps one width into the allowed range; non-finite input gets the minimum. */
export function clampColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return COLUMN_WIDTH_MIN;
  return Math.min(
    COLUMN_WIDTH_MAX,
    Math.max(COLUMN_WIDTH_MIN, Math.round(value)),
  );
}

/**
 * Validates a parsed storage value: unknown shapes collapse to `{}`, every
 * width is clamped, so a rotted blob never reaches the table.
 */
export function sanitizeColumnWidths(value: unknown): ColumnWidths {
  if (!isRecord(value)) return {};
  const widths: ColumnWidths = {};
  for (const [column, raw] of Object.entries(value)) {
    if (column === "") continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    widths[column] = clampColumnWidth(raw);
  }
  return widths;
}

/** Immutable write of one column width. */
export function withColumnWidth(
  widths: ColumnWidths,
  column: string,
  width: number,
): ColumnWidths {
  return { ...widths, [column]: clampColumnWidth(width) };
}

/** Drops the override, so the column falls back to its default width. */
export function withoutColumn(
  widths: ColumnWidths,
  column: string,
): ColumnWidths {
  if (!(column in widths)) return widths;
  const next = { ...widths };
  delete next[column];
  return next;
}

/** Inline `<col>` style for a stored width; `undefined` keeps the CSS default. */
export function columnWidthStyle(
  widths: ColumnWidths,
  column: string,
): { width: string } | undefined {
  const width = widths[column];
  return width === undefined ? undefined : { width: `${width}px` };
}

export function columnWidthsStorageKey(
  projectId: string,
  screen: ColumnScreen,
): string {
  return `${COLUMN_WIDTHS_STORAGE_PREFIX}${projectId}.${screen}`;
}

/** Stored widths of one project screen; never throws, never returns garbage. */
export function readColumnWidths(
  projectId: string,
  screen: ColumnScreen,
  storage: ColumnWidthStorage | null = browserStorage(),
): ColumnWidths {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(columnWidthsStorageKey(projectId, screen));
    return raw === null ? {} : sanitizeColumnWidths(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Persists one project screen; storage errors must not break the table. */
export function writeColumnWidths(
  projectId: string,
  screen: ColumnScreen,
  widths: ColumnWidths,
  storage: ColumnWidthStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      columnWidthsStorageKey(projectId, screen),
      JSON.stringify(sanitizeColumnWidths(widths)),
    );
  } catch {
    // Quota exceeded or storage disabled: keep the in-memory widths only.
  }
}

type DragState = { column: string; startX: number; startWidth: number };

export type ColumnWidthsApi = {
  widths: ColumnWidths;
  /** Column currently being dragged, or `null`. */
  resizingColumn: string | null;
  /** Sets one width (clamped) and schedules a storage write. */
  setWidth: (column: string, width: number) => void;
  /** Drops the override, restoring the default width. */
  resetWidth: (column: string) => void;
  /** Starts a drag from the measured width of the column. */
  startResize: (column: string, clientX: number, startWidth: number) => void;
  /** Applies the pointer position of an active drag. */
  moveResize: (clientX: number) => void;
  /** Ends the drag; pointer capture itself stays with the component. */
  endResize: () => void;
};

/**
 * DOM props of the narrow drag/keyboard handle on the right edge of a header
 * cell. Shared by the persons and events tables, which use the same gestures.
 */
export function columnResizeHandle(
  api: ColumnWidthsApi,
  column: string,
  label: string,
): HTMLAttributes<HTMLSpanElement> {
  const start = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cell = event.currentTarget.parentElement;
    const width = cell?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    api.startResize(column, event.clientX, width);
  };

  const move = (event: ReactPointerEvent<HTMLSpanElement>) => {
    api.moveResize(event.clientX);
  };

  const end = (event: ReactPointerEvent<HTMLSpanElement>) => {
    api.endResize();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const key = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    const step = event.shiftKey ? COLUMN_WIDTH_STEP_LARGE : COLUMN_WIDTH_STEP;
    const cell = event.currentTarget.parentElement;
    const current =
      api.widths[column] ?? cell?.getBoundingClientRect().width ?? 0;
    if (current <= 0) return;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current - step;
    else if (event.key === "ArrowRight") next = current + step;
    else if (event.key === "Home") next = COLUMN_WIDTH_MIN;
    else if (event.key === "End") next = COLUMN_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    api.setWidth(column, next);
  };

  return {
    className: [
      "col-resize-handle",
      api.resizingColumn === column ? "col-resize-handle-active" : "",
    ]
      .filter(Boolean)
      .join(" "),
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": label,
    "aria-valuemin": COLUMN_WIDTH_MIN,
    "aria-valuemax": COLUMN_WIDTH_MAX,
    "aria-valuenow": api.widths[column],
    tabIndex: 0,
    onPointerDown: start,
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: api.endResize,
    onKeyDown: key,
    onDoubleClick: () => api.resetWidth(column),
  };
}

/**
 * Column widths of one project screen. Storage is read once per project and
 * written debounced (and flushed on unmount), so a drag does not hit
 * localStorage on every pointer move.
 */
export function useColumnWidths(
  projectId: string,
  screen: ColumnScreen,
): ColumnWidthsApi {
  const [widths, setWidths] = useState<ColumnWidths>(() =>
    readColumnWidths(projectId, screen),
  );
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const latest = useRef(widths);
  latest.current = widths;

  // Another project or screen brings its own stored widths.
  useEffect(() => {
    drag.current = null;
    setResizingColumn(null);
    setWidths(readColumnWidths(projectId, screen));
  }, [projectId, screen]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const timer = window.setTimeout(() => {
      writeColumnWidths(projectId, screen, latest.current);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [projectId, screen, widths]);

  // Flush the last width synchronously when the screen is left.
  useEffect(
    () => () => {
      writeColumnWidths(projectId, screen, latest.current);
    },
    [projectId, screen],
  );

  const setWidth = useCallback((column: string, width: number) => {
    setWidths((previous) => withColumnWidth(previous, column, width));
  }, []);

  const resetWidth = useCallback((column: string) => {
    setWidths((previous) => withoutColumn(previous, column));
  }, []);

  const startResize = useCallback(
    (column: string, clientX: number, startWidth: number) => {
      if (!Number.isFinite(startWidth) || startWidth <= 0) return;
      drag.current = { column, startX: clientX, startWidth };
      setResizingColumn(column);
      // Pin the measured width so the column stops taking the leftover space
      // and the next pointer move is a pure delta.
      setWidths((previous) => ({
        ...previous,
        [column]: Math.round(startWidth),
      }));
    },
    [],
  );

  const moveResize = useCallback((clientX: number) => {
    const state = drag.current;
    if (state === null) return;
    setWidths((previous) =>
      withColumnWidth(
        previous,
        state.column,
        state.startWidth + clientX - state.startX,
      ),
    );
  }, []);

  const endResize = useCallback(() => {
    drag.current = null;
    setResizingColumn(null);
  }, []);

  return {
    widths,
    resizingColumn,
    setWidth,
    resetWidth,
    startResize,
    moveResize,
    endResize,
  };
}
