# Building Explorer — domain spec

## WHAT

A single-page map app: OpenStreetMap vector basemap (OpenFreeMap Liberty rendered by MapLibre;
pan, zoom and bearing, pitch locked at 0), Overture buildings + parts rendered in contrast colors
from zoom > 10, clickable. The basemap is flat and vector-only: provider raster relief and
fill-extrusion building layers are removed before the editor overlays are installed.
Zoom and bearing controls sit in the visible map's bottom-right corner, shifting left when the
building panel is open so they remain accessible.
Selecting a building or building part opens a right-side panel with an interactive 3D extrusion
(initial bearing copied from the map on every new selection, then zoom + rotate independent of
the map, Mapterhorn z13 terrain), with adjacent buildings
drawn in gray as context, and below it an inspector listing every raw tag of the
selected feature. A "Photos" toggle swaps the basemap for satellite imagery and reduces
buildings/parts to boundaries only. While Photos is on, a four-way-arrow button toggles imagery
alignment mode. In that mode the editing map's drag-pan interaction is locked and primary-pointer
dragging changes only the imagery's geographic offset. The chosen offset remains aligned through
map pan, zoom and bearing changes and survives toggling Photos for the current session. MapLibre
raster layers have no per-layer translation, so imagery renders in a separate non-interactive map
beneath the editing map; its camera follows the editing camera plus the stored Mercator offset.
With a building selected, a mutually exclusive "LiDAR" toggle replaces the basemap with the same
merged point cloud used by the 3D view while retaining the building and part boundaries. The map
layer is strictly top-down: it projects longitude and latitude into Web Mercator XY, discards survey
height for positioning, and remains under the editor overlays. Closing the selection exits LiDAR
mode because its point set is defined by the selected parent building.

## Height rules (authoritative)

- `height` (m) wins.
- Else level count × the building's level height.
- Base: `min_height`, else minimum level × the same level height.
- **Level height is per building, not per part**: `height ÷ building:levels` when the building
  has both, else 3 m for residential subtypes (apartments etc.) and 4 m otherwise. Parts use
  their building's value, so they stack instead of drifting — a part computing its own level
  height from its own type misplaces it whenever the building has a measured height.
- `building:min_level` is the number of skipped levels below the part (per the OSM wiki, it is
  "analogous to `min_height`"), so base = `building:min_level` × level height and
  `building:levels` must exceed it.

### Worked example: levels are counts, not floor names

A 5-level base occupies 5 level-heights, 0-20 m at 4 m per level. For a tower resting on it:

| tagging                                      | renders           | meaning                                                 |
| -------------------------------------------- | ----------------- | ------------------------------------------------------- |
| `building:min_level=6` + `building:levels=8` | 24-32 m, 2 levels | 6 level-heights of empty space below — leaves a 4 m gap |
| `building:min_level=5` + `building:levels=8` | 20-32 m, 3 levels | flush on the base, floors 6-8                           |

Writing the floor's number (6) instead of the count of levels skipped beneath it (5) both
lifts the part by one level and makes it one level thinner. This is a common tagging slip;
way/1545666244 and way/1545666247 on way/111680989 have it. The renderer reads counts, which
is correct, so such data legitimately shows a gap.

- A building with parts renders only its parts in 3D unless they leave the footprint mostly
  uncovered; see [Building parts](#building-parts).

## Building parts

A part belongs to a building when at least **50% of the part's area** falls inside the
building outline (`src/lib/parts.ts`). Touching is not evidence of ownership: adjacent
buildings in OSM routinely share walls and therefore vertices, so any test based on
"a vertex lies inside" attributes a neighbour's parts to the wrong building. Overture
needs no test at all, since its parts carry `building_id`.

Parts replace the outline in 3D only when they cover at least **85%** of the footprint.
Partial part coverage is common in OSM, and dropping the outline then makes most of the
building disappear.

At live-OSM zoom, parts are independent selection targets. When a part and its parent both cover
the click point, the part wins as the more specific entity. The map highlights only that part and
the inspector shows and edits the part's own OSM id and tags. The selection still carries its
parent building and sibling parts: the parent supplies the shared level height, the complete
building stays visible as 3D context, and the camera frames the selected part. LOD1 advice is not
offered for parts because the source describes whole building blocks. The part's
`building:part=yes` inspector row includes a **parent** link that switches selection to its loaded
building outline without another network request.

## External 3D views

The panel does not embed third-party imagery. Below the local Three.js viewer, **Open in Bing**
and **Open in Google** links launch photorealistic 3D centered on the selected building. Their
URLs are regenerated from the current orbit camera whenever it rotates, tilts or zooms, carrying
the same heading, tilt and viewing distance as far as each provider's URL format allows. Bing's
distance is approximate because it exposes zoom and eye height rather than an explicit range.

The **field of view is shared** between the local camera and the Google Earth link — one exported
constant, `FIELD_OF_VIEW`, used both to construct the `PerspectiveCamera` and to write the `y`
parameter in the URL. Distance, heading and tilt only agree on framing if the lens does too: at 50°
locally against the 35° sent to Google, the same distance showed a view 1.48x wider, so the local
camera looked that much further away than the one the link opened. That gap is a ratio, so starting
closer would have hidden it for one frame and let it return on the first scroll.
Creating the links makes no third-party request; coordinates and the user's IP leave the app only
when a link is opened.

The embedded Google photorealistic section remembers its expanded state in local storage. Once the
mapper opens it, it stays expanded while switching buildings and after reloads until the mapper
explicitly hides it. An in-memory copy supplies the same state immediately when selection changes
temporarily unmount and remount the section, avoiding a closed-panel flash.

Pending-change links for existing OSM ways and relations resolve the entity through the cached
element route, fit its geometry without landing below z16, and select it once its live tile data
arrives. There is no general-purpose ID search control on the map.

## Cutting footprint holes

At live-OSM zoom, the top **Cut hole** tool starts a geometry draft. The first click must fall
inside a live building and fixes the target element; every click then adds the next vertex, shown
as a small square, and the evolving loop is drawn over the map. Clicking the first square or
pressing Enter closes the loop once it has at least three vertices. The loop must be simple,
non-trivial, and fully contained by one solid area of the target building without overlapping an
existing hole.

Escape, pressing **Cut hole** again, opening the changes sidebar, or leaving live-OSM zoom cancels
the whole draft and commits nothing. Successful completion adds an interior ring as a local
geometry override, refreshes the live map, selection outline, 3D building and context, marks the
element purple, and adds one `geometry` entry to the changes sidebar. Geometry overrides are
current-session state and are not uploaded. The 3D extrusion removes both caps inside the loop
and renders the resulting inner vertical faces with a distinct, two-sided wall material so the
opening reads from every camera direction. When building parts would normally replace the outline,
a locally cut outline is authoritative in 3D; otherwise those uncut parts would fill the opening.

## Slicing buildings into parts

At live-OSM zoom, the top **Slice** tool uses a crosshair cursor and creates a partition path using
the same square-node interaction as **Cut hole**. A slice boundary is any outer or interior ring of
the building outline **or of any of its existing parts** — a hole or part edge is a real boundary of
the area a slice divides, so an open slice may start or end on one. While the crosshair is within 12
screen pixels of such a boundary, a purple X previews the closest edge coordinate that will be used.
If it is within 9 pixels of a boundary node, a hollow square takes priority and clicking reuses that
node's exact coordinate. A first boundary click starts an open slice: further clicks add polyline
bends and clicking another point on the same building's outline, hole, or part edge completes it.
A first click inside the footprint, away from every boundary, starts a closed-loop slice; clicking
its first node or pressing Enter closes it after at least three nodes. Every segment must remain in
the solid building footprint and the path must be simple.

The two modes differ in what they change:

- An **open polyline** partitions what it crosses, and must divide something — the outline, an
  existing part, or the area no part covers yet — otherwise it is rejected. A cut that ends on a part
  edge leaves the outline itself whole.
- A **closed loop** creates two new parts without changing the `building=*` outline: one base part
  copies the complete building footprint and one center part uses the enclosed loop. They overlap in
  2D deliberately, avoiding a ring-shaped complement while covering the whole outline. Both inherit
  the outline's known physical tags; the mapper must adjust `height` plus `min_height` or
  `building:levels` plus `building:min_level` when the center is stacked above the base, so their 3D
  volumes do not overlap. Escape, pressing **Slice** again, opening pending changes, or leaving
  live-OSM zoom cancels the draft.

Boundary snapping stays out of full selection assembly. Before the first node it reads candidate
rings from a lightweight index over the displayed collection; after the target is known it caches
that building's outline, holes, and part rings in screen coordinates, invalidating them only when the
map camera moves. Pointer events are coalesced to one snap calculation and draft-source update per
animation frame. Completing a slice may run polygon boolean operations, but cursor movement must
never associate every loaded part, assemble 3D neighbors, or run Turf intersections.

The operation follows [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings):

- the single `building=*` outline remains unchanged and continues to hold whole-building metadata;
- the partition regions cover the complete outline as `building:part=*` areas;
- a newly covered region has `building:part=yes` plus any known physical tags inherited from the
  outline: `height`, `building:levels`, `min_height`, `building:min_level`, facade/roof material
  and colour, and roof geometry tags;
- names, addresses, operator and other whole-building tags are not copied to generated parts;
- every existing part crossed by the path is partitioned by the same geometry, the largest
  fragment retains the original OSM entity id, and new fragments inherit all tags of that part;
- uncovered footprint regions become new session-local part entities. These and every modified
  original part appear in Pending changes and render purple on the map.

The OSM key is singular `building:min_level`; there is no `min_levels` key in this model.
`building:levels` is the total level count including skipped levels below an elevated part and
must be greater than `building:min_level`. Because generated parts are contained within the
outline, Slice does not create a `type=building` relation; that relation is reserved for complex
grouping or parts outside the outline. Slice geometry is current-session pending state until the
changeset-upload feature exists.

## LOD1 advice and local edits

Stockholm LOD1 (see ADR 0003) is matched to the selected building by greatest area overlap,
requiring at least 40% of the OSM footprint to be covered. Coverage is computed **both ways**:
when the OSM building accounts for less than half the LOD1 block, the block is generalized over
several buildings and its heights are not about this building — advice is then marked
unreliable rather than hidden, because the mapper decides.

Suggested tags: `height` (ridge minus ground), `roof:height` (ridge minus eaves, dropped when
taller than half the building, which indicates a merged block), and `building:levels` estimated
from the facade height at the building's own level height.

The whole pending change set is local only and persists in IndexedDB, so a reload keeps it: tag
overrides keyed per OSM element, footprint overrides and drawn parts under their own store. Both
halves must persist together — a tag override that outlives the part it describes is a pending
change pointing at nothing, and reused part ids would let it attach itself to the next drawn part.
Restoring drawn parts therefore also continues the part-id counter past the highest restored id, and
any tag override for a drawn part that did not come back is dropped on load.

Tag edits are stored per OSM element in IndexedDB, applied over the source tags and
re-normalized so the 3D view and height rules see them immediately, revertable per tag and per
building. The selected building, its parts, and every neighboring context building render from
these effective properties. The live map source does too, so applying or reverting an edit
immediately updates the building's height-data color. A global **X changes** button reports tag
and geometry overrides from the map's top-left corner and opens a left sidebar grouped by entity.
Each group has one linked building ID header followed by rows laid out like the inspector's tag
table: the key on the left, then the original value, an arrow, and the pending value highlighted the
way an edited value is highlighted there. Selecting the header closes the sidebar, centers the map on
its entity through the normal ID lookup flow, and selects that building. Each header also carries a
discard action for that entity alone, behind the same confirmation dialog: it drops every tag
override on the entity plus its footprint override, and for a part drawn in this session — which
exists only as a pending change — it deletes the part itself, tag overrides included.

Every row can also be changed or dropped on its own, without leaving the panel:

- **Edit** opens the same value dialog the inspector uses — one shared component, so the two cannot
  drift apart. Here it accepts any text, because any tag can be pending, while the inspector's
  dimension rows keep their numeric rules. An override keeps its first-seen original, so reverting
  still restores what OSM has rather than the value it was last edited to.
- **Remove** means whatever dropping that property means for where it came from: a tag override goes
  back to the OSM value, a drawn part's own tag is unset, and a footprint override is discarded.
- Two rows are deliberately not removable on their own, and say why: the `geometry` row of a drawn
  part, which _is_ the part (use the entity action, which confirms), and `building:part` on a drawn
  part, without which the way would not be a part at all.
- Geometry rows cannot be edited — their value is a description of a footprint change, not a tag
  anybody could type. The sidebar's **Revert all** action opens the
  same dialog for every entity at once; confirming clears every pending tag edit and every geometry
  override from IndexedDB. Either scope immediately restores the raw OSM properties and geometry in
  the map and 3D view, and reselects the affected entity when it still exists. Nothing is uploaded
  yet.

For both buildings and parts, `height`, `building:levels`, `min_height`, `building:min_level`,
`roof:levels`, and `roof:height` always have inspector rows, including a **not set** row when absent.
Building outlines and parts additionally always expose `roof:shape` as a select: **none** removes the tag,
**pyramid** writes the standard `pyramidal` value, **hipped** writes `hipped`, **dome** writes `dome`,
and **onion** writes `onion`. A non-standard existing value remains available as its current value so opening the select never rewrites it. Hovering
their value reveals an edit icon. It opens a numeric modal using the user-facing labels `height`,
`levels`, `min_height`, `min_levels`, `roof_levels`, and `roof_height`; Escape dismisses it and Enter saves a valid
changed value. Heights must be positive metres, levels positive counts, and total height/levels must
exceed their corresponding minimum. `building:min_level`, `min_height` and `roof:levels` may be zero
— a part can start at ground level and a flat roof has no roof levels — while the others must be
above it. Saving uses the standard singular OSM key `building:min_level` and immediately refreshes
the effective map and 3D geometry. `roof:levels` is metadata only: the 3D height comes from `height`
or `building:levels`, so editing it changes no geometry.

The `height` and `roof:height` rows also have a horizontal-arrow handle immediately before their
property names. Dragging the handle left or right changes the effective value live in 0.5 m steps; the left and right arrow
keys provide the same control when the handle is focused. It accepts unit-bearing source values by
converting them to metres. A source value outside the 0.5 m grid is first rounded to the nearest step
before the drag delta is applied. The control never steps to zero, below zero, or to/below
`min_height`; roof height never steps to zero or below.

When a building or part has a supported shape and a positive `roof:height`, its total `height` still
marks the apex. The facade is a separate extrusion ending at `height - roof:height`. A pyramidal roof
connects that top outline directly to one center point; a dome uses eight progressively lifted and
shrunk rings whose sine/cosine profile approaches the center apex like a sphere. An onion samples
twelve height rings along a related profile whose slope changes from 90 degrees at the facade to 45
degrees at the apex, instead of the dome's 90-to-0-degree change. Its radius correction spans the
upper half of the roof so the pointed silhouette stays visibly distinct from a dome at normal viewing
distance. Roof planning and surface geometry live in `src/lib/roofs.ts`, separate from scene assembly
so additional roof types can be added without changing the facade height rules.

## Laser point cloud

Mapterhorn is the 3D preview's ground source of truth (see
[ADR 0006](../../adr/0006-mapterhorn-defines-3d-ground.md)). Its z13 Terrarium tiles form the
terrain mesh. Scene zero is the lowest raster sample inside the selected building boundary,
including sampled boundary vertices for footprints smaller than a raster cell. Every neighboring
building sits at its own footprint's lowest Mapterhorn elevation relative to that reference; all
parts of one building share that base. OSM heights remain distances above the building base.

The 3D view draws airborne laser points as coloured dots around the selected building (see
ADR 0004), from two sources that share one tile format and are tried in order per z16 tile:

- **Stockholm 2023**, 25 points/m², imported to `data/lidar` and served by `/api/lidar`. Dense, and
  coloured from the orthophoto, so the cloud reads as a photographic surface. Buildings are a
  classified LAS class here.
- **Laserdata Skog**, 1.4 points/m², read on demand from Lantmäteriet by `/api/skog` (see
  [ADR 0005](../../adr/0005-national-laser-data-read-on-demand.md)). Covers the country. No colour
  and no building class, so dots are coloured by class — ground, water, bridge — with unclassified
  points split by return count, one return reading as hard surface and several as vegetation. That
  split is a hint, not a classification, and it is what makes a roof legible among trees.

The map can show the decoded cloud in a LiDAR evidence mode. It uses a 2D GPU point layer so dense
municipal tiles do not become hundreds of thousands of GeoJSON features. Each point carries only
its Web Mercator X/Y and source colour into the map shader; Z is deliberately absent, producing no
camera perspective, terrain alignment, roof-distance recolouring, or vertical displacement. The
ordinary map pitch remains locked to zero, and footprint boundaries stay above the dots.

Both sources are read where available. Occupied one-meter municipal coverage cells and their
immediate neighbors suppress national returns, so dense data wins over its actual coverage while
Skog fills a municipal scan that ends partway through a tile. Points are kept within 100 m of the footprint. A stored classification byte
carries the LAS class in its low bits and a single-return flag in `0x80`.

Within the selected element's footprint, returns above its rendered roof are recoloured by their
vertical distance from that roof: green below 1 m, orange from 1-5 m, yellow from 5-10 m, and red
above 10 m, with soft gradients between bands. A selected building follows the visible roof of any
part beneath the point; a selected part uses that part's own roof. Returns at or below the roof,
inside footprint holes, or outside the selected footprint retain their source colour.

LiDAR stays an overlay and never defines ground. For each survey, class-2 returns are compared with
Mapterhorn at their coordinates; the median residual vertically translates that survey onto the
terrain datum. The same correction applies to its roofs, preserving measured heights. If one
survey has no ground returns it shares the other correction, and if neither does, published levels
are shown without correction. Vendor-flagged noise (LAS class 7) is dropped at import.

The inspector's LOD1 strip carries the cloud's status after the LOD1 sentence: `laser: reading…`
while tiles are being read, `laser: 345,031 pts · Laserdata Skog` once they are, and
`laser: no points` where neither survey covers the building. It is keyed to the building it
describes, so a selection whose lookup is still in flight shows nothing rather than the previous
building's count. Without it a building still being read looks exactly like one with no data,
which matters most for the national source, where a first read assembles tiles on demand.

The cloud is evidence only. It suggests no tags and is not matched to parts; a `height` that
disagrees with the survey shows up as a roof floating above or sunk into the dots, and the mapper
draws the conclusion. Points arrive after the buildings, are added to the standing scene without
moving the camera, and are absent wherever neither source has points — where both tile routes
answer an empty tile rather than an error, so a missing credential, a missing product permission
and an upstream outage all look the same to the view: no dots.

## Selection

The selected element is carried in the URL hash: `/#way/42764754`. Opening that address centres the
map on the element and selects it through the normal id lookup, and selecting one writes its id
back. Writes use `replaceState`, so clicking around a neighborhood does not fill the back button
and no `hashchange` is raised by the app's own writes; editing the hash by hand selects that
element. Deselecting removes the hash. Only real OSM ids appear there — a part drawn by
Slice carries a negative placeholder id (`way/-1`) that nothing upstream can resolve, so it leaves
the hash untouched. The same grammar the ID
search accepted is understood: `way/123`, `w123`, `r123` and pasted openstreetmap.org URLs.

Selection and the inspector are **live OSM only**, at z >= 16. Both building outlines and
`building:part` elements can be selected, including through ID search. The Overture overview is a
snapshot that cannot be edited and whose fields are not OSM tags (`is_underground`,
`has_parts`, `@geometry_source`), so clicking it below that zoom shows a hint instead of
opening the panel. Every vertex on the selected element's outer and inner footprint rings is shown
as a small black dot; the repeated closing coordinate in GeoJSON produces only one dot. Inside its
nine-pixel interaction target, a node becomes a larger purple dot with a white halo and the pointer
cursor, and that highlight follows the node while it is dragged. Dragging previews the new footprint
continuously and stores one pending geometry change on release, updating the map and 3D view.
At drag start, every loaded building or part with a vertex at that exact coordinate joins the drag;
all copies preview and commit the same new coordinate, with a pending geometry change on every
affected existing entity. This preserves shared corners and walls instead of pulling only the selected
footprint away from its neighbors. The drag is recorded as a move of the OSM node, not as a new
corner, so on upload the node itself moves and everything attached to it follows — including the ways
this editor never loaded, which the on-screen expansion cannot reach (see
[osm-submission](osm-submission.md)). Releasing without moving changes nothing. Double-clicking an empty
position on a selected outer or inner ring inserts a node at the nearest point on that segment;
double-clicking near an existing node does not add a duplicate. A node reshape remains compatible
with parts in 3D: once parts cover the edited outline, they replace it normally. Only a **Cut hole**
override makes the outline authoritative, because older parts could otherwise fill that opening.

## 3D context

Buildings whose footprint falls within `NEIGHBOR_PADDING_M` (80 m) of the selected
building's bounding box are extruded in flat gray, nearest first and capped at
`MAX_NEIGHBORS` (60) so the scene stays light. They follow the same height rules
and part handling as the selection. The camera frames the _selected_ building
alone (`buildScene` returns a separate `focus` box), otherwise context would push
the subject into the distance. Ground is sized from the half-diagonal of every
solid drawn, so no building overhangs it.

Live tag edits replace only the local scene geometry. The Three.js renderer,
WebGL context, camera, orbit controls, terrain and decoded LiDAR stay mounted
while the selected entity is unchanged, and multiple edits before one paint
collapse to the newest geometry. `roof:height` changes the facade/roof join but
not the apex, so it also reuses the existing LiDAR point buffer. A genuine
viewer teardown explicitly releases its WebGL context so it cannot evict the
MapLibre or persistent Google 3D context.

Neighbors are read from the same tile features as the selection, so context stops
at the edge of the loaded tiles — acceptable, since the click always happens
inside the loaded area.

## Map color coding

Buildings and parts are colored by the _provenance of their height_, which is what
makes the estimate trustworthy or not:

- purple — pending local overrides exist for this element; this takes priority over provenance;
- green — `height` present (measured);
- blue — no `height`, but `num_floors` present (estimated via the per-floor rule);
- red — neither, so the height is a bare single-floor guess.

Each color has a brighter variant used over satellite imagery, and the legend
follows the active palette. The selection highlight is a white casing under a
near-black line so it stays distinct from all building colors on both basemaps.

## Data sources

Two sources, deliberately split (see [ADR 0001](../../adr/0001-live-osm-data-for-editing.md)):

- **Overture PMTiles** — wide-area overview at z10-15. Global, free, no rate limits. Never an edit target: it lags OSM by weeks and its geometry carries no OSM node identity, so edits cannot be round-tripped. Release pinned in `src/lib/overture.ts`. Tile features are clipped at tile borders, so fragments of one id are merged with `@turf/union` on selection.
- **Live OSM API** — everything editable, at z >= 16, always through the cached proxy required by [ADR 0002](../../adr/0002-cached-rate-limited-osm-proxy.md).

Two local reference datasets sit beside them, imported to the same z16 grid and served from disk:
Stockholm LOD1 blocks ([ADR 0003](../../adr/0003-lod1-as-advice-not-import.md)) and the 2023 laser
point cloud ([ADR 0004](../../adr/0004-laser-point-cloud-as-raw-evidence.md)). Neither is ever an
edit target.

Mapterhorn z13 terrain is read through the app's fixed-grid `/api/terrain` route and decoded in the
3D preview. It defines ground elevation only and is never an edit target or a source of OSM height
tags.

Height and color logic follows OSM tags once FT-03 of [EP-001](../../plans/epics/EP-001-osm-editing/index.md) lands; until then it reads Overture property names.
