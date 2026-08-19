# EP-001 - Edit buildings and submit to OSM

Status: Draft (2026-08-19)

Turns the read-only building explorer into an editor that submits building and building-part changes back to OpenStreetMap.

Related documents:

- [Live OSM data for editing](../../../adr/0001-live-osm-data-for-editing.md): Why edit data comes from the OSM API. Read it before changing a data source.
- [Cached, rate-limited OSM proxy](../../../adr/0002-cached-rate-limited-osm-proxy.md): Mandatory access policy. Read it before adding any upstream request.
- [Building Explorer domain spec](../../../spec/domain/building-explorer.md): Current normative behavior. Read it to see what each slice changes.

## Goal

A user pans to their area, sees current OSM buildings, edits heights, levels and parts, and uploads a valid changeset — without the project ever being rate-limited or banned.

## Slices

- **FT-01 Cached OSM read proxy.** Route handler, z16 tile grid, single-flight, three cache layers, token bucket, backoff. Acceptance: the second request for a tile makes zero upstream calls; upstream call count is observable; no browser request ever leaves for an upstream host.
- **FT-02 Live OSM building layer.** Render buildings and parts from proxied OSM data at z >= 16, keeping Overture for z10-15. Acceptance: a freshly made OSM edit appears after its tile expires.
- **FT-03 OSM tag semantics.** Height rules and map color coding move to OSM tags with unit parsing. Acceptance: `height=40 ft` and `building:levels` both resolve correctly; parts respect `min_height` / `building:min_level`.
- **FT-04 Local edit model.** Dirty state, undo, and a pending-change set held client-side. Acceptance: edits survive panning and are clearly distinguishable from upstream data.
- **FT-05 OAuth 2.0 PKCE sign-in** against `api06.dev.openstreetmap.org`. Acceptance: token acquired and refreshed without the app ever handling a password.
- **FT-06 Changeset upload** with version conflict handling, dev API only. Acceptance: a round-trip edit is visible on the dev server; a stale version produces a clean conflict message, not a silent overwrite.
- **FT-07 Production switch.** Only after FT-06 is proven on the dev API.

## Verification notes

- Upstream call counting is part of the definition of done for FT-01; every later slice must keep that count flat while panning over cached area.
- Write slices are developed exclusively against the OSM dev API. Production writes are a deliberate, separate step.
