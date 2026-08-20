# Building Explorer

Browse a map, click a building or one of its parts, inspect it in 3D.

- **Map**: [MapLibre GL](https://maplibre.org/) with OpenStreetMap raster tiles. Pan, zoom and rotate — right-drag, the bottom-right camera controls, or shift+arrows change bearing; pitch stays locked at 0 so footprints are always read from straight above.
- **Buildings**: [Overture Maps](https://overturemaps.org/) buildings theme, streamed straight from the official PMTiles release (`building` + `building_part` layers). Shown from zoom 10 and clickable, colored by the height data each feature carries:
  - 🟪 **purple** — locally modified, with pending overrides
  - 🟩 **green** — a measured `height`
  - 🟦 **blue** — no height, but a `num_floors` count we multiply into one
  - 🟥 **red** — footprint only, so the height is a single-floor guess

  Coverage varies a lot by region: Amsterdam is ~88% green, Stockholm is ~69% blue with ~30% red.

- **Cut hole**: at live-OSM zoom, activate the top toolbar tool and click inside a building to place square nodes. Click the first node or press Enter to close a valid loop; Escape or pressing **Cut hole** again cancels the entire draft. A completed hole updates the map footprint and 3D extrusion immediately, including visible vertical inner walls through the building's full height. It marks the building purple and appears in the changes sidebar.
- **Slice**: at live-OSM zoom, use the crosshair to start on any outer or interior building boundary and draw a straight or multi-node polyline to another boundary — which divides what it crosses — or start inside and draw a closed loop, which only _adds_ the part it encloses and leaves everything under it untouched. A loop deliberately does not carve the surrounding area into a ring: a ring is a polygon with a hole, and OSM can express that only as a multipolygon relation, which is not what drawing a tower on a roof should produce. The rest of the outline is then left without a part, which the pre-upload checks report. A purple **X** previews an edge snap; a hollow square previews exact reuse of an existing footprint node, including hole and part nodes. The original `building=*` outline stays intact while the resulting regions become `building:part=*` areas; any existing parts crossed by the slice are split too. Escape or pressing **Slice** again cancels the draft.
- **3D view**: selecting a building or `building:part` opens a side panel with a [Three.js](https://threejs.org/) extrusion on [Mapterhorn](https://mapterhorn.com/) z13 terrain. The selected building's lowest terrain sample is scene zero; neighbors use their own footprint minima, so slopes remain visible without tilting a building. Clicking a part highlights and inspects that part, frames it in 3D, and retains its parent and sibling parts for context. Its initial bearing matches the map at the moment the entity is selected, then zoom (scroll) and rotation (drag) are independent via OrbitControls. Adjacent buildings within 80 m are drawn in gray for context (capped at 60, nearest first).
- **External 3D**: links below the local 3D viewer open the selected building in Bing or Google Earth. Rotating, tilting or zooming the local camera updates both links, so the external view starts from the same angle — and the same framing: the local camera and the Google Earth link share one field of view (35°), so neither reframes on the way across. No third-party request is made until a link is opened.
- **Linkable selection**: the selected element lives in the URL hash — `/#way/42764754` opens the app on that building, selecting one writes its id back, and deselecting clears it. Hash writes use `replaceState`, so the back button is not filled with buildings.
- **Inspector**: below the 3D view the panel lists every OSM tag on the selected building or part, raw and alphabetized, with its own id and version in the header. Hovering `height`, `building:levels`, `min_height`, or `building:min_level` reveals a pencil; its modal saves with Enter and cancels with Escape, and accepted values update the map and 3D view immediately. A selected part exposes a **parent** link beside `building:part=yes`. Pending edits are stored against that exact OSM entity; LOD1 advice remains building-outline only.
- **Selection is live OSM only** (z >= 16). Clicking the Overture overview below that zoom shows a hint rather than snapshot fields that are not OSM tags and cannot be edited.
- **Photos**: toggle a satellite-imagery underlay (Esri World Imagery); with photos on, only building and part boundaries are drawn. A four-way-arrow button then enables alignment mode: map panning is locked and dragging moves only the imagery. The geographic offset survives ordinary map pan, zoom, bearing changes, and toggling Photos during the current session.

## Data sources

Two sources, split on purpose (see [ADR 0001](memory/adr/0001-live-osm-data-for-editing.md)):

| Zoom  | Source                    | Why                                                                                                                                               |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10-15 | Overture PMTiles snapshot | Global, free, no rate limits — good for an overview. Lags OSM by weeks, and its geometry has no OSM node identity, so it is never an edit target. |
| 16+   | Live OSM API, proxied     | Shows edits made minutes ago and carries element type, id, version and node ids, which is what editing needs.                                     |

The legend shows which one is active.

### The OSM read path

Every upstream request goes through this app; the browser never calls OSM directly. This is a hard requirement, not an optimization — see [ADR 0002](memory/adr/0002-cached-rate-limited-osm-proxy.md).

- `GET /api/osm/tile/16/:x/:y` — buildings and parts for one z16 tile. Off-grid requests are rejected, which keeps the cache key space bounded.
- `GET /api/osm/stats` — upstream and cache counters, so the request cost is observable at any time.

Layers: IndexedDB in the browser, then an in-memory LRU and a disk store under `.cache/osm/`. Concurrent requests for one tile collapse into a single upstream fetch, upstream calls are spaced ~1.1 s apart with one in flight, 429/504 back off honoring `Retry-After`, and a circuit breaker serves stale data rather than retrying. Tiles are fetched only at z >= 16, on debounced map idle, nearest-first and capped per viewport.

Measured on the Stockholm test area: 10 simultaneous requests for one tile produced 1 upstream call, and a full page reload produced none at all.

## LOD1 advice

Stockholm's **"SBK 3D-Byggnader (LOD1) generaliserade"** (from [the city's data portal](https://dataportalen.stockholm.se/dataportalen/GetMetaDataById?id=88d3b57c-a914-4922-97a6-a9a76b1e0175)) gives per-building ground, eaves, roof-median and ridge levels measured from airborne laser data. Import it into z16 tiles:

```bash
node scripts/import-lod1.mjs
```

That downloads the published shapefiles, reads the MultiPatch solids and their DBF heights, reprojects SWEREF99 18 00 (EPSG:3011) to WGS84, and writes `data/lod1/16/{x}/{y}.json` — 77,743 buildings for the whole city. The files are gitignored; regenerate them rather than committing them.

Selecting a building matches it against the LOD1 block with the greatest overlap and offers:

| tag               | from                                                            |
| ----------------- | --------------------------------------------------------------- |
| `height`          | ridge minus ground — what OSM's `height` means                  |
| `roof:height`     | ridge minus eaves, skipped when implausible                     |
| `building:levels` | estimated from the facade height at the building's level height |

Advice appears as a button on the row: green **+** when OSM has no value, amber **!** when OSM disagrees. Pressing it applies the value, which highlights, re-renders the 3D view immediately, and can be reverted per tag or per building. Pending changes live in IndexedDB — tag overrides, footprint overrides and drawn parts alike — so a reload keeps them. A purple **X changes** button in the top-left opens a sidebar grouped by affected building ID, with each property change on its own row beneath its linked building header, laid out like the inspector's tag table; selecting the header centers the map and opens that building. Every row can be **edited** — through the same value dialog the inspector uses — or **removed**, which reverts a tag override to what OSM has, unsets a drawn part's own tag, or discards a footprint override. A drawn part's `geometry` and `building:part` rows are the exceptions, since removing either would mean deleting the part: the header's own discard action does that, with a confirmation. **Revert all** asks for confirmation, then discards every pending tag and geometry change.

LOD1 footprints are generalized, so coverage is reported both ways. When one LOD1 block spans several OSM buildings its heights describe the whole block, not the selected building — those suggestions are drawn muted and the panel says so.

## Laser point cloud

Stockholm's **"SBK Punktmoln - flygburen laserskanning (2023)"** is the raw survey behind those LOD1 heights: >16 points/m², classified, and coloured from the 2023 orthophoto. Import it into z16 tiles:

```bash
node scripts/import-lidar.mjs
```

With no arguments that downloads the one area the city publishes for direct download — 200 x 200 m over Stora Essingen (Kungsholmen), 1,010,569 points. Pass `--src <file|dir>` for LAS files ordered from the city (geodataservice@stockholm.se), and `--max-per-tile` to change the 500,000-point cap. The script reads the LAS header, VLR projection and point records itself, reprojects EPSG:3011 to WGS84, and writes `data/lidar/16/{x}/{y}.bin`: planar `uint16` arrays the browser views without parsing. Gitignored, like `data/lod1`.

The 3D view then draws the cloud as dots around the selected building, in its true orthophoto colours. Mapterhorn—not LiDAR—defines ground: each survey is vertically aligned by the median difference between its ground-class returns and the z13 terrain at the same coordinates. A `height` that disagrees with the survey shows up directly: the extruded roof floats above the dots or sinks below them. Nothing is inferred from the points — see [ADR 0004](memory/adr/0004-laser-point-cloud-as-raw-evidence.md) and [ADR 0006](memory/adr/0006-mapterhorn-defines-3d-ground.md).

## National laser data, on demand

Where the city's scan stops, **Lantmäteriet's "Laserdata Nedladdning, skog"** takes over — open data, CC0, no fee, 1.4 points/m² over Stockholm, flown 2021-03-23. It is not imported: the upstream COPC files are 0.5-1.4 GB each and cover the country, so `/api/skog/tile/{z}/{x}/{y}` finds the file through Lantmäteriet's public STAC API, range-reads only the octree nodes over the tile, and caches the assembled tile under `.cache/skog`. One z16 tile costs about 15 nodes and 2-4 MB upstream, and answers from cache in ~30 ms afterwards. See [ADR 0005](memory/adr/0005-national-laser-data-read-on-demand.md).

Access needs a free [Geotorget](https://geotorget.lantmateriet.se/konto-privatperson) account with permission for the product, then two server-side variables in `.env`:

```bash
GEOTORGET_LOGIN=your-account
GEOTORGET_PASSWORD=your-password
```

Nothing that reaches the browser sees them. Without them — or without the product permission, or when upstream is down — the route answers an empty tile and the 3D view simply has no dots; the reason is in the `x-skog` and `x-skog-error` response headers, and `x-skog-read` reports what a live read cost.

The inspector says which it is: the LOD1 strip ends with `laser: reading…`, `laser: 345,031 pts · Laserdata Skog`, or `laser: no points`, so a tile still being assembled is distinguishable from an area the surveys never covered.

The 3D view merges the sources spatially: occupied one-meter city coverage cells suppress nearby national returns, while the national survey fills uncovered parts of the same tile. Stockholm therefore shows photographic dots at 25 points/m² without losing Skog coverage at a municipal scan boundary. Measured against the city scan on five Stora Essingen buildings, ridge heights from this source agreed within 0.8 m median, 1.1 m worst — closer than LOD1 manages on the same buildings. It is thin below ~50 m² of footprint, and a footprint percentile reads a narrow tower's skirt rather than its top.

## Signing in to OSM

Sign-in is OAuth 2.0 with PKCE, from the submit dialog: **Log in with OpenStreetMap** when signed
out, the account name and **Log out** when signed in. It runs against the **development** API
(`api06.dev.openstreetmap.org`) — writes are proven there before production (EP-001 FT-07) — and the
dialog names the host, so a dev account is never mistaken for a production one.

The browser never holds an access token. It sends the user to OSM for consent, receives an
authorization code back, and hands that code to this app's own route, which exchanges it and keeps
the token in an httpOnly cookie (ADR 0002: no browser talks to an upstream API). Consent itself is
the one upstream navigation that cannot be proxied. Signing out revokes the token upstream before
dropping the cookie. Sign-in happens in a popup so the map, selection and pending changes survive it;
if the popup is blocked it falls back to a redirect, which is safe because pending changes are stored.

`OSM_OAUTH_BASE` chooses the server. The dev instance and production are separate installations with
separate accounts _and_ separate application registries, so an application registered on one is an
unknown client on the other. When the host is the real OSM the account row says so in amber — an
account on the public map is not the same thing as one on a test server, and this app is being taught
to write.

To enable sign-in, register an OAuth 2 application — on the dev server
(<https://api06.dev.openstreetmap.org/oauth2/applications>) or production
(<https://www.openstreetmap.org/oauth2/applications>), matching whichever `OSM_OAUTH_BASE` points at —
with:

- **Redirect URI** `http://127.0.0.1:3000/oauth/callback` — match the port you actually run on, and
  use the loopback **IP**: OSM forces https on redirect URIs and exempts only `127.0.0.1` and `::1`,
  never the name `localhost`. The app derives its redirect URI from the origin you have open, so
  browse to `http://127.0.0.1:<port>` too, or OSM will reject the mismatch. Note that IndexedDB and
  cookies are per-origin, so pending changes made on `localhost` are not visible on `127.0.0.1`.
- **Permissions** "Read user preferences" and "Modify the map" — and nothing else. There is no
  per-element scope: `write_api` ("Modify the map") covers nodes, ways and relations. "Redact map
  data" is a moderator scope for editing element history and must never be requested.
- Confidential application: either. The code exchange happens on the server, so a secret can be held
  properly; set `OSM_CLIENT_SECRET` when the application is confidential and leave it unset when it is
  not. PKCE is sent either way — it proves the browser that finished the flow is the one that started
  it, which a secret does not.

Then set the client id (and secret, if any):

```bash
echo 'OSM_CLIENT_ID=your-client-id' >> .env
```

These are read on the server only — deliberately not `NEXT_PUBLIC_`, which would inline them at build time and make one
build unable to serve both dev and production. The browser is told the client id, scope and authorize
endpoint by `/api/osm/session`; a public PKCE client id is not a secret (it travels in the consent URL),
so this is about runtime configuration, not concealment. Without a client id the dialog says what to
register and offers no broken button.

## Submitting to OSM

A purple **X changes** button opens the pending-change sidebar; **Review & submit to OSM** at its
foot builds the changeset and opens the review dialog, which is also where you sign in. **Upload**
sends it: create changeset, upload, close, all through this app's own routes because the token is in an
httpOnly cookie. It is enabled only with a signed-in account, zero errors and a comment; writing to the
real OSM additionally needs `OSM_ALLOW_PRODUCTION_WRITES=true` and a confirmation, since an accidental
upload can only be reverted, never erased. Once a changeset lands, the pending changes are dropped and
the affected tiles are refetched past every cache, so the map shows what OSM now holds. The rules
behind all of it live in [the submission spec](memory/spec/domain/osm-submission.md).

Three things happen when the changeset is assembled (`src/lib/osm/changeset.ts`):

- **Nodes are reused, not restacked.** Every vertex is resolved against the nodes already loaded
  (`node_ids` from the OSM API): an exact position is always the same node, a near miss within 3 cm
  reuses only within the edited building's own group, and two drawn vertices at one position collapse
  into one node. Slicing a square therefore adds **2** nodes, both shared by the parts either side,
  instead of 8 unconnected ones. New nodes that land on a wall are inserted into that wall's way, so
  the parts share it rather than crossing it.
- **A drawn part is `way/-1`, not an invented id.** OSM has no id for it until an upload assigns
  one, so it carries the negative placeholder the changeset sends — the convention JOSM (`way -1`)
  and iD (`w-1`) use — which means the review dialog and the `osmChange` name it identically, and a
  negative id is what marks an element as not existing upstream.
- **Versions travel with every modify**, so a stale edit comes back as a conflict instead of
  overwriting somebody's newer work.
- **A hole becomes a multipolygon.** A way holds one ring, so cutting a hole converts the way into
  the untagged `outer` member of a new `type=multipolygon` relation and moves the tags onto it —
  what the wiki prescribes and what JOSM's _create multipolygon_ does.

Before that document can be sent it has to pass the checks. Errors block, warnings are for the
reviewer, and every rule that exists upstream is taken from upstream rather than invented: numeric
formats from JOSM's `numeric.mapcss`, geometry rules from its `geometry.mapcss` and validation
tests, coverage from [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings).
Highlights:

| level   | check                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| error   | unclosed, self-intersecting or self-touching ways; duplicated consecutive nodes; a part reaching outside its outline; missing version, node list or member list; `building:levels` that is not a count; a `min_height` above `height`, a roof taller than the building, a `building:min_level` that skips every level; API limits (2 000 nodes per way, 10 000 elements per changeset); an empty changeset or comment |
| warning | a part we merely inherit reaching outside its outline; ground-level parts leaving more than 2% of the outline uncovered; two parts whose **3D volumes** overlap (2D overlap alone is legal); a part above the building's own height; `,` as a decimal separator or a missing space before `m`; deprecated keys such as `min_levels`; a footprint over 920 000 m²; a height over 300 m; parts under 1 m²               |

The checks only report on what the changeset writes: tag checks cover the keys it changes, ring checks
the element the change is about. Real buildings carry other mappers' tagging, and an element we resend
unchanged must not produce warnings about it — let alone block an upload.

Notably **not** checked: ring winding. OSM has no direction convention for buildings — "the direction
of the ways does not matter" — and JOSM only checks it for `natural=coastline` and `natural=land`, so
reordering a way would bump its version for nothing. Winding is still normalized internally
(RFC 7946: outer counter-clockwise, holes clockwise) because turf, MapLibre and the 3D extrusion read
it. Likewise the only coordinate grid is OSM's own 1e-7 degrees (~1.1 cm); snapping to anything
coarser would _move_ existing nodes, and neighbouring buildings share them.

The review dialog lists each element with its action, version, tag diff, node reuse and the
structural consequences in words, and offers the `osmChange` document for copy or download as `.osc`
so the same edit can be validated in JOSM.

## Why third-party 3D uses links

Measured 2026-08-19: `bing.com/maps?style=3d` answers `X-Frame-Options: DENY`, and Google Maps answers `SAMEORIGIN`, so their photorealistic 3D views cannot be framed. The panel therefore links out and translates the current Three.js orbit into each provider's camera URL: target, heading, tilt and distance for Google Earth; direction, pitch, eye height and an approximate zoom for Bing.

Real photorealistic 3D in-app would mean Google's 3D Tiles with CesiumJS — an API key and a paid quota, not an iframe.

## Height rules

Sources are normalized onto shared property names (`src/lib/buildings.ts`), so one implementation covers both. For OSM that means `height`, `building:levels`, `min_height` and `building:min_level`, with units like `40 ft` parsed. Then (see `src/lib/heights.ts`):

1. `height` (meters) when present;
2. otherwise level count × the building's **level height**;
3. minimum height, else minimum level × the same level height, lifts the base (so parts starting above ground float correctly).

The level height is derived per building, not per part: `height ÷ building:levels` when the building has both, else 3 m for residential buildings (apartments etc.) and 4 m for everything else. Every part of a building uses its building's value, so parts stack on each other instead of drifting apart. `building:min_level` is read as the OSM wiki defines it — the number of skipped levels below the part — so a part with `building:min_level=6` sits at the height of six levels.

A part is attributed to a building when at least 50% of its area falls inside that building's outline — adjacent OSM buildings share walls and vertices, so touching proves nothing. Parts replace the outline in 3D only when they cover at least 85% of the footprint; otherwise the outline is drawn too, since partial part coverage would otherwise make most of the building vanish.

### OSM notation created by Slice

The [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings) model keeps one whole-building `building=*` outline and covers it with separate `building:part=*` areas. Slice follows that model: new generic regions get `building:part=yes` and inherit physical tags when present—`height`, `building:levels`, `min_height`, `building:min_level`, materials, colours, and roof geometry. Whole-building metadata such as `name` and addresses remains only on the outline. Existing parts keep their tags on every resulting fragment. The correct lower-level key is singular `building:min_level`, not `min_levels`; a `type=building` relation is unnecessary while every generated part remains inside its outline.

## Implementation notes

- Selection is fully client-side: on click, tile features are read with `queryRenderedFeatures` / `querySourceFeatures`; parts are linked to the building via Overture's `building_id`. Tile-boundary fragments of the same feature are stitched with `@turf/union`.
- MapLibre's worker is served from `public/` (`setWorkerUrl`) because bundlers mangle its default URL. The files are copied from `node_modules` by the `postinstall` script — never edit them by hand.
- The Overture release is pinned in `src/lib/overture.ts` (`BUILDINGS_PMTILES_URL`); bump it when a new release ships (see <https://stac.overturemaps.org/catalog.json>).

## Getting started

```bash
yarn
yarn dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

```bash
yarn lint        # oxlint (type-aware)
yarn lint:full   # lint + format check + knip + jscpd
yarn format      # oxfmt --write
yarn build       # production build
```

Data attribution: © OpenStreetMap contributors, © Overture Maps Foundation, imagery © Esri & contributors, terrain © Mapterhorn and its listed sources, LOD1 models and 2023 laser point cloud © Stockholms stad, Laserdata Skog © Lantmäteriet (CC0).

## Photorealistic 3D (optional)

Set `NEXT_PUBLIC_MAP_TILES_API_KEY` in `.env.local` (billing-enabled Google Cloud project, Map
Tiles API enabled) to render Google's photorealistic mesh in the panel's third section. Billed per
session: $6/1,000 beyond 1,000 free per month, one session covering three hours. The renderer is
created once and only the camera moves, and the section is collapsed by default so no session starts
until you look. Orientation aid only — Google imagery is not a permitted source for OSM edits.
