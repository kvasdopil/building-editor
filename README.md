# Building Explorer

Browse a map, click a building, inspect it in 3D.

- **Map**: [MapLibre GL](https://maplibre.org/) with OpenStreetMap raster tiles. Pan and zoom only (no tilt/bearing).
- **Buildings**: [Overture Maps](https://overturemaps.org/) buildings theme, streamed straight from the official PMTiles release (`building` + `building_part` layers). Shown from zoom 10 and clickable, colored by the height data each feature carries:
  - 🟩 **green** — a measured `height`
  - 🟦 **blue** — no height, but a `num_floors` count we multiply into one
  - 🟥 **red** — footprint only, so the height is a single-floor guess

  Coverage varies a lot by region: Amsterdam is ~88% green, Stockholm is ~69% blue with ~30% red.

- **3D view**: selecting a building opens a side panel with a [Three.js](https://threejs.org/) extrusion of the building — independent zoom (scroll) and rotate (drag) via OrbitControls, flat ground disc. Adjacent buildings within 80 m are drawn in gray for context (capped at 60, nearest first); the camera frames the selected building only.
- **Inspector**: below the 3D view the panel lists every tag on the selected feature, raw and alphabetized.
- **Photos**: toggle a satellite-imagery underlay (Esri World Imagery); with photos on, only building and part boundaries are drawn.

## Height rules

For each building or part (see `src/lib/heights.ts`):

1. `height` (meters) when present;
2. otherwise `num_floors` × **3 m** for residential buildings (apartments etc.) or × **4 m** for everything else;
3. `min_height`, else `min_floor` × the same per-floor height, lifts the base (parts hovering above ground render correctly).

Buildings with parts are rendered from their parts; the outline is used only when no parts exist.

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
