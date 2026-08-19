# EP-001 - Edit buildings and submit to OSM

Status: Active (2026-08-19)

Turns the read-only building explorer into an editor that submits building and building-part changes back to OpenStreetMap.

Related documents:

- [Live OSM data for editing](../../../adr/0001-live-osm-data-for-editing.md): Why edit data comes from the OSM API. Read it before changing a data source.
- [Cached, rate-limited OSM proxy](../../../adr/0002-cached-rate-limited-osm-proxy.md): Mandatory access policy. Read it before adding any upstream request.
- [Building Explorer domain spec](../../../spec/domain/building-explorer.md): Current normative behavior. Read it to see what each slice changes.

## Goal

A user pans to their area, sees current OSM buildings, edits heights, levels and parts, and uploads a valid changeset — without the project ever being rate-limited or banned.

## Slices

- **FT-01 Cached OSM read proxy — done.** Route handler, z16 tile grid, single-flight, three cache layers, token bucket, backoff. Verified: 10 concurrent requests for one tile made 1 upstream call (9 coalesced); a repeat request served from cache in ~10 ms; a full page reload made zero requests, IndexedDB serving every tile; off-grid zooms rejected with 400; concurrent tiles serialized ~1.05 s apart.
- **FT-02 Live OSM building layer — done.** Render buildings and parts from proxied OSM data at z >= 16, keeping Overture for z10-15. Verified: at z >= 16 buildings render from live OSM with selection, 3D and neighbors working; `relation/34394` showed version 52 with current tags.
- **FT-03 OSM tag semantics — done.** Height rules and map color coding move to OSM tags with unit parsing. Implemented in `src/lib/osm/parse.ts`: unit-aware height parsing, `building:levels`, `min_height` / `building:min_level`, residential detection for the per-floor estimate. Colors and the 3D view read the normalized values, so both sources share one implementation.
- **FT-04 Local edit model — done.** Dirty state, undo, and a pending-change set held client-side. Verified: applying advice re-renders the 3D view on the same render (a footprint-only building went from the 4 m fallback to 18.5 m), edited values are highlighted with a per-tag revert, and edits survive a reload — after F5, way/194996878 still showed `building:levels=5` over OSM's 6, and reverting restored 6 and removed the stored entry.
- **FT-05 OAuth 2.0 PKCE sign-in** against `api06.dev.openstreetmap.org`. Acceptance: token acquired and refreshed without the app ever handling a password.
- **FT-06 Changeset upload** with version conflict handling, dev API only. Acceptance: a round-trip edit is visible on the dev server; a stale version produces a clean conflict message, not a silent overwrite.
- **FT-08 Validation hints.** Flag suspect geometry and tagging in the inspector rather than
  silently rendering it: a part floating above everything below it (likely `building:min_level`
  off by one, see the worked example in the domain spec), parts overflowing their outline, and
  parts leaving the footprint mostly uncovered. Acceptance: way/111680989's two floating parts
  are flagged with the suggested `building:min_level` value.
- **FT-07 Production switch.** Only after FT-06 is proven on the dev API.

- **FT-09 LOD1 advice — done.** Import Stockholm LOD1 and suggest `height`, `roof:height` and
  `building:levels` per building, with match confidence. Verified against way/204715520 (74%
  coverage, three values offered) and the merged Luma Park block (advice correctly marked
  unreliable).

## Verification notes

- Upstream call counting is part of the definition of done for FT-01; every later slice must keep that count flat while panning over cached area.
- Write slices are developed exclusively against the OSM dev API. Production writes are a deliberate, separate step.
