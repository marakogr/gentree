import { useEffect, useRef } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import worldUrl from "./world.geo.json?url";
import type { MapCluster } from "./group";

// world.geo.json is Natural Earth 1:110m admin-0 countries (public domain),
// fetched from nvkelso/natural-earth-vector. It is loaded only when the
// offline basemap is used or tiles fail.

export type MapView = { lat: number; lon: number; zoom: number };

type MapLabels = {
  map: string;
  zoomIn: string;
  zoomOut: string;
  offline: string;
  attribution: string;
};

type MapCanvasProps = {
  clusters: MapCluster[];
  selectedKey: string | null;
  basemap: "osm" | "offline";
  tileUrl: string;
  fitSignal: number;
  /** First render only; later views are updated by the map itself. */
  initialView: MapView;
  focus: { lat: number; lon: number; zoom: number; signal: number } | null;
  /** When true, an empty-map click asks the page for a manual point. */
  pinMode: boolean;
  onMapClick: (lat: number, lon: number) => void;
  onView: (view: MapView) => void;
  onHover: (
    cluster: MapCluster | null,
    at: { x: number; y: number } | null,
  ) => void;
  onSelect: (cluster: MapCluster) => void;
  labels: MapLabels;
};

/**
 * Leaflet owns pan, wheel zoom, pinch and the marker layer. The parent passes
 * groups already clustered for the current zoom; this component only draws.
 */
export function MapCanvas({
  clusters,
  selectedKey,
  basemap,
  tileUrl,
  fitSignal,
  initialView,
  focus,
  pinMode,
  onMapClick,
  onView,
  onHover,
  onSelect,
  labels,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const outlineRef = useRef<L.GeoJSON | null>(null);
  const worldRef = useRef<GeoJSON.GeoJsonObject | null>(null);
  const outlineRequest = useRef<Promise<void> | null>(null);
  const lastFitRef = useRef(0);

  const onViewRef = useRef(onView);
  const onHoverRef = useRef(onHover);
  const onSelectRef = useRef(onSelect);
  const pinModeRef = useRef(pinMode);
  const onMapClickRef = useRef(onMapClick);
  onViewRef.current = onView;
  onHoverRef.current = onHover;
  onSelectRef.current = onSelect;
  pinModeRef.current = pinMode;
  onMapClickRef.current = onMapClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, {
      center: [initialView.lat, initialView.lon],
      zoom: initialView.zoom,
      minZoom: 2,
      maxZoom: 18,
      zoomControl: false,
      worldCopyJump: true,
    });
    markerLayerRef.current = L.layerGroup().addTo(map);
    map.attributionControl.setPrefix(false);
    map.on("zoomend moveend", () => {
      const center = map.getCenter();
      onViewRef.current({
        lat: center.lat,
        lon: center.lng,
        zoom: map.getZoom(),
      });
    });
    map.on("click", (event) => {
      if (pinModeRef.current) {
        onMapClickRef.current(event.latlng.lat, event.latlng.lng);
      }
    });
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      tileRef.current = null;
      outlineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) {
      map.removeLayer(tileRef.current);
      tileRef.current = null;
    }
    if (outlineRef.current) {
      map.removeLayer(outlineRef.current);
      outlineRef.current = null;
    }

    let cancelled = false;
    const addOutline = (data: GeoJSON.GeoJsonObject) => {
      if (cancelled || !mapRef.current || outlineRef.current) return;
      outlineRef.current = L.geoJSON(data, {
        interactive: false,
        style: {
          color: "#8b93a1",
          weight: 0.6,
          fillColor: "#aab3c0",
          fillOpacity: 0.22,
        },
      }).addTo(mapRef.current);
    };
    const loadOutline = async () => {
      if (worldRef.current) {
        addOutline(worldRef.current);
        return;
      }
      if (!outlineRequest.current) {
        outlineRequest.current = fetch(worldUrl)
          .then((response) => (response.ok ? response.json() : null))
          .then((data: GeoJSON.GeoJsonObject | null) => {
            if (!data) return;
            worldRef.current = data;
            addOutline(data);
          })
          .catch(() => {
            // The plain background is a valid fallback; points stay usable.
          })
          .finally(() => {
            outlineRequest.current = null;
          });
      }
      await outlineRequest.current;
    };

    if (basemap === "osm") {
      const tiles = L.tileLayer(tileUrl, {
        maxZoom: 19,
        attribution: labels.attribution,
      });
      let fellBack = false;
      tiles.on("tileerror", () => {
        if (fellBack || cancelled) return;
        fellBack = true;
        map.removeLayer(tiles);
        void loadOutline();
      });
      tiles.addTo(map);
      tileRef.current = tiles;
    } else {
      void loadOutline();
    }

    return () => {
      cancelled = true;
    };
  }, [basemap, tileUrl, labels.attribution]);

  useEffect(() => {
    const layer = markerLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const cluster of clusters) {
      const classes = ["map-marker"];
      if (cluster.eventCount === 1 && cluster.placeCount === 1) {
        classes.push("map-marker-single");
      } else {
        classes.push("map-marker-count");
      }
      if (cluster.placeCount > 1) classes.push("map-marker-cluster");
      if (selectedKey !== null && cluster.id.split("|").includes(selectedKey)) {
        classes.push("map-marker-selected");
      }
      const html =
        cluster.eventCount === 1 && cluster.placeCount === 1
          ? `<div class="${classes.join(" ")}"></div>`
          : `<div class="${classes.join(" ")}">${cluster.eventCount}</div>`;
      const icon = L.divIcon({
        className: "map-marker-wrap",
        html,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      const marker = L.marker([cluster.lat, cluster.lon], {
        icon,
        keyboard: false,
        riseOnHover: true,
        bubblingMouseEvents: false,
      });
      marker.on("mouseover", (event) => {
        if (pinModeRef.current) return;
        const original = (event as L.LeafletMouseEvent).originalEvent;
        onHoverRef.current(
          cluster,
          original ? { x: original.clientX, y: original.clientY } : null,
        );
      });
      marker.on("mouseout", () => onHoverRef.current(null, null));
      marker.on("click", () => {
        if (!pinModeRef.current) onSelectRef.current(cluster);
      });
      marker.addTo(layer);
    }
  }, [clusters, selectedKey]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    mapRef.current.setView([focus.lat, focus.lon], focus.zoom);
  }, [focus?.signal]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitSignal === lastFitRef.current || clusters.length === 0) {
      return;
    }
    lastFitRef.current = fitSignal;
    const bounds = L.latLngBounds(
      clusters.map((cluster) => [cluster.lat, cluster.lon] as [number, number]),
    );
    map.fitBounds(bounds.pad(0.25), { maxZoom: 10, animate: false });
  }, [fitSignal, clusters]);

  return (
    <div className={pinMode ? "map-canvas-wrap map-pin-mode" : "map-canvas-wrap"}>
      <div
        ref={containerRef}
        className="map-canvas"
        role="application"
        aria-label={labels.map}
      />
      <div className="map-zoom">
        <button
          type="button"
          className="map-zoom-button"
          onClick={() => mapRef.current?.zoomIn()}
          aria-label={labels.zoomIn}
          title={labels.zoomIn}
        >
          +
        </button>
        <button
          type="button"
          className="map-zoom-button"
          onClick={() => mapRef.current?.zoomOut()}
          aria-label={labels.zoomOut}
          title={labels.zoomOut}
        >
          −
        </button>
      </div>
      {basemap === "offline" ? (
        <p className="map-offline-note">{labels.offline}</p>
      ) : null}
    </div>
  );
}
