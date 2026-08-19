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
- Else level count × the building's level height.
- Base: `min_height`, else minimum level × the same level height.
- **Level height is per building, not per part**: `height ÷ building:levels` when the building
  has both, else 3 m for residential subtypes (apartments etc.) and 4 m otherwise. Parts use
  their building's value, so they stack instead of drifting — a part computing its own level
  height from its own type misplaces it whenever the building has a measured height.
- `building:min_level` is the number of skipped levels below the part (per the OSM wiki), so
  base = `building:min_level` × level height and `building:levels` must exceed it.
- A building with parts renders only its parts in 3D unless they leave the footprint mostly
  uncovered; see [Building parts](#building-parts).

## Building parts

A part belongs to a building when at least **50% of the part's area** falls inside the
building outline (`src/lib/parts.ts`). Touching is not evidence of ownership: adjacent
buildings in OSM routinely share walls and therefore vertices, so any test based on
"a vertex lies inside" attributes a neighbour's parts to the wrong building. Overture
needs no test at all, since its parts carry `building_id`.

Parts replace the outline in 3D only when they cover at least **85%** of the footprint.
Partial part coverage is common in OSM, and dropping the outline then makes most of the
building disappear.

## Selection

Selection and the inspector are **live OSM only**, at z >= 16. The Overture overview is a
snapshot that cannot be edited and whose fields are not OSM tags (`is_underground`,
`has_parts`, `@geometry_source`), so clicking it below that zoom shows a hint instead of
opening the panel.

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
