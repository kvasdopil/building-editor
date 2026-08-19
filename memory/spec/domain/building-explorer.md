# Building Explorer — domain spec

## WHAT

A single-page map app: OpenStreetMap basemap (MapLibre, pan/zoom only, no tilt/bearing),
Overture buildings + parts rendered in contrast colors from zoom > 10, clickable.
Selecting a building opens a right-side panel with an interactive 3D extrusion
(zoom + rotate independent of the map, flat ground), with adjacent buildings
drawn in gray as context, and below it an inspector listing every raw tag of the
selected feature. A "Photos" toggle swaps the
basemap for satellite imagery and reduces buildings/parts to boundaries only.

## Height rules (authoritative)

- `height` (m) wins.
- Else `num_floors` × 3 m if residential subtype (apartments etc.), × 4 m otherwise.
- Base: `min_height`, else `min_floor` × the same per-floor height.
- Parts inherit the parent building's subtype for the per-floor estimate.
- A building with parts renders only its parts in 3D; the outline is a fallback.

## 3D context

Buildings whose footprint falls within `NEIGHBOR_PADDING_M` (80 m) of the selected
building's bounding box are extruded in flat gray, nearest first and capped at
`MAX_NEIGHBORS` (60) so the scene stays light. They follow the same height rules
and part handling as the selection. The camera frames the _selected_ building
alone (`buildScene` returns a separate `focus` box), otherwise context would push
the subject into the distance. Ground is sized from the half-diagonal of every
solid drawn, so no building overhangs it.

Neighbors are read from the same tile features as the selection, so context stops
at the edge of the loaded tiles — acceptable, since the click always happens
inside the loaded area.

## Map color coding

Buildings and parts are colored by the _provenance of their height_, which is what
makes the estimate trustworthy or not:

- green — `height` present (measured);
- blue — no `height`, but `num_floors` present (estimated via the per-floor rule);
- red — neither, so the height is a bare single-floor guess.

Each color has a brighter variant used over satellite imagery, and the legend
follows the active palette. The selection highlight is a white casing under a
near-black line so it stays distinct from all three data colors on both basemaps.

## Data sources

Two sources, deliberately split (see [ADR 0001](../../adr/0001-live-osm-data-for-editing.md)):

- **Overture PMTiles** — wide-area overview at z10-15. Global, free, no rate limits. Never an edit target: it lags OSM by weeks and its geometry carries no OSM node identity, so edits cannot be round-tripped. Release pinned in `src/lib/overture.ts`. Tile features are clipped at tile borders, so fragments of one id are merged with `@turf/union` on selection.
- **Live OSM API** — everything editable, at z >= 16, always through the cached proxy required by [ADR 0002](../../adr/0002-cached-rate-limited-osm-proxy.md).

Height and color logic follows OSM tags once FT-03 of [EP-001](../../plans/epics/EP-001-osm-editing/index.md) lands; until then it reads Overture property names.
