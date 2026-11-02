import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AddRegular,
  ArrowDownRegular,
  ArrowUpRegular,
  CheckmarkRegular,
  HistoryRegular,
  OrganizationRegular,
  SettingsRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
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
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { personsApi } from "../../api/client";
import type {
  ParentRef,
  Person,
  PersonDetail,
  Versioned,
} from "../../api/types";
import { FilterBar, type FilterChipModel } from "../../components/filters/FilterBar";
import { BulkBar } from "../../components/ui/bulk-bar";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty";
import { IconButton } from "../../components/ui/icon-button";
import { MenuButton, type MenuItem } from "../../components/ui/menu";
import { useToast } from "../../components/ui/toast";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { EMPTY_VALUE } from "../../lib/formatValue";
import {
  columnResizeHandle,
  columnWidthStyle,
  useColumnWidths,
} from "../../lib/tableColumns";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useScrollMemory, useViewState } from "../../lib/useViewState";
import type { ViewFilters } from "../../lib/viewState";
import PersonCard from "./PersonCard";
import PersonForm from "./PersonForm";
import {
  PERSON_NAVIGATION_ACTIONS,
  personNavigationLabelKey,
  type PersonNavigationAction,
} from "./actions";
import {
  ageInCompletedYears,
  ageTone,
  displayName,
  filterPersons,
  lifeYears,
  parentEntries,
  parentSummary,
  sortPersons,
  type PersonSort,
  type PersonSortDirection,
} from "./helpers";
import "./persons.css";

const PAGE_SIZE = 25;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];
const SKELETON_CELLS = [0, 1, 2, 3, 4];

/** Splitter bounds in percent of the layout width. */
const LIST_WIDTH_DEFAULT = 58;
const LIST_WIDTH_MIN = 35;
const LIST_WIDTH_MAX = 75;

/** Table columns in canonical order; "name" is always visible. */
const PERSON_COLUMNS = ["name", "years", "age", "parents", "actions"] as const;
type PersonColumn = (typeof PERSON_COLUMNS)[number];

const COLUMN_LABEL_KEYS: Record<PersonColumn, string> = {
  name: "person:colName",
  years: "person:colYears",
  age: "person:age",
  parents: "person:colParents",
  actions: "common:fields.actions",
};

/** Layout keys live next to the filters but survive a filter reset. */
const LAYOUT_FILTER_KEYS = ["columns", "columnsVersion", "listWidth"] as const;

/** Bumped when a new column must appear in layouts saved before it existed. */
const PERSON_COLUMNS_VERSION = "2";

function layoutFilters(filters: ViewFilters): ViewFilters {
  const next: ViewFilters = {};
  for (const key of LAYOUT_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/** Stored column choice, or every column when the user never chose. */
function readPersonColumns(filters: ViewFilters): PersonColumn[] {
  const raw = filters.columns;
  if (!Array.isArray(raw)) return [...PERSON_COLUMNS];
  const known = PERSON_COLUMNS.filter((column) => raw.includes(column));
  if (!known.includes("name")) known.unshift("name");
  // "age" arrived after layouts were first stored: show it once for those, then
  // respect the user's own choice (the version is written on the next toggle).
  if (
    filters.columnsVersion !== PERSON_COLUMNS_VERSION &&
    !known.includes("age")
  ) {
    const afterYears = known.indexOf("years");
    known.splice(afterYears >= 0 ? afterYears + 1 : 1, 0, "age");
  }
  return known;
}

function clampListWidth(value: number): number {
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, value));
}

/** Stored splitter position in percent, clamped to the allowed range. */
function readListWidth(filters: ViewFilters): number {
  const raw = filters.listWidth;
  if (typeof raw !== "string" || raw === "") return LIST_WIDTH_DEFAULT;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? clampListWidth(parsed) : LIST_WIDTH_DEFAULT;
}

/** Direction arrow of the active sort column. */
function SortIcon({ direction }: { direction: PersonSortDirection }) {
  return direction === "asc" ? (
    <ArrowUpRegular fontSize={12} aria-hidden="true" />
  ) : (
    <ArrowDownRegular fontSize={12} aria-hidden="true" />
  );
}

type Props = {
  projectId: string;
  focusPersonId?: string | null;
  onFocusHandled?: () => void;
  onNavigate: (action: PersonNavigationAction, personId: string) => void;
  /** Optional: the shell may pass the project's home person for kinship. */
  homePersonId?: string | null;
};

type Editing = { person: Person; version: string };

// Fluent owns the table chrome; the page only keeps what is specific to this
// list: a sticky header inside the scrolling panel and the column widths.
// The columns menu can hide columns, so the widths live in a `colgroup` that
// is rebuilt from the visible set (Fluent already uses `table-layout: fixed`):
// name and parents share the remaining space, years and the action icons get
// a fixed width, and every cell clips instead of pushing its neighbour. A
// stored width overrides the CSS default on the matching `<col>`, and the
// handle in the header's `aside` slot edits it.
const useStyles = makeStyles({
  table: {
    "& th": {
      position: "sticky",
      top: 0,
      zIndex: 1,
      backgroundColor: tokens.colorNeutralBackground1,
    },
    // Fixed layout: a long name or parent list is clipped, never overlapped.
    "& td, & th": {
      overflow: "hidden",
    },
  },
  row: {
    cursor: "pointer",
  },
  selectedRow: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Selected,
    },
  },
  yearsLayout: {
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
  },
  // The sortable header cell owns a flex button; keep the label on the start
  // edge like every other header.
  sortButton: {
    justifyContent: "flex-start",
  },
  /** Fixed widths; a column without a width takes the remaining space. */
  colYears: {
    width: "9rem",
  },
  colAge: {
    width: "5rem",
  },
  colActions: {
    width: "6rem",
  },
  actionsCell: {
    whiteSpace: "nowrap",
  },
  detailSkeleton: {
    display: "grid",
    rowGap: tokens.spacingVerticalS,
  },
  skeletonTitle: {
    width: "45%",
  },
});

/** Remount on project change so the debounced query starts from that project. */
export default function PersonsPage(props: Props) {
  return <PersonsView key={props.projectId} {...props} />;
}

function PersonsView({
  projectId,
  focusPersonId,
  onFocusHandled,
  onNavigate,
  homePersonId = null,
}: Props) {
  const { t } = useTranslation(["person", "common", "enums"]);
  const styles = useStyles();
  const toast = useToast();
  const { state, patch } = useViewState(projectId, "persons");
  const [today] = useState(() => new Date());

  const [queryInput, setQueryInput] = useState(state.query);
  const debouncedQuery = useDebouncedValue(queryInput, 250);
  const lastDebounced = useRef(debouncedQuery);

  const [all, setAll] = useState<Versioned<Person>[]>([]);
  const [totalPersons, setTotalPersons] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [parents, setParents] = useState<Record<string, ParentRef[]>>({});
  /** Bumped after a relationship change so the parent column reloads even when
   * the page is the same; `pageKey` alone would keep the stale batch. */
  const [parentsVersion, setParentsVersion] = useState(0);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  /** The side card can open in a window of its own for a full-width read. */
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const detailRequest = useRef(0);

  // Persisted layout (columns + splitter position) lives in the section's
  // filters map, so it survives tab switches and app restarts per project.
  const [columns, setColumns] = useState<PersonColumn[]>(() =>
    readPersonColumns(state.filters),
  );
  const [listWidth, setListWidth] = useState(() => readListWidth(state.filters));
  const [resizing, setResizing] = useState(false);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;

  // Newest first by default; a stored choice always wins over the default.
  const storedSort = state.sort;
  const sortKey: PersonSort =
    storedSort?.key === "birth" ||
    storedSort?.key === "death" ||
    storedSort?.key === "age"
      ? storedSort.key
      : storedSort
        ? "name"
        : "birth";
  const direction: PersonSortDirection = storedSort?.direction ?? "desc";

  const loadAll = useCallback(async () => {
    if (projectId === "") {
      setListLoading(false);
      return;
    }
    setListLoading(true);
    try {
      const page = await personsApi.listAll({ sort: "name" });
      setAll(page.items);
      setTotalPersons(page.total);
      setError(null);
    } catch (caught) {
      setAll([]);
      setTotalPersons(0);
      setError(normalizeError(caught));
    } finally {
      setListLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Live search: only a changed debounced value updates the persisted query.
  useEffect(() => {
    if (lastDebounced.current === debouncedQuery) return;
    lastDebounced.current = debouncedQuery;
    patch({ query: debouncedQuery, page: 0 });
  }, [debouncedQuery, patch]);

  const allPersons = useMemo(() => all.map((item) => item.entity), [all]);
  const filtered = useMemo(
    () => filterPersons(allPersons, state.query),
    [allPersons, state.query],
  );
  const sorted = useMemo(
    () => sortPersons(filtered, sortKey, direction),
    [filtered, sortKey, direction],
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(state.page, totalPages - 1);
  const items = useMemo(
    () => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [sorted, page],
  );

  useEffect(() => {
    if (state.page > page) patch({ page });
  }, [state.page, page, patch]);

  // One batch call per page instead of a `person_get` per row.
  const pageIds = useMemo(() => items.map((item) => item.id), [items]);
  const pageKey = pageIds.join("|");

  const versionById = useMemo(
    () => new Map(all.map((item) => [item.entity.id, item.version])),
    [all],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allPageSelected =
    items.length > 0 && items.every((item) => selectedSet.has(item.id));
  const somePageSelected = items.some((item) => selectedSet.has(item.id));

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
    setSelectedIds(checked ? items.map((item) => item.id) : []);
  };

  useEffect(() => {
    if (pageIds.length === 0) {
      setParents({});
      return undefined;
    }
    let active = true;
    personsApi
      .parents(pageIds)
      .then((map) => {
        if (active) setParents(map);
      })
      .catch(() => {
        // Auxiliary column: a failed batch never breaks the list.
        if (active) setParents({});
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, parentsVersion]);

  const openDetail = useCallback(
    async (id: string) => {
      const token = detailRequest.current + 1;
      detailRequest.current = token;
      try {
        const next = await personsApi.get(id);
        if (detailRequest.current !== token) return;
        setDetail(next);
        setLoadedId(id);
        setError(null);
        setStale(false);
      } catch (caught) {
        if (detailRequest.current !== token) return;
        const normalized = normalizeError(caught);
        setDetail(null);
        setLoadedId(id);
        if (normalized.code === "NOT_FOUND") {
          patch({ selectedId: null });
        } else {
          setError(normalized);
        }
      }
    },
    [patch],
  );

  useEffect(() => {
    if (!state.selectedId) {
      detailRequest.current += 1;
      setDetail(null);
      setLoadedId(null);
      return;
    }
    void openDetail(state.selectedId);
  }, [state.selectedId, openDetail]);

  // Deep link from search/timeline: select the person, then let the shell clear
  // the one-shot focus so a later visit starts on the remembered selection.
  useEffect(() => {
    if (!focusPersonId) return;
    patch((previous) =>
      previous.selectedId === focusPersonId
        ? previous
        : { ...previous, selectedId: focusPersonId, page: 0 },
    );
    onFocusHandled?.();
  }, [focusPersonId, onFocusHandled, patch]);

  const select = (id: string) => {
    if (id === state.selectedId) return;
    setExpanded(false);
    patch({ selectedId: id });
  };

  /** Close the detail pane: the list takes the whole width again. */
  const closeSelection = () => {
    detailRequest.current += 1;
    setExpanded(false);
    patch({ selectedId: null });
  };

  /* ---------- splitter ---------- */

  const commitListWidth = (value: number) => {
    const next = Math.round(clampListWidth(value));
    setListWidth(next);
    patch((previous) => ({
      ...previous,
      filters: { ...previous.filters, listWidth: String(next) },
    }));
  };

  const widthFromPointer = (clientX: number) => {
    const rect = layoutRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const percent = ((clientX - rect.left) / rect.width) * 100;
    setListWidth(clampListWidth(percent));
  };

  const onSplitterPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    widthFromPointer(event.clientX);
  };

  const onSplitterPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    widthFromPointer(event.clientX);
  };

  const endSplitterDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitListWidth(listWidthRef.current);
  };

  const onSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 5 : 2;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = listWidth - step;
    else if (event.key === "ArrowRight") next = listWidth + step;
    else if (event.key === "Home") next = LIST_WIDTH_MIN;
    else if (event.key === "End") next = LIST_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    commitListWidth(next);
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
  } = useColumnWidths(projectId, "persons");

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
  const columnHandle = (column: PersonColumn) =>
    columnResizeHandle(columnApi, column, t(COLUMN_LABEL_KEYS[column]));

  const toggleColumn = (column: PersonColumn) => {
    // The name column is the minimum: it is always visible.
    if (column === "name") return;
    const next = columns.includes(column)
      ? columns.filter((item) => item !== column)
      : PERSON_COLUMNS.filter(
          (item) => item === column || columns.includes(item),
        );
    setColumns(next);
    patch((previous) => ({
      ...previous,
      filters: {
        ...previous.filters,
        columns: next,
        columnsVersion: PERSON_COLUMNS_VERSION,
      },
    }));
  };

  const columnItems: MenuItem[] = PERSON_COLUMNS.map((column) => {
    const visible = columns.includes(column);
    const mandatory = column === "name";
    return {
      id: column,
      label: t(COLUMN_LABEL_KEYS[column]),
      icon: visible ? (
        <CheckmarkRegular fontSize={16} aria-hidden="true" />
      ) : undefined,
      disabled: mandatory,
      disabledReason: mandatory ? t("person:columnsNameRequired") : undefined,
      onSelect: () => toggleColumn(column),
    };
  });

  const toggleSort = (key: PersonSort) => {
    // `sortKey` already includes the default, so the first click on the
    // highlighted "birth" column flips the visible desc order to asc.
    const active = sortKey === key;
    const next: PersonSortDirection = active
      ? direction === "asc"
        ? "desc"
        : "asc"
      : key === "birth"
        ? "desc"
        : "asc";
    patch({ sort: { key, direction: next }, page: 0 });
  };

  const resetFilters = () => {
    lastDebounced.current = "";
    setQueryInput("");
    // Layout (columns, splitter width) is not a filter: keep it.
    patch((previous) => ({
      ...previous,
      query: "",
      filters: layoutFilters(previous.filters),
      page: 0,
    }));
  };

  const clearQuery = () => {
    lastDebounced.current = "";
    setQueryInput("");
    patch({ query: "", page: 0 });
  };

  const startCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const startEdit = () => {
    if (!detail) return;
    setEditing({ person: detail.person.entity, version: detail.person.version });
    setFormOpen(true);
  };

  const handleSaved = (person: Person) => {
    const wasEditing = editing !== null;
    setFormOpen(false);
    setEditing(null);
    if (!wasEditing) {
      // A newly created person must stay visible and selected.
      lastDebounced.current = "";
      setQueryInput("");
    }
    patch((previous) =>
      wasEditing
        ? { ...previous, selectedId: person.id }
        : {
            ...previous,
            selectedId: person.id,
            page: 0,
            query: "",
            filters: layoutFilters(previous.filters),
          },
    );
    if (wasEditing) void openDetail(person.id);
    void loadAll();
  };

  const refreshSelected = () => {
    if (state.selectedId) void openDetail(state.selectedId);
    setParentsVersion((current) => current + 1);
    void loadAll();
  };

  const deleteSelected = async () => {
    const versioned = detail?.person;
    if (!versioned) return;
    const name = displayName(versioned.entity, t("person:unknownName"));
    if (!window.confirm(t("person:deleteConfirmName", { name }))) return;
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      await personsApi.delete(versioned.entity.id, versioned.version);
      setDetail(null);
      patch({ selectedId: null });
      toast.success(t("person:deleted"));
      await loadAll();
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") setStale(true);
      else setError(normalized);
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
        await personsApi.delete(id, version);
      }),
    );

    const deleted = results.filter((result) => result.status === "fulfilled")
      .length;
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    setSelectedIds([]);
    if (state.selectedId && ids.includes(state.selectedId)) {
      setDetail(null);
      patch({ selectedId: null });
    }
    await loadAll();
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
    void loadAll();
    if (state.selectedId) void openDetail(state.selectedId);
  };

  const onScrollTop = useCallback(
    (value: number) => patch({ scrollTop: value }),
    [patch],
  );
  const scrollRef = useScrollMemory({
    scrollTop: state.scrollTop,
    onScrollTop,
    ready: !listLoading,
  });

  const chips: FilterChipModel[] = [];
  if (state.query.trim() !== "") {
    chips.push({
      id: "query",
      label: t("person:chipQuery", { query: state.query }),
      removeLabel: t("person:chipQueryRemove"),
      onRemove: clearQuery,
    });
  }

  const shownDetail =
    detail && detail.person.entity.id === state.selectedId ? detail : null;
  // Selecting another row must not flash the empty state before the fetch.
  const detailPending =
    state.selectedId !== null && loadedId !== state.selectedId;

  return (
    <section className="panel persons-page">
      <div className="card-head persons-head">
        <div className="persons-head-title">
          <h1 className="page-title">{t("person:title")}</h1>
          <Badge appearance="tint" color="informative" size="small">
            {t("person:count", { count: totalPersons })}
          </Badge>
        </div>
      </div>

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>
            {t(`errors.${error.code}`, { defaultValue: t("errors.UNKNOWN") })}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {stale ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>{t("common:errors.STALE_WRITE")}</MessageBarTitle>
            {t("person:conflict")}
          </MessageBarBody>
          <MessageBarActions>
            <Button variant="secondary" size="sm" onClick={reloadAfterStale}>
              {t("common:actions.reload")}
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      <div
        ref={layoutRef}
        className={[
          "persons-layout",
          state.selectedId ? "" : "persons-layout-solo",
          resizing ? "persons-layout-resizing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={
          { "--persons-list-width": `${listWidth}%` } as CSSProperties
        }
      >
        <section className="panel persons-panel" aria-label={t("person:title")}>
          <div className="persons-toolbar">
            <div className="persons-toolbar-row">
              <FilterBar
                query={queryInput}
                onQueryChange={setQueryInput}
                queryPlaceholder={t("person:searchPlaceholder")}
                queryLabel={t("person:searchLabel")}
                clearLabel={t("person:clearSearch")}
                filtersLabel={t("person:filters")}
                activeCount={chips.length}
                chips={chips}
                onReset={resetFilters}
                resetLabel={t("person:resetFilters")}
                resultLabel={t("common:filters.found", {
                  count: filtered.length,
                  total: totalPersons,
                })}
                loading={false}
                showActiveBadge={false}
                showReset={false}
              />
              <div className="persons-toolbar-actions">
                <MenuButton
                  iconOnly
                  icon={<SettingsRegular fontSize={16} aria-hidden="true" />}
                  label={t("person:columnsTitle")}
                  items={columnItems}
                  align="end"
                />
                <Button
                  variant="primary"
                  data-tour="persons-add"
                  onClick={startCreate}
                >
                  <AddRegular fontSize={16} aria-hidden="true" />
                  {t("person:new")}
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

          <div
            className={
              resizingColumn
                ? "persons-list persons-list-resizing"
                : "persons-list"
            }
            ref={scrollRef}
          >
            {listLoading ? (
              <Table size="small" className={styles.table} aria-busy="true">
                <TableBody>
                  {SKELETON_ROWS.map((row) => (
                    <TableRow key={row}>
                      {SKELETON_CELLS.map((cell) => (
                        <TableCell key={cell}>
                          <Skeleton aria-hidden="true">
                            <SkeletonItem size={16} />
                          </Skeleton>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : items.length === 0 ? (
              <EmptyState
                compact
                text={
                  all.length === 0 ? t("person:empty") : t("person:noMatches")
                }
                actionLabel={
                  all.length === 0 ? t("person:new") : t("person:resetFilters")
                }
                onAction={all.length === 0 ? startCreate : resetFilters}
              />
            ) : (
              <Table size="small" className={styles.table}>
                <colgroup>
                  <col className="bulk-select-col" />
                  {columns.map((column) => (
                    <col
                      key={column}
                      className={
                        column === "years"
                          ? styles.colYears
                          : column === "age"
                            ? styles.colAge
                            : column === "actions"
                              ? styles.colActions
                              : undefined
                      }
                      style={columnWidthStyle(columnWidths, column)}
                    />
                  ))}
                </colgroup>
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
                    {columns.includes("name") ? (
                      <TableHeaderCell
                        sortable
                        sortDirection={
                          sortKey === "name"
                            ? direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        sortIcon={
                          sortKey === "name" ? (
                            <SortIcon direction={direction} />
                          ) : undefined
                        }
                        button={{
                          className: styles.sortButton,
                          onClick: () => toggleSort("name"),
                        }}
                        aside={columnHandle("name")}
                      >
                        {t("person:colName")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("years") ? (
                      <TableHeaderCell
                        sortable
                        sortDirection={
                          sortKey === "birth"
                            ? direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        sortIcon={
                          sortKey === "birth" ? (
                            <SortIcon direction={direction} />
                          ) : undefined
                        }
                        button={{
                          className: styles.sortButton,
                          onClick: () => toggleSort("birth"),
                        }}
                        aside={columnHandle("years")}
                      >
                        {t("person:colYears")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("age") ? (
                      <TableHeaderCell
                        sortable
                        sortDirection={
                          sortKey === "age"
                            ? direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        sortIcon={
                          sortKey === "age" ? (
                            <SortIcon direction={direction} />
                          ) : undefined
                        }
                        button={{
                          className: styles.sortButton,
                          onClick: () => toggleSort("age"),
                        }}
                        aside={columnHandle("age")}
                      >
                        {t("person:age")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("parents") ? (
                      <TableHeaderCell aside={columnHandle("parents")}>
                        {t("person:colParents")}
                      </TableHeaderCell>
                    ) : null}
                    {columns.includes("actions") ? (
                      <TableHeaderCell
                        className={styles.actionsCell}
                        aside={columnHandle("actions")}
                      >
                        {t("common:fields.actions")}
                      </TableHeaderCell>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entity) => {
                    const selected = entity.id === state.selectedId;
                    const entries = parentEntries(parents[entity.id]);
                    const summary = parentSummary(entries);
                    const age = ageInCompletedYears(entity, today);
                    const tone = ageTone(entity, today);
                    return (
                      <TableRow
                        key={entity.id}
                        className={mergeClasses(
                          styles.row,
                          selected && styles.selectedRow,
                        )}
                        aria-selected={selected}
                        onClick={() => select(entity.id)}
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
                            aria-label={t("common:bulk.selectPerson", {
                              name:
                                displayName(entity) || t("person:unknownName"),
                            })}
                          />
                        </TableCell>
                        {columns.includes("name") ? (
                          <TableCell>
                            <TableCellLayout>
                              <button
                                type="button"
                                className="person-name"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  select(entity.id);
                                }}
                              >
                                {displayName(entity) || t("person:unknownName")}
                              </button>
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                        {columns.includes("years") ? (
                          <TableCell>
                            <TableCellLayout className={styles.yearsLayout}>
                              <span className="person-years">
                                {lifeYears(entity)}
                              </span>
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                        {columns.includes("age") ? (
                          <TableCell>
                            <TableCellLayout>
                              {age === null ? (
                                <span className="person-empty">{EMPTY_VALUE}</span>
                              ) : (
                                <span className={`person-age person-age-${tone}`}>
                                  {age}
                                </span>
                              )}
                            </TableCellLayout>
                          </TableCell>
                        ) : null}
                        {columns.includes("parents") ? (
                          <TableCell>
                            {entries.length === 0 ? (
                              <span className="person-empty">{EMPTY_VALUE}</span>
                            ) : (
                              <span className="person-parents">
                                {summary.visible.map((parent) => (
                                  <span
                                    key={parent.id}
                                    className="person-parent"
                                  >
                                    {parent.name || t("person:unknownName")}
                                    {parent.adoptive ? (
                                      <span
                                        className="person-parent-adoptive"
                                        title={t("person:adoptive")}
                                      >
                                        {t("person:adoptiveShort")}
                                      </span>
                                    ) : null}
                                  </span>
                                ))}
                                {summary.extra > 0 ? (
                                  <span className="person-parent-extra">
                                    {t("person:parentsMore", {
                                      extra: summary.extra,
                                    })}
                                  </span>
                                ) : null}
                              </span>
                            )}
                          </TableCell>
                        ) : null}
                        {columns.includes("actions") ? (
                          <TableCell className={styles.actionsCell}>
                            <div className="person-row-actions">
                              {PERSON_NAVIGATION_ACTIONS.map((action) => {
                                const Icon =
                                  action === "tree"
                                    ? OrganizationRegular
                                    : HistoryRegular;
                                const label = t(personNavigationLabelKey(action));
                                return (
                                  <IconButton
                                    key={action}
                                    label={label}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onNavigate(action, entity.id);
                                    }}
                                  >
                                    <Icon fontSize={16} aria-hidden="true" />
                                  </IconButton>
                                );
                              })}
                            </div>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="persons-pager">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0 || listLoading}
              onClick={() => patch({ page: Math.max(0, page - 1) })}
            >
              {t("common:actions.previous")}
            </Button>
            <span className="meta">
              {t("common:page", { page: page + 1 })} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page + 1 >= totalPages || listLoading}
              onClick={() => patch({ page: page + 1 })}
            >
              {t("common:actions.next")}
            </Button>
          </div>
        </section>

        {state.selectedId ? (
          <>
            <div
              className="persons-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("person:resizeList")}
              aria-valuemin={LIST_WIDTH_MIN}
              aria-valuemax={LIST_WIDTH_MAX}
              aria-valuenow={Math.round(listWidth)}
              tabIndex={0}
              onPointerDown={onSplitterPointerDown}
              onPointerMove={onSplitterPointerMove}
              onPointerUp={endSplitterDrag}
              onPointerCancel={endSplitterDrag}
              onKeyDown={onSplitterKeyDown}
              onDoubleClick={() => commitListWidth(LIST_WIDTH_DEFAULT)}
            />

            <aside className="persons-detail">
              {shownDetail ? (
                <PersonCard
                  detail={shownDetail}
                  persons={allPersons}
                  projectId={projectId}
                  homePersonId={homePersonId}
                  onOpenPerson={select}
                  onEdit={startEdit}
                  onDelete={() => void deleteSelected()}
                  onChanged={refreshSelected}
                  onNavigate={onNavigate}
                  onBack={closeSelection}
                  onExpand={() => setExpanded(true)}
                  busy={busy}
                />
              ) : detailPending ? (
                <div
                  className="persons-panel persons-detail-skeleton"
                  aria-busy="true"
                >
                  <Skeleton aria-hidden="true" className={styles.detailSkeleton}>
                    <SkeletonItem size={24} className={styles.skeletonTitle} />
                    <SkeletonItem size={16} />
                    <SkeletonItem size={16} />
                    <SkeletonItem size={16} />
                  </Skeleton>
                </div>
              ) : (
                <div className="persons-panel persons-detail-empty">
                  <EmptyState compact text={t("person:selectPrompt")} />
                </div>
              )}
            </aside>
          </>
        ) : null}
      </div>

      {formOpen ? (
        <PersonForm
          key={editing?.person.id ?? "new"}
          initial={editing?.person ?? null}
          version={editing?.version ?? null}
          onSaved={handleSaved}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onReload={() => {
            setFormOpen(false);
            setEditing(null);
            reloadAfterStale();
          }}
        />
      ) : null}

      {expanded && shownDetail ? (
        <Dialog
          open
          size="full"
          titleHidden
          title={displayName(shownDetail.person.entity)}
          busy={busy}
          onClose={() => setExpanded(false)}
        >
          <div className="person-window">
            <PersonCard
              detail={shownDetail}
              persons={allPersons}
              projectId={projectId}
              homePersonId={homePersonId}
              onOpenPerson={select}
              onEdit={startEdit}
              onDelete={() => void deleteSelected()}
              onChanged={refreshSelected}
              onNavigate={onNavigate}
              onBack={() => setExpanded(false)}
              busy={busy}
            />
          </div>
        </Dialog>
      ) : null}

      <Dialog
        open={bulkDeleteOpen}
        size="sm"
        title={t("common:bulk.deletePeopleTitle")}
        description={t("common:bulk.deletePeopleConfirm", {
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
        <p className="bulk-hint">{t("common:bulk.deletePeopleHint")}</p>
      </Dialog>
    </section>
  );
}
