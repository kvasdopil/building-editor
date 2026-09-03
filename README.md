# Building Editor

Separate buildings into parts, set heights and roofs, preview them in 3D, and submit changes to
OpenStreetMap.

Browse a map, click a building or one of its parts, inspect it in 3D.

- **Map**: [MapLibre GL](https://maplibre.org/) with OpenStreetMap vector tiles and a flat Liberty style hosted by [OpenFreeMap](https://openfreemap.org/); the provider's raster relief and 3D buildings are disabled. Pan, zoom and rotate — right-drag, the bottom-right camera controls, or shift+arrows change bearing; pitch stays locked at 0 so footprints are always read from straight above.
- **Buildings**: below z15.5 the app shows only the normal vector basemap. From z15.5, live OpenStreetMap buildings and parts appear and become editable, colored by the height data each feature carries:
  - 🟪 **purple** — locally modified, with pending overrides
  - 🟩 **green** — a measured `height`
  - 🟦 **blue** — no height, but a `num_floors` count we multiply into one
  - 🟥 **red** — footprint only, so the height is a single-floor guess

  Coverage varies a lot by region: Amsterdam is ~88% green, Stockholm is ~69% blue with ~30% red.

- **Reshape**: at live-OSM zoom, every corner of the selected building or part is a black dot; a node carrying its own OSM tags is a white dot with a black outline, and an entrance (`entrance=*`) is a larger black disc with a white arrow in it. Within nine pixels a corner grows a purple halo and can be dragged. It snaps to every visible building or part node and edge: landing on a node merges the edited footprints onto that node, while landing on an edge inserts the node into every coincident wall, including the parent outline. A dragged node also snaps when any pair of its incident footprint edges reaches 90°, shown by a small purple right-angle square. Double-clicking an empty stretch of a ring adds the same shared corner to every coincident wall too. A freely moved corner shared with other loaded buildings and parts moves in all of them at once, and on upload the OSM **node itself moves** — so a fence, a path, or a neighbouring outline this editor never loaded keeps the corner too, instead of being left behind on an abandoned node.
- **Add node**: with a live building or part selected, activate the plus-circle toolbar tool. Pressing an empty outer or inner footprint edge inserts a node into every coincident loaded wall and immediately starts dragging it; releasing without moving keeps it at the pressed edge position. Pressing an existing node starts the normal node drag and never creates a duplicate. Both kinds of drag include the same visible-boundary, LOD1 and right-angle snapping. Clicking another building or part selects it and retargets the still-active tool, while clicking the map background preserves the current selection. Escape abandons a drag in flight — corner or wall — discarding its preview and any node the gesture had just inserted; with no drag running it exits the mode. A newly inserted node remains a new OSM node even when it is moved during the same gesture; existing nodes retain the normal move/merge semantics.
- **Move a wall**: hovering an edge of the selected footprint highlights the stretch of wall it belongs to in violet — that segment extended both ways for as long as the outline turns by no more than 15° at the node between, so a wall broken into several segments by party walls or a survey moves as one — and the cursor changes to show it can be dragged. The highlight is the whole affordance: nothing is drawn until you hover, and it appears exactly where a press would take the wall. Dragging slides the run along its own normal: the sideways component of the pointer's travel is the whole intent, and the component along the wall is discarded, so the wall stays parallel to where it was and only its distance changes. Every node of the run takes the same offset, including the same nodes in any other loaded footprint that shares them, so a party wall stays attached to its neighbour, and the notice names how far it moved. Corner handles keep priority. With no tool active the whole hovered edge grabs the wall; in Add node mode only the middle of a segment does, so the rest of the edge still inserts a node.
- **Cut hole**: at live-OSM zoom, select a building and activate the top toolbar tool, then place square nodes anywhere to draw a cutting mask; without a selection, the first node must be inside or snapped to the target building. Every visible building and part node attracts within nine screen pixels and every edge within twelve, reusing the exact snapped coordinate. Click the first node or press Enter to close a valid loop; Escape or pressing **Cut hole** again cancels the entire draft. A mask fully inside the footprint makes a hole, while one crossing its boundary clips that portion from the footprint. The map footprint and 3D extrusion update immediately, including visible vertical inner walls through the building's full height. The same area is subtracted from every underlying part, whether the part is an existing OSM element or was drawn locally. The building and affected parts turn purple and appear in the changes sidebar.
- **Slice**: at live-OSM zoom, use the crosshair to start on any outer or interior building boundary and draw a straight or multi-node polyline to another boundary — which divides what it crosses — or start inside and draw a closed loop. When outlines share a wall, the already selected building is preferred as the target. An interior loop creates a new tower part covering the loop while the original `building=*` outline stays unchanged. If the building had no parts, it also creates one complete-footprint base part; otherwise its existing parts remain the base and only the tower is added. The tower copies the outline's `height` and `min_height` tags when available; those editable values determine how it stacks in 3D. A purple **X** previews an edge snap; a hollow square previews exact reuse of an existing footprint node, including hole and part nodes. Existing parts crossed by an open slice are split too. When that slice generates a base/remainder, only part groups connected to an outer or inner building boundary are cut out of it; isolated groups remain stacked over the base, while holes already present in the building outline remain holes. Escape or pressing **Slice** again cancels the draft.
- **First parts own the roof**: when Slice or Add part divides an outline that had no parts, every generated part copies `roof:shape`, `roof:direction`, `roof:orientation`, and `roof:height`, and those tags are removed from the parent outline in the same pending change.
- **Add part**: with a live building outline selected, start on its outer boundary, draw a simple footprint outside it, and return to a different point on the boundary. Edge and node snaps are the same as Slice; when LOD1 is visible, its corners also attract the helper gizmo for exterior nodes. The loop closes along the existing outline between its two snaps, so an addition can wrap around one or several building corners without a closing chord crossing the building. Completing the loop expands the `building=*` outline and creates the exterior `building:part=*`; every existing part boundary sharing either attachment edge receives the same snapped node. When the building previously had no parts, its original footprint also becomes a base part—with those shared nodes—so the expanded outline remains completely covered.
- **Shared corners**: a cut ends on a wall, and a wall usually belongs to more than the pieces being cut — the outline, and any part on the other side. Every corner a cut creates is inserted into each of their rings too, so the new boundary shares the wall instead of crossing it. The far-side part shows up in the changes sidebar as **corner shared**.
- **Multipolygon outlines**: relation footprints retain their member-way node identities. Reshape, Add node, wall handles, Slice and Add part can therefore move existing corners and insert new outline nodes into either closed members or rings assembled from open members, without rewriting the relation topology. The upload remains blocked if an existing boundary node was removed or reordered, because member ownership would no longer be deterministic.
- **3D view**: selecting a building or `building:part` opens a side panel with a [Three.js](https://threejs.org/) extrusion on [Mapterhorn](https://mapterhorn.com/) z13 terrain. The selected building's lowest terrain sample is scene zero; neighbors use their own footprint minima, so slopes remain visible without tilting a building. Clicking a part highlights and inspects that part, frames it in 3D, and retains its parent and sibling parts for context. Its initial bearing matches the map at the moment the entity is selected, then zoom (scroll) and rotation (drag) are independent via OrbitControls. Adjacent buildings within 80 m are drawn in gray for context (capped at 60, nearest first).
- **External maps**: links at the bottom of the properties list open the selected building in Bing 3D, Google Maps satellite view, or OpenStreetMap. Bing follows the local camera's heading, tilt, and approximate range; Google Maps follows its target and approximate zoom; OpenStreetMap opens the selected OSM element. No third-party request is made until a link is opened.
- **Linkable selection and view**: the URL hash carries both what is selected and how the map is being looked at, as `&`-separated segments — `/#way/42764754&normals&lines=1&lod1=0`. `/#way/42764754` opens the app on that building, selecting one writes its id back, and deselecting clears it. The view segments are `photos`, `lidar`, `height`, `normals` or `diff` (`map` is the default and is left out), plus `lines=1` to draw the LiDAR links (default off) and `lod1=0` to hide the LOD1 outline (default on). Only what differs from the defaults is written, so an ordinary link stays `/#way/42764754`. A LiDAR view needs a building, so it is honoured only when the hash also names one. Hash writes use `replaceState`, so the back button is not filled with buildings.
- **Inspector**: below the 3D view the panel starts with the selected feature id, then lists every OSM tag on the selected building or part, raw and alphabetized. There is no separate building/part header or panel-level close/revert toolbar. A part's `building:part` row includes a parent control. Hovering `height`, `building:levels`, `min_height`, or `building:min_level` reveals a pencil; its modal saves with Enter and cancels with Escape. Shaped roofs use a type select; gabled, gambrel, and round roofs add a `roof:orientation` select, while skillion roofs add a compass drag handle beside a clickable `roof:direction` degree value. Accepted values update the map and 3D view immediately. Pending edits are stored against that exact OSM entity; LOD1 advice remains building-outline only.
- **Skillion direction**: a selected building or part with an effective `roof:shape=skillion` shows a purple, white-cased V over its footprint centroid. Its sharp corner points downhill. Without `roof:direction`, the slope is perpendicular to the longest side of the footprint's minimum-area bounding rectangle. Dragging the inspector compass toward any screen direction casts a matching ray from the centroid, finds the first footprint edge, and stores that edge's outward-facing normal as whole numeric degrees, so the modeled plane stays perpendicular to a real wall. Clicking the value opens the numeric editor for an exact manual bearing.
- **Complex hipped roofs**: `roof:shape=hipped` uses an interior straight skeleton to turn the complete footprint into one equal-pitch roof. Concave L-, H- and T-shaped outlines form their own connected hips, ridges and valleys instead of being split into rectangular roofs; invalid skeletons fall back to the pyramidal surface rather than disappearing.
- **Part roof ownership**: changing a part's `roof:shape` also clears `roof:shape` from its parent outline, so the two do not carry competing roof types.
- **Selection is live OSM only** (z >= 15.5). Below that threshold there is no editor-owned building overlay, legend, or selection highlight—only the normal basemap geometry.
- **Photos**: a **Map / Photos / LiDAR** switch in the top-right chooses what sits under the editor overlays—only one at a time, because the imagery and the point cloud both replace the basemap. Photos is an Esri World Imagery underlay; with photos on, only building and part boundaries are drawn. A four-way-arrow button on the toolbar's second row then enables alignment mode: map panning is locked and dragging moves only the imagery. The geographic offset survives ordinary map pan, zoom, bearing changes, and toggling Photos during the current session.
- **LiDAR**: with a building selected, the third position of that switch shows a top-down point cloud. It reuses the same merged imported/national cloud as the 3D view but sends only longitude and latitude to a GPU point layer—survey height never affects position—so the view remains flat XY beneath building and part boundaries. Each point is also joined to the next point in storage order by a faint line whenever the two are within 20 m and from the same survey. Because a tile keeps its points in the order the scanner recorded them, these links draw the acquisition pattern rather than a nearest-neighbour graph: imported Stockholm and ICGC tiles preserve scanner order, while national Skog tiles—stored in COPC octree order—show only short scattered chains. Choosing LiDAR fills that second row with a **Color / Height / Normal / Diff** selector and a **Lines** checkbox that draws the links; it starts off, so the mode opens on the bare dots. **Color** is the orthophoto sample. **Height** is a rainbow ramp—violet lowest through blue, green and yellow to red highest—fitted to the heights currently in view and refitted when the map settles. **Normal** runs the same ramp over each link's angle from horizontal on a fixed 0–90° scale—violet lying flat, red standing vertical—so walls and tree trunks show as red threads. It is the raw per-link inclination with nothing fitted or smoothed, which means it reports tilt along the beam's bearing rather than the tilt of the surface. **Diff** colours each point by how far it sits above what the app models for it—the subtraction the 3D view already colours discrepancies with, so it uses the same per-survey terrain alignment. It covers the whole view, not just the selected building: a point is measured against whichever footprint covers it, the selected one or any of the neighbours the 3D view draws as context, and against Mapterhorn terrain everywhere else. It has its own palette rather than the height ramp, because what matters is a sign more than a magnitude: colour is spent in proportion to the size of the gap, so the centimetre-scale disagreement covering most of a scene sits near grey instead of competing for attention. The two signs take opposite halves of the colour wheel, so which way a point disagrees is legible before any magnitude: warm where the survey stands above the model—grey-green through yellow to red—and cold where it falls below it—grey-blue through blue to violet. The cold side keeps a floor of saturation the warm side does not, so the boundary where points pass under a roof reads as a clean edge rather than fading out through the same grey. The scale is symmetric about zero and fixed at ten metres rather than fitted to the view, so a colour is worth the same disagreement everywhere: about a storey reads as a clear green, five metres yellow, ten metres or more red. A horizontally misplaced building shows as a red patch where its roof returns land on unmodelled terrain, beside a blue one where the modelled solid stands over bare ground. Anything unmodelled reads warm—an unrecorded storey, a building nobody has mapped, and trees, which are modelled nowhere. Height reaches all of this only as colour; position stays flat XY.

## Data sources

The map switches from context to editing at z15.5 (see [ADR 0001](memory/adr/0001-live-osm-data-for-editing.md)):

| Map zoom | Source                | Why                                                                                                        |
| -------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| < 15.5   | OpenFreeMap basemap   | Clean geographic context without a highlighted building overlay.                                           |
| >= 15.5  | Live OSM API, proxied | Current editable footprints with element type, id, version and node identity, fetched on a fixed z16 grid. |

The building legend appears only with the live OSM layer.

### The OSM read path

Every upstream request goes through this app; the browser never calls OSM directly. This is a hard requirement, not an optimization — see [ADR 0002](memory/adr/0002-cached-rate-limited-osm-proxy.md).

- `GET /api/osm/tile/16/:x/:y` — buildings and parts for one z16 tile. Off-grid requests are rejected, which keeps the cache key space bounded.
- `GET /api/osm/stats` — upstream and cache counters, so the request cost is observable at any time.

Layers: IndexedDB in the browser, then an in-memory LRU and a disk store under `.cache/osm/`. Concurrent requests for one tile collapse into a single upstream fetch, upstream calls are spaced ~1.1 s apart with one in flight, 429/504 back off honoring `Retry-After`, and a circuit breaker serves stale data rather than retrying. Fixed-grid z16 tiles are fetched only at map zoom z >= 15.5, on debounced map idle, nearest-first and capped per viewport.

Measured on the Stockholm test area: 10 simultaneous requests for one tile produced 1 upstream call, and a full page reload produced none at all.

## LOD1 advice

Stockholm's **"SBK 3D-Byggnader (LOD1) generaliserade"** (from [the city's data portal](https://dataportalen.stockholm.se/dataportalen/GetMetaDataById?id=88d3b57c-a914-4922-97a6-a9a76b1e0175)) gives per-building ground, eaves, roof-median and ridge levels measured from airborne laser data. Import it into z16 tiles:

LOD1 is a **local-development reference only**. Production builds do not fetch or display it, its
tile route returns 404, and `data/lod1` is excluded from Vercel uploads until the city's metadata
states explicit redistribution and OSM-compatible reuse terms.

```bash
node scripts/import-lod1.mjs
```

That downloads the published shapefiles, reads the MultiPatch solids and their DBF heights, reprojects SWEREF99 18 00 (EPSG:3011) to WGS84, and writes `data/lod1/16/{x}/{y}.json` — 77,743 buildings for the whole city. The files are gitignored; regenerate them rather than committing them.

Selecting a building matches it against the LOD1 block with the greatest overlap and offers:

| tag               | from                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `height`          | ridge minus ground, rounded to the nearest 0.5 m                 |
| `roof:height`     | ridge minus eaves, rounded to 0.5 m and skipped when implausible |
| `building:levels` | estimated from the facade height at the building's level height  |

The matched generalized footprint is drawn as a light-gray outline on the map, beneath the selected
OSM outline. While it is visible, dragging an OSM footprint node within nine screen pixels of a LOD1
corner snaps it to that corner; shared OSM nodes still move in every loaded footprint that owns them.
The **LOD1** toggle hides the outline and disables its snapping, or restores both. While drawing an
exterior outline with **Add part**, the same nine-pixel snap moves the helper gizmo and placed
exterior node onto a LOD1 corner.

Advice appears as a button on the row: green **+** when OSM has no value, amber **!** when OSM disagrees. Pressing it applies the value, which highlights, re-renders the 3D view immediately, and can be reverted per tag or per building. Pending changes live in IndexedDB — tag overrides, footprint overrides and drawn parts alike — so a reload keeps them. A purple **X changes** button in the top-left opens a sidebar grouped by affected building ID, with each property change on its own row beneath a normal `#way/…` entity link, laid out like the inspector's tag table. The group for the current map selection is highlighted. Following a header link closes the sidebar, centers the map and opens that entity. Every row can be **edited** — through the same value dialog the inspector uses — or **removed**, which reverts a tag override to what OSM has, unsets a drawn part's own tag, or discards a footprint override. A drawn part's `geometry` and `building:part` rows are the exceptions, since removing either would mean deleting the part: the header's own discard action does that, with a confirmation. **Revert all** asks for confirmation, then discards every pending tag and geometry change.

LOD1 footprints are generalized, so coverage is reported both ways. When one LOD1 block spans several OSM buildings its heights describe the whole block, not the selected building — those suggestions are drawn muted and the panel says so.

## Roof advice from the laser

Where LOD1 stops, the point cloud carries on. The selected building's Surface raster (below) is read
for the same dimension tags, so advice reaches the places the city's model does not: **every
`building:part`**, which LOD1 has no equivalent of at all; **`roof:shape`**, which it does not model;
and any building whose LOD1 block spans several structures. LOD1 keeps the row wherever it has a
confident opinion, and the laser fills in the rest — the tooltip on each button names which source
it came from.

| tag           | from                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `height`      | the 99th percentile of raw cell maxima, above this building's own ground |
| `roof:height` | the rise whose roof sits closest to the points, searched over its range  |
| `roof:shape`  | what the roof does where it meets each wall of the outline               |

Ground is a low percentile of the ground-class returns within 2 m of the outline — the ground the
walls actually stand in, following OSM's convention of measuring from the building's lowest ground
point. Neither the cloud's level for its whole 200 m box nor a wider skirt will do: the first put a
waterfront house 4 m above its own ground, and the second read a shed on the Kastellet cliff 3 m too
tall by measuring from the shoreline six metres away. Against 260 tagged buildings in Hammarby
Sjöstad the laser reads `height` to 1.12 m mean absolute error and `roof:height` to 0.69 m, both
closer than LOD1 manages on the same buildings (1.58 m and 1.55 m). In the dense old town, where
narrow streets leave few ground returns, LOD1 is still the better source (2.53 m against 3.26 m).

Beside the `roof:shape` row are **two** such measurements: what the laser recommends, and what the
element's own tags already describe. The roof each combination implies is built as the 3D view would
extrude it and measured against the points, so the recommendation is answerable rather than merely
asserted — a mapper can see whether it beats what is tagged, and by how much. Pressing the
recommendation applies all three tags at once, since they describe one roof and a height without the
roof height it was measured with builds a different one.

Each is given as a distance and as a share of the building's own height, because the same distance
means different things on different buildings: half a metre is a fortieth of an apartment block and a
fifth of a shed. Under a couple of decimetres, or a few per cent, is the roof that is there; a metre,
or a fifth of the building, means something the shape does not describe — a lift housing, a terrace,
a wing at another height, tree canopy over a small roof.

The fit chooses one of the three tags. `roof:height` is settled by it — every half-metre rise the
building could have is tried and the closest-fitting one is offered, because nothing reads the eaves
directly and the low percentile of roof cells is only a guess at where the roof starts. `height` is
not: it names the highest point of the building, a high percentile of raw maxima reads that
directly, and a mean residual pulls it down because the broad surfaces near the eaves outvote the
ridge line. Letting the fit place the height as well costs half a metre of downward bias and takes
its mean error from 1.12 m to 1.67 m. Nor the shape: brute-forcing every shape, orientation, height
and rise against these points scores 42 of 112 tagged roofs, against the walls' 70, because a
gambrel or a barrel vault has enough freedom to bend onto anything at two points per square metre.

`roof:shape` is a judgement rather than a measurement — it agrees with 70 of 112 tagged roofs — so it
is always offered muted and never claims the confidence the heights do. It is decided per wall: whether the roof falls over that wall, runs along
it as a gable end, or climbs away from it as the high side of a single pitch. Reading the walls
rather than the roof as a whole is what makes a courtyard block legible, since its wings point every
way at once. See `src/lib/roof-advice.ts` for the readings that were measured and rejected — at two
points per square metre the height residuals of a gable, a hip and a barrel vault differ by
centimetres, well inside the noise from roof equipment, so elevation is the wrong thing to compare.

## Laser point cloud

Stockholm's **"SBK Punktmoln - flygburen laserskanning (2023)"** is the raw survey behind those LOD1 heights: >16 points/m², classified, and coloured from the 2023 orthophoto. Import it into z16 tiles:

```bash
node scripts/import-lidar.mjs
```

With no arguments that downloads the one area the city publishes for direct download — 200 x 200 m over Stora Essingen (Kungsholmen), 1,010,569 points. Pass `--src <file|dir>` for LAS files ordered from the city (geodataservice@stockholm.se), and `--max-per-tile` to change the 500,000-point cap. The script reads the LAS header, VLR projection and point records itself, reprojects EPSG:3011 to WGS84, and writes `data/lidar/16/{x}/{y}.bin`: planar `uint16` arrays the browser views without parsing. Gitignored, like `data/lod1`.

The same importer accepts ICGC's classified and RGB-coloured **LiDAR Territorial 2021–2023** for a
bounded area of Catalonia. ICGC publishes ordinary 1 x 1 km LAZ files in EPSG:25831 rather than
spatially indexed COPC, so they are imported ahead of time and then flow through that same
`/api/lidar` endpoint. For Sagrada Familia:

```bash
node scripts/import-lidar.mjs --dataset icgc --bbox 2.173,41.4028,2.176,41.4045
```

The box is padded by 100 m by default to match the viewer's context cloud; pass `--padding 0` for
only the exact box. Each upstream kilometre sheet is hundreds of megabytes, and the importer refuses
more than 16 in one run unless `--max-source-tiles` is raised explicitly. Downloads remain under
`data/lidar/source/icgc`. The source id in each LDR1 tile makes the existing endpoint and inspector
name it `ICGC LiDAR Territorial 2021–2023`. The data is CC BY 4.0; derived uses must credit the
Institut Cartogràfic i Geològic de Catalunya (ICGC).

The 3D view then draws the cloud as dots around the selected building. Source colours stay intact outside the selected footprint and at or below its roof; points above the roof blend from green (<1 m) through orange (1-5 m) and yellow (5-10 m) to red (>10 m). The map's LiDAR mode draws the same cloud from straight above using source colours and XY coordinates only. Mapterhorn—not LiDAR—defines ground: each survey is vertically aligned by the median difference between its ground-class returns and the z13 terrain at the same coordinates. A `height` that disagrees with the survey shows up directly. Nothing is inferred into editable tags from the points — see [ADR 0004](memory/adr/0004-laser-point-cloud-as-raw-evidence.md) and [ADR 0006](memory/adr/0006-mapterhorn-defines-3d-ground.md).

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
real OSM additionally asks for a confirmation, since an accidental upload can only be reverted, never
erased. Once a changeset lands, the pending changes are dropped and
the submitted comment is cleared, and the affected tiles are refetched past every cache, so the map
shows what OSM now holds. The next review regenerates its description from its new changes. The rules
behind all of it live in [the submission spec](memory/spec/domain/osm-submission.md).

When a part reaches above the parent outline's `height`, that review warning offers **Fix**. It sets
the outline's `height` to the maximum effective top height across all of the building's parts and
re-runs the checks immediately. An overlapping-volume warning also offers **Fix** when one shorter
part starts at 0 m and the other has a higher top: it sets the higher part's `min_height` to the
shorter part's top, stacking the two volumes without changing either `height`.

Three things happen when the changeset is assembled (`src/lib/osm/changeset.ts`):

- **Nodes are reused, not restacked.** Every vertex is resolved against the nodes already loaded
  (`node_ids` from the OSM API): an exact position is always the same node, a near miss within 3 cm
  reuses only within the edited building's own group, and two drawn vertices at one position collapse
  into one node. Slicing a square therefore adds **2** nodes, both shared by the parts either side,
  instead of 8 unconnected ones. New nodes that land on a wall are inserted into that wall's way, so
  the parts share it rather than crossing it.
- **A freely dragged corner moves its node; it never replaces it.** Position alone cannot tell a moved
  vertex from a new one, so the drag itself is recorded and becomes a `modify` on the node — carrying
  its version, so a conflict is still caught, and its own tags, since a modify replaces the element.
  Replacing the node instead would orphan the original in OSM, drop whatever it carried, and strand
  every way outside the loaded tiles on the old corner. Moving a shared corner across two buildings
  therefore uploads exactly **one** element: the node. Ways an upload would rewrite identically are
  left out rather than resent for a version bump.
- **A corner snapped onto an existing node reuses that node.** Edited ways replace the dragged node
  id with the target node id, so the two corners are not uploaded as stacked nodes.
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
Geometry findings have a **Show** action that zooms to a red marker at the exact failing point.
Self-intersections also name the two crossing edges; **Fix** is offered only for a single local
backtrack where removing the folded-over corner makes the whole ring simple, never for an ambiguous
bow-tie.
Highlights:

| level   | check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| error   | unclosed, self-intersecting or self-touching ways; duplicated consecutive nodes; a part reaching outside its outline; missing version, node list or member list; `building:levels` that is not a count; a `min_height` above `height`, a roof taller than the building, a `building:min_level` that skips every level; API limits (2 000 nodes per way, 10 000 elements per changeset); an empty changeset or comment; a dragged corner whose node version is not loaded, or that landed exactly on another node |
| warning | a part we merely inherit reaching outside its outline; ground-level parts leaving more than 2% of the outline uncovered; two parts whose **3D volumes** overlap (2D overlap alone is legal); a part above the building's own height; `,` as a decimal separator or a missing space before `m`; deprecated keys such as `min_levels`; a footprint over 920 000 m²; a height over 300 m; parts under 1 m²                                                                                                          |

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

Measured 2026-08-19: `bing.com/maps?style=3d` answers `X-Frame-Options: DENY`, and Google Maps answers `SAMEORIGIN`, so those views cannot be framed. The panel therefore links out from the bottom of the properties list. Bing receives direction, pitch, eye height, and approximate zoom from the current Three.js orbit. Google Maps receives the building center, satellite basemap, and approximate zoom through its cross-platform Maps URL. OpenStreetMap receives the selected element id, or the building center for a local-only element.

The optional in-app view streams Google's Photorealistic 3D Tiles through the existing Three.js
renderer. It authenticates through Cesium ion rather than a direct Google API key and does not use
an iframe.

## Height rules

Sources are normalized onto shared property names (`src/lib/buildings.ts`), so one implementation covers both. For OSM that means `height`, `building:levels`, `min_height` and `building:min_level`, with units like `40 ft` parsed. Then (see `src/lib/heights.ts`):

1. `height` (meters) when present;
2. otherwise level count × the building's **level height**;
3. minimum height, else minimum level × the same level height, lifts the base (so parts starting above ground float correctly).

The level height is derived per building, not per part: `height ÷ building:levels` when the building has both, else 3 m for residential buildings (apartments etc.) and 4 m for everything else. Every part of a building uses its building's value, so parts stack on each other instead of drifting apart. `building:min_level` is read as the OSM wiki defines it — the number of skipped levels below the part — so a part with `building:min_level=6` sits at the height of six levels.

Shaped roofs use `roof:height` as the section between eaves and the total `height`. In addition to pyramidal, dome and onion profiles, `gabled`, `gambrel` and `round` roofs derive an oriented minimum-area bounding rectangle from the footprint. Their ridge follows its longest side by default (`roof:orientation=along`) and rotates onto its shorter side for `roof:orientation=across`. Gabled roofs use two planar slopes; gambrel roofs bisect each sloped side into equal-length steep lower and shallow upper panels, producing 60° and 30° pitches when the equivalent gable is 45°; round roofs approximate a circular barrel arch with twelve clipped strips. A skillion roof is one plane from the high edge at total `height` to the low edge at `height - roof:height`; a numeric `roof:direction` is used as its exact downhill bearing. Named compass tags and inspector compass drags are treated as look directions from the centroid and resolve to the normal of the first edge they hit; dragging saves the result rounded to whole degrees, while the clickable value accepts a manual numeric bearing. An omitted or invalid direction falls perpendicular to the bounding rectangle's longest side. All axial roof shells and raised end walls are cut to the real building footprint, including concave outlines and holes. A part with its own roof shape, height, orientation, or direction gets an independent roof and axis. A part without any of those is extruded up to the parent roof and shares the parent's profile, height, direction/orientation, and axis; when parts replace the outline, the parent roof shell is still rendered once across them.

A part is attributed to a building when at least 50% of its area falls inside that building's outline — adjacent OSM buildings share walls and vertices, so touching proves nothing. Parts replace the outline in 3D only when they cover at least 85% of the footprint; otherwise the outline is drawn too, since partial part coverage would otherwise make most of the building vanish.

### OSM notation created by Slice

The [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings) model keeps one whole-building `building=*` outline and covers it with separate `building:part=*` areas. Slice follows that model with sparse part tags: a new generic region gets `building:part=yes` and an explicit copy of the outline's `height` when available, while matching levels, materials, colours, and roof properties are omitted. A split fragment of an existing part likewise retains explicit `height` plus only values that differ from the outline. Omitted physical values remain effective parent defaults in the editor. Whole-building metadata such as `name` and addresses remains only on the outline. The correct lower-level key is singular `building:min_level`, not `min_levels`; a `type=building` relation is unnecessary while every generated part remains inside its outline.

## Implementation notes

- Selection is fully client-side: at live zoom, a click resolves the rendered OSM building or part against the loaded fixed-grid tile collection, where parts are associated with their parent outline by geometric overlap.
- MapLibre's worker is served from `public/` (`setWorkerUrl`) because bundlers mangle its default URL. The files are copied from `node_modules` by the `postinstall` script — never edit them by hand.

## Getting started

```bash
yarn
yarn dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The loopback IP is
allowlisted for Next.js development assets and is required for the local OSM
OAuth callback described above.

## Production deployment

Production runs on the Vercel project `silly-goose-tech/building-editor` at
`buildings.sillygoose.se`. Its secrets are Vercel environment variables, `.env` and `.env.*` are
ignored for deployments as well as for git, and the deployed filesystem is not storage — the disk
caches degrade to per-instance memory. The rules, and what that degradation costs, live in
[the production deployment spec](memory/spec/operations/production-deployment.md).

## Scripts

Imported datasets live under `data/` by default. Set **`BUILDING_DATA_DIR`** to read them from
somewhere else — a git worktree wants the checkout's copy rather than tens of megabytes of its own,
and both the API routes and `yarn advice` honour it. Do not symlink the directory into the tree
instead: Tailwind's source scan follows the link, resolves a path above the project root, and
Turbopack fails every build with `FileSystemPath("").join("../../../data") leaves the filesystem
root`.

```bash
yarn lint        # oxlint (type-aware)
yarn lint:full   # lint + format check + knip + jscpd
yarn format      # oxfmt --write
yarn build       # production build
yarn advice      # roof measurements for a building, from the terminal
```

`yarn advice way/123456` prints what the laser reads for one element's `height`, `roof:height` and
`roof:shape` beside the OSM tags and the LOD1 block, and does the same for each of its
`building:part`s; `--bbox w,s,e,n` measures every tagged building in a box and ends with the error
against those tags, which is how the reading is calibrated, and `--png <dir>` writes each building's
surface grid out as a picture to look at. It runs the app's own modules — Node strips the types,
`scripts/lib/ts-hooks.mjs` resolves them — through the same limiter and `.cache` as the server, so
no dev server is involved and a warm cache is shared with one.

It measures what the side panel offers (see [Roof advice from the laser](#roof-advice-from-the-laser)),
so a run over a well-tagged area is how those readings are calibrated. In the old town `roof:shape`
drops to 51%: half the roofs there are `gambrel`, `mansard`, `half-hipped` or `many`, shapes this
does not distinguish and never suggests.

Data attribution: © OpenStreetMap contributors, imagery © Esri & contributors, terrain © Mapterhorn and its listed sources, LOD1 models and 2023 laser point cloud © Stockholms stad, Laserdata Skog © Lantmäteriet (CC0).

## Photorealistic 3D (optional)

Set `NEXT_PUBLIC_CESIUM_TOKEN` in `.env.local` and add Google Photorealistic 3D Tiles (asset
`2275207`) to that Cesium ion account. Cesium plan, asset-access and attribution requirements apply;
restrict the browser token to the intended assets and origins. Direct Google Map Tiles API keys are
not supported because affected EEA Google Cloud projects cannot request Photorealistic 3D Tiles.
The renderer is created once and only the camera moves, and the section is collapsed by default so
it streams nothing until opened. Orientation aid only — Google imagery is not a permitted source
for OSM edits.
