import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Badge,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableRow,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  AttachRegular,
  CheckmarkRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { eventsApi, mediaApi, personsApi, projectsApi } from "../../api/client";
import type {
  CivilDate,
  DatePrecision,
  DateValue,
  EventEntity,
  EventType,
  MediaItem,
  Person,
  ValidationReport,
  Versioned,
} from "../../api/types";
import { EventFilterHeader } from "./EventFilterHeader";
import { ColumnMenu } from "../../components/patterns/column-menu";
import { CollectionShell } from "../../components/patterns/collection-shell";
import {
  DataTable,
  DataTableColgroup,
  HeaderCell,
  SelectionCell,
  SelectionHeaderCell,
} from "../../components/patterns/data-table";
import { PageShell } from "../../components/patterns/page-shell";
import { Pager } from "../../components/patterns/pager";
import type { SplitterBounds } from "../../components/patterns/splitter";
import { nextSortDirection } from "../../components/patterns/tableState";
import { BulkBar } from "../../components/ui/bulk-bar";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty";
import type { MenuItem } from "../../components/ui/menu";
import { useToast } from "../../components/ui/toast";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { dash } from "../../lib/formatValue";
import {
  columnResizeHandle,
  useColumnWidths,
} from "../../lib/tableColumns";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useScrollMemory, useViewState } from "../../lib/useViewState";
import { photosByPerson } from "../media/helpers";
import { displayName } from "../persons/helpers";
import { ValidationSummary } from "../projects/ValidationSummary";
import EventForm from "./EventForm";
import { EventCard } from "./EventCard";
import { EventPersonCell } from "./EventPersonCell";
import { EVENT_TYPE_ICONS } from "./typeIcons";
import {
  useEventFilterState,
  usePruneEventPersonFilter,
} from "./useEventFilterState";
import { usePersonScopeIds } from "../persons/usePersonScopeIds";
import { ANOMALY_CODES, anomalySummary, detectAnomalies } from "./anomalies";
import {
  EVENT_COLUMNS,
  EVENT_PAGE_SIZE,
  eventDateLabel,
  eventOwnerId,
  eventPersonIds,
  eventTypeLabel,
  eventYearBounds,
  filterEventRows,
  isEventSortKey,
  isEventType,
  isYearRangeInvalid,
  type EventPersonScope,
  paginateEventRows,
  readEventColumns,
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

/** Splitter bounds in percent of the layout width. */
const EVENTS_SPLITTER: SplitterBounds = {
  defaultWidth: 62,
  min: 35,
  max: 75,
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

const useStyles = makeStyles({
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
  /** Jump to the timeline with the current filters and search. */
  onOpenTimeline?: () => void;
};

export default function EventsPage({
  projectId,
  focusPersonId,
  onFocusHandled,
  focusEventId,
  onEventFocusHandled,
  onOpenPerson,
  onRequestNewPerson,
  onOpenTimeline,
}: Props) {
  const { t, i18n } = useTranslation([
    "event",
    "common",
    "enums",
    "person",
    "project",
  ]);
  const formatDate = useDateFormatter();
  const toast = useToast();
  const styles = useStyles();
  const { state: view, patch } = useViewState(projectId, "events");
  // Query and the person/type/year filters live in the shared section, so the
  // map and timeline see the same values once they use this header.
  const sharedFilters = useEventFilterState(projectId);
  const { setFilter: setSharedFilter, reset: resetSharedFilters } =
    sharedFilters;

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
  const [validationReport, setValidationReport] =
    useState<ValidationReport | null>(null);
  const [validationBusy, setValidationBusy] = useState(false);
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
  const debouncedQuery = useDebouncedValue(sharedFilters.query);

  /* ---------- master-detail splitter ---------- */

  // The width is layout state, not a filter: it lives next to the filters and
  // survives a reset because `clearEventFilterValues` keeps unknown keys.
  const commitListWidth = (stored: string) => {
    patch((previous) => ({
      ...previous,
      filters: { ...previous.filters, listWidth: stored },
    }));
  };

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
    setSharedFilter("personId", focusPersonId);
    patch({ page: 0, selectedId: null });
    onFocusHandled?.();
  }, [focusPersonId, onFocusHandled, patch, setSharedFilter]);

  // Deep link from the validation report: the issue points at an event. Drop
  // the search and every filter that could hide it, then hand the id to the
  // existing `focusRequestId` path, which picks the page and the row.
  useEffect(() => {
    if (!focusEventId) return;
    resetSharedFilters();
    patch({ page: 0, selectedId: null });
    setFocusRequestId(focusEventId);
    onEventFocusHandled?.();
  }, [focusEventId, onEventFocusHandled, patch, resetSharedFilters]);

  /* ---------- derived list ---------- */

  // `patch` rebuilds the filters/sort objects on every state write (including
  // scroll offsets), so memoise on serialised values instead of identities.
  const filterSignature = useMemo(
    () => JSON.stringify(view.filters),
    [view.filters],
  );
  const filters = sharedFilters.filters;
  const scopePersonIds = usePersonScopeIds(
    filters.personId,
    filters.personScope,
  );
  // The search text is not counted: it has its own clear button, and the reset
  // row should not appear for typing alone.
  const activeFilterCount = sharedFilters.activeCount;
  const storedColumns = useMemo(
    () => readEventColumns(view.filters),
    [filterSignature],
  );

  const personsById = useMemo(
    () => new Map(persons.map((item) => [item.entity.id, item.entity])),
    [persons],
  );

  // A stored person filter can outlive its person (deleted here or imported
  // from another tree). Drop it as soon as this project's people are known.
  const knownPersonIds = useMemo(
    () => new Set(personsById.keys()),
    [personsById],
  );
  usePruneEventPersonFilter(
    filters,
    knownPersonIds,
    sharedFilters.setFilter,
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

  // Search and the person sort still see everyone in the event, while the
  // «person» column itself renders only the owner (see `eventOwnerId`).
  const eventPeople = useCallback(
    (event: EventEntity): string =>
      eventPersonIds(event).map(personName).join(", "),
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
    () =>
      filterEventRows(
        events,
        debouncedQuery,
        filters,
        rowContext,
        scopePersonIds,
      ),
    [events, debouncedQuery, filters, rowContext, scopePersonIds],
  );

  const sorted = useMemo(
    () => sortEventRows(filtered, sort, rowContext),
    [filtered, sort, rowContext],
  );

  const page = useMemo(
    () => paginateEventRows(sorted, view.page),
    [sorted, view.page],
  );

  // The card follows the persisted selection, so a deep link that sets
  // `selectedId` opens it even when the row is on another page.
  const selectedRow = useMemo(
    () => events.find((row) => row.entity.id === view.selectedId) ?? null,
    [events, view.selectedId],
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
        scopePersonIds,
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

  // The badge is the shortcut to the same report the check screen shows; the
  // popup reuses its body instead of leaving the events screen.
  const openValidation = async () => {
    setValidationBusy(true);
    try {
      setValidationReport(await projectsApi.validate());
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setValidationBusy(false);
    }
  };

  /* ---------- filters ---------- */

  const handleQueryChange = (value: string) => {
    sharedFilters.setQuery(value);
    patch({ page: 0 });
  };

  const handlePersonFilter = (personId: string) => {
    setSharedFilter("personId", personId);
    patch({ page: 0 });
  };

  const handlePersonScope = (scope: EventPersonScope) => {
    setSharedFilter("personScope", scope);
    patch({ page: 0 });
  };

  const handleTypeFilter = (types: string[]) => {
    setSharedFilter("types", types.filter(isEventType));
    patch({ page: 0 });
  };

  const handleFromYear = (value: string) => {
    setSharedFilter("fromYear", value);
    patch({ page: 0 });
  };

  const handleToYear = (value: string) => {
    setSharedFilter("toYear", value);
    patch({ page: 0 });
  };

  // A stored `from` later than `to` can only come from the old number inputs;
  // the slider cannot draw that pair, so swap the bounds once after loading.
  useEffect(() => {
    if (!isYearRangeInvalid(filters.fromYear, filters.toYear)) return;
    setSharedFilter("fromYear", filters.toYear);
    setSharedFilter("toYear", filters.fromYear);
    patch({ page: 0 });
  }, [filters.fromYear, filters.toYear, patch, setSharedFilter]);

  const resetFilters = () => {
    sharedFilters.reset();
    patch({ page: 0 });
  };

  const toggleSort = (key: EventSortKey) => {
    const direction = nextSortDirection(key, sort.key, sort.direction);
    patch({ sort: { key, direction }, page: 0 });
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

  const personEntities = useMemo(
    () => persons.map((item) => item.entity),
    [persons],
  );

  return (
    <>
      <PageShell
        className="events-page"
        headerClassName="events-head"
        titleGroupClassName="events-head-title"
        actionsClassName="events-head-actions"
        title={t("event:title")}
        titleAside={
          <Badge appearance="tint" color="informative" size="small">
            {t("event:count", { count: events.length })}
          </Badge>
        }
        actions={
          anomalyCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="events-anomalies"
              onClick={() => void openValidation()}
              loading={validationBusy}
              title={anomalyTitle}
              aria-label={`${t("event:anomaly.check")}. ${anomalyTitle}`}
            >
              <WarningRegular aria-hidden="true" />
              {t("event:anomaly.count", { count: anomalyCount })}
            </Button>
          ) : undefined
        }
      >

      <CollectionShell
        storedWidth={view.filters.listWidth}
        onCommitWidth={commitListWidth}
        bounds={EVENTS_SPLITTER}
        splitterLabel={t("event:resizeList")}
        listLabel={t("event:title")}
        layoutClassName="events-layout"
        listClassName="events-panel"
        splitterClassName="events-splitter"
        detailAs="section"
        detailPanel
        detailClassName="events-panel events-card-panel"
        toolbar={
          <div className="events-toolbar">
            <div className="events-toolbar-row">
              <EventFilterHeader
                query={sharedFilters.query}
                onQueryChange={handleQueryChange}
                onReset={resetFilters}
                loading={loading}
                personId={filters.personId}
                onPersonChange={handlePersonFilter}
                personScope={filters.personScope}
                onPersonScopeChange={handlePersonScope}
                persons={personEntities}
                photos={photos}
                types={filters.types}
                onTypesChange={handleTypeFilter}
                fromYear={filters.fromYear}
                toYear={filters.toYear}
                onFromYearChange={handleFromYear}
                onToYearChange={handleToYear}
                yearBounds={yearBounds}
                resultLabel={t("common:filters.found", {
                  count: filtered.length,
                  total: events.length,
                })}
                activeCount={activeFilterCount}
              />
            <div className="events-toolbar-actions">
              {onOpenTimeline ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenTimeline}
                >
                  {t("event:openTimeline")}
                </Button>
              ) : null}
              <ColumnMenu
                label={t("event:columns.title")}
                items={columnItems}
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
        }
        banner={
          <>
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
          </>
        }
        footer={
            <Pager
              className="events-pager"
              page={page.page}
              totalPages={page.totalPages}
              label={`${t("common:page", { page: page.page + 1 })} / ${page.totalPages}`}
              previousLabel={t("common:actions.previous")}
              nextLabel={t("common:actions.next")}
              disabled={busy}
              onPageChange={(next) => patch({ page: next })}
            />
        }
        detail={
          selectedRow ? (
              <EventCard
                event={selectedRow}
                persons={personEntities}
                onEdit={() => startEdit(selectedRow)}
                onClose={() => patch({ selectedId: null })}
              />
          ) : undefined
        }
      >
        {loading && events.length === 0 ? (
          <>
            <p className="ui-sr-only" role="status">
              {t("common:loading")}
            </p>
            <div className="events-table-wrap" aria-hidden="true">
              <DataTable>
                <DataTableColgroup
                  columns={columns}
                  widths={columnWidths}
                  columnClassName={(column) => `events-col events-col-${column}`}
                />
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
              </DataTable>
            </div>
          </>
        ) : events.length === 0 ? (
          <EmptyState
            compact
            text={t("event:empty")}
            // With people in the project the header already offers
            // "New event"; only the no-people case needs its own action.
            actionLabel={
              persons.length === 0 ? t("event:createPerson") : undefined
            }
            onAction={persons.length === 0 ? onRequestNewPerson : undefined}
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
              <DataTable ariaLabel={t("event:title")}>
                <DataTableColgroup
                  columns={columns}
                  widths={columnWidths}
                  columnClassName={(column) => `events-col events-col-${column}`}
                />
                <TableHeader>
                  <TableRow>
                    <SelectionHeaderCell
                      checked={
                        allPageSelected
                          ? true
                          : somePageSelected
                            ? "mixed"
                            : false
                      }
                      onChange={togglePageSelected}
                      label={t("common:bulk.selectAll")}
                    />
                    {columns.includes("date") ? (
                      <HeaderCell
                        direction={sort.key === "date" ? sort.direction : undefined}
                        onSort={() => toggleSort("date")}
                        aside={columnHandle("date")}
                      >
                        {t("event:date")}
                      </HeaderCell>
                    ) : null}
                    {columns.includes("type") ? (
                      <HeaderCell
                        direction={sort.key === "type" ? sort.direction : undefined}
                        onSort={() => toggleSort("type")}
                        aside={columnHandle("type")}
                      >
                        {t("event:type")}
                      </HeaderCell>
                    ) : null}
                    {columns.includes("person") ? (
                      <HeaderCell
                        direction={
                          sort.key === "person" ? sort.direction : undefined
                        }
                        onSort={() => toggleSort("person")}
                        aside={columnHandle("person")}
                      >
                        {t("event:person")}
                      </HeaderCell>
                    ) : null}
                    {columns.includes("place") ? (
                      <HeaderCell aside={columnHandle("place")}>
                        {t("event:place")}
                      </HeaderCell>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.rows.map((row) => {
                    const entity = row.entity;
                    const TypeIcon = EVENT_TYPE_ICONS[entity.type];
                    const codes = anomalies.get(entity.id);
                    const anomalyLabel = codes
                      ? codes
                          .map((code) => t(`event:anomaly.codes.${code}`))
                          .join("; ")
                      : null;
                    const selected = view.selectedId === entity.id;
                    const ownerId = eventOwnerId(entity);
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
                        }}
                      >
                        <SelectionCell
                          checked={selectedSet.has(entity.id)}
                          onChange={(checked) =>
                            toggleSelected(entity.id, checked)
                          }
                          label={t("common:bulk.selectEvent", {
                            name: `${eventTypeLabel(
                              entity.type,
                              entity.originalType,
                              t,
                            )} ${dateText}`,
                          })}
                        />
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
                              <EventPersonCell
                                ownerId={ownerId}
                                name={
                                  ownerId === null ? "" : personName(ownerId)
                                }
                                onOpenPerson={onOpenPerson}
                              />
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
              </DataTable>
            </div>

          </>
        )}
      </CollectionShell>
      </PageShell>

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

      <Dialog
        open={validationReport !== null}
        size="md"
        title={t("project:validate")}
        onClose={() => setValidationReport(null)}
        footer={
          <Button
            variant="secondary"
            onClick={() => setValidationReport(null)}
          >
            {t("common:actions.close")}
          </Button>
        }
      >
        {validationReport ? (
          <ValidationSummary
            report={validationReport}
            locale={i18n.language}
            emptyLabel={t("project:emptyValue")}
            onOpenEvent={(eventId) => {
              const target = events.find((row) => row.entity.id === eventId);
              if (!target) return;
              setValidationReport(null);
              startEdit(target);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}
