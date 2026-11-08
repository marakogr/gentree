import { makeStyles, tokens } from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ArrowSyncRegular,
  CalendarLtrRegular,
  DismissRegular,
  QuestionCircleRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { eventsApi, mediaApi, personsApi, timelineApi } from "../../api/client";
import type {
  MediaItem,
  Person,
  TimelineEntry,
  TimelineScope,
} from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import type { Translate } from "../../lib/dates";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { cn } from "../../lib/utils";
import { useScrollMemory, useViewState } from "../../lib/useViewState";
import {
  useEventFilterState,
  usePruneEventPersonFilter,
} from "../events/useEventFilterState";
import {
  eventYearBounds,
  matchesEventQuery,
  type EventPersonScope,
} from "../events/helpers";
import { ActiveFilterNotice } from "../events/ActiveFilterNotice";
import { photosByPerson } from "../media/helpers";
import { displayName } from "../persons/helpers";
import { toTimelineEvents } from "./adapter";
import type { TimelineWindow } from "./dates";
import { EventPopover } from "./EventPopover";
import { EventFilterRow } from "../events/EventFilterRow";
import { TimelineGenerations } from "./filters";
import { eventTypeLabel } from "./format";
import { useTimelineTranslate } from "./i18n";
import {
  buildLineMarkers,
  clampWindow,
  computeMarkerWindow,
  markerDomain,
  partitionLineEvents,
  personEventIds,
  positionOnLine,
  relatedEventIds,
} from "./line";
import {
  LineCanvas,
} from "./LineCanvas";
import {
  canRequestScope,
  clampGenerations,
  createLineRequestGuard,
  scopeLabel,
  scopeRequiresPerson,
} from "./scope";
import type { TimelineEvent } from "./types";
import {
  buildTimelineListParams,
  resetTimelineView,
  resolveInitialTimelineView,
  timelineViewPatch,
  type TimelineView,
} from "./view";

type LineStatus = "idle" | "loading" | "ready" | "empty" | "error";

interface LineState {
  status: LineStatus;
  dated: TimelineEntry[];
  undated: TimelineEntry[];
  truncated: boolean;
  scopeTruncated: boolean;
  error: AppErrorEnvelope | null;
}

const IDLE_LINE: LineState = {
  status: "idle",
  dated: [],
  undated: [],
  truncated: false,
  scopeTruncated: false,
  error: null,
};

// Fluent tokens only; the screen keeps its own layout classes. `tokens.colorBrandForegroundInverted`
// is the teal accent that still passes AA on a neutral surface (brandForeground1 is 2.99:1
// with this ramp).
const useStyles = makeStyles({
  muted: {
    color: tokens.colorNeutralForeground2,
  },
  surface: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  dashedSurface: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
  },
  popover: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
  quietButton: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: "transparent",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  iconButton: {
    color: tokens.colorNeutralForeground2,
    backgroundColor: "transparent",
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  errorIcon: {
    color: tokens.colorStatusDangerForeground1,
  },
  neutralIcon: {
    color: tokens.colorNeutralForeground2,
  },
  // Undated table: Fluent tokens keep the sticky header opaque while the body
  // scrolls underneath it.
  tableHead: {
    backgroundColor: tokens.colorNeutralBackground1,
  },
  tableRow: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rowHover: {
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
});

function formatWindowRange(
  window: TimelineWindow | null,
  t: Translate,
): string {
  if (window === null) {
    return t("line.rangeUnknown");
  }
  const from = window.start.getFullYear();
  const to = window.end.getFullYear();
  return from === to ? String(from) : `${from}–${to}`;
}

/** True when every field of the patch already has the value it would write. */
function isNoopViewPatch(
  previous: TimelineView,
  patch: Partial<TimelineView>,
): boolean {
  return (Object.keys(patch) as Array<keyof TimelineView>).every(
    (key) => previous[key] === patch[key],
  );
}

function PageMessage({
  title,
  children,
  tone = "neutral",
  retry,
  retryLabel,
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "error";
  retry?: () => void;
  retryLabel?: string;
}) {
  const styles = useStyles();
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      {tone === "error" ? (
        <WarningRegular
          fontSize={20}
          className={styles.errorIcon}
          aria-hidden="true"
        />
      ) : (
        <CalendarLtrRegular
          fontSize={20}
          className={styles.neutralIcon}
          aria-hidden="true"
        />
      )}
      <p className="text-sm font-medium">{title}</p>
      <div className={cn("max-w-md text-xs leading-relaxed", styles.muted)}>
        {children}
      </div>
      {retry !== undefined && (
        <button
          type="button"
          onClick={retry}
          className={cn(
            styles.quietButton,
            "inline-flex h-7 items-center gap-1 rounded-md px-2.5 py-0 text-[11px]",
          )}
        >
          <ArrowClockwiseRegular fontSize={14} aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

function eventTitle(event: TimelineEvent, t: Translate): string {
  return event.title?.trim() || eventTypeLabel(event.type, t);
}

function eventPersonLabel(
  event: TimelineEvent,
  t: Translate,
): string | null {
  if (event.participants.length === 0) {
    return null;
  }
  // Undated rows list every participant: a marriage has two, and dropping the
  // second one would misrepresent the event.
  return event.participants
    .map((participant) => {
      const parts = [participant.firstName, participant.lastName].filter(
        (part): part is string => part !== null && part.trim().length > 0,
      );
      return parts.length > 0 ? parts.join(" ") : t("unnamedPerson");
    })
    .join(", ");
}

type Props = {
  projectName: string;
  /**
   * Project key for the persisted view state. App passes the real id; when it
   * is absent, the unique project name is a stable per-project key.
   */
  projectId?: string;
  /** One-shot focus requested by another screen (person row/card). */
  initialScope?: TimelineScope;
  initialPersonId?: string | null;
  onOpenPerson: (personId: string) => void;
  onOpenEvent?: (eventId: string) => void;
};

export default function TimelinePage({
  projectName,
  projectId,
  initialScope = "all",
  initialPersonId = null,
  onOpenPerson,
  onOpenEvent,
}: Props) {
  const t = useTimelineTranslate();
  const styles = useStyles();
  const viewKey = projectId ?? projectName;
  const { state: storedView, patch: patchView } = useViewState(
    viewKey,
    "timeline",
  );
  // Event types are shared with the events and map screens.
  const eventFilters = useEventFilterState(viewKey);
  const eventTypes = eventFilters.filters.types;
  const sharedPersonId = eventFilters.filters.personId;
  const sharedPersonScope = eventFilters.filters.personScope;
  const sharedFromYear = eventFilters.filters.fromYear;
  const sharedToYear = eventFilters.filters.toYear;
  const sharedQuery = eventFilters.query;
  const activeFilterCount = eventFilters.activeCount;
  const { setFilter: setSharedFilter } = eventFilters;

  // The stored view is the base; a one-shot person deep link from another
  // screen overrides the focus for this mount only.
  const [view, setView] = useState<TimelineView>(() =>
    resolveInitialTimelineView({
      stored: storedView,
      initialScope,
      initialPersonId,
    }),
  );
  const {
    scope,
    personId,
    generations,
  } = view;

  // Deep link from another screen: seed the shared person filter once, then
  // the sync effect below turns it into the timeline focus.
  useEffect(() => {
    if (!initialPersonId) return;
    setSharedFilter("personId", initialPersonId);
    setSharedFilter(
      "personScope",
      initialScope === "ancestors" ||
        initialScope === "descendants" ||
        initialScope === "both"
        ? initialScope
        : "person",
    );
  }, [initialPersonId, initialScope, setSharedFilter]);

  // The person and the relation are the same filter as on the events/map
  // screens: opening the timeline keeps the chosen person and scope.
  useEffect(() => {
    const nextPersonId = sharedPersonId === "" ? null : sharedPersonId;
    const nextScope: TimelineScope =
      sharedPersonId === "" ? "all" : sharedPersonScope;
    setView((previous) =>
      previous.personId === nextPersonId && previous.scope === nextScope
        ? previous
        : { ...previous, personId: nextPersonId, scope: nextScope },
    );
  }, [sharedPersonId, sharedPersonScope]);

  // Every view change is persisted by the section view state hook.
  useEffect(() => {
    patchView(timelineViewPatch(view));
  }, [patchView, view]);

  const applyView = useCallback((patch: Partial<TimelineView>) => {
    // A click that repeats the current value must not re-render the screen or
    // reach the persisted view state; identical patches stay a no-op.
    setView((previous) =>
      isNoopViewPatch(previous, patch) ? previous : { ...previous, ...patch },
    );
  }, []);

  const [line, setLine] = useState<LineState>(IDLE_LINE);
  // Only the newest `timeline_list` response may write the line: two quick
  // scope clicks can resolve out of order.
  const [requestGuard] = useState(createLineRequestGuard);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [window, setWindow] = useState<TimelineWindow | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [persons, setPersons] = useState<Person[]>([]);
  const [photos, setPhotos] = useState<ReadonlyMap<string, MediaItem>>(
    () => new Map(),
  );
  // Scale of the shared year filter: the whole project, never the filtered line,
  // so a range that hides every event can still be widened (issue #107).
  const [yearScale, setYearScale] = useState(() => {
    const currentYear = new Date().getFullYear();
    return { minYear: currentYear, maxYear: currentYear, hasDated: false };
  });

  /** Backend rows may send `personGender`; the loaded list is the fallback. */
  const genderById = useMemo(
    () => new Map(persons.map((person) => [person.id, person.gender] as const)),
    [persons],
  );
  const nameById = useMemo(
    () =>
      new Map(
        persons.map((person) => [
          person.id,
          displayName(person, t("unknownPerson")),
        ]),
      ),
    [persons, t],
  );

  // A stored person filter can outlive its person (deleted here or copied from
  // another tree): drop it once this project's people are loaded.
  const knownPersonIds = useMemo(
    () => new Set(persons.map((person) => person.id)),
    [persons],
  );
  usePruneEventPersonFilter(
    eventFilters.filters,
    knownPersonIds,
    eventFilters.setFilter,
  );

  const focus = useMemo(
    () =>
      buildTimelineListParams(
        view,
        eventTypes,
        sharedFromYear,
        sharedToYear,
      ),
    // Only these fields reach the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, personId, generations, eventTypes, sharedFromYear, sharedToYear],
  );
  const focusKey = `${scope}|${personId ?? ""}|${generations}|${eventTypes.join(",")}|${sharedFromYear}|${sharedToYear}`;
  const lastFocusRef = useRef<string | null>(null);
  const requestable = canRequestScope({ scope, personId, generations });

  useEffect(() => {
    let active = true;
    Promise.all([
      personsApi.list({ limit: 1000, sort: "name" }),
      // Photos are decoration: a media failure must not hide the picker.
      mediaApi.list().catch(() => [] as MediaItem[]),
    ])
      .then(([page, media]) => {
        if (active) {
          setPersons(page.items.map((item) => item.entity));
          setPhotos(photosByPerson(media));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // The year filter is shared with the events screen. Load the project's scale
  // once so this screen can show the same control and let the user widen a
  // range that hides every event; a failure keeps the filter row without a
  // slider instead of hiding the line.
  useEffect(() => {
    let active = true;
    eventsApi
      .list({})
      .then((rows) => {
        if (!active) return;
        setYearScale(eventYearBounds(rows, new Date().getFullYear()));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const focusChanged = lastFocusRef.current !== focusKey;
    lastFocusRef.current = focusKey;
    if (focusChanged) {
      setSelectedEventId(null);
    }
    setWindow(null);
    // Any focus, even an incomplete one, supersedes a request in flight.
    const requestId = requestGuard.begin();
    if (!requestable) {
      setLine({ ...IDLE_LINE, status: "idle" });
      return;
    }

    let active = true;
    setLine({ ...IDLE_LINE, status: "loading" });

    timelineApi
      .list(focus)
      .then((result) => {
        if (!active || !requestGuard.accepts(requestId)) {
          return;
        }
        const status: LineStatus =
          result.dated.length === 0 && result.undated.length === 0
            ? "empty"
            : "ready";
        setLine({
          status,
          dated: result.dated,
          undated: result.undated,
          truncated: result.truncated,
          scopeTruncated: result.scopeTruncated,
          error: null,
        });

        const partitioned = partitionLineEvents(
          toTimelineEvents(result.dated, undefined, nameById),
          toTimelineEvents(result.undated, undefined, nameById),
        );
        setWindow(
          computeMarkerWindow(buildLineMarkers(partitioned.dated, t)),
        );
      })
      .catch((caught: unknown) => {
        if (active && requestGuard.accepts(requestId)) {
          setLine({
            ...IDLE_LINE,
            status: "error",
            error: normalizeError(caught),
          });
        }
      });

    return () => {
      active = false;
    };
  }, [focus, focusKey, reloadKey, requestable, requestGuard, t, nameById]);

  // The search text is shared with the events screen; the line filters rows
  // client-side because the command has no text query.
  const query = sharedQuery.trim();
  const matchesQuery = useCallback(
    (entry: TimelineEntry) =>
      query === "" ||
      matchesEventQuery(
        entry.event,
        {
          personName: entry.personName,
          typeLabel: eventTypeLabel(entry.event.type, t),
        },
        query,
      ),
    [query, t],
  );
  const visibleDated = useMemo(
    () => line.dated.filter(matchesQuery),
    [line.dated, matchesQuery],
  );
  const visibleUndated = useMemo(
    () => line.undated.filter(matchesQuery),
    [line.undated, matchesQuery],
  );

  const datedEvents = useMemo(
    () => toTimelineEvents(visibleDated, genderById, nameById),
    [visibleDated, genderById, nameById],
  );
  const undatedEvents = useMemo(
    () => toTimelineEvents(visibleUndated, genderById, nameById),
    [visibleUndated, genderById, nameById],
  );

  const partitioned = useMemo(
    () => partitionLineEvents(datedEvents, undatedEvents),
    [datedEvents, undatedEvents],
  );
  const markers = useMemo(
    () => buildLineMarkers(partitioned.dated, t),
    [partitioned.dated, t],
  );
  // The loaded events are the navigation reference: a gesture may move the
  // window well past them, but it stops once no event would stay in view.
  const domain = useMemo(() => markerDomain(markers), [markers]);
  const dataWindow = useMemo(() => computeMarkerWindow(markers), [markers]);

  const allEvents = useMemo(
    () => [...datedEvents, ...undatedEvents],
    [datedEvents, undatedEvents],
  );
  const entriesById = useMemo(() => {
    const index = new Map<string, TimelineEntry>();
    for (const entry of [...visibleDated, ...visibleUndated]) {
      index.set(entry.event.id, entry);
    }
    return index;
  }, [visibleDated, visibleUndated]);

  const relatedIds = useMemo(
    () => relatedEventIds(allEvents, selectedEventId),
    [allEvents, selectedEventId],
  );

  const focusHighlight = useMemo(
    () =>
      scope === "all" && personId !== null
        ? personEventIds(allEvents, personId)
        : new Set<string>(),
    [allEvents, personId, scope],
  );
  const highlightIds = useMemo(() => {
    if (selectedEventId !== null) {
      const result = new Set(relatedIds);
      result.add(selectedEventId);
      return result;
    }
    return focusHighlight;
  }, [focusHighlight, relatedIds, selectedEventId]);

  const selectedEvent =
    selectedEventId === null
      ? null
      : (allEvents.find((event) => event.id === selectedEventId) ?? null);
  const selectedEntry =
    selectedEventId === null ? null : (entriesById.get(selectedEventId) ?? null);

  const handleRetry = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  const commitWindow = useCallback(
    (next: TimelineWindow) => {
      setWindow(clampWindow(next, domain));
    },
    [domain],
  );

  const handleFit = useCallback(() => {
    setWindow(dataWindow);
  }, [dataWindow]);

  const selectEvent = useCallback((eventId: string) => {
    setSelectedEventId(eventId);
  }, []);

  const closeEvent = useCallback(() => {
    setSelectedEventId(null);
  }, []);

  const handlePersonChange = useCallback(
    (nextPersonId: string) => {
      setSharedFilter("personId", nextPersonId);
      if (nextPersonId === "") {
        setSharedFilter("personScope", "person");
        applyView({ personId: null, scope: "all" });
        return;
      }
      applyView({
        personId: nextPersonId,
        scope: scope === "all" ? "person" : scope,
      });
    },
    [applyView, scope, setSharedFilter],
  );

  const handlePersonScopeChange = useCallback(
    (next: EventPersonScope) => {
      setSharedFilter("personScope", next);
      applyView({ scope: next });
    },
    [applyView, setSharedFilter],
  );

  const handleEventSaved = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  // One action clears everything that can hide events: the shared person/type/
  // year filter, the shared search text and the timeline's own scope. The year
  // range has no slider on this screen, so the reset must be reachable from the
  // filter notice (issue #107).
  const { reset: resetSharedFilters } = eventFilters;
  const handleResetFilters = useCallback(() => {
    resetSharedFilters();
    setView((previous) => resetTimelineView(previous));
  }, [resetSharedFilters]);

  const saveScroll = useCallback(
    (value: number) => patchView({ scrollTop: value }),
    [patchView],
  );
  const scrollRef = useScrollMemory({
    scrollTop: storedView.scrollTop,
    onScrollTop: saveScroll,
    ready: line.status === "ready",
  });

  const showLine =
    line.status === "ready" && markers.length > 0 && window !== null;

  const visibleInWindow = useMemo(() => {
    if (window === null) {
      return 0;
    }
    return markers.filter(
      (marker) => positionOnLine(marker.time, window) !== null,
    ).length;
  }, [markers, window]);

  const emptyRange =
    showLine && visibleInWindow === 0 && markers.length > 0 && window !== null;

  const focusIncomplete = line.status === "idle" && !requestable;

  return (
    <div
      ref={scrollRef}
      className="timeline-page-scroll flex min-h-[700px] flex-col gap-2"
      data-testid="timeline-line-page"
    >
      <div
        className={cn(
          styles.surface,
          "shrink-0 space-y-2 rounded-lg px-3 py-2",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="page-title">{t("line.title")}</h1>
          <div className="relative flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={t("line.helpAria")}
            aria-expanded={helpOpen}
            title={t("line.helpTitle")}
            onClick={() => setHelpOpen((current) => !current)}
            className={cn(
              styles.iconButton,
              "inline-flex size-8 items-center justify-center rounded-md p-0",
            )}
          >
            <QuestionCircleRegular fontSize={16} aria-hidden="true" />
          </button>
          {helpOpen && (
            <div
              role="dialog"
              aria-label={t("line.helpTitle")}
              data-testid="line-help"
              className={cn(
                styles.popover,
                "absolute right-0 top-9 z-50 w-72 rounded-md p-3 text-[11px] leading-relaxed",
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="font-semibold">{t("line.helpTitle")}</p>
                <button
                  type="button"
                  onClick={() => setHelpOpen(false)}
                  aria-label={t("line.helpClose")}
                  className={cn(styles.iconButton, "rounded p-0.5")}
                >
                  <DismissRegular fontSize={14} aria-hidden="true" />
                </button>
              </div>
              <ul className={cn(styles.muted, "list-disc space-y-1 pl-4")}>
                <li>{t("line.helpWheel")}</li>
                <li>{t("line.helpDrag")}</li>
                <li>{t("line.helpDouble")}</li>
                <li>{t("line.helpBrush")}</li>
                <li>{t("line.helpButtons")}</li>
                <li>{t("line.helpLegend")}</li>
                <li>{t("line.helpKeyboard")}</li>
              </ul>
            </div>
          )}
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={cn(styles.muted, "text-xs tabular-nums")}
            data-testid="line-count"
          >
            {t("line.countAxis", { count: markers.length })}
            {undatedEvents.length > 0
              ? ` · ${t("line.countNoDate", { count: undatedEvents.length })}`
              : ""}
          </span>
        </div>

        <EventFilterRow
          testId="line-filters"
          className="timeline-filter-row"
          personFilterId="timeline-focus-person"
          personId={sharedPersonId}
          personScope={sharedPersonScope}
          persons={persons}
          photos={photos}
          types={eventTypes}
          onPersonChange={handlePersonChange}
          onPersonScopeChange={handlePersonScopeChange}
          onTypesChange={(types) => setSharedFilter("types", types)}
          yearRange={{
            from: sharedFromYear,
            to: sharedToYear,
            minYear: yearScale.minYear,
            maxYear: yearScale.maxYear,
            hasDated: yearScale.hasDated,
            onFromChange: (value) => setSharedFilter("fromYear", value),
            onToChange: (value) => setSharedFilter("toYear", value),
          }}
          extra={
            <TimelineGenerations
              generations={generations}
              onGenerationsChange={(value) =>
                applyView({ generations: clampGenerations(value) })
              }
            />
          }
        />

        <ActiveFilterNotice
          activeCount={activeFilterCount}
          fromYear={sharedFromYear}
          toYear={sharedToYear}
          query={sharedQuery}
          showQuery
          onReset={handleResetFilters}
          testId="timeline-filters-active"
        />

        {line.truncated && (
          <p role="status" className={cn(styles.muted, "text-[11px]")}>
            {t("line.truncated")}
          </p>
        )}
      </div>

      {line.scopeTruncated && (
        <p
          role="status"
          data-testid="scope-truncated"
          className={cn(
            styles.surface,
            styles.muted,
            "shrink-0 rounded px-3 py-1.5 text-[11px] leading-relaxed",
          )}
        >
          {t("line.scopeTruncated")}
        </p>
      )}

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-3",
          selectedEvent !== null &&
            "md:grid-cols-[minmax(0,1fr)_320px]",
        )}
      >
        <section
          className="relative flex min-h-0 min-w-0 flex-col"
          aria-label={t("line.canvasAria")}
        >
          {line.status === "loading" && (
            <PageMessage title={t("line.loading")}>
              <span className="inline-flex items-center gap-2">
                <ArrowSyncRegular
                  fontSize={16}
                  className="animate-spin"
                  aria-hidden="true"
                />
                {t("line.loadingHint")}
              </span>
            </PageMessage>
          )}

          {focusIncomplete && scopeRequiresPerson(scope) && (
            <PageMessage title={t("line.choosePersonTitle")}>
              {t("line.choosePersonHint", { scope: scopeLabel(scope, t) })}
            </PageMessage>
          )}

          {line.status === "error" && (
            <PageMessage
              title={t("line.errorTitle")}
              tone="error"
              retry={handleRetry}
              retryLabel={t("line.retry")}
            >
              <ErrorBanner error={line.error} />
            </PageMessage>
          )}

          {line.status === "empty" &&
            (activeFilterCount > 0 || sharedQuery.trim() !== "" ? (
              // Filters, not missing data: say so and offer the reset the
              // timeline otherwise has no control for.
              <PageMessage
                title={t("line.emptyFilteredTitle")}
                retry={handleResetFilters}
                retryLabel={t("line.resetFilters")}
              >
                {t("line.emptyFilteredHint")}
              </PageMessage>
            ) : (
              <PageMessage title={t("line.emptyTitle")}>
                {t("line.emptyHint")}
              </PageMessage>
            ))}

          {showLine && window !== null && (
            <div className="relative flex min-h-[480px] flex-1 flex-col">
              <LineCanvas
                markers={markers}
                window={window}
                domain={domain}
                fullWindow={dataWindow}
                selectedEventId={selectedEventId}
                rootPersonId={personId}
                focusPersonId={personId}
                highlightIds={highlightIds}
                onSelectEvent={selectEvent}
                onWindowChange={commitWindow}
                onFit={handleFit}
              />
              {emptyRange && (
                <div
                  data-testid="line-empty-range"
                  role="status"
                  className={cn(
                    styles.popover,
                    "absolute inset-x-8 top-1/2 z-20 -translate-y-1/2 rounded-lg p-4 text-center text-xs",
                  )}
                >
                  <p className="font-medium">
                    {t("line.emptyRangeTitle", {
                      range: formatWindowRange(window, t),
                    })}
                  </p>
                  <p className={cn(styles.muted, "mt-1")}>
                    {t("line.emptyRangeHint")}
                  </p>
                  <button
                    type="button"
                    className={cn(
                      styles.quietButton,
                      "mt-2 inline-flex h-7 items-center rounded-md px-2.5 py-0 text-[11px]",
                    )}
                    onClick={handleFit}
                  >
                    {t("fit")}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {selectedEvent !== null && selectedEntry !== null && (
          <aside className="contents min-h-0 md:block md:overflow-y-auto">
            <EventPopover
              event={selectedEntry.event}
              persons={persons}
              onClose={closeEvent}
              onOpenPerson={onOpenPerson}
              onOpenEvent={onOpenEvent}
              onSaved={handleEventSaved}
            />
          </aside>
        )}
      </div>

      {undatedEvents.length > 0 && line.status === "ready" && (
        <details
          className={cn(styles.surface, "shrink-0 rounded-lg px-3 py-2")}
          data-testid="line-undated"
        >
          <summary
            className={cn(
              styles.muted,
              "cursor-pointer text-[13px] font-semibold",
            )}
          >
            {t("line.undatedTitle", { count: undatedEvents.length })}
          </summary>
          <p className={cn(styles.muted, "mt-1 text-xs")}>
            {t("line.undatedHint")}
          </p>
          <div
            className={cn(
              styles.surface,
              "mt-2 max-h-60 overflow-auto rounded-md",
            )}
            data-testid="line-undated-table"
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead className={cn(styles.tableHead, "sticky top-0 z-10")}>
                <tr
                  className={cn(
                    styles.muted,
                    "text-[11px] uppercase tracking-wide",
                  )}
                >
                  <th scope="col" className="px-2.5 py-1.5 font-semibold">
                    {t("line.undatedTableType")}
                  </th>
                  <th scope="col" className="px-2.5 py-1.5 font-semibold">
                    {t("line.undatedTablePerson")}
                  </th>
                  <th scope="col" className="px-2.5 py-1.5 font-semibold">
                    {t("line.undatedTablePlace")}
                  </th>
                  <th
                    scope="col"
                    className="px-2.5 py-1.5 text-right font-semibold"
                  >
                    {t("line.undatedAction")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {undatedEvents.map((event) => {
                  const kindLabel = eventTypeLabel(event.type, t);
                  const title = eventTitle(event, t);
                  const person = eventPersonLabel(event, t);
                  // The place column falls back to the description; a missing
                  // value stays an honest dash instead of an invented label.
                  const place = event.place?.trim() ?? "";
                  const description = event.description?.trim() ?? "";
                  const placeText = place.length > 0 ? place : description;
                  return (
                    <tr
                      key={event.id}
                      data-testid="line-undated-row"
                      className={cn(
                        styles.tableRow,
                        styles.rowHover,
                        "cursor-pointer",
                      )}
                      onClick={() => selectEvent(event.id)}
                    >
                      <td className="px-2.5 py-1.5 align-top">
                        <span className="block font-medium">{kindLabel}</span>
                        {title !== kindLabel && (
                          <span
                            className={cn(
                              styles.muted,
                              "block text-[11px]",
                            )}
                          >
                            {title}
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 align-top">
                        {person ?? (
                          <span className={styles.muted} aria-hidden="true">
                            —
                          </span>
                        )}
                      </td>
                      <td className="max-w-80 px-2.5 py-1.5 align-top">
                        {placeText.length > 0 ? (
                          <span className="line-clamp-2 break-words">
                            {placeText}
                          </span>
                        ) : (
                          <span className={styles.muted} aria-hidden="true">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-right align-top">
                        <button
                          type="button"
                          data-testid="line-undated-open"
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation();
                            selectEvent(event.id);
                          }}
                          className={cn(
                            styles.quietButton,
                            "inline-flex h-7 items-center rounded-md px-2 py-0 text-xs",
                          )}
                        >
                          {t("line.undatedOpen")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {line.status === "ready" &&
        markers.length === 0 &&
        undatedEvents.length > 0 && (
          <div
            className={cn(
              styles.dashedSurface,
              styles.muted,
              "shrink-0 rounded-lg p-3 text-[11px]",
            )}
          >
            {t("line.onlyUndated")}
          </div>
        )}
    </div>
  );
}
