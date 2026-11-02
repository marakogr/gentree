---
type: concept
title: Event places, coordinates and the map
description: How Gentree stores and validates a confirmed place point, how the Map tab filters, groups and clusters events, how online tiles and the offline outline work, and where address suggestions and Wikidata historical names fit.
tags: [map, places, coordinates, wikidata, privacy]
sources:
  - id: openwiki-source-a3aaf9fe726e7e10b17608a4
    resource: repo://desktop/apps/desktop/src/commands/geocode.rs
  - id: openwiki-source-07ff1d98434acde7550a42fd
    resource: repo://desktop/crates/config/src/model.rs
  - id: openwiki-source-c4a3d3efa573f4ccf9383021
    resource: repo://desktop/crates/core/src/geo.rs
  - id: openwiki-source-b1deb83549642a379f0826ee
    resource: repo://desktop/crates/core/src/place.rs
  - id: openwiki-source-c635bd74bf6d9595e09a95db
    resource: repo://desktop/crates/core/src/project.rs
  - id: openwiki-source-2ceb2cf109727ad6a4699cb4
    resource: repo://desktop/crates/core/src/record.rs
  - id: openwiki-source-f8ae01af2bebf963ebcbf796
    resource: repo://desktop/ui/src/features/map/group.ts
  - id: openwiki-source-c6719d49d8769d8d201a6ee9
    resource: repo://desktop/ui/src/features/map/MapCanvas.tsx
  - id: openwiki-source-6bc3418f4747c69dddf22d6f
    resource: repo://desktop/ui/src/features/map/range.ts
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
---

# Event places, coordinates and the map

A place in Gentree is two things: the editable text on the event (`place`) and, only when the user confirms one, a WGS84 point (`place_geo`). The text stays the source of truth for display and editing; the point is provenance for the Map tab. A point belongs to one event, not to a place name, because two events may name the same village and mean different settlements.

## The stored point

`Event.place_geo` is an optional `PlaceGeo` (`desktop/crates/core/src/geo.rs`):

```rust
pub struct PlaceGeo {
    pub lat: f64,
    pub lon: f64,
    pub precision: PlacePrecision, // POINT | SETTLEMENT | REGION | COUNTRY | UNKNOWN
    pub source: PlaceSource,       // PHOTON | DADATA | WIKIDATA | MANUAL
    pub provider_ref: Option<String>,
    pub label: Option<String>,
}
```

`validate` rejects non-finite or out-of-range latitude (`-90..=90`) and longitude (`-180..=180`), a `providerRef` over 200 characters and a `label` over 500 characters. The point is omitted from JSON when absent, so events without coordinates stay byte-compatible with older projects. Adding the field was project format 4; the `WIKIDATA` source was format 5.

`PlacePrecision` records what the provider actually returned: a house or street is `POINT`, a city or village centroid is `SETTLEMENT`, and a district or state is `REGION`. A settlement centroid must not be presented as a house. `PlaceSource` records provenance, and a `MANUAL` point is never overwritten by a geocoder.

## Confirming a point

A place typed by hand has no coordinates. The user resolves it in one of two ways:

- pick an address suggestion, which returns a point with the provider label and reference;
- place a manual point on the map.

`apply_place_geo` in `desktop/crates/core/src/place.rs` applies one confirmed point to selected events in place. It matches the event's current `place` case- and whitespace-insensitively, skips events that already have a point unless `overwrite` is true, counts duplicate ids once, counts unknown ids as skipped, and validates the point before touching anything. The display text is never rewritten.

The event form can also clear the point while keeping the text, for example after the user edits the place by hand. A suggestion without a point is still usable as text; it simply stays off the map.

## The Map tab

`desktop/ui/src/features/map` renders the Map tab from the same timeline entries the Timeline screen uses:

1. `filterByYears` keeps only events whose date position falls inside the chosen inclusive year range. Undated events and events without `place_geo` never appear as points; they are counted separately as unresolved places instead of being guessed into place.
2. `groupByPlace` makes one group per confirmed point, keyed by four decimal places (about 11 m). Events that share a point become one place; names are never used for identity, so same-named villages with different points stay apart.
3. `clusterPlaces` merges distinct places whose markers collide on screen at the current zoom (44 px by default). Clusters show the event count and split apart as the user zooms in.

`MapCanvas` owns Leaflet pan/zoom, the marker layer and the optional tiles. Projection helpers in `projection.ts` use the same Web Mercator 256 px grid as Leaflet, so clustering matches what is drawn without importing Leaflet into the pure modules. Node markers are plain DOM elements over the map; clicking a marker opens the place panel or the event card.

The Map tab also exposes the unresolved-places panel: a place name that exists on events but has no confirmed point can be searched through the geocoder or pinned manually. Applying a point is an explicit, reviewed action; nothing is geocoded automatically from a bare string.

## Tiles, offline mode and privacy

The basemap is configured by `map.basemap` (`osm | offline`) and `map.tile_url` (`desktop/crates/config/src/model.rs`). With `osm`, raster tiles are requested only while the Map tab is open; the tile server sees the approximate viewport, never the archive. With `offline`, no tile request is made and the bundled Natural Earth 1:110m outline is drawn instead. If tiles fail, the outline is used as a fallback so points stay usable.

Opening the map itself makes no network request. Address suggestions and historical-name lookups are separate, explicit features with their own switches:

- **Address suggestions** use Photon and/or DaData. They are on by default and can be turned off in Settings; while off, no query leaves the machine. `api_key_env` stores the name of the environment variable holding a DaData key, never the key.
- **Historical names** use Wikidata (CC0). The event keeps the historical text, and the modern name is shown next to it. Only the place name is sent, and the feature has its own switch.

## Related pages

- [People, events and validation](persons-and-events.md) for the `Event` record and its validation.
- [Project folder format and write discipline](../architecture/project-format.md) for the format versions that carry the point.
- [React UI structure and localization](../desktop/ui.md) for the screen shell around the map.
- [GEDCOM, JSON and ZIP interchange](../import/interchange.md) for how places and points survive exchange.
