# Building Explorer — domain spec

## WHAT

A single-page map app: OpenStreetMap basemap (MapLibre; pan, zoom and bearing, pitch locked at 0),
Overture buildings + parts rendered in contrast colors from zoom > 10, clickable.
Zoom and bearing controls sit in the visible map's bottom-right corner, shifting left when the
building panel is open so they remain accessible.
Selecting a building or building part opens a right-side panel with an interactive 3D extrusion
(initial bearing copied from the map on every new selection, then zoom + rotate independent of
the map, flat ground), with adjacent buildings
drawn in gray as context, and below it an inspector listing every raw tag of the
selected feature. A "Photos" toggle swaps the basemap for satellite imagery and reduces
buildings/parts to boundaries only. While Photos is on, a four-way-arrow button toggles imagery
alignment mode. In that mode the editing map's drag-pan interaction is locked and primary-pointer
dragging changes only the imagery's geographic offset. The chosen offset remains aligned through
map pan, zoom and bearing changes and survives toggling Photos for the current session. MapLibre
raster layers have no per-layer translation, so imagery renders in a separate non-interactive map
beneath the editing map; its camera follows the editing camera plus the stored Mercator offset.

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
Creating the links makes no third-party request; coordinates and the user's IP leave the app only
when a link is opened.

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
the same square-node interaction as **Cut hole**. While the crosshair is within 12 screen pixels of
an outer building boundary, a purple X previews the closest edge coordinate that will be used. If
it is within 9 pixels of an existing outer-ring node, a hollow square takes priority and clicking
reuses that node's exact coordinate. A first boundary click starts an open slice: further clicks
add polyline bends and clicking another point on that same building's outer boundary completes it.
A first click inside the footprint starts a closed-loop slice; clicking its first node or pressing
Enter closes it after at least three nodes. Every segment must remain in the solid building
footprint and the path must be simple. Escape, pressing **Slice** again, opening pending changes,
or leaving live-OSM zoom cancels the draft.

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
Each group has one linked building ID header followed by compact, single-line rows containing the
property, original value, and pending value. Selecting the header closes the sidebar, centers the
map on its entity through the normal ID lookup flow, and selects that building. The sidebar's
**Revert all** action opens a confirmation dialog; confirming clears every pending tag edit and every
geometry override from IndexedDB, and immediately restores the raw OSM properties and geometry in
both the map and 3D view. Nothing is uploaded yet.

For both buildings and parts, `height`, `building:levels`, `min_height`, and
`building:min_level` always have inspector rows, including a **not set** row when absent. Hovering
their value reveals an edit icon. It opens a numeric modal using the user-facing labels `height`,
`levels`, `min_height`, and `min_levels`; Escape dismisses it and Enter saves a valid changed
value. Heights must be positive metres, levels positive counts, minimums non-negative, and total
height/levels must exceed their corresponding minimum. Saving uses the standard singular OSM key
`building:min_level` and immediately refreshes the effective map and 3D geometry.

## Laser point cloud

The 3D view draws Stockholm's 2023 airborne laser scan (see ADR 0004) as coloured dots around the
selected building, when tiles for that area have been imported. Points come from `data/lidar` z16
binary tiles, are kept within 100 m of the building footprint, and carry the orthophoto colour of
each return, so the cloud reads as a photographic surface rather than a height ramp.

Heights are RH2000 levels, while extruded buildings stand on a zero ground plane. Every dot is
therefore lowered by one ground level for the whole scene: the median of the nearby ground-class
returns, or the lowest point of any class when roofs hide the ground completely. Vendor-flagged
noise (LAS class 7) is dropped at import.

The cloud is evidence only. It suggests no tags and is not matched to parts; a `height` that
disagrees with the survey shows up as a roof floating above or sunk into the dots, and the mapper
draws the conclusion. Points arrive after the buildings, are added to the standing scene without
moving the camera, and are absent outside the imported area, where the tile route answers an
empty tile.

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
opening the panel.

## 3D context

Buildings whose footprint falls within `NEIGHBOR_PADDING_M` (80 m) of the selected
building's bounding box are extruded in flat gray, nearest first and capped at
`MAX_NEIGHBORS` (60) so the scene stays light. They follow the same height rules
and part handling as the selection. The camera frames the _selected_ building
alone (`buildScene` returns a separate `focus` box), otherwise context would push
the subject into the distance. Ground is sized from the half-diagonal of every
solid drawn, so no building overhangs it.

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

Height and color logic follows OSM tags once FT-03 of [EP-001](../../plans/epics/EP-001-osm-editing/index.md) lands; until then it reads Overture property names.
