# ADR 0009 - IGN LiDAR HD is read on demand

Status: Active (2026-09-05)

Records how France's open LiDAR HD reaches the app without importing whole kilometre sheets.

Related documents:

- [Building Explorer domain spec](../spec/domain/building-explorer.md): Defines how surveys are
  merged, labelled, aligned, and displayed. Read this for the user-visible contract.
- [National laser data is read on demand](0005-national-laser-data-read-on-demand.md): The existing
  Swedish COPC architecture this integration extends. Read this for the shared rationale.
- [Local datasets and measurement tools](../spec/operations/local-datasets-and-tools.md): Defines
  source ids and cache locations. Read this before changing tile persistence.

## Decision

- Use IGN's classified **LiDAR HD** point cloud under Licence Ouverte 2.0.
- `/api/ign/tile/[z]/[x]/[y]` resolves intersecting 1 km COPC files from the public WFS layer
  `IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle`, range-reads a four-points/m² octree level of detail, and
  encodes the points into the app's LDR1 z16 tile format, uniformly thinning any browser tile above
  the established 500,000-point cap.
- Keep every upstream call server-side, bounded by concurrency, retry, hierarchy-page, node, and
  byte caps. Cache assembled tiles under `.cache/ign`; serve an empty tile on lookup or upstream
  failure so the editor remains usable.
- Support metropolitan EPSG:2154 coverage first. Project query boxes into Lambert-93 and every
  returned point back to WGS84. Overseas territories use different legal projections and remain
  outside this route until they receive explicit projection support.
- Assign LDR1 source id `3`, label the survey `IGN LiDAR HD`, and colour its classified returns by
  ground, vegetation, building, water, and bridge class because the source carries no RGB.

## Why

- The Eiffel Tower source tile is about 105 MB and neighbouring selections can cross a kilometre
  boundary. Downloading complete files in the browser would be slow and wasteful.
- COPC already provides a spatial octree and byte-range access. The verified Eiffel z16 tile needs
  46 nodes and about 21 MB of compressed upstream data, while later requests use the assembled
  cache.
- The WFS index is the maintained source of truth for coverage and URLs. Hard-coding the Eiffel
  tile would solve one landmark while leaving the rest of France disconnected and would age as IGN
  republishes acquisitions.

## Trade-offs

- A cold tile requires a WFS lookup plus COPC hierarchy and point-node reads; it can take several
  seconds. Buildings and terrain continue rendering while the cloud arrives.
- Four points/m² is enough for roofs, terrain, and massing but not the Eiffel Tower's fine lattice.
  COPC levels are taken whole, so the delivered density may be higher where a deeper level is needed.
- IGN69 elevations are treated like the other survey datums: class-2 ground returns measure a
  vertical translation to Mapterhorn, while LiDAR remains evidence rather than ground truth.
- COPC order is octree order, not scanner order. The optional link view therefore shows short
  storage-order chains rather than acquisition scan lines.
