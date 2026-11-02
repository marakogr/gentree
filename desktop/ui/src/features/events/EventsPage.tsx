import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Badge,
  Checkbox,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDownRegular,
  ArrowUpRegular,
  AttachRegular,
  BriefcaseRegular,
  CheckmarkRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  HatGraduationRegular,
  HeartBrokenRegular,
  HeartRegular,
  HomeRegular,
  LeafThreeRegular,
  LinkDismissRegular,
  PersonRegular,
  QuestionCircleRegular,
  SettingsRegular,
  WarningRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { eventsApi, mediaApi, personsApi } from "../../api/client";
import type {
  CivilDate,
  DatePrecision,
  DateValue,
  EventEntity,
  EventType,
  MediaItem,
  Person,
  Versioned,
} from "../../api/types";
import { FilterBar } from "../../components/filters/FilterBar";
import { MultiSelectDropdown } from "../../components/filters/MultiSelectDropdown";
import { YearRange } from "../../components/filters/YearRange";
import { BulkBar } from "../../components/ui/bulk-bar";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty";
import { MenuButton, type MenuItem } from "../../components/ui/menu";
import { useToast } from "../../components/ui/toast";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { dash } from "../../lib/formatValue";
import {
  columnResizeHandle,
  columnWidthStyle,
  useColumnWidths,
  type ColumnWidths,
} from "../../lib/tableColumns";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useScrollMemory, useViewState } from "../../lib/useViewState";
import type { ViewFilters } from "../../lib/viewState";
import { photosByPerson } from "../media/helpers";
import { displayName } from "../persons/helpers";
import PersonSearch from "../persons/PersonSearch";
import EventForm from "./EventForm";
import { ANOMALY_CODES, anomalySummary, detectAnomalies } from "./anomalies";
import {
  EVENT_COLUMNS,
  EVENT_PAGE_SIZE,
  EVENT_TYPES,
  clearEventFilterValues,
  eventDateLabel,
  eventPersonIds,
  eventTypeLabel,
  eventYearBounds,
  filterEventRows,
  isEventSortKey,
  isEventType,
  isYearRangeInvalid,
  paginateEventRows,
  readEventColumns,
  readEventFilters,
  resolveEventColumns,
  sortEventRows,
  withFilterValue,
  type EventColumn,
  type EventRowContext,
  type EventSortKey,
  type EventSortState,
} from "./helpers";
import "./events.css";

// Newest events on top by default; a stored `view.sort` still wins.
const DEFAULT_SORT: EventSortState = { key: "date", direction: "desc" };

const TYPE_ICONS: Record<EventType, FluentIcon> = {
  BIRTH: PersonRegular,
  DEATH: HeartBrokenRegular,
  MARRIAGE: HeartRegular,
  DIVORCE: LinkDismissRegular,
  BURIAL: LeafThreeRegular,
  RESIDENCE: HomeRegular,
  OCCUPATION: BriefcaseRegular,
  EDUCATION: HatGraduationRegular,
  OTHER: QuestionCircleRegular,
};

/** Year-first table dates: `2016 · 1 October`. */
const DATE_YEAR_SEPARATOR = " \u00b7 ";

/** UTC midnight for a `YYYY-MM-DD` civil date, or `null` when it is invalid. */
function civilDateToUtc(value: CivilDate): Date | null {
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Table cell date: the year first, then the day and the month name in the
 * active locale (`2016 · 1 October` / `2016 · October 1`). Only the display
 * order changes - sorting and filtering keep using the raw `DateValue`.
 */
function formatYearFirst(
  value: CivilDate,
  precision: DatePrecision,
  dayMonth: Intl.DateTimeFormat,
  month: Intl.DateTimeFormat,
): string | null {
  const instant = civilDateToUtc(value);
  if (!instant) return null;
  const year = String(instant.getUTCFullYear());
  if (precision === "YEAR") return year;
  const rest =
    precision === "MONTH" ? month.format(instant) : dayMonth.format(instant);
  return `${year}${DATE_YEAR_SEPARATOR}${rest}`;
}

/**
 * Column widths live on a `colgroup`, so every page of rows renders with the
 * same layout regardless of how long the current page's values are. A stored
 * width overrides the CSS default of the matching column.
 */
function EventColumnGroup({
  columns,
  widths,
}: {
  columns: readonly EventColumn[];
  widths: ColumnWidths;
}) {
  return (
    <colgroup>
      <col className="bulk-select-col" />
      {columns.map((column) => (
        <col
          key={column}
          className={`events-col events-col-${column}`}
          style={columnWidthStyle(widths, column)}
        />
      ))}
    </colgroup>
  );
}

/** Direction arrow of the active sort column. */
function EventSortIcon({ direction }: { direction: "asc" | "desc" }) {
  return direction === "asc" ? (
    <ArrowUpRegular fontSize={12} aria-hidden="true" />
  ) : (
    <ArrowDownRegular fontSize={12} aria-hidden="true" />
  );
}

const useStyles = makeStyles({
  // `table-layout: fixed` plus the colgroup widths keep the columns from
  // resizing when the page slice changes; the table is already 100% wide.
  table: {
    tableLayout: "fixed",
    width: "100%",
  },
  actionsHeader: {
    whiteSpace: "nowrap",
  },
  // The sortable header cell owns a flex button; keep the label on the start
  // edge like every other header.
  sortButton: {
    justifyContent: "flex-start",
  },
  // The actions header and its row controls share the cell's start edge, so
  // the icons sit exactly under the label instead of hugging the right edge.
  actionsHeaderButton: {
    justifyContent: "flex-start",
  },
  actionsCell: {
    whiteSpace: "nowrap",
  },
  skeletonCell: {
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  // Neutral selection, same as the persons list: the brand appearance floods
  // the whole row with accent colour.
  selectedRow: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Selected,
    },
  },
});

type Editing = { event: EventEntity; version: string };

/** Toggleable event columns plus the always-visible actions column. */
type ResizableColumn = EventColumn | "actions";

type Props = {
  projectId: string;
  /** Deep link from the search screen: filter by this person once. */
  focusPersonId?: string | null;
  onFocusHandled?: () => void;
  /** Deep link from the validation report: reveal this event once. */
  focusEventId?: string | null;
  onEventFocusHandled?: () => void;
  /** Opened by the shell later; the name stays a plain text while absent. */
  onOpenPerson?: (personId: string) => void;
  /** Shown in the "no people yet" note; the shell wires it later. */
  onRequestNewPerson?: () => void;
  /** Shown next to the anomaly counter when provided. */
  onValidateData?: () => void;
};

export default function EventsPage({
  projectId,
  focusPersonId,
  onFocusHandled,
  focusEventId,
  onEventFocusHandled,
  onOpenPerson,
  onRequestNewPerson,
  onValidateData,
}: Props) {
  const { t, i18n } = useTranslation(["event", "common", "enums", "person"]);
  const formatDate = useDateFormatter();
  const toast = useToast();
  const styles = useStyles();
  const { state: view, patch } = useViewState(projectId, "events");

  const [events, setEvents] = useState<Versioned<EventEntity>[]>([]);
  const [persons, setPersons] = useState<Versioned<Person>[]>([]);
  const [photos, setPhotos] = useState<ReadonlyMap<string, MediaItem>>(
    () => new Map(),
  );
  const [filesByEvent, setFilesByEvent] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [stale, setStale] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [createDefaults, setCreateDefaults] = useState<{
    type: EventType;
    personId: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<Versioned<EventEntity> | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(view.query);

  /* ---------- date display ---------- */

  // Month names come from the same locale as `useDateFormatter`; the year is
  // numeric and locale-independent, so it is printed from the civil value.
  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: "long",
        timeZone: "UTC",
      }),
    [i18n.language],
  );
  const dayMonthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }),
    [i18n.language],
  );

  const eventDateText = useCallback(
    (date: DateValue): string => {
      const primary = date.start ?? date.end;
      // Unknown days and free-text originals keep the shared formatter: there
      // is no bound to reorder.
      if (date.precision === "UNKNOWN" || primary === null) {
        return eventDateLabel(date, formatDate);
      }
      const bound = (value: CivilDate): string =>
        formatYearFirst(value, date.precision, dayMonthFormatter, monthFormatter) ??
        formatDate(date);
      switch (date.qualifier) {
        case "BEFORE":
          return t("common:date.before", { date: bound(date.end ?? primary) });
        case "AFTER":
          return t("common:date.after", { date: bound(primary) });
        case "APPROXIMATE":
          return t("common:date.approximate", { date: bound(primary) });
        case "RANGE":
          // `lib/dates` owns the half-open `[start, end)` conversion; keeping
          // its text avoids showing the exclusive end day.
          return formatDate(date);
        default:
          return bound(primary);
      }
    },
    [dayMonthFormatter, formatDate, monthFormatter, t],
  );

  /* ---------- data ---------- */

  const load = useCallback(async () => {
    if (projectId === "") return;
    setLoading(true);
    setError(null);
    try {
      const [rows, personPage, eventCounts, media] = await Promise.all([
        eventsApi.list({}),
        personsApi.list({ limit: 1000, sort: "name" }),
        // Small map of event id -> file count; the dialog loads the items.
        mediaApi.eventCounts(),
        // Profile photos decorate the person filter; a media failure must not
        // hide the events.
        mediaApi.list().catch(() => [] as MediaItem[]),
      ]);
      setEvents(rows);
      setPersons(personPage.items);
      setFilesByEvent(eventCounts);
      setPhotos(photosByPerson(media));
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live search uses `useDebouncedValue`: the view state holds every keystroke
  // so a return restores it, while the heavier filtering runs on the debounced
  // value only.

  // Deep link from search: apply the person once and reset the shell's focus.
  useEffect(() => {
    if (!focusPersonId) return;
    patch((previous) => ({
      ...previous,
      filters: withFilterValue(previous.filters, "personId", focusPersonId),
      page: 0,
      selectedId: null,
    }));
    onFocusHandled?.();
  }, [focusPersonId, onFocusHandled, patch]);

  // Deep link from the validation report: the issue points at an event. Drop
  // the search and every filter that could hide it, then hand the id to the
  // existing `focusRequestId` path, which picks the page and the row.
  useEffect(() => {
    if (!focusEventId) return;
    patch((previous) => ({
      ...previous,
      query: "",
      filters: clearEventFilterValues(previous.filters),
      page: 0,
      selectedId: null,
    }));
    setFocusRequestId(focusEventId);
    onEventFocusHandled?.();
  }, [focusEventId, onEventFocusHandled, patch]);

  /* ---------- derived list ---------- */

  // `patch` rebuilds the filters/sort objects on every state write (including
  // scroll offsets), so memoise on serialised values instead of identities.
  const filterSignature = useMemo(
    () => JSON.stringify(view.filters),
    [view.filters],
  );
  const filters = useMemo(
    () => readEventFilters(view.filters),
    [filterSignature],
  );
  const storedColumns = useMemo(
    () => readEventColumns(view.filters),
    [filterSignature],
  );

  const personsById = useMemo(
    () => new Map(persons.map((item) => [item.entity.id, item.entity])),
    [persons],
  );

  const personName = useCallback(
    (personId: string): string => {
      const person = personsById.get(personId);
      return person
        ? displayName(person, t("person:unknownName"))
        : t("person:unknownName");
    },
    [personsById, t],
  );

  const eventPeople = useCallback(
    (event: EventEntity): string =>
      [event.personId, ...(event.participantIds ?? [])]
        .map(personName)
        .join(", "),
    [personName],
  );

  const rowContext = useCallback(
    (event: EventEntity): EventRowContext => ({
      personName: eventPeople(event),
      typeLabel: eventTypeLabel(event.type, event.originalType, t),
    }),
    [eventPeople, t],
  );

  const sortKey = view.sort?.key ?? "";
  const sortDirection = view.sort?.direction ?? "";
  const sort = useMemo<EventSortState>(() => {
    if (sortKey !== "" && isEventSortKey(sortKey)) {
      return { key: sortKey, direction: sortDirection === "desc" ? "desc" : "asc" };
    }
    return DEFAULT_SORT;
  }, [sortKey, sortDirection]);

  const filtered = useMemo(
    () => filterEventRows(events, debouncedQuery, filters, rowContext),
    [events, debouncedQuery, filters, rowContext],
  );

  const sorted = useMemo(
    () => sortEventRows(filtered, sort, rowContext),
    [filtered, sort, rowContext],
  );

  const page = useMemo(
    () => paginateEventRows(sorted, view.page),
    [sorted, view.page],
  );

  const pageKey = page.rows.map((row) => row.entity.id).join("|");
  const versionById = useMemo(
    () => new Map(events.map((item) => [item.entity.id, item.version])),
    [events],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allPageSelected =
    page.rows.length > 0 &&
    page.rows.every((row) => selectedSet.has(row.entity.id));
  const somePageSelected = page.rows.some((row) =>
    selectedSet.has(row.entity.id),
  );

  // A new page, query or sort is a new selection scope: never delete rows the
  // user can no longer see.
  useEffect(() => {
    setSelectedIds([]);
  }, [pageKey, projectId]);

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((ids) =>
      checked
        ? ids.includes(id)
          ? ids
          : [...ids, id]
        : ids.filter((item) => item !== id),
    );
  };

  const togglePageSelected = (checked: boolean) => {
    setSelectedIds(
      checked ? page.rows.map((row) => row.entity.id) : [],
    );
  };

  const columns = useMemo(
    () => resolveEventColumns(storedColumns, events),
    [storedColumns, events],
  );

  const anomalies = useMemo(
    () => detectAnomalies(events, persons),
    [events, persons],
  );
  const anomalyCounts = useMemo(() => anomalySummary(anomalies), [anomalies]);
  const anomalyCount = anomalies.size;
  const anomalyTitle = useMemo(
    () =>
      ANOMALY_CODES.filter((code) => anomalyCounts[code] > 0)
        .map((code) => `${t(`event:anomaly.codes.${code}`)}: ${anomalyCounts[code]}`)
        .join("\n"),
    [anomalyCounts, t],
  );

  // The year slider spans from the earliest dated event to today. The current
  // year is read from the clock, never hard-coded.
  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const yearBounds = useMemo(
    () => eventYearBounds(events, currentYear),
    [events, currentYear],
  );

  /* ---------- scroll memory ---------- */

  const handleScrollTop = useCallback(
    (value: number) => patch({ scrollTop: value }),
    [patch],
  );
  const scrollMemoryRef = useScrollMemory({
    scrollTop: view.scrollTop,
    onScrollTop: handleScrollTop,
    ready: !loading && events.length > 0,
  });
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollNodeRef.current = node;
      scrollMemoryRef(node);
    },
    [scrollMemoryRef],
  );

  // Scroll only when the selection changes during the session; the restored
  // scroll offset owns the first render. Re-runs when the page slice changes so
  // a row selected on another page is still brought into view.
  const lastScrolled = useRef<string | null>(view.selectedId);
  useEffect(() => {
    const id = view.selectedId;
    if (!id || lastScrolled.current === id) return;
    const node = scrollNodeRef.current;
    const row = document.getElementById(`event-row-${id}`);
    if (!node || !row) return;
    const nodeRect = node.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const headHeight = 34;
    if (
      rowRect.top < nodeRect.top + headHeight ||
      rowRect.bottom > nodeRect.bottom
    ) {
      node.scrollTop += rowRect.top - nodeRect.top - headHeight - 4;
    }
    lastScrolled.current = id;
  }, [view.selectedId, page.rows]);

  // A freshly created row may land on another page: jump to it once loaded.
  useEffect(() => {
    if (!focusRequestId) return;
    const index = sorted.findIndex((row) => row.entity.id === focusRequestId);
    if (index < 0) return;
    patch({
      page: Math.floor(index / EVENT_PAGE_SIZE),
      selectedId: focusRequestId,
    });
    setFocusRequestId(null);
  }, [focusRequestId, sorted, patch]);

  // Keep the stored page inside the clamped range, e.g. after a delete shrank
  // the list or a restored page no longer exists.
  useEffect(() => {
    if (view.page !== page.page) patch({ page: page.page });
  }, [view.page, page.page, patch]);

  /* ---------- mutations ---------- */

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setCreateDefaults(null);
  };

  const startCreate = () => {
    setEditing(null);
    setCreateDefaults(null);
    setFormOpen(true);
  };

  const startRelated = (request: { type: EventType; personId: string }) => {
    setEditing(null);
    setCreateDefaults(request);
    setFormOpen(true);
  };

  const startEdit = (row: Versioned<EventEntity>) => {
    setEditing({ event: row.entity, version: row.version });
    setCreateDefaults(null);
    setFormOpen(true);
  };

  const handleSaved = (saved: Versioned<EventEntity>) => {
    const created = editing === null;
    setFormOpen(false);
    setEditing(null);
    setCreateDefaults(null);
    toast.success(t(created ? "event:createdToast" : "event:updatedToast"));

    // Saving must not move the user to another list: the query and filters stay
    // exactly as they were. The saved row is revealed only when it still passes
    // them; otherwise the current page and selection are left untouched.
    const visible =
      filterEventRows(
        [{ entity: saved.entity }],
        debouncedQuery,
        filters,
        rowContext,
      ).length > 0;
    if (visible) {
      setFocusRequestId(saved.entity.id);
    } else if (view.selectedId === saved.entity.id) {
      patch({ selectedId: null });
    }
    void load();
  };

  const handleDeletedFromForm = (id: string) => {
    setFormOpen(false);
    setEditing(null);
    setCreateDefaults(null);
    if (view.selectedId === id) patch({ selectedId: null });
    toast.success(t("event:deletedToast"));
    void load();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      await eventsApi.delete(deleting.entity.id, deleting.version);
      if (view.selectedId === deleting.entity.id) patch({ selectedId: null });
      setDeleting(null);
      toast.success(t("event:deletedToast"));
      await load();
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") {
        setDeleting(null);
        setStale(true);
      } else {
        setError(normalized);
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteBulk = async () => {
    if (selectedIds.length === 0) return;
    const ids = [...selectedIds];
    setBusy(true);
    setError(null);
    setStale(false);

    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const version = versionById.get(id);
        if (!version) throw new Error(`missing version for ${id}`);
        await eventsApi.delete(id, version);
      }),
    );

    const deleted = results.filter((result) => result.status === "fulfilled")
      .length;
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    setSelectedIds([]);
    if (view.selectedId && ids.includes(view.selectedId)) {
      patch({ selectedId: null });
    }
    await load();
    if (failure) {
      setError(normalizeError(failure.reason));
      toast.error(
        t("common:bulk.partial", { deleted, total: ids.length }),
      );
    } else {
      toast.success(t("common:bulk.deleted", { count: deleted }));
    }
    setBulkDeleteOpen(false);
    setBusy(false);
  };

  const reloadAfterStale = () => {
    setStale(false);
    void load();
  };

  /* ---------- filters ---------- */

  const patchFilters = useCallback(
    (next: (current: ViewFilters) => ViewFilters) => {
      patch((previous) => ({
        ...previous,
        filters: next(previous.filters),
        page: 0,
      }));
    },
    [patch],
  );

  const handleQueryChange = (value: string) => patch({ query: value, page: 0 });

  const handlePersonFilter = (personId: string) =>
    patchFilters((current) =>
      withFilterValue(current, "personId", personId),
    );

  const handleTypeFilter = (types: string[]) =>
    patchFilters((current) =>
      withFilterValue(current, "types", types.filter(isEventType)),
    );

  const handleFromYear = (value: string) =>
    patchFilters((current) => withFilterValue(current, "fromYear", value));

  const handleToYear = (value: string) =>
    patchFilters((current) => withFilterValue(current, "toYear", value));

  // A stored `from` later than `to` can only come from the old number inputs;
  // the slider cannot draw that pair, so swap the bounds once after loading.
  useEffect(() => {
    if (!isYearRangeInvalid(filters.fromYear, filters.toYear)) return;
    patchFilters((current) =>
      withFilterValue(
        withFilterValue(current, "fromYear", filters.toYear),
        "toYear",
        filters.fromYear,
      ),
    );
  }, [filters.fromYear, filters.toYear, patchFilters]);

  const resetFilters = () => {
    patch((previous) => ({
      ...previous,
      query: "",
      filters: clearEventFilterValues(previous.filters),
      page: 0,
    }));
  };

  const toggleSort = (key: EventSortKey) => {
    patch((previous) => {
      const current =
        previous.sort && isEventSortKey(previous.sort.key)
          ? previous.sort
          : null;
      const direction =
        current && current.key === key
          ? current.direction === "asc"
            ? "desc"
            : "asc"
          : "asc";
      return { ...previous, sort: { key, direction }, page: 0 };
    });
  };

  /* ---------- column widths ---------- */

  const {
    widths: columnWidths,
    resizingColumn,
    setWidth: setColumnWidth,
    resetWidth: resetColumnWidth,
    startResize,
    moveResize,
    endResize,
  } = useColumnWidths(projectId, "events");

  const columnLabel = (column: ResizableColumn): string =>
    column === "actions"
      ? t("common:fields.actions")
      : t(`event:columns.${column}`);

  const columnApi = {
    widths: columnWidths,
    resizingColumn,
    setWidth: setColumnWidth,
    resetWidth: resetColumnWidth,
    startResize,
    moveResize,
    endResize,
  };
  /** Narrow drag/keyboard handle on the right edge of a header cell. */
  const columnHandle = (column: ResizableColumn) =>
    columnResizeHandle(columnApi, column, columnLabel(column));

  const toggleColumn = (column: EventColumn) => {
    const selected = columns.includes(column)
      ? columns.filter((item) => item !== column)
      : [...columns, column];
    if (selected.length === 0) return;
    const ordered = EVENT_COLUMNS.filter((item) => selected.includes(item));
    patch((previous) => ({
      ...previous,
      filters: withFilterValue(previous.filters, "columns", ordered),
    }));
  };

  const columnItems: MenuItem[] = EVENT_COLUMNS.map((column) => ({
    id: column,
    label: t(`event:columns.${column}`),
    icon: columns.includes(column) ? (
      <CheckmarkRegular fontSize={16} aria-hidden="true" />
    ) : undefined,
    disabled: columns.includes(column) && columns.length === 1,
    disabledReason: t("event:columns.lastOne"),
    onSelect: () => toggleColumn(column),
  }));

  const typeOptions = useMemo(
    () =>
      EVENT_TYPES.map((type) => {
        const Icon = TYPE_ICONS[type];
        return {
          id: type,
          label: t(`enums:eventType.${type}`),
          icon: <Icon fontSize={16} aria-hidden="true" />,
        };
      }),
    [t],
  );

  const personEntities = useMemo(
    () => persons.map((item) => item.entity),
    [persons],
  );

  const pageFrom = page.total === 0 ? 0 : page.offset + 1;
  const pageTo = page.offset + page.rows.length;

  return (
    <>
      <div className="events-head">
        <div className="events-head-title">
          <h1 className="page-title">{t("event:title")}</h1>
          <Badge appearance="tint" color="informative" size="small">
            {t("event:count", { count: events.length })}
          </Badge>
        </div>

        <div className="events-head-actions">
          {anomalyCount > 0 ? (
            <span className="events-anomalies" title={anomalyTitle}>
              <WarningRegular aria-hidden="true" />
              {t("event:anomaly.count", { count: anomalyCount })}
              <span className="ui-sr-only">{anomalyTitle}</span>
            </span>
          ) : null}
          {onValidateData && anomalyCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={onValidateData}>
              {t("event:anomaly.check")}
            </Button>
          ) : null}
        </div>
      </div>

      <section className="panel events-page">
        <div className="events-toolbar">
          <div className="events-toolbar-row">
            <div className="events-filters">
              <div className="events-filter-top">
                <FilterBar
                  query={view.query}
                  onQueryChange={handleQueryChange}
                  queryPlaceholder={t("event:searchPlaceholder")}
                  queryLabel={t("event:searchLabel")}
                  clearLabel={t("event:clearSearch")}
                  filtersLabel={t("event:filtersTitle")}
                  activeCount={0}
                  chips={[]}
                  onReset={resetFilters}
                  resetLabel={t("event:resetFilters")}
                  loading={loading}
                />
                <div className="events-person-filter">
                  <PersonSearch
                    id="events-person-filter"
                    label={t("event:person")}
                    hideLabel
                    persons={personEntities}
                    photos={photos}
                    value={filters.personId}
                    onChange={handlePersonFilter}
                    placeholder={t("event:personFilterPlaceholder")}
                    allOptionLabel={t("event:allPersons")}
                    clearLabel={t("event:clearPerson")}
                    emptyLabel={t("event:noPersonMatches")}
                  />
                </div>
                <span className="events-result">
                  {t("common:filters.found", {
                    count: filtered.length,
                    total: events.length,
                  })}
                </span>
              </div>
              <div className="events-filter-row">
                <div className="events-type-filter">
                  <MultiSelectDropdown
                    options={typeOptions}
                    values={[...filters.types]}
                    onChange={handleTypeFilter}
                    label={t("event:type")}
                    allLabel={t("event:allTypes")}
                    searchPlaceholder={t("event:typeFilterSearch")}
                    emptyLabel={t("event:noPersonMatches")}
                    multipleLabel={(count) =>
                      t("event:typesSelected", { count })
                    }
                  />
                </div>
                <YearRange
                  from={filters.fromYear}
                  to={filters.toYear}
                  minYear={yearBounds.minYear}
                  maxYear={yearBounds.maxYear}
                  disabled={
                    !yearBounds.hasDated ||
                    yearBounds.minYear >= yearBounds.maxYear
                  }
                  disabledHint={
                    yearBounds.hasDated ? undefined : t("event:yearRangeEmpty")
                  }
                  onFromChange={handleFromYear}
                  onToChange={handleToYear}
                  fromLabel={t("event:yearFrom")}
                  toLabel={t("event:yearTo")}
                  groupLabel={t("event:yearRange")}
                />
              </div>
            </div>
            <div className="events-toolbar-actions">
              <MenuButton
                iconOnly
                icon={<SettingsRegular fontSize={16} aria-hidden="true" />}
                label={t("event:columns.title")}
                items={columnItems}
                align="end"
              />
              <Button
                variant="primary"
                data-tour="events-add"
                onClick={startCreate}
                disabled={persons.length === 0}
                disabledReason={t("event:noPersons")}
              >
                {t("event:new")}
              </Button>
            </div>
          </div>

          {selectedIds.length > 0 ? (
            <BulkBar
              selectedLabel={t("common:bulk.selected", {
                count: selectedIds.length,
              })}
              deleteLabel={t("common:actions.delete")}
              onDelete={() => setBulkDeleteOpen(true)}
            />
          ) : null}
        </div>

        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {t(`errors.${error.code}`, {
                defaultValue: t("errors.UNKNOWN"),
              })}
            </MessageBarBody>
          </MessageBar>
        ) : null}

        {stale ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>{t("common:errors.STALE_WRITE")}</MessageBarTitle>
              {t("event:conflict")}
            </MessageBarBody>
            <MessageBarActions>
              <Button variant="secondary" size="sm" onClick={reloadAfterStale}>
                {t("common:actions.reload")}
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}

        {loading && events.length === 0 ? (
          <>
            <p className="ui-sr-only" role="status">
              {t("common:loading")}
            </p>
            <div className="events-table-wrap" aria-hidden="true">
              <Table size="small" className={styles.table}>
                <EventColumnGroup columns={columns} widths={columnWidths} />
                <TableBody>
                  {Array.from({ length: 8 }, (_, index) => (
                    <TableRow key={index}>
                      {columns.map((column) => (
                        <TableCell key={column} className={styles.skeletonCell}>
                          <Skeleton>
                            <SkeletonItem size={16} />
                          </Skeleton>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : events.length === 0 ? (
          <EmptyState
            compact
            text={t("event:empty")}
            actionLabel={persons.length === 0 ? t("event:createPerson") : t("event:new")}
            onAction={
              persons.length === 0
                ? onRequestNewPerson
                : startCreate
            }
          />
        ) : page.rows.length === 0 ? (
          <EmptyState
            compact
            text={t("event:noResults")}
            actionLabel={t("event:resetFilters")}
            onAction={resetFilters}
          />
        ) : (
          <>
            <div
              className={
                resizingColumn
                  ? "events-table-wrap events-table-wrap-resizing"
                  : "events-table-wrap"
              }
              ref={setScrollNode}
            >
              <Table
                size="small"
                className={styles.table}
                aria-label={t("event:title")}
              >
                <EventColumnGroup columns={columns} widths={columnWidths} />
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className="bulk-select-cell">
                      <Checkbox
                        checked={
                          allPageSelected
                            ? true
                            : somePageSelected
                              ? "mixed"
                              : false
                        }
                        onChange={(_event, data) =>
                          togglePageSelected(data.checked === true)
                        }
                        aria-label={t("common:bulk.selectAll")}
                      />
                    </TableHeaderCell>
                    {columns.includes("date") ? (
                      <TableHeaderCell
                        sortable
                        sortDirection={
                          sort.key === "date"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        sortIcon={
                          sort.key === "date" ? (
                            <EventSortIcon direction={sort.direction} />
                          ) : undefined
                        }
                        button={{
                          className: styles.sortButton,
                          onClick: () => toggleSort("date"),
                        }}
                        aside={columnHandle("date")}
                      >
                        {t("event:date")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("type") ? (
                      <TableHeaderCell
                        sortable
                        sortDirection={
                          sort.key === "type"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        sortIcon={
                          sort.key === "type" ? (
                            <EventSortIcon direction={sort.direction} />
                          ) : undefined
                        }
                        button={{
                          className: styles.sortButton,
                          onClick: () => toggleSort("type"),
                        }}
                        aside={columnHandle("type")}
                      >
                        {t("event:type")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("person") ? (
                      <TableHeaderCell
                        sortable
                        sortDirection={
                          sort.key === "person"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        sortIcon={
                          sort.key === "person" ? (
                            <EventSortIcon direction={sort.direction} />
                          ) : undefined
                        }
                        button={{
                          className: styles.sortButton,
                          onClick: () => toggleSort("person"),
                        }}
                        aside={columnHandle("person")}
                      >
                        {t("event:person")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("place") ? (
                      <TableHeaderCell aside={columnHandle("place")}>
                        {t("event:place")}
                      </TableHeaderCell>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.rows.map((row) => {
                    const entity = row.entity;
                    const TypeIcon = TYPE_ICONS[entity.type];
                    const codes = anomalies.get(entity.id);
                    const anomalyLabel = codes
                      ? codes
                          .map((code) => t(`event:anomaly.codes.${code}`))
                          .join("; ")
                      : null;
                    const selected = view.selectedId === entity.id;
                    const dateText = eventDateText(entity.date);
                    const fileCount = filesByEvent[entity.id] ?? 0;
                    return (
                      <TableRow
                        key={entity.id}
                        id={`event-row-${entity.id}`}
                        className={selected ? styles.selectedRow : undefined}
                        aria-selected={selected || undefined}
                        onClick={() => {
                          patch({ selectedId: entity.id });
                          startEdit(row);
                        }}
                      >
                        <TableCell
                          className="bulk-select-cell"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            checked={selectedSet.has(entity.id)}
                            onChange={(_event, data) =>
                              toggleSelected(entity.id, data.checked === true)
                            }
                            aria-label={t("common:bulk.selectEvent", {
                              name: `${eventTypeLabel(
                                entity.type,
                                entity.originalType,
                                t,
                              )} ${dateText}`,
                            })}
                          />
                        </TableCell>
                        {columns.includes("date") ? (
                          <TableCell title={dateText}>
                            <TableCellLayout truncate>
                              <div className="events-date-cell">
                                <span className="events-date-text">{dateText}</span>
                                {anomalyLabel ? (
                                  <span
                                    className="events-anomaly"
                                    role="img"
                                    aria-label={anomalyLabel}
                                    title={anomalyLabel}
                                  >
                                    <WarningRegular aria-hidden="true" />
                                  </span>
                                ) : null}
                              </div>
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                        {columns.includes("type") ? (
                          <TableCell title={eventTypeLabel(entity.type, entity.originalType, t)}>
                            <TableCellLayout truncate>
                              <span
                                className={`events-type events-type-${entity.type}`}
                              >
                                <TypeIcon aria-hidden="true" />
                                <span className="events-type-label">
                                  {eventTypeLabel(entity.type, entity.originalType, t)}
                                </span>
                              </span>
                              {fileCount > 0 ? (
                                <span
                                  className="events-files"
                                  role="img"
                                  aria-label={t("event:filesBadge", {
                                    count: fileCount,
                                  })}
                                  title={t("event:filesBadge", {
                                    count: fileCount,
                                  })}
                                >
                                  <AttachRegular aria-hidden="true" />
                                  <span>{fileCount}</span>
                                </span>
                              ) : null}
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                        {columns.includes("person") ? (
                          <TableCell>
                            <TableCellLayout>
                              {onOpenPerson ? (
                                <span className="events-person-links">
                                  {eventPersonIds(entity).map((personId, index) => (
                                    <span key={personId}>
                                      {index > 0 ? (
                                        <span
                                          className="events-person-sep"
                                          aria-hidden="true"
                                        >
                                          ,{" "}
                                        </span>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="events-person-link"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          onOpenPerson(personId);
                                        }}
                                      >
                                        {personName(personId)}
                                      </button>
                                    </span>
                                  ))}
                                </span>
                              ) : (
                                <span className="events-person-static">
                                  {eventPeople(entity)}
                                </span>
                              )}
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                        {columns.includes("place") ? (
                          <TableCell title={entity.place ?? undefined}>
                            <TableCellLayout truncate>
                              {dash(entity.place)}
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="events-pager">
              <span className="events-pager-info">
                {t("event:pageInfo", {
                  page: page.page + 1,
                  pages: page.totalPages,
                })}
                {page.total > 0
                  ? ` \u00b7 ${t("event:rangeInfo", {
                      from: pageFrom,
                      to: pageTo,
                      total: page.total,
                    })}`
                  : null}
              </span>
              <div className="events-pager-actions">
                <Button
                  size="sm"
                  disabled={page.page === 0 || busy}
                  onClick={() => patch({ page: Math.max(0, page.page - 1) })}
                >
                  <ChevronLeftRegular fontSize={16} aria-hidden="true" />
                  {t("common:actions.previous")}
                </Button>
                <Button
                  size="sm"
                  disabled={page.page + 1 >= page.totalPages || busy}
                  onClick={() => patch({ page: page.page + 1 })}
                >
                  {t("common:actions.next")}
                  <ChevronRightRegular fontSize={16} aria-hidden="true" />
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      {formOpen ? (
        <EventForm
          key={editing?.event.id ?? "new"}
          initial={editing?.event ?? null}
          version={editing?.version ?? null}
          persons={persons}
          defaultPersonId={createDefaults?.personId ?? filters.personId}
          defaultType={createDefaults?.type}
          onSaved={handleSaved}
          onCancel={closeForm}
          onDeleted={handleDeletedFromForm}
          onReload={() => {
            closeForm();
            void load();
          }}
          onRequestNewPerson={onRequestNewPerson}
          onFilesChanged={() => {
            void load();
          }}
          onCreateRelated={startRelated}
        />
      ) : null}

      {deleting ? (
        <Dialog
          open
          title={t("event:deleteTitle")}
          onClose={() => setDeleting(null)}
          busy={busy}
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDeleting(null)}
                disabled={busy}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() => void confirmDelete()}
              >
                {t("common:actions.delete")}
              </Button>
            </>
          }
        >
          <p className="meta">
            {t("event:deleteBody", {
              type: eventTypeLabel(
                deleting.entity.type,
                deleting.entity.originalType,
                t,
              ),
              date: eventDateLabel(deleting.entity.date, formatDate),
            })}
          </p>
        </Dialog>
      ) : null}

      <Dialog
        open={bulkDeleteOpen}
        size="sm"
        title={t("common:bulk.deleteEventsTitle")}
        description={t("common:bulk.deleteEventsConfirm", {
          count: selectedIds.length,
        })}
        busy={busy}
        onClose={() => {
          if (!busy) setBulkDeleteOpen(false);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setBulkDeleteOpen(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void deleteBulk()}
            >
              {t("common:actions.delete")}
            </Button>
          </>
        }
      >
        <p className="bulk-hint">{t("common:bulk.deleteEventsHint")}</p>
      </Dialog>
    </>
  );
}
