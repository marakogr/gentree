import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Spinner,
  Text,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  DismissRegular,
  LocationRegular,
} from "@fluentui/react-icons";
import { eventsApi, timelineApi } from "../../api/client";
import type { TimelineEntry } from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { useViewState } from "../../lib/useViewState";
import type { ViewFilters } from "../../lib/viewState";
import { toApiDate, toTimelineEvent } from "../timeline/adapter";
import { formatTimelineDate } from "../timeline/dates";
import { EventPopover } from "../timeline/EventPopover";
import { eventTypeLabel } from "../timeline/format";
import { useTimelineTranslate } from "../timeline/i18n";
import {
  clusterEntries,
  clusterPlaces,
  groupByPlace,
  type MapCluster,
  type PlaceGroup,
} from "./group";
import { useMapTranslate } from "./i18n";
import { MapCanvas, type MapView } from "./MapCanvas";
import { ClarifyPanel } from "./ClarifyPanel";
import { groupUnresolved, type UnresolvedPlace } from "./unresolved";
import { filterByYears, yearBounds, type YearBounds } from "./range";
import "./map.css";

const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

type MapLoadState = {
  status: "loading" | "ready" | "error";
  dated: TimelineEntry[];
  undated: TimelineEntry[];
  truncated: boolean;
  error: AppErrorEnvelope | null;
};

const INITIAL_STATE: MapLoadState = {
  status: "loading",
  dated: [],
  undated: [],
  truncated: false,
  error: null,
};

type MapSettings = {
  basemap: "osm" | "offline";
  tileUrl: string;
  geocoderEnabled: boolean;
  historicalEnabled: boolean;
};

type HoverState = {
  cluster: MapCluster;
  at: { x: number; y: number };
};

function storedNumber(filters: ViewFilters, key: string): number | null {
  const value = filters[key];
  if (typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Restores the last year range and viewport of this project, if valid. */
function parseStoredMapView(filters: ViewFilters): {
  range: YearBounds | null;
  view: MapView | null;
} {
  const min = storedNumber(filters, "from");
  const max = storedNumber(filters, "to");
  const lat = storedNumber(filters, "lat");
  const lon = storedNumber(filters, "lon");
  const zoom = storedNumber(filters, "zoom");
  const range =
    min !== null && max !== null && min <= max ? { min, max } : null;
  const view =
    lat !== null &&
    lon !== null &&
    zoom !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    zoom >= 2 &&
    zoom <= 18
      ? { lat, lon, zoom }
      : null;
  return { range, view };
}

export default function MapPage({
  projectId,
  onOpenPerson,
}: {
  projectId: string;
  onOpenPerson: (personId: string) => void;
}) {
  const t = useMapTranslate();
  const tm = useTimelineTranslate();
  const { state: storedView, patch: patchView } = useViewState(projectId, "map");
  const initialStored = useRef(parseStoredMapView(storedView.filters));
  const [state, setState] = useState<MapLoadState>(INITIAL_STATE);
  const [settings, setSettings] = useState<MapSettings>({
    basemap: "osm",
    tileUrl: DEFAULT_TILE_URL,
    geocoderEnabled: true,
    historicalEnabled: true,
  });
  const [range, setRange] = useState<YearBounds | null>(null);
  const [view, setView] = useState<MapView>(
    () => initialStored.current.view ?? { lat: 25, lon: 15, zoom: 3 },
  );
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [placePanel, setPlacePanel] = useState<PlaceGroup | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TimelineEntry | null>(null);
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [focus, setFocus] = useState<
    { lat: number; lon: number; zoom: number; signal: number } | null
  >(null);
  const focusSignal = useRef(0);
  const fitted = useRef(false);
  const [showClarify, setShowClarify] = useState(false);
  const [pinTarget, setPinTarget] = useState<{
    place: UnresolvedPlace;
    eventIds: string[];
  } | null>(null);
  const [pinError, setPinError] = useState<AppErrorEnvelope | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const result = await timelineApi.list({ scope: "all" });
      setState({
        status: "ready",
        dated: result.dated,
        undated: result.undated,
        truncated: result.truncated,
        error: null,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        error: normalizeError(error),
      }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, projectId]);

  useEffect(() => {
    invoke<{
      config?: {
        map?: { basemap?: string; tile_url?: string };
        geocoder?: { enabled?: boolean };
        historical_geocoder?: { enabled?: boolean };
      };
    }>("settings_get")
      .then((snapshot) => {
        const map = snapshot?.config?.map;
        setSettings({
          basemap: map?.basemap === "offline" ? "offline" : "osm",
          tileUrl: map?.tile_url?.trim() || DEFAULT_TILE_URL,
          geocoderEnabled: snapshot?.config?.geocoder?.enabled !== false,
          historicalEnabled:
            snapshot?.config?.historical_geocoder?.enabled === true,
        });
      })
      .catch(() => {
        // Defaults are usable; the map never depends on the settings call.
      });
  }, []);

  const placed = useMemo(
    () => state.dated.filter((entry) => entry.event.placeGeo),
    [state.dated],
  );
  const placedUndated = useMemo(
    () => state.undated.filter((entry) => entry.event.placeGeo),
    [state.undated],
  );
  const hasAnyPlace = useMemo(
    () =>
      [...state.dated, ...state.undated].some(
        (entry) => (entry.event.place ?? "").trim() !== "",
      ),
    [state.dated, state.undated],
  );
  const unresolvedPlaces = useMemo(
    () => groupUnresolved([...state.dated, ...state.undated]),
    [state.dated, state.undated],
  );

  const bounds = useMemo(() => yearBounds(placed), [placed]);
  useEffect(() => {
    setRange((current) => {
      if (bounds === null) return null;
      if (current === null) {
        const stored = initialStored.current.range;
        if (stored === null) return bounds;
        return {
          min: Math.max(bounds.min, Math.min(stored.min, bounds.max)),
          max: Math.min(bounds.max, Math.max(stored.max, bounds.min)),
        };
      }
      // Keep the user's chosen window and clamp it when the archive changed.
      return {
        min: Math.max(bounds.min, Math.min(current.min, bounds.max)),
        max: Math.min(bounds.max, Math.max(current.max, bounds.min)),
      };
    });
  }, [bounds]);

  const activeRange = range ?? bounds;
  useEffect(() => {
    // Wait until the stored range was applied; otherwise the first render
    // would overwrite it with the full archive bounds.
    if (!range) return;
    patchView((previous) => ({
      ...previous,
      filters: {
        ...previous.filters,
        from: String(range.min),
        to: String(range.max),
        lat: String(view.lat),
        lon: String(view.lon),
        zoom: String(view.zoom),
      },
    }));
  }, [
    range?.min,
    range?.max,
    view.lat,
    view.lon,
    view.zoom,
    patchView,
  ]);
  const filtered = useMemo(
    () =>
      activeRange
        ? filterByYears(placed, activeRange.min, activeRange.max)
        : [],
    [placed, activeRange],
  );
  const groups = useMemo(() => groupByPlace(filtered), [filtered]);
  const clusters = useMemo(
    () => clusterPlaces(groups, view.zoom, { selectedKey: selectedGroupKey }),
    [groups, view.zoom, selectedGroupKey],
  );

  const hadStoredView = initialStored.current.view !== null;
  useEffect(() => {
    if (!fitted.current && state.status === "ready" && placed.length > 0) {
      fitted.current = true;
      if (!hadStoredView) setFitSignal((current) => current + 1);
    }
  }, [state.status, placed.length, hadStoredView]);

  const handleSelect = (cluster: MapCluster) => {
    setHovered(null);
    setShowClarify(false);
    if (cluster.groups.length > 1) {
      focusSignal.current += 1;
      setFocus({
        lat: cluster.lat,
        lon: cluster.lon,
        zoom: Math.min(14, view.zoom + 2),
        signal: focusSignal.current,
      });
      return;
    }
    const group = cluster.groups[0];
    setSelectedGroupKey(group.key);
    if (group.entries.length === 1) {
      setPlacePanel(null);
      setSelectedEntry(group.entries[0]);
      return;
    }
    setSelectedEntry(null);
    setPlacePanel(group);
  };

  const closePanels = () => {
    setSelectedEntry(null);
    setPlacePanel(null);
    setSelectedGroupKey(null);
    setShowClarify(false);
  };

  const openClarify = () => {
    setSelectedEntry(null);
    setPlacePanel(null);
    setSelectedGroupKey(null);
    setNotice(null);
    setPinError(null);
    setShowClarify(true);
  };

  const manualPoint = (place: UnresolvedPlace, eventIds: string[]) => {
    setShowClarify(false);
    setSelectedEntry(null);
    setPlacePanel(null);
    setSelectedGroupKey(null);
    setNotice(null);
    setPinError(null);
    setPinTarget({ place, eventIds });
  };

  const handleMapClick = async (lat: number, lon: number) => {
    if (!pinTarget) return;
    setPinError(null);
    try {
      const result = await eventsApi.applyPlaceGeo({
        eventIds: pinTarget.eventIds,
        expectedPlace: pinTarget.place.label,
        point: { lat, lon, precision: "POINT", source: "MANUAL" },
      });
      setPinTarget(null);
      setNotice(
        result.applied > 0
          ? t("clarifyApplied", {
              applied: result.applied,
              skipped: result.skipped,
            })
          : t("clarifyNothingChanged"),
      );
      await load();
    } catch (caught) {
      setPinError(normalizeError(caught));
    }
  };

  useEffect(() => {
    if (!pinTarget) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinTarget(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [pinTarget]);

  const labels = useMemo(
    () => ({
      map: t("title"),
      zoomIn: t("zoomIn"),
      zoomOut: t("zoomOut"),
      offline: t("offlineNotice"),
      attribution: "© OpenStreetMap contributors",
    }),
    [t],
  );

  const showEmptyMap =
    state.status === "ready" && placed.length === 0 && !hasAnyPlace;
  const showNoPoints =
    state.status === "ready" && placed.length === 0 && hasAnyPlace;

  return (
    <section className="map-page">
      <header className="map-header">
        <div>
          <h1 className="page-title">{t("title")}</h1>
          <p className="map-subtitle">{t("subtitle")}</p>
        </div>
        <div className="map-counts">
          <Text size={300}>{t("event:count", { count: filtered.length })}</Text>
          <Text size={300}>{t("placesCount", { count: groups.length })}</Text>
          {placedUndated.length > 0 ? (
            <Text size={200} className="map-muted">
              {t("undatedCount", { count: placedUndated.length })}
            </Text>
          ) : null}
        </div>
      </header>

      <div className="map-toolbar">
        {bounds && activeRange ? (
          <YearRange
            bounds={bounds}
            value={activeRange}
            onChange={setRange}
            label={t("rangeLabel")}
            fromLabel={t("rangeFrom")}
            toLabel={t("rangeTo")}
            resetLabel={t("rangeReset")}
          />
        ) : null}
        <Button
          appearance="subtle"
          icon={<ArrowClockwiseRegular />}
          onClick={() => setFitSignal((current) => current + 1)}
          disabled={clusters.length === 0}
        >
          {t("fitAll")}
        </Button>
      </div>

      {state.truncated ? (
        <div className="map-notice">{t("truncated")}</div>
      ) : null}
      {notice ? <div className="map-notice">{notice}</div> : null}
      {unresolvedPlaces.length > 0 ? (
        <div className="map-notice map-notice-warn">
          <span>
            {t("unresolvedCount", { count: unresolvedPlaces.length })}{" "}
            {t("unresolvedHint")}
          </span>
          <Button appearance="subtle" size="small" onClick={openClarify}>
            {t("clarifyTitle")}
          </Button>
        </div>
      ) : null}
      <ErrorBanner error={state.error} />
      <ErrorBanner error={pinError} />

      <div className="map-body">
        <MapCanvas
          clusters={clusters}
          selectedKey={selectedGroupKey}
          basemap={settings.basemap}
          tileUrl={settings.tileUrl}
          fitSignal={fitSignal}
          initialView={view}
          focus={focus}
          pinMode={pinTarget !== null}
          onMapClick={(lat, lon) => void handleMapClick(lat, lon)}
          onView={setView}
          onHover={(cluster, at) =>
            setHovered(cluster && at ? { cluster, at } : null)
          }
          onSelect={handleSelect}
          labels={labels}
        />

        {pinTarget ? (
          <div className="map-pin-banner">
            <Text>
              {t("clarifyPinHint", { place: pinTarget.place.label })}
            </Text>
            <Button size="small" onClick={() => setPinTarget(null)}>
              {t("clarifyCancel")}
            </Button>
          </div>
        ) : null}

        {state.status === "loading" ? (
          <div className="map-overlay">
            <Spinner size="small" />
            <Text>{t("loading")}</Text>
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="map-overlay map-overlay-error">
            <LocationRegular fontSize={32} aria-hidden="true" />
            <Text weight="semibold">{t("loadError")}</Text>
            <Button appearance="primary" onClick={() => void load()}>
              {t("retry")}
            </Button>
          </div>
        ) : null}

        {state.status === "ready" &&
        activeRange &&
        filtered.length === 0 &&
        placed.length > 0 ? (
          <div className="map-overlay">
            <LocationRegular fontSize={32} aria-hidden="true" />
            <Text weight="semibold">{t("noRange")}</Text>
            <Text size={200} className="map-muted">
              {t("noRangeHint")}
            </Text>
          </div>
        ) : null}

        {showEmptyMap ? (
          <div className="map-overlay">
            <LocationRegular fontSize={32} aria-hidden="true" />
            <Text weight="semibold">{t("noPlaces")}</Text>
            <Text size={200} className="map-muted">
              {t("noPlacesHint")}
            </Text>
          </div>
        ) : null}

        {showNoPoints ? (
          <div className="map-overlay">
            <LocationRegular fontSize={32} aria-hidden="true" />
            <Text weight="semibold">{t("noPoints")}</Text>
            <Text size={200} className="map-muted">
              {t("noPointsHint")}
            </Text>
          </div>
        ) : null}

        {hovered ? (
          <HoverCard
            hovered={hovered}
            t={t}
            tm={tm}
          />
        ) : null}

        {showClarify ? (
          <ClarifyPanel
            places={unresolvedPlaces}
            geocoderEnabled={
              settings.geocoderEnabled || settings.historicalEnabled
            }
            onClose={() => setShowClarify(false)}
            onApplied={() => void load()}
            onManual={manualPoint}
            t={t}
            tm={tm}
          />
        ) : null}

        {placePanel ? (
          <PlacePanel
            group={placePanel}
            onClose={closePanels}
            onOpen={(entry) => {
              setPlacePanel(null);
              setSelectedEntry(entry);
            }}
            t={t}
            tm={tm}
          />
        ) : null}

        {selectedEntry ? (
          <aside className="map-side-panel map-event-panel">
            <EventPopover
              key={selectedEntry.event.id}
              event={toTimelineEvent(selectedEntry)}
              personId={selectedEntry.event.personId}
              onClose={() => {
                setSelectedEntry(null);
                setSelectedGroupKey(placePanel?.key ?? null);
              }}
              onOpenPerson={onOpenPerson}
              onSaved={() => {
                setSelectedEntry(null);
                void load();
              }}
            />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function YearRange({
  bounds,
  value,
  onChange,
  label,
  fromLabel,
  toLabel,
  resetLabel,
}: {
  bounds: YearBounds;
  value: YearBounds;
  onChange: (value: YearBounds) => void;
  label: string;
  fromLabel: string;
  toLabel: string;
  resetLabel: string;
}) {
  const disabled = bounds.min === bounds.max;
  return (
    <div className="map-range" role="group" aria-label={label}>
      <label className="map-range-field">
        <span>{fromLabel}</span>
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          value={value.min}
          disabled={disabled}
          aria-label={fromLabel}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange({ min: Math.min(next, value.max), max: value.max });
          }}
        />
        <output>{value.min}</output>
      </label>
      <span className="map-range-separator" aria-hidden="true">
        —
      </span>
      <label className="map-range-field">
        <span>{toLabel}</span>
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          value={value.max}
          disabled={disabled}
          aria-label={toLabel}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange({ min: value.min, max: Math.max(next, value.min) });
          }}
        />
        <output>{value.max}</output>
      </label>
      <Button
        appearance="subtle"
        size="small"
        onClick={() => onChange(bounds)}
        disabled={disabled || (value.min === bounds.min && value.max === bounds.max)}
      >
        {resetLabel}
      </Button>
    </div>
  );
}

function modernPlaceName(group: PlaceGroup): string | null {
  const modern =
    group.entries
      .find((entry) => entry.event.placeGeo?.label)
      ?.event.placeGeo?.label?.trim() ?? "";
  return modern !== "" && modern !== (group.place ?? "").trim()
    ? modern
    : null;
}

function HoverCard({
  hovered,
  t,
  tm,
}: {
  hovered: HoverState;
  t: ReturnType<typeof useMapTranslate>;
  tm: ReturnType<typeof useTimelineTranslate>;
}) {
  const entries = clusterEntries(hovered.cluster);
  const shown = entries.slice(0, 4);
  const place = hovered.cluster.groups[0]?.place;
  const modern =
    hovered.cluster.groups.length === 1
      ? modernPlaceName(hovered.cluster.groups[0])
      : null;
  const left = Math.max(8, Math.min(hovered.at.x + 16, window.innerWidth - 340));
  const top = Math.max(8, Math.min(hovered.at.y + 16, window.innerHeight - 220));
  return (
    <div className="map-hover" style={{ left, top }} role="tooltip">
      <Text weight="semibold">
        {hovered.cluster.placeCount > 1
          ? t("placesCount", { count: hovered.cluster.placeCount })
          : place ?? t("event:place")}
      </Text>
      {modern ? (
        <Text as="p" size={200} className="map-muted">
          {t("modernName", { name: modern })}
        </Text>
      ) : null}
      <ul>
        {shown.map((entry) => (
          <li key={entry.event.id}>
            <span className="map-hover-date">
              {formatTimelineDate(toApiDate(entry.event.date), tm)}
            </span>
            <span className="map-hover-person">{entry.personName}</span>
            <span className="map-hover-type">
              {eventTypeLabel(entry.event.type, tm)}
            </span>
          </li>
        ))}
      </ul>
      {entries.length > shown.length ? (
        <Text size={200} className="map-muted">
          {t("hoverMore", { count: entries.length - shown.length })}
        </Text>
      ) : null}
    </div>
  );
}

function PlacePanel({
  group,
  onClose,
  onOpen,
  t,
  tm,
}: {
  group: PlaceGroup;
  onClose: () => void;
  onOpen: (entry: TimelineEntry) => void;
  t: ReturnType<typeof useMapTranslate>;
  tm: ReturnType<typeof useTimelineTranslate>;
}) {
  const modern = modernPlaceName(group);
  return (
    <aside className="map-side-panel" aria-label={t("placeEvents")}>
      <header className="map-side-head">
        <div>
          <Text weight="semibold">{group.place ?? t("event:place")}</Text>
          <Text size={200} className="map-muted">
            {t("event:count", { count: group.entries.length })}
          </Text>
          {modern ? (
            <Text size={200} className="map-muted">
              {t("modernName", { name: modern })}
            </Text>
          ) : null}
        </div>
        <Button
          appearance="subtle"
          icon={<DismissRegular />}
          aria-label={t("close")}
          onClick={onClose}
        />
      </header>
      <ul className="map-event-list">
        {group.entries.map((entry) => (
          <li key={entry.event.id}>
            <button
              type="button"
              className="map-event-row"
              onClick={() => onOpen(entry)}
            >
              <span className="map-event-date">
                {formatTimelineDate(toApiDate(entry.event.date), tm)}
              </span>
              <span className="map-event-person">{entry.personName}</span>
              <span className="map-event-type">
                {eventTypeLabel(entry.event.type, tm)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
