# ADR 0005 - National laser data is read on demand, never imported

Status: Draft (2026-08-20)

Records how Lantmäteriet's national point cloud reaches the app: range reads from upstream COPC files behind a server cache, rather than an import like Stockholm's own scan.

Related documents:

- [The laser point cloud is raw evidence](0004-laser-point-cloud-as-raw-evidence.md): Why laser points are shown rather than summarized. Read it first; this record only changes where the points come from.
- [All upstream OSM traffic goes through a cached, rate-limited proxy](0002-cached-rate-limited-osm-proxy.md): The policy this one deliberately diverges from, and why.
- [Building Explorer domain spec](../spec/domain/building-explorer.md): The normative behavior of the two sources.

## Decision

- The dataset is "Laserdata Nedladdning, skog" — open data, CC0, no fee, but reachable only with a Geotorget account. Points are classified ground, water and bridge; roofs are unclassified. Measured density over Stockholm is 1.4 points/m², flown 2021-03-23 leaf-off.
- Files are found through Lantmäteriet's public STAC API and read by HTTP range request. **Nothing is imported.** `/api/skog/tile/[z]/[x]/[y]` assembles a tile the first time it is asked for and caches the bytes under `.cache/skog`.
- The credential lives in `GEOTORGET_LOGIN` / `GEOTORGET_PASSWORD`, read only by the server. Nothing that reaches the browser can see it.
- The 3D view reads both sources where available. Occupied one-meter municipal coverage cells suppress nearby national points, while Skog fills the rest of a partially covered tile.
- Every failure — no credential, no product permission, upstream outage — answers an empty tile. The reason travels in `x-skog` and `x-skog-error` headers.

## Why

- The whole country is 30 GB of LAZ and Stockholm alone is 22 files of 0.5-1.4 GB. Importing that to serve 200 m² at a time is absurd, and COPC exists precisely so it is unnecessary: one z16 tile costs 16-45 nodes and 3-5 MB upstream, 1-2.5 s cold, and the assembled tile is 2-4 MB at ~2 points/m².
- Serial spacing like ADR 0002's OSM proxy would make one building take ten seconds, and the reason for that rule — a small volunteer service that bans abusers — does not apply to a national bulk download host. The gate is on concurrency instead, with backoff on 429 and 5xx.
- Reading on demand means the data is never stale and no area has to be chosen in advance. The cache makes the second look instant, and a stale cached tile is served when upstream fails.
- Measured against Stockholm's 25 points/m² scan on five buildings, Skog's ridge heights agreed within 0.8 m median (worst 1.1 m) — closer than LOD1 manages on the same buildings.

## Coverage over Stockholm

Verified by sampling 18 points across every district against the published data boundaries: the
municipality is covered completely, by three flight blocks with **different dates**.

| block  | flown      | area                                                                     |
| ------ | ---------- | ------------------------------------------------------------------------ |
| 21C031 | 2021-03-23 | most of the city, from Rinkeby and Kista down through Södermalm to Årsta |
| 21C030 | 2021-04-12 | the south-east: Skarpnäck, Farsta                                        |
| 20C029 | 2020-03-31 | the south-west: Skärholmen, Sätra                                        |

All three are leaf-off spring flights, which is what makes roofs separable without a building class.
The seam matters for validation: a building finished in 2020 has no roof returns in the south-west
block but does in the rest of the city, so "no points on this roof" carries a different meaning
depending on which district it is in.

## Trade-offs

- The reader must know that these files key their octree to the LAS **header bounding box**, not to the cube in the COPC info VLR that the specification names. Node "6-2-47-18" over Stora Essingen decodes 1.2 km from where the cube predicts. Selection therefore steps the header box and pads by a cell, so a spec-following file over-reads rather than missing points.
- No colour: the survey carries no RGB, so dots are coloured by class, and unclassified points are split by return count — one return reads as hard surface, several as vegetation. That is a hint, not a classification.
- 1.4 points/m² is ~60-150 returns on a small house and 15-30 on a 40 m² part. Enough for a ridge on medium and large footprints, thin below that, and the wrong statistic entirely on a narrow tower, where a footprint percentile reads the skirt rather than the top.
- `laz-perf` is WebAssembly that loads its `.wasm` from beside itself, so `copc` and `laz-perf` are declared `serverExternalPackages`. Bundling them fails at runtime with ENOENT.
- A per-tile read cap (64 nodes, 16 MB) bounds a pathological request. Hitting it is reported in `x-skog-read`, never silent.
- The density target counts each node's points **weighted by how much of the node the query box covers**. Counting a node's own total instead lets one top-of-octree node, spanning the whole 5-10 km file, satisfy any target while contributing almost nothing to the tile: that bug returned 4% of the available points over Farsta before it was caught by comparing yield between flight blocks.
