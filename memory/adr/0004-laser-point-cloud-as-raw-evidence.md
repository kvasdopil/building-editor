# ADR 0004 - The laser point cloud is raw evidence, shown not summarized

Status: Draft (2026-08-19)

Records why Stockholm's airborne laser point cloud is imported as points and drawn as dots in the 3D view, instead of being reduced to numbers the way LOD1 is.

Related documents:

- [LOD1 is advice, never an import](0003-lod1-as-advice-not-import.md): The same laser survey after generalization into one block per building group. Read it first; this record is about the measurement behind those blocks.
- [Building Explorer domain spec](../spec/domain/building-explorer.md): What the dots are and how they are placed. Read it for the normative behavior.
- [National laser data is read on demand](0005-national-laser-data-read-on-demand.md): The second source, covering the country where the city's own scan stops. Read it before changing how points are delivered.
- [Mapterhorn defines the 3D ground datum](0006-mapterhorn-defines-3d-ground.md): The terrain source of truth and the vertical alignment contract for this overlay. Read it before changing point heights.

## Decision

- The dataset is "SBK Punktmoln - flygburen laserskanning (2023)" from Stockholm's data portal: LAS, SWEREF 99 18 00 (EPSG:3011), heights in RH2000, >16 points/m², coloured from the 2023 orthophoto, classified into ground, building, water, bridge, noise and unclassified.
- `scripts/import-lidar.mjs` reprojects it and writes one **binary** tile per z16 grid cell under `data/lidar`, thinned to at most 500,000 points per tile. `src/lib/lidar.ts` reads those tiles directly into typed arrays.
- The 3D view draws the cloud as coloured dots around the selected building, in the same local frame as the extruded solids. Mapterhorn supplies the ground and scene datum; class-2 returns only measure the per-survey translation that visually aligns this overlay. Nothing is inferred from it: no suggested tags, no per-part heights.

## Why

- LOD1's four heights per block are already a summary of this survey, and the summary is what fails for `building:part`: one block covers a whole terrace, so it cannot say how tall the wing or the tower is. The points can, because they can be clipped to any polygon — including the session-local parts that Slice invents.
- Before deriving anything from the cloud, it has to be visible. Dots against the extruded solid make a wrong `height` tag obvious — the roof floats above the dots or sinks below them — and make the failure modes visible too: vegetation over an eave, a neighbour's roof inside a sloppy footprint, a building newer than the flight with no roof returns at all.
- Binary tiles, not GeoJSON: a z16 tile at 16 points/m² is over a million points. Quantized to 9 bytes each and served as planar arrays, the browser views them without parsing or copying.

## Trade-offs

- Only a 200 x 200 m test area over Stora Essingen is published for direct download; the full municipality is ordered from the city (geodataservice@stockholm.se). Everywhere else the tile route answers an empty tile and the 3D view is unchanged, so the feature is invisible until the data exists.
- Dot heights keep their measured vertical differences but receive one robust vertical correction per survey against Mapterhorn. This removes datum seams without allowing points to define the ground.
- Thinning to 500,000 points per tile is uniform over the file's own flight-line order. It is reported by the importer rather than silent, and the cap is a flag.
- `data/lidar` is generated, gitignored, and rebuilt by the script — like `data/lod1`.
