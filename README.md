# Building Explorer

Browse a map, click a building, inspect it in 3D.

- **Map**: [MapLibre GL](https://maplibre.org/) with OpenStreetMap raster tiles. Pan and zoom only (no tilt/bearing).
- **Buildings**: [Overture Maps](https://overturemaps.org/) buildings theme, streamed straight from the official PMTiles release (`building` + `building_part` layers). Shown from zoom 10 and clickable, colored by the height data each feature carries:
  - 🟩 **green** — a measured `height`
  - 🟦 **blue** — no height, but a `num_floors` count we multiply into one
  - 🟥 **red** — footprint only, so the height is a single-floor guess

  Coverage varies a lot by region: Amsterdam is ~88% green, Stockholm is ~69% blue with ~30% red.

- **3D view**: selecting a building opens a side panel with a [Three.js](https://threejs.org/) extrusion of the building — independent zoom (scroll) and rotate (drag) via OrbitControls, flat ground disc. Adjacent buildings within 80 m are drawn in gray for context (capped at 60, nearest first); the camera frames the selected building only.
- **Inspector**: below the 3D view the panel lists every OSM tag on the selected element, raw and alphabetized, with its id and version in the header.
- **Selection is live OSM only** (z >= 16). Clicking the Overture overview below that zoom shows a hint rather than snapshot fields that are not OSM tags and cannot be edited.
- **Photos**: toggle a satellite-imagery underlay (Esri World Imagery); with photos on, only building and part boundaries are drawn.

## Data sources

Two sources, split on purpose (see [ADR 0001](memory/adr/0001-live-osm-data-for-editing.md)):

| Zoom  | Source                    | Why                                                                                                                                               |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10-15 | Overture PMTiles snapshot | Global, free, no rate limits — good for an overview. Lags OSM by weeks, and its geometry has no OSM node identity, so it is never an edit target. |
| 16+   | Live OSM API, proxied     | Shows edits made minutes ago and carries element type, id, version and node ids, which is what editing needs.                                     |

The legend shows which one is active.

### The OSM read path

Every upstream request goes through this app; the browser never calls OSM directly. This is a hard requirement, not an optimization — see [ADR 0002](memory/adr/0002-cached-rate-limited-osm-proxy.md).

- `GET /api/osm/tile/16/:x/:y` — buildings and parts for one z16 tile. Off-grid requests are rejected, which keeps the cache key space bounded.
- `GET /api/osm/stats` — upstream and cache counters, so the request cost is observable at any time.

Layers: IndexedDB in the browser, then an in-memory LRU and a disk store under `.cache/osm/`. Concurrent requests for one tile collapse into a single upstream fetch, upstream calls are spaced ~1.1 s apart with one in flight, 429/504 back off honoring `Retry-After`, and a circuit breaker serves stale data rather than retrying. Tiles are fetched only at z >= 16, on debounced map idle, nearest-first and capped per viewport.

Measured on the Stockholm test area: 10 simultaneous requests for one tile produced 1 upstream call, and a full page reload produced none at all.

## LOD1 advice

Stockholm's **"SBK 3D-Byggnader (LOD1) generaliserade"** (from [the city's data portal](https://dataportalen.stockholm.se/dataportalen/GetMetaDataById?id=88d3b57c-a914-4922-97a6-a9a76b1e0175)) gives per-building ground, eaves, roof-median and ridge levels measured from airborne laser data. Import it into z16 tiles:

```bash
node scripts/import-lod1.mjs
```

That downloads the published shapefiles, reads the MultiPatch solids and their DBF heights, reprojects SWEREF99 18 00 (EPSG:3011) to WGS84, and writes `data/lod1/16/{x}/{y}.json` — 77,743 buildings for the whole city. The files are gitignored; regenerate them rather than committing them.

Selecting a building matches it against the LOD1 block with the greatest overlap and offers:

| tag               | from                                                            |
| ----------------- | --------------------------------------------------------------- |
| `height`          | ridge minus ground — what OSM's `height` means                  |
| `roof:height`     | ridge minus eaves, skipped when implausible                     |
| `building:levels` | estimated from the facade height at the building's level height |

Advice appears as a button on the row: green **+** when OSM has no value, amber **!** when OSM disagrees. Pressing it applies the value, which highlights, re-renders the 3D view immediately, and can be reverted per tag or per building. Pending edits live in IndexedDB, so a reload keeps them.

LOD1 footprints are generalized, so coverage is reported both ways. When one LOD1 block spans several OSM buildings its heights describe the whole block, not the selected building — those suggestions are drawn muted and the panel says so.

## Height rules

Sources are normalized onto shared property names (`src/lib/buildings.ts`), so one implementation covers both. For OSM that means `height`, `building:levels`, `min_height` and `building:min_level`, with units like `40 ft` parsed. Then (see `src/lib/heights.ts`):

1. `height` (meters) when present;
2. otherwise level count × the building's **level height**;
3. minimum height, else minimum level × the same level height, lifts the base (so parts starting above ground float correctly).

The level height is derived per building, not per part: `height ÷ building:levels` when the building has both, else 3 m for residential buildings (apartments etc.) and 4 m for everything else. Every part of a building uses its building's value, so parts stack on each other instead of drifting apart. `building:min_level` is read as the OSM wiki defines it — the number of skipped levels below the part — so a part with `building:min_level=6` sits at the height of six levels.

A part is attributed to a building when at least 50% of its area falls inside that building's outline — adjacent OSM buildings share walls and vertices, so touching proves nothing. Parts replace the outline in 3D only when they cover at least 85% of the footprint; otherwise the outline is drawn too, since partial part coverage would otherwise make most of the building vanish.

## Implementation notes

- Selection is fully client-side: on click, tile features are read with `queryRenderedFeatures` / `querySourceFeatures`; parts are linked to the building via Overture's `building_id`. Tile-boundary fragments of the same feature are stitched with `@turf/union`.
- MapLibre's worker is served from `public/` (`setWorkerUrl`) because bundlers mangle its default URL. The files are copied from `node_modules` by the `postinstall` script — never edit them by hand.
- The Overture release is pinned in `src/lib/overture.ts` (`BUILDINGS_PMTILES_URL`); bump it when a new release ships (see <https://stac.overturemaps.org/catalog.json>).

## Getting started

```bash
yarn
yarn dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

```bash
yarn lint        # oxlint (type-aware)
yarn lint:full   # lint + format check + knip + jscpd
yarn format      # oxfmt --write
yarn build       # production build
```

Data attribution: © OpenStreetMap contributors, © Overture Maps Foundation, imagery © Esri & contributors.
