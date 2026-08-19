# ADR 0001 - Live OSM data for editing, Overture for overview

Status: Draft (2026-08-19)

Records why building geometry that the user can edit must come from the live OpenStreetMap API, and why the Overture Maps snapshot is kept only as a zoomed-out overview layer.

Related documents:

- [Cached, rate-limited OSM proxy](0002-cached-rate-limited-osm-proxy.md): The access policy this decision depends on. Read it before adding any upstream request.
- [Building Explorer domain spec](../spec/domain/building-explorer.md): Normative behavior of the map, the 3D view, and the height rules. Read it to see what this decision changes.

## Decision

- Anything the user can select and edit is read from the OSM API (`GET /api/0.6/map?bbox=`), which returns nodes, ways and relations with their versions.
- Overture PMTiles remain as a wide-area overview layer only (z10-15). They are never an edit target.
- Overpass is reserved for filtered questions ("buildings here missing `height`"), not for routine per-pan reads.

## Why

Measured on 2026-08-19 against release `2026-07-22.0`:

- That release is the _newest_ Overture release, so bumping the pin cannot help.
- The newest `update_time` on any source in the Stockholm z14 tile is `2026-06-07` — roughly ten weeks stale. Recent OSM edits are structurally absent.
- 95% (Stockholm) / 100% (New York) of buildings carry an OSM element id and version in `sources.record_id`, e.g. `w957525117@5`. The remainder come from Microsoft ML Buildings and USGS Lidar and have no OSM object at all.
- Decisive: Overture geometry has **no node identity**. OSM ways reference shared nodes, so moving a corner means moving a node that neighboring ways may also use. A normalized polygon cannot be round-tripped into an OSM changeset.

The OSM API is also the endpoint iD and JOSM use for exactly this purpose, so editor-shaped read traffic is expected there — unlike Overpass.

## Trade-offs

- Two id spaces coexist (Overture GERS UUIDs vs OSM type/id). Bridged through `sources.record_id` when a cross-reference is needed.
- The OSM map call returns _all_ features in the bbox, not just buildings, so payloads are larger than an equivalent Overpass query. Accepted in exchange for authoritative versions and node identity.
- Live reads cannot be served straight to the browser; they require the caching policy in ADR 0002.
- Height and color logic must move from Overture property names back to OSM tags (`height`, `building:levels`, `min_height`, `building:min_level`, `building:part`), including unit parsing such as `40 ft`.
