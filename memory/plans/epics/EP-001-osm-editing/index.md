# EP-001 - Edit buildings and submit to OSM

Status: Active (2026-08-19)

Turns the read-only building explorer into an editor that submits building and building-part changes back to OpenStreetMap.

Related documents:

- [Live OSM data for editing](../../../adr/0001-live-osm-data-for-editing.md): Why edit data comes from the OSM API. Read it before changing a data source.
- [Cached, rate-limited OSM proxy](../../../adr/0002-cached-rate-limited-osm-proxy.md): Mandatory access policy. Read it before adding any upstream request.
- [Building Explorer domain spec](../../../spec/domain/building-explorer.md): Current normative behavior. Read it to see what each slice changes.
- [OSM submission spec](../../../spec/domain/osm-submission.md): Normative changeset assembly and the pre-upload check list. Read it before touching FT-06 or FT-08.

## Goal

A user pans to their area, sees current OSM buildings, edits heights, levels and parts, and uploads a valid changeset — without the project ever being rate-limited or banned.

## Slices

- **FT-01 Cached OSM read proxy — done.** Route handler, z16 tile grid, single-flight, three cache layers, token bucket, backoff. Verified: 10 concurrent requests for one tile made 1 upstream call (9 coalesced); a repeat request served from cache in ~10 ms; a full page reload made zero requests, IndexedDB serving every tile; off-grid zooms rejected with 400; concurrent tiles serialized ~1.05 s apart.
- **FT-02 Live OSM building layer — done.** Render buildings and parts from proxied OSM data at z >= 16, keeping Overture for z10-15. Verified: at z >= 16 buildings render from live OSM with selection, 3D and neighbors working; `relation/34394` showed version 52 with current tags.
- **FT-02 selection performance fix (2026-08-22).** Map selection used to parse every displayed
  feature and associate every building with every part on every click, even when switching between
  siblings of one already assembled building. Selection now owns one lazy lookup per immutable
  displayed snapshot, caches parent groups and context per building, and applies the 80 m / 60
  neighbor bounds filter before exact part-overlap work. Element bounds, areas, and GeoJSON features
  used by overlap checks are cached per immutable element. The local Three.js runtime is parent-keyed:
  sibling switches retain its WebGL context, building and neighbor meshes, terrain, decoded LiDAR,
  and static point positions, updating only focus and discrepancy colours. This also prevents a
  sibling switch from aborting in-flight terrain or national LiDAR reads.
- **FT-03 OSM tag semantics — done.** Height rules and map color coding move to OSM tags with unit parsing. Implemented in `src/lib/osm/parse.ts`: unit-aware height parsing, `building:levels`, `min_height` / `building:min_level`, residential detection for the per-floor estimate. Colors and the 3D view read the normalized values, so both sources share one implementation.
- **FT-04 Local edit model — done.** Dirty state, undo, and a pending-change set held client-side. Verified: applying advice re-renders the 3D view on the same render (a footprint-only building went from the 4 m fallback to 18.5 m), edited values are highlighted with a per-tag revert, and edits survive a reload — after F5, way/194996878 still showed `building:levels=5` over OSM's 6, and reverting restored 6 and removed the stored entry. Extended
  2026-08-19: footprint overrides and drawn parts persist too, in their own IndexedDB store. Before
  that only tag overrides survived a reload, so a tag edit on a sliced part outlived the part and
  turned into a pending change pointing at nothing — reported by the submit checks as
  `drawn-element-missing` — while the part-id counter restarted at 1 and could hand the ghost's
  overrides to the next drawn part. Drawn parts also moved off an invented `new/part-N` id onto the
  negative placeholder the upload actually uses (`way/-1`), so one `type/id` grammar covers every
  element and the review dialog and the `osmChange` name it identically. Verified: seeding a drawn part plus an override on it and a
  second override on a part that no longer exists, then reloading, restored the part with its
  geometry and merged override ("3 properties across 1 OSM entity") and deleted the orphan from
  IndexedDB.
- **FT-10 Changeset assembly and pre-upload checks — done.** Pending changes are structured into
  the elements a changeset would carry and reviewed before anything is sent: node identity resolved
  against loaded OSM nodes (exact reuse, 3 cm near-miss within the building group, drawn duplicates
  merged), new nodes inserted into the walls they landed on, versions on every modify, and a hole
  converted into a `type=multipolygon` relation with the tags moved off the way. A submit dialog
  shows the plan, the errors and warnings, and the exact `osmChange` (copyable, downloadable as
  `.osc` for JOSM). Uploading stays inert on purpose. Verified against a synthetic OSM tile: a tag
  edit resends the way's node list and the relation's members unchanged; a no-op edit is dropped;
  a hole moved `building`, `height` and `name` off `way/1` onto a new relation with `outer`=way 1
  and `inner`=the new ring; a slice of a square produced 2 new nodes (not 8), both shared by the
  two new parts, and inserted both into the outline at `[101, -2, 102, 103, -1, 104, 101]`; the
  half-covered case warned "50% of way/1 (63 m²) is not covered"; `building:levels=-2` and
  `height=12,5` were reported as an error and a warning respectively. Swept over real OSM data
  through the app's own proxy — 153 way buildings in three Stockholm z16 tiles, 383 changesets
  (slice, hole and tag edit for each): zero structural failures (every referenced node present, every
  ring closed and repeat-free, versions on modifies only, no dangling relation members), every slice
  needing exactly 2.00 new nodes against 8.3 reused, all 105 holes producing a multipolygon, and
  2 warnings in total — both the same true positive, Storkyrkan's single 130 m² bell-tower part on a
  2292 m² footprint. That sweep is also what showed the checks had to be scoped to what the changeset
  writes: an unscoped uppercase-key rule fired on `ref:SE:raa`, and a pre-existing part sticking out
  of a neighbour's outline would have blocked an unrelated upload.

- **FT-10 fix (2026-08-19).** The changeset was assembled from a memo over the raw-tile _ref_, whose
  dependencies listed only the edits, so tiles arriving never refreshed it. After a reload — when the
  restored edits change while nothing has loaded yet — every edit reported `element-not-loaded` and the
  changeset came out empty, with the building on screen and its tile loaded. Raw tiles are now held as
  state alongside the ref the map callbacks read. Reproduced against `way/110870522` and confirmed
  fixed: the same deep link now plans `modify way/110870522 v4`, `building:levels 0 → 2`, all checks
  passing. The changeset comment is also a properly required field now — marked, invalid when short,
  with one shared rule (`isUsableComment`) behind both the field and the blocking check.

- **FT-05 OAuth 2.0 PKCE sign-in — done.** Against `api06.dev.openstreetmap.org`, from the submit
  dialog: account name plus **Log out** when signed in, **Log in with OpenStreetMap** when not. The
  browser never holds a token — the code exchange happens in a route handler and the token lives in an
  httpOnly cookie (ADR 0002) — the session is re-confirmed upstream rather than trusted from the
  cookie, sign-out revokes upstream first, and consent opens in a popup so pending changes survive.
  Verified: the S256 challenge matches RFC 7636's test vector and the challenge in the authorize URL
  matches the verifier stored for that attempt; the authorize URL carries the dev host,
  `response_type=code`, `S256`, `scope=read_prefs write_api`, the running origin's redirect URI and a
  fresh `state`; a forged postMessage with the wrong state is refused ("The sign-in response did not
  match this session"); `error=access_denied` on the callback shows OSM's own reason; the
  no-opener redirect fallback stores the code, returns to the app and consumes it; with no client id
  configured the dialog names the env var and the exact redirect URI to register instead of offering a
  dead button. Client id and OAuth host are server-only env (`OSM_CLIENT_ID`, `OSM_OAUTH_BASE`), served
  to the browser by `/api/osm/session`, so they stay runtime configuration rather than build-time
  constants. Not verified end to end: the code exchange itself needs an OAuth application registered
  on the dev server, which only the account owner can create.
- **FT-06 Changeset upload — implemented, awaiting a real round trip.** `PUT /changeset/create`, the
  upload POST rendered from the reviewed plan with the changeset id, and `PUT /changeset/close` in a
  `finally`, all server-side. `diffResult` is parsed for the placeholder → real id mapping; on success
  the pending changes are dropped and the affected tiles refetched past every cache (`?fresh=1`), so
  the map shows what OSM holds. Upload is gated on a signed-in account, no errors and a comment; a
  production host additionally needs `OSM_ALLOW_PRODUCTION_WRITES=true` and a confirmation naming the
  account and element count. Verified without writing: the rendered document carries
  `changeset="<id>"` on every element, the create body carries `comment`, `created_by` and `source`, a
  realistic `diffResult` parses to the right mapping, an unauthenticated upload is refused 401, and the
  refusal is reported to the UI before the button is pressed. Still unverified: an actual changeset
  landing, and 409 conflict handling against a real stale version.

  Two fixes after first contact: the hook reported "Sign-in is still loading" to a signed-in user
  because `config?.uploadRefusal ?? fallback` conflated the server's `null` ("nothing refused") with a
  missing answer, so Upload never enabled — the session is now the single writer of that config, read
  back after a sign-in too, and only a missing config means "not yet". Escape during the upload
  confirmation also closed the review behind it; the confirmation owns Escape while it is up. The gate
  was then exercised over every state: exactly one enables Upload — signed in, no errors, nothing
  refused.

  Two more after the first real upload landed. The dialog kept reviewing after success: `onUploaded`
  clears the pending changes, so the plan recomputed to empty and the checks reported "there is nothing
  to upload" with a red footer over a changeset that had just succeeded. A completed upload now replaces
  the review entirely — header, result, ids assigned, changeset link, one **Done** — because there is
  nothing left to validate. And that result used to persist for the rest of the session, since the
  dialog stays mounted when closed; it is cleared whenever the dialog opens. Exercised end to end with
  `/api/osm/session`, `/api/osm/oauth/token` and `/api/osm/changeset` stubbed in the page, so nothing
  reached OSM: the stubbed sign-in enabled Upload ("attributed to TestMapper"), the confirmation named
  the host and element count, the route received the reviewed plan verbatim (`create way/-1 id=-1`,
  4 nodes, the typed comment), and the result view listed `node/-2 → node/111`, `node/-3 → node/112`,
  `way/-1 → way/222` with the pending changes cleared to zero.

  Follow-up (2026-08-23): successful upload now clears the submitted comment while retaining the
  success result. The next review therefore accepts its newly generated plan description instead of
  carrying the previous changeset's text across the dialog's mounted lifetime.

- **FT-08 Validation hints.** Surface the FT-10 checks in the inspector, not only at submit time, so
  suspect geometry and tagging are visible while editing rather than silently rendered: a part floating above everything below it (likely `building:min_level`
  off by one, see the worked example in the domain spec), parts overflowing their outline, and
  parts leaving the footprint mostly uncovered. Acceptance: way/111680989's two floating parts
  are flagged with the suggested `building:min_level` value.
- **FT-10 fix (2026-08-20).** Typing in the changeset comment re-ran every check, because the comment
  was a dependency of the memo that walks each part through boolean geometry: 12 ms per keystroke on a
  nine-part building before rendering, and worse on a real changeset. The comment rule now stands on
  its own (`commentIssues`) and the geometry pass runs once when the dialog opens; the element list is
  memoised too, since it cannot change while the comment does. Measured in the app on a 70-element
  changeset: median 2.4 ms per keystroke, down from a per-keystroke validation of 12 ms plus rendering.
  Numbers are from a development build, where React renders twice.

- **FT-10 review performance fix (2026-08-21).** Changeset assembly and validation reused the map's
  selection function for every changed element. That function deliberately builds 3D context, so each
  call reparsed every loaded feature and associated every building with every part before discarding
  the neighbours the submit flow never uses. The isolated `osm/building-lookup.ts` module now creates
  one lazy lookup per raw or locally edited collection, parses it once, computes only requested
  building groups, and reuses a group across sibling edits. A synthetic dense collection of 480
  features and 60 part entries took
  2365.1 ms through repeated full map selection and 13.9 ms through the submission lookup (170× for
  this isolated stage). The complete static review process—changeset assembly, checks, and `osmChange`
  rendering—is exposed through the isolated `osm/submission-review.ts` module; the cheap comment rule
  remains separate so typing cannot rebuild it. Node indexing and the actual checks remain unchanged.

- **FT-10 relation fix (2026-08-21).** Multipolygon submission originally keyed support to a
  `glue` edit and required closed member ways. Persisted real edits showed why an edit-kind label is
  not a topology guarantee: `relation/1794585` had become a `reshape` after its Slice nodes were
  dragged, while `relation/14227562` used `add-part` and its outer ring was assembled from four open
  ways. Submission now proves the mapping from geometry instead. Every old member node must survive
  in cyclic order; edited arcs between those anchors are written back in each member's original XML
  direction. Verified with both persisted shapes: relation 1794585 modifies closed
  `way/111680986` with two inserted and eight moved nodes; relation 14227562 modifies only open
  `way/1067568286` with four inserted and four moved nodes. Neither relation member list is rewritten.

- **Add part shared-node fix (2026-08-21).** Add part expanded the outline and created the exterior
  part but skipped the local weld pass already used by Slice. Its two attachment nodes could
  therefore lie on an existing part's matching wall without appearing in that part's node list. Both
  exact snapped points are now inserted into every sibling part segment they lie on, including
  session-local parts and the base part created for a previously unpartitioned building. Existing
  part areas and earlier edit metadata are preserved.

- **Reshape topology and node visibility (2026-08-23).** Reshape now uses the same node-first
  boundary snapping model as the drawing tools across every visible building and part. A drag onto
  an edge inserts the shared node into every coincident ring, including the parent outline; a drag
  onto an existing node rewrites edited node lists to that node rather than stacking coordinates.
  Double-click insertion runs the same local weld pass, so adding a corner to a part's shared wall
  also changes its outline. Nodes with their own OSM tags render amber. Verification: `yarn lint`
  and `yarn tsc --noEmit` pass; interactive map verification remains to be performed in the user-run
  development server.

- **Part roof ownership (2026-08-23).** Editing `roof:shape` on a part now records removal of the
  parent's `roof:shape`. When Slice or Add part creates the first parts for an unpartitioned outline,
  all generated parts explicitly copy `roof:shape`, `roof:direction`, `roof:orientation`, and
  `roof:height`, while the same keys are removed from the outline. Later part additions retain sparse inheritance. Static
  verification uses `yarn lint` and `yarn tsc --noEmit`; interactive verification remains in the
  user-run development server.

- **Axial roof orientation (2026-08-24).** Gabled, gambrel, and round barrel roofs now parse and edit
  `roof:orientation=along|across`. `along` remains the OSM default ridge on the long axis of the
  minimum-area oriented rectangle; `across` rotates every profile, clip band, and raised end wall
  onto its short axis. Parts inherit the parent's orientation unless they define their own roof
  shape, height, or orientation.

- **Skillion roofs and direction (2026-08-24).** `roof:shape=skillion` now renders as one clipped
  plane from the total-height edge down to the eaves. `roof:direction` accepts degrees and 16-point
  compass values as the downhill bearing; without it, the slope takes either deterministic direction
  perpendicular to the longest side of the minimum-area oriented rectangle. The inspector compass
  handle turns its drag vector into a centroid ray and saves the first intersected edge's aligned
  normal rounded to whole degrees; clicking the adjacent value opens exact numeric editing. Selecting
  an effective skillion building or part draws a map-aligned V at its centroid with the sharp corner
  downhill.

- **Overlapping-volume fix (2026-08-23).** The `overlapping-volumes` warning now offers a
  deterministic **Fix** when the shorter part starts at ground and the other part has a higher top.
  It sets the higher part's `min_height` to the shorter part's effective top, then the existing
  review flow immediately rebuilds the plan and validation findings. Equal-height and elevated-base
  overlaps remain review-only because there is no unambiguous stacking order.

- **Slice change (2026-08-20, refined 2026-08-21).** A closed loop used to partition the building
  into the loop interior _and its complement_, so drawing a tower inside a footprint produced a
  ring-shaped part alongside it — and a ring is a polygon with a hole, uploaded as a
  `type=multipolygon` relation. Four of them landed that way in changeset 187728645. A loop now adds
  the tower region without modifying existing parts. It creates a complete-footprint base only when
  the building had no parts; with existing parts it yields 1 addition and 0 replacements. Open
  polylines are unaffected — the sweep over two tiles still shows 110 slices and 89 holes with zero
  structural failures and 2.00 new nodes per slice.

- **Hole propagation through parts (2026-08-25).** A cut hole used to modify only the building
  outline and force that outline to replace all part meshes in 3D, leaving the actual part geometry
  and upload unchanged. The cut loop is now boolean-subtracted from every intersected existing or
  drawn part. Contained loops become part holes, boundary-crossing loops become notches, every
  affected element receives a pending geometry change, and normal part-coverage rendering remains
  active because the opening exists in the source geometry.

- **FT-07 Production switch.** Only after FT-06 is proven on the dev API. Note that **sign-in** was
  pointed at production early (2026-08-19), because the OAuth application was registered there and the
  two installations do not share registries; that is safe only while nothing writes. FT-06 therefore
  carries an extra acceptance criterion: an upload must refuse a production host unless production
  writes are enabled by their own explicit setting, so pointing `OSM_OAUTH_BASE` at the real map can
  never by itself send edits to it.

- **FT-09 LOD1 advice — done.** Import Stockholm LOD1 and suggest `height`, `roof:height` and
  `building:levels` per building, with match confidence. Verified against way/204715520 (74%
  coverage, three values offered) and the merged Luma Park block (advice correctly marked
  unreliable).

## Verification notes

- Upstream call counting is part of the definition of done for FT-01; every later slice must keep that count flat while panning over cached area.
- Write slices are developed exclusively against the OSM dev API. Production writes are a deliberate, separate step.
