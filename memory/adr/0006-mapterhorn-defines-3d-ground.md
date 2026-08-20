# ADR 0006 - Mapterhorn defines the 3D ground datum

Status: Draft (2026-08-20)

Records why the 3D preview takes ground elevation from Mapterhorn rather than from either LiDAR survey, and how the point clouds are aligned without becoming a source of truth.

Related documents:

- [Building Explorer domain spec](../spec/domain/building-explorer.md): Normative 3D terrain, building-base and overlay behavior. Read it when changing scene elevation calculations.
- [The laser point cloud is raw evidence](0004-laser-point-cloud-as-raw-evidence.md): Why LiDAR remains a visual overlay rather than inferred tags or ground geometry. Read it before deriving anything from returns.
- [National laser data is read on demand](0005-national-laser-data-read-on-demand.md): How the sparse national point cloud is fetched and combined with the municipal scan.

## Decision

- The 3D preview reads Mapterhorn's 512 px, Terrarium-encoded WebP tiles at **z13**. Mapterhorn is the source of truth for every ground elevation in the scene.
- Scene zero is the **lowest Mapterhorn sample inside the selected building outline**. Raster sample centres inside the polygon are considered; boundary vertices are sampled too so a footprint smaller than one z13 texel still has a reference.
- Each building and its parts share a flat base at the lowest Mapterhorn elevation inside that building's own outline. Its scene offset is that elevation minus the selected building's reference. OSM `height`, levels and minimum-height rules remain physical distances above that base; Mapterhorn does not invent or replace tags.
- The terrain mesh and all absolute elevations are expressed relative to the selected reference. Terrain outside the footprint may therefore be below zero when the selected building sits uphill.
- Stockholm 2023 and Laserdata Skog remain point overlays. For each survey independently, nearby class-2 ground returns are compared with Mapterhorn at the same coordinates and the median `LiDAR z - terrain z` residual is removed from every point in that survey. This is a vertical translation only: returns never move the terrain or building bases.
- Both LiDAR sources may be read for one z16 tile. Occupied one-meter municipal coverage cells and their immediate neighbors take priority; national points fill the remainder. Tile-wide fallback is forbidden because a municipal dataset boundary can cross the middle of a tile.

## Why

- LiDAR coverage, density, flight date and classification differ between the two surveys. Using either survey to establish ground makes the same building jump when a source appears, disappears or crosses a tile boundary.
- Mapterhorn supplies one consistent DEM contract for the terrain surface. A fixed z13 avoids resolution changing with the preview camera and makes the reference reproducible.
- The lowest footprint elevation is stable on a slope and gives the whole building one base plane, which the OSM Simple 3D Buildings model assumes. Parts must not acquire independent terrain offsets or they stop stacking.
- Survey levels can carry small vertical-datum or processing offsets. A robust class-2 residual preserves roof-to-ground distances while making both overlays meet the Mapterhorn terrain.

## Trade-offs

- At z13, terrain detail is several meters per sample in Stockholm. This is appropriate for a building base and neighborhood slope, but it is not a foundation survey.
- A flat building base taken from the downhill edge can sit below the uphill terrain. That visible intersection represents the explicit lowest-point rule rather than an attempt to reshape the footprint or infer a stepped foundation.
- When one survey has no usable ground returns, it inherits the other survey's median correction; when neither has ground returns, no correction can be measured and their published orthometric levels are used as-is.
- If Mapterhorn is unavailable, buildings appear immediately on the former flat fallback and LiDAR uses its legacy local ground estimate. That fallback is temporary display behavior, never an alternative source of truth.
