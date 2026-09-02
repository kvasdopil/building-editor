# ADR 0008 - ICGC LiDAR is imported through the dense-survey path

Status: Active (2026-09-02)

Records why Catalonia's ICGC LiDAR Territorial data uses the existing offline `/api/lidar` path
instead of a new on-demand range-reading service.

Related documents:

- [The laser point cloud is raw evidence](0004-laser-point-cloud-as-raw-evidence.md): Defines the dense imported point-tile contract and why the app displays the returns. Read this before changing their meaning.
- [National laser data is read on demand](0005-national-laser-data-read-on-demand.md): Explains the COPC architecture used for Sweden's national fallback. Read this to understand why the ICGC source cannot use the same request path.
- [Local datasets and measurement tools](../spec/operations/local-datasets-and-tools.md): Defines where imported files live and how bounded ICGC areas are selected. Read this before running or changing the importer.
- [Building Explorer domain spec](../spec/domain/building-explorer.md): Defines how the client merges, labels, aligns, and displays every LiDAR survey.

## Decision

- ICGC **LiDAR Territorial 2021–2023** is imported for an explicit WGS84 bounding box by
  `scripts/import-lidar.mjs --dataset icgc --bbox west,south,east,north`.
- The importer projects the box to ETRS89 / UTM zone 31N (EPSG:25831), resolves the intersecting
  public 1 km ICGC sheets, downloads their LAZ files, and writes the same z16 LDR1 tiles as the
  Stockholm importer. `/api/lidar` serves both datasets.
- Byte 12 of the 16-byte LDR1 header carries a stable source id. Zero remains Stockholm, preserving
  every tile written before the field had meaning; one is Laserdata Skog and two is ICGC.
- Imported dense returns take the same one-metre spatial priority over a sparse fallback, and every
  survey receives its own ground-to-Mapterhorn vertical correction.
- ICGC data and derived tiles remain subject to CC BY 4.0 attribution to the Institut Cartogràfic i
  Geològic de Catalunya.

## Why

ICGC files support HTTP range requests but are ordinary LAZ, not COPC: compression chunks preserve
recording order but provide no spatial octree. Finding the returns inside one web-map tile therefore
requires scanning its entire 1 km source sheet, commonly hundreds of megabytes. Doing that in a
route handler would make a cold request slow and memory-heavy, and the production filesystem is not
durable enough to make the result a reliable shared cache. The existing dense-survey importer is the
honest contract for such data.

The shared LDR1 route avoids duplicating client loading and merge code. A source id in its previously
reserved word is sufficient because Stockholm and Catalonia do not overlap, while still allowing the
inspector and per-survey terrain alignment to distinguish them.

## Trade-offs

- Catalonia coverage exists only where a developer has run the bounded import. It is not an automatic
  country-wide production service, and generated source and tile files remain gitignored.
- A 100 m default pad matches the viewer's context cloud but may add neighboring ICGC sheets. A
  16-sheet default limit makes that cost explicit before a multi-gigabyte download begins.
- LAZ decoding needs the compressed source sheet in memory. The importer makes two passes and stores
  only bounded typed-array samples, avoiding a full decompressed copy and preserving recording order.
- Sagrada Familia crosses the `430583` / `431583` source boundary; resolving all intersecting sheets
  from the projected bbox is required rather than choosing the sheet under the building centroid.
