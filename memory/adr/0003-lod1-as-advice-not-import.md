# ADR 0003 - LOD1 is advice, never an import

Status: Draft (2026-08-19)

Records how Stockholm's LOD1 building model is used: as per-building suggestions a mapper accepts one at a time, not as a bulk import.

Related documents:

- [Live OSM data for editing](0001-live-osm-data-for-editing.md): Why edit targets come from OSM. Read it first; LOD1 never becomes an edit target itself.
- [Building Explorer domain spec](../spec/domain/building-explorer.md): The matching rules and suggested tags. Read it for the normative behavior.

## Decision

- The dataset is "SBK 3D-Byggnader (LOD1) generaliserade" from Stockholm's data portal, imported to local z16 tiles by `scripts/import-lod1.mjs` and served from disk.
- It produces **suggestions attached to individual buildings**. Every value is applied by an explicit press, is highlighted afterwards, and is revertable. There is no bulk apply and no automated upload.
- Match quality is measured in both directions and shown. Advice from a LOD1 block that spans several OSM buildings is marked unreliable rather than hidden.

## Why

- Height data is what OSM most lacks here, and this dataset is authoritative: laser-measured ground, eaves, roof-median and ridge levels, from the city itself.
- Mechanically importing third-party geometry or attributes into OSM is contentious and often unwelcome; a per-building suggestion that a mapper checks against the 3D view keeps a human in the loop, which is also what the OSM import guidelines expect.
- Generalized footprints mean a block can cover a terrace. Silently attributing a block's ridge height to one house in that terrace would inject plausible but wrong data, so the mismatch is surfaced instead.

## Trade-offs

- Coverage is Stockholm only. Other cities need their own import; the matching and suggestion code is source-agnostic.
- `data/lod1` is a generated 35 MB tree, gitignored and rebuilt by the script rather than committed.
- The importer carries a hand-written shapefile reader and SWEREF99 inverse projection, because the toolchain has no GDAL. Both are small, documented, and validated against known buildings.
