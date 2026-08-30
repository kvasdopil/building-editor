# Building Explorer — domain spec

## WHAT

A single-page map app: OpenStreetMap vector basemap (OpenFreeMap Liberty rendered by MapLibre;
pan, zoom and bearing, pitch locked at 0). Below map zoom z15.5 only that normal basemap is shown;
at z15.5 and above, live OSM buildings and parts appear in contrast colors and become selectable.
The basemap is flat and vector-only: provider raster relief and fill-extrusion building layers are
removed before the editor overlays are installed.
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
"a vertex lies inside" attributes a neighbour's parts to the wrong building.

Parts replace the outline in 3D only when they cover at least **85%** of the footprint.
Partial part coverage is common in OSM, and dropping the outline then makes most of the
building disappear.

At live-OSM zoom, parts are independent selection targets. When a part and its parent both cover
the click point, the part wins as the more specific entity. The map highlights only that part and
the inspector shows and edits the part's own OSM id and tags. The selection still carries its
parent building and sibling parts: the parent supplies the shared level height, the complete
building stays visible as 3D context, and the camera frames the selected part. LOD1 advice is not
offered for parts because the source describes whole building blocks. The inspector toolbar always
shows the selected entity id. For a part, that id comes before a `part of way/…` parent link, which
switches selection to its loaded building outline without another network request.

Selection assembly is cached per immutable displayed-feature snapshot. The snapshot is parsed once,
parent and sibling associations are lazy, and building parts are associated only after bounding-box
and distance filtering has reduced 3D context to the nearest eligible buildings. Switching between
a parent and its already assembled parts therefore reuses the parent, siblings, and neighbors rather
than repeating the building-by-part polygon-overlap pass.

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

The embedded Google photorealistic section authenticates exclusively through Cesium ion asset
`2275207` when a Cesium browser token is configured. Direct Google Map Tiles keys are not supported
because affected EEA Google Cloud projects cannot request the 3D tiles. The section remembers its
expanded state in local storage. Once the mapper opens it, it stays expanded while switching
buildings and after reloads until the mapper explicitly hides it. An in-memory copy supplies the
same state immediately when selection changes temporarily unmount and remount the section, avoiding
a closed-panel flash.

Pending-change links for existing OSM ways and relations resolve the entity through the cached
element route, fit its geometry without landing below the z15.5 live-data threshold, and select it
once its live tile data arrives. There is no general-purpose ID search control on the map.

## Cutting footprint holes

At live-OSM zoom, the top **Cut hole** tool starts a geometry draft. When a building or one of its
parts is selected, its parent building is the target and the first vertex may be placed anywhere,
including outside the footprint. Without a selection, the first click must fall inside a live
building or snap to its boundary and fixes that target. Every click then adds the next vertex, shown
as a small square, and the evolving loop is drawn over the map. Clicking the first square or pressing
Enter closes the loop once it has at least three vertices. The loop must be simple, non-trivial, and
overlap some solid area of the target building.

Every mask vertex uses the same boundary snapping as the other geometry tools. Any visible building
or part node takes priority within nine screen pixels; otherwise an edge attracts within twelve
pixels. The preview distinguishes node and edge snaps, and a click stores the exact existing node
coordinate or projected edge coordinate. Before the target is fixed, an unselected building may
also be acquired by snapping the first vertex to its boundary. Once selected, the subtraction target
does not change when a mask vertex snaps to a different visible building or part.

Escape, pressing **Cut hole** again, opening the changes sidebar, or leaving live-OSM zoom cancels
the whole draft and commits nothing. The completed loop is a boolean subtraction mask: when wholly
inside the building it adds an interior ring, while a boundary-crossing mask clips the overlapped
portion from the outer footprint and may leave a notch or multiple polygons. The same mask is
boolean-subtracted from every associated part whose solid area it intersects, including locally
drawn parts. A mask wholly inside a part creates an inner ring; one crossing a part boundary leaves
the corresponding notch. The operation is rejected atomically if the mask misses the building, a
boolean subtraction fails, or it would consume the whole building or an entire part. Successful
completion refreshes the live map, selection outline, 3D building and context, marks the building
and affected parts purple, and adds their `geometry` entries to the changes sidebar. Geometry
overrides persist in IndexedDB until reverted or uploaded. The 3D extrusion removes both caps inside
the loop and renders the resulting inner vertical faces with a distinct, two-sided wall material so
the opening reads from every camera direction. Normal part-coverage rendering remains active because
the actual part geometries now carry the opening instead of relying on an outline-only rendering
exception.

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

If a building is already selected when the first Slice node is placed, its building group is tested
first for both boundary snaps and interior-loop containment. Only a click that is not on or inside
that selected building falls back to the global rendered-feature search. This makes a shared wall
deterministic: relation/1794585 and way/111680989 share several consecutive segments, but selecting
the relation before Slice keeps it as the target instead of silently locking the draft to the way.

The two modes differ in what they change:

- An **open polyline** partitions what it crosses, and must divide something — the outline, an
  existing part, or the area no part covers yet — otherwise it is rejected. A cut that ends on a part
  edge leaves the outline itself whole.
- A **closed loop** creates a center tower part from the enclosed loop without changing the
  `building=*` outline or any existing parts. If the building has no parts yet, it also creates one
  base part copying the complete building footprint; that base and tower overlap in 2D deliberately,
  avoiding a ring-shaped complement while covering the whole outline. If parts already exist, they
  remain the base and only the tower is added. The tower begins with `building:part=yes` and explicit
  copies of the outline's `height` and `min_height` when available. A generated base part copies only
  `height`; other omitted physical values use the outline as their effective editor defaults. The
  first time an outline without parts is partitioned, every generated part additionally receives
  explicit copies of `roof:shape`, `roof:direction`, `roof:orientation`, and `roof:height` when
  present, and those four tags are removed from the parent outline. Once parts exist, later slices retain the normal sparse
  tag rule instead of repeatedly copying parent roof values.
  The mapper must add only the differing `height` plus `min_height` or
  `building:levels` plus `building:min_level` when the center is stacked above the base, so their 3D
  volumes do not overlap. Escape, pressing **Slice** again, opening pending changes, or leaving
  live-OSM zoom cancels the draft.

Boundary snapping stays out of full selection assembly. Before the first node it reads candidate
rings from a lightweight index over the displayed collection; after the target is known it caches
that building's outline, holes, and part rings in screen coordinates, invalidating them only when the
map camera moves. Pointer events are coalesced to one snap calculation and draft-source update per
animation frame. Completing a slice may run polygon boolean operations, but cursor movement must
never associate every loaded part, assemble 3D neighbors, or run Turf intersections.

Every corner a cut creates joins each ring of the building group it lands on, not only the pieces the
cut produced. Ending a slice on the wall between two parts puts the corner in the part on the far side
as well, and an endpoint on the outline puts it in the outline. A corner that was already there is
left alone, and the sub-millimetre drift boolean geometry leaves on untouched corners does not count
as new. Without this the new boundary only crosses its neighbours instead of sharing them, and the
wall comes apart the first time it is dragged. Each element that gains a corner picks up its own
pending geometry change, listed as **corner shared**.

The operation follows [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings):

- the single `building=*` outline remains unchanged and continues to hold whole-building metadata;
- the partition regions cover the complete outline as `building:part=*` areas;
- a newly covered region has `building:part=yes` plus an explicit copy of the outline's `height`
  when available; matching level, material, colour, and roof values are omitted and use the outline
  as effective defaults for rendering and validation;
- a center tower created by a closed loop additionally copies the outline's `min_height` when
  available;
- an explicit part height/level, minimum height/level, or roof value overrides the corresponding
  outline default;
- names, addresses, operator and other whole-building tags are not copied to generated parts;
- every existing part crossed by the path is partitioned by the same geometry, the largest
  fragment retains the original OSM entity id, and new fragments keep explicit `height` plus only
  values of that part which differ from the outline;
- uncovered footprint regions become new session-local part entities. These and every modified
  original part appear in Pending changes and render purple on the map.

The OSM key is singular `building:min_level`; there is no `min_levels` key in this model.
`building:levels` is the total level count including skipped levels below an elevated part and
must be greater than `building:min_level`. Because generated parts are contained within the
outline, Slice does not create a `type=building` relation; that relation is reserved for complex
grouping or parts outside the outline. Slice geometry is current-session pending state until the
changeset-upload feature exists.

## Adding an exterior building part

At live-OSM zoom, **Add part** is enabled only while a `building=*` outline—not one of its parts—is
selected. Activating it fixes that outline as the target and makes the geometry tools mutually
exclusive. The first node must snap to an outer-ring edge or existing node, and the last node must
snap to a different point on the same outline. Edge snaps use the same 12-pixel tolerance as Slice
and exact nodes take priority within nine pixels. A click honors the visible snap preview when it is
still under the pointer; it must not discard that preview and independently classify the click as
inside. When the matched LOD1 outline is visible, its vertices are additional nine-pixel snap targets
for the helper gizmo and intermediate exterior nodes. OSM boundary snaps retain priority, and LOD1
vertices cannot satisfy the required first or last attachment to the selected OSM outline. Hiding
LOD1 removes those helper targets. Intermediate clicks are not rejected by a separate
point-in-polygon approximation. The completed boolean operation below is the single authority for
whether the path stayed outside, which avoids false rejections on edited outlines and at
coordinate-grid rounding boundaries.
Escape, changing selection, leaving live zoom, opening pending changes, or activating another
geometry tool cancels the draft.

The resulting loop must be simple, contribute at least 0.1 m² outside the outline, have no material
interior overlap, and share a real wall segment rather than touching the building at only one point.
The drawn exterior path is not closed with a straight chord. Both directions along the existing
outer ring between the final and initial snaps are evaluated, including every intervening building
corner; the valid non-overlapping candidate with the smaller part area is used. This permits an
addition to wrap around one or several corners while rejecting the opposite boundary path, which
would enclose or cross the original building. The two snaps must resolve to the same outer ring.
Completion performs one atomic local operation:

- union the drawn footprint into the existing `building=*` outline and record an `add-part` geometry
  modification on that element;
- create a pending `building:part=yes` using the drawn exterior footprint, with an explicit copy of
  the outline's `height` when available; omitted physical values continue to use the outline as
  effective editor defaults;
- insert each snapped attachment node into every existing or pending part boundary whose segment
  shares that outline edge, preserving any earlier geometry edit on that part;
- when the selected building had no parts, also create one base `building:part=yes` from the complete
  pre-expansion outline with the same sparse-tag rule and attachment nodes.

When Add part creates the first parts for an outline, both the base and exterior part explicitly copy
the outline's `roof:shape`, `roof:direction`, `roof:orientation`, and `roof:height`, and the outline loses those tags in
the same pending operation. This is the same roof-ownership transfer used by Slice.

If parts already existed, their areas remain unchanged—only a matching boundary segment gains the
shared node—and no extra base is invented. Newly created parts use the building outline as their
parent, participate in selection and 3D rendering immediately, and share snapped wall nodes with the
modified outline in the upload plan. A disconnected point-touch, an overlapping addition, or a loop
that crosses back through the building is rejected without changing any pending state.

## LOD1 advice and local edits

Stockholm LOD1 (see ADR 0003) is matched to the selected building by greatest area overlap,
requiring at least 40% of the OSM footprint to be covered. Coverage is computed **both ways**:
when the OSM building accounts for less than half the LOD1 block, the block is generalized over
several buildings and its heights are not about this building — advice is then marked
unreliable rather than hidden, because the mapper decides.

The matched generalized LOD1 footprint is drawn as a light-gray map outline beneath the selected
OSM outline. It appears by default for an outline selection and shares the advice panel's exact
best-overlap match. A top-map **LOD1** toggle hides or restores it; the control is unavailable when
there is no match or a building part is selected. While the outline is visible, dragging an OSM
footprint node within nine screen pixels of a LOD1 vertex snaps the destination to that vertex,
rounded only to OSM's seven-decimal coordinate grid. Hiding LOD1 disables that snap target. If the
dragged OSM node is shared, every loaded footprint which owns it still moves to the snapped position.

Suggested tags: `height` (ridge minus ground), `roof:height` (ridge minus eaves, dropped when
taller than half the building, which indicates a merged block), and `building:levels` estimated
from the facade height at the building's own level height.

## Laser roof advice

The selected building's point cloud is rasterized into the half-metre surface grid and read for
`height`, `roof:height` and `roof:shape` — for the outline and for **each `building:part`
separately**, which LOD1 cannot do ([ADR 0007](../../adr/0007-laser-roof-advice.md)). The raster is
built from the whole building whichever element is selected, so a part is measured in the same frame
as its neighbours.

`height` is the 99th percentile of raw per-cell maxima above this building's own ground: the 10th
percentile of ground-class returns within 2 m of the outline, widened outwards only when that ring
holds too few. A raw return more than 1.5 m above the surface fitted around it is discarded first —
a chimney, an antenna, an overhanging branch. `roof:height` is that ridge minus eaves read from the
roof's own cells, where the roof starts at half the building's height so a courtyard or a lower wing
cannot pull the join down. `roof:shape` is read from what the roof does where it meets each stretch
of wall, weighted by wall length, and is always offered unconfident: it is a judgement, and the panel
draws it muted with "confirm against the roof".

Each element's advice carries the **fit error**: the roof those tags describe, built as the 3D view
would extrude it and measured against the cells as the mean distance over the closest-fitting 90%.
The `roof:shape` row shows it beside the same measurement for the element's current tags, so the two
are comparable, and pressing the recommendation applies the whole combination at once — a height
without the roof height it was measured with builds a different roof. The advised figure is measured
from the rounded values that get written, so it equals what the tags report once applied.

The error may choose `roof:height`, searched in the written half-metre steps, and only where the
modelled roof already lands within 0.5 m of the points. It never chooses `height`, which names the
ridge the maxima read directly, and it never chooses the shape. ADR 0007 records the measurements
behind both limits.

LOD1 keeps precedence for any tag it has a confident opinion on; the laser fills in the rest —
`roof:shape` always, every `building:part`, and any building whose LOD1 block spans several
structures. Each suggestion names its source in the tooltip.

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
Each group has one ordinary hash-link entity header (`#way/…`) followed by rows laid out like the
inspector's tag table: the key on the left, then the original value, an arrow, and the pending value
highlighted the way an edited value is highlighted there. The group matching the current map
selection is visibly highlighted. Following the header closes the sidebar, centers the map on its
entity through the normal ID lookup flow, and selects it. Each header also carries a
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
**pyramid** writes the standard `pyramidal` value, **hipped** writes `hipped`, **gabled** writes
`gabled`, **gambrel** writes `gambrel`, **round** writes `round`, **skillion** writes `skillion`,
**dome** writes `dome`, and **onion** writes `onion`. A
non-standard existing value remains available as its current value so opening the select never rewrites it. Hovering
their value reveals an edit icon. It opens a numeric modal using the user-facing labels `height`,
`levels`, `min_height`, `min_levels`, `roof_levels`, and `roof_height`; Escape dismisses it and Enter saves a valid
changed value. Heights must be positive metres, levels positive counts, and total height/levels must
exceed their corresponding minimum. `building:min_level`, `min_height` and `roof:levels` may be zero
— a part can start at ground level and a flat roof has no roof levels — while the others must be
above it. Saving uses the standard singular OSM key `building:min_level` and immediately refreshes
the effective map and 3D geometry. `roof:levels` is metadata only: the 3D height comes from `height`
or `building:levels`, so editing it changes no geometry.

When the effective `roof:shape` is `gabled`, `gambrel`, or `round`, the inspector additionally exposes
`roof:orientation` as a select. **default (along)** removes the explicit tag and uses the OSM default,
**along** writes `along`, and **across** writes `across`. A non-standard existing value remains
available unchanged. `along` places the ridge on the long axis of the footprint's oriented minimum
rectangle; `across` places it on the perpendicular short axis. `roof:direction` remains a distinct
OSM tag describing downslope compass direction and is not interpreted as ridge orientation.

When the effective `roof:shape` is `skillion`, the inspector additionally exposes `roof:direction`
as a compass drag handle immediately to the left of a clickable value. The pointer displacement from
the compass defines a continuous lookup bearing (up is north, right is east). After a 6 px dead zone,
the editor casts that bearing as a ray from the selected footprint's area-weighted centroid, finds the
nearest positive intersection with an outer edge, chooses the edge normal facing into the same
half-plane as the ray, and writes the normal as numeric degrees rounded to the nearest whole number.
If a ray hits a shared vertex, the edge whose normal aligns most closely with the lookup bearing wins.
Clicking the displayed value opens the numeric editor, which accepts an exact manual bearing from 0°
through 360°, normalizes 360° to 0°, and removes the explicit tag when the input is cleared. An unset
value is displayed as **automatic**. Existing named compass tags resolve through the same edge-normal
rule for rendering and are canonicalized to degrees by the next drag or manual edit. The stored value
is the downhill direction from the high edge toward the low eave, matching OSM's rainwater-flow
convention.

Setting or removing `roof:shape` on a building part also removes `roof:shape` from its parent outline
as a pending edit. A part with an explicitly edited roof type owns that roof definition; the outline
must not retain a competing roof type.

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
distance.

A hipped roof uses the footprint's interior straight skeleton. Every outer and hole boundary edge
moves inward at the same rate; edge-collapse and split events form the hips, ridges and valleys, so
concave L-, H- and T-shaped footprints remain one continuous equal-pitch roof rather than a collection
of rectangular roofs. The skeleton's propagation time becomes elevation from the eaves to the tagged
`roof:height`, and each skeleton face is triangulated independently to retain hard facet creases. The
CGAL/Wasm engine initializes once when the 3D viewer mounts. Until it is ready, or whenever a weakly
simple skeleton cannot be constructed, the same footprint uses the existing pyramidal roof as a safe
fallback instead of disappearing.

Gabled, gambrel and round roofs derive a deterministic main axis from the footprint's minimum-area oriented
bounding rectangle. With no valid `roof:orientation`, or with `along`, the rectangle's longest edge
is the ridge direction; `across` rotates the ridge onto its shorter edge. Other values are preserved
as source tags but render with the OSM `along` default. A gabled roof is two planar
slopes from that ridge to the two transverse rectangle edges. A gambrel roof divides each gabled half
into two equal-length sloped panels, creating four planar bands. The two panels rotate 15° in opposite
directions around the equivalent gable pitch while retaining the same eaves, ridge and `roof:height`;
a 45° gable therefore becomes a 60° lower panel and a 30° upper panel. Extremely shallow or steep
roofs use the largest smaller offset that keeps both panels rising toward the ridge. A round roof uses
the same ridge and edge positions but samples twelve transverse strips along a semicircular arch. Each
strip is intersected with the actual polygon before triangulation, so concave footprints,
multipolygons and holes cut the roof rather than receiving a bounding-box cap. Boundary segments are
split at the same profile samples and get vertical fill from the flat eaves extrusion to the slope or
arch, producing closed gable, gambrel and arched end walls.

A skillion roof is one clipped plane. Its high boundary reaches total `height` and its downhill
boundary meets the facade at `height - roof:height`. A valid numeric `roof:direction` from 0° through
360° fixes the downhill bearing exactly. A 16-point compass value from N through NNW resolves to the
normal of the first outer edge hit from the frame footprint's centroid in that compass direction.
Without a valid direction the footprint's minimum-area oriented rectangle supplies a deterministic default
perpendicular to its longest side; either of the two perpendicular directions is valid, and the
renderer keeps the one produced by the stable rectangle frame. Selecting a building or part whose
effective roof shape is skillion draws a fixed-size purple V with a white casing at that selected
footprint's area-weighted centroid. The sharp corner uses map-aligned rotation and points downhill,
including while the map bearing changes or a pending direction edit updates the 3D roof.

A part carrying its own non-empty `roof:shape`, `roof:height`, `roof:orientation`, or `roof:direction` resolves an
independent roof plan and minimum rectangle from that part, inheriting any omitted roof values from
the outline. A part without all four resolves the parent's roof plan, absolute eaves, apex,
direction/orientation, and parent-derived axis; it is extruded and cut under that shared surface. The parent roof
shell renders once across untagged parts when part coverage suppresses the parent outline solid,
rather than giving every part a separate ridge. Roof inheritance, planning, axis selection, clipping,
profiles and emitted surface/wall geometry live in `src/lib/roofs.ts`, separate from scene assembly so
additional roof types can be added without changing facade orchestration.

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

The same layer joins each point to the next one in storage order with a faint line, skipping any
pair further apart than 20 m or belonging to different surveys. A tile keeps its points in the
order the scanner produced them, so the links are not a nearest-neighbour graph: they draw the
recording order itself, and make the acquisition structure of each survey visible. The imported
Stockholm tiles retain it — links run in two families about 30 degrees apart in runs of roughly
25-30 points, mixed evenly over the whole tile, at a median step of 0.9 m. The national Skog tiles
do not: COPC stores its points in octree order, so the links there are short, near-random chains
with only a weak directional bias. The distinction matters when reading the cloud, because a
"stripe" in Skog data is an artefact of the file layout, not of the flight.

The basemap, the imagery and the point cloud are three positions of one **Map / Photos / LiDAR**
switch rather than independent toggles, because each replaces the one below it; `LiDAR` is
unavailable without a selection. Whatever the chosen underlay needs sits on a second toolbar row
rather than beside the switch, so the switch keeps its place as its options come and go: `Photos`
puts the four-way alignment button there, and `LiDAR` a **Color / Height / Normal / Diff** selector plus a
**Lines** checkbox, which draws the links between consecutively recorded points; it starts off, so
the mode opens on the bare dots.

The whole view is in the URL hash alongside the selection, as `&`-separated segments — for example
`#way/42764754&normals&lines=1&lod1=0`. The segment that parses as an OSM reference is the
selection; `photos`, `lidar`, `height`, `normals` and `diff` name the underlay together with its
colouring,
since those read as one choice; `lines=1` and `lod1=0` carry the two toggles away from their
defaults. Only non-defaults are written, so an ordinary link stays `#way/42764754`. A LiDAR mode is
honoured only when the hash also names an element, so a cloud is never shown for a building that
will never arrive.

The view is applied after mount rather than as initial state, because the server never sees the hash
and rendering it directly would not match what was sent — but it is _read_ during render, into a ref,
which two hazards make necessary. The effect that writes the hash runs in the same commit as the one
that applies the view, so reading in the effect would let the write see state still at its defaults
and replace the arriving view with them; and React's development double-mount would then re-read a
hash that had already been overwritten, losing the view for good. Writing is additionally held back
until the restored view has actually reached the state, so the first commit cannot publish the
defaults. `parseOsmRef` anchors an element id to the end of its string, so the selection hook is
given the reference segment rather than the whole hash; handed the whole hash it silently returns
null for any URL carrying a view, which cost both the deep link and, through the deselect path, the
reference in the URL.

`Color` is the survey's own orthophoto sample. `Height` replaces it with a rainbow ramp — violet at
the lowest point, through blue, green and yellow, to red at the highest. The ramp is fitted to the
heights of the points inside the current viewport, refitted when a movement settles rather than per
frame, so zooming into a courtyard spreads the full sweep over its few metres instead of over the
tallest roof in the padded cloud. Points and links share the ramp, so a link crossing a roof edge
shows the step as a colour break.

`Normal` runs the same ramp over the angle each link makes with the horizontal, from violet lying
flat to red standing vertical, over a fixed 0 to 90 degree range. It is the raw inclination of the
step from one stored point to the next — nothing is fitted, smoothed or thresholded — so a wall or a
tree trunk shows as a red thread wherever the beam crossed it. The angle is carried per point rather
than per link, because points and links share one vertex buffer: a point takes the angle of the link
arriving at it, which makes a drawn link exact at its far end and a blend toward the previous link's
angle at its near end. On the Stockholm tile the medians run water 0.7, bridge deck 2.0, ground 2.9,
building 10.2 and mixed roof-and-vegetation 11.7 degrees, with 11 per cent of all links steeper than
75 degrees.

Because it is per link, this reports the tilt along the beam's own bearing and not the tilt of the
surface: a link running level across a pitched roof reports no slope, so one roof plane can read two
ways depending on which way the scanner happened to be sweeping. Recovering the surface itself would
need a second, differently-oriented link, which the sweep structure does not readily give.

`Diff` runs the ramp over how far each point sits above what the app models for it. It is the same
subtraction the 3D view colours discrepancies with, lifted out of `extrude.ts` so the flat map can
show it too, and it therefore inherits the same per-survey terrain alignment: the point's height
brought onto the scene datum, minus the modelled surface there.

That surface spans the whole view rather than one footprint. A point is measured against whichever
building covers it — the selected one or any neighbour the 3D view already draws as context, each on
its own terrain base and using its parts where it has them — and against Mapterhorn terrain wherever
no footprint does. Positive therefore means the survey found something above what is modelled: an
unrecorded storey, a roof taller than its tags, a building nobody has mapped, or a tree, which is
modelled nowhere and so reads as a large disagreement. Negative means the model stands above the
scan. Footprints can overlap where an outline and a neighbouring part share a wall, so the higher
roof wins, matching what the 3D view would draw.

Testing every point against every footprint would be sixty polygons against half a million points,
redone whenever the terrain or the selected part settles, so footprints are first bucketed into 25 m
cells by bounding box and each point only tests the one or two buildings its own cell holds. That
keeps a 400,000 point cloud against 61 buildings inside 100 ms.

The scale is symmetric about zero and fixed at ten metres, not fitted to what is on screen. Fitting
it sounds adaptive and is useless here: a single tree stands twenty metres above the terrain nobody
modelled it on, so it sets the scale and squashes a building five metres wrong down to almost
nothing. Fixed also means a colour is worth the same everywhere — one storey looks like one storey
whichever building is selected and however far the map is zoomed — instead of shifting meaning under
a pan.

This mode does not use the violet-to-red ramp, because the reading that matters is a sign more than a
magnitude. Colour is spent in proportion to how much there is to say: around zero everything is
nearly grey, so the centimetre-scale disagreement covering most of a scene stops competing for
attention, and strength builds linearly with the gap. The two signs take opposite halves of the
wheel, so which way a point disagrees is legible before any magnitude is read: warm where the survey
stands above the model — grey-green at 0.2 m, green at a storey, yellow at five metres, red at ten
or more — and cold where it falls below it, grey-blue at a metre through blue to violet at ten. The
cold side holds a floor of 0.26 saturation that the warm side does not, so the boundary where points
pass under a roof is a step of about 0.19 in RGB rather than a fade through the same grey. That boundary is the point of the mode: it marks exactly where the survey
drops inside the modelled solid. A horizontally misplaced building therefore shows as a red patch
where its roof returns fall on unmodelled terrain, beside a blue one where the modelled solid stands
over nothing but ground.

Because the comparison spans the whole view, editing one building's height recolours only that
building's own footprint: everything else on screen is measured against terrain or against a
neighbour, and neither moves when a height changes. It reads as less alive than it did when the
selected element was the only thing coloured, but nothing else has anything to say about the edit.

The value is carried as a `(difference, known)` pair because a shader cannot be handed a missing
value and NaN through a vertex attribute is not portable enough to rely on. Only points beyond the
terrain tiles are left unknown, and those render grey.

### Editing has to stay interactive

Dragging a height or a corner re-runs the 3D scene once per frame, so everything that frame touches
is on the critical path. Four things keep it there.

The scene keeps the local origin the first build chose for as long as the same building is selected,
instead of recomputing it from the footprint centre. The origin is only a reference for the scene's
own coordinates, and letting it follow the centre shifted every laser point whenever a corner moved,
forcing the whole position buffer to be rewritten for an edit that never moved a point. With it
held, a laser point's position depends only on the origin and the terrain alignment — neither of
which an edit changes — so a rebuild keeps its positions and takes only new colours.

Height differences are computed only while the map is actually drawing them. They cost more than the
rest of a rebuild put together, and every other view ignores them.

Mapterhorn elevation under each laser point is sampled once per cloud and terrain and kept, keyed on
both so it is released with them. It cannot change, and it is four raster lookups and a bilinear
blend for every point no building covers — most of them, in an ordinary view.

The footprint index the difference pass searches is a flat array addressed by row and column rather
than a map of `"column/row"` strings. It is consulted once per laser point, so the string and its
hash were being built half a million times per pass; the coordinate handed to the polygon tests is
one reused pair for the same reason.

Together these take a drag frame over a 400,000 point cloud with sixty neighbouring buildings from
about 140 ms to 8 ms, or 33 ms with the difference view open.

Height reaches the map only as colour in every mode; position stays flat XY throughout.

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

The cloud is drawn as evidence first: a `height` that disagrees with the survey shows up as a roof
floating above or sunk into the dots, and the mapper draws the conclusion. It is also measured, per
element and per tag, into the roof advice described above ([ADR 0007](../../adr/0007-laser-roof-advice.md)). Points arrive after the buildings, are added to the standing scene without
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

Selection and the inspector are **live OSM only**, at map zoom z >= 15.5. Both building outlines and
`building:part` elements can be selected, including through ID search. Dropping below that threshold
clears selection and leaves only the normal basemap: there is no building overlay, building legend,
selection highlight, or zoom hint. Every vertex on the selected element's outer and inner footprint rings is shown
as a small black dot, except a node with its own OSM tags, which is amber; the repeated closing
coordinate in GeoJSON produces only one dot. Inside its
nine-pixel interaction target, a node becomes a larger purple dot with a white halo and the pointer
cursor, and that highlight follows the node while it is dragged. Dragging previews the new footprint
continuously and stores one pending geometry change on release, updating the map and 3D view.
At drag start, every loaded building or part with a vertex at that exact coordinate joins the drag;
all copies preview and commit the same new coordinate, with a pending geometry change on every
affected existing entity. This preserves shared corners and walls instead of pulling only the selected
footprint away from its neighbors. The drag is recorded as a move of the OSM node, not as a new
corner, so on upload the node itself moves and everything attached to it follows — including the ways
this editor never loaded, which the on-screen expansion cannot reach (see
[osm-submission](osm-submission.md)). While dragging, every visible building and part boundary is a
snap target: existing nodes take priority within nine pixels and edges attract within twelve pixels.
The dragged node's own position and incident edges are excluded. Snapping onto another node merges
the edited rings onto that existing node, collapsing an adjacent duplicate; snapping onto an edge
inserts the node into every coincident loaded ring, including a part's parent outline. Releasing
without moving changes nothing.

Every pair of footprint edges incident to the dragged coordinate also supplies a perpendicular snap
constraint, including distinct pairs from shared nodes used by several loaded rings. In screen-space,
the valid positions form the circle whose diameter joins the two fixed neighboring vertices; the
closest point on that circle is offered when it lies within ten pixels of the pointer. Existing node
snaps retain priority. A right-angle candidate competes with an edge candidate by distance, and LOD1
is considered only when neither geometry candidate applies. While the perpendicular snap is active,
a white-cased purple square gizmo is centered directly over the dragged node, aligned to its two
incident edges, and rendered above the node handle. It disappears immediately when another snap
wins, the pointer leaves tolerance, the drag commits, or the drag is cancelled. The released
coordinate is rounded through the normal OSM grid and uses the same move-versus-insertion metadata as
any other drag.

Double-clicking an empty position on a selected outer or inner ring inserts a node at the nearest
point on that segment and into every coincident loaded ring; double-clicking near an existing node
does not add a duplicate. Node reshapes and hole cuts remain compatible with parts in 3D: once parts
cover the edited outline, they replace it normally, and a hole cut has already subtracted the opening
from every underlying part.

### Add node mode

At live-OSM zoom, **Add node** is enabled when a building outline or `building:part` is selected and
targets that selected element. Pressing the primary pointer within eight screen pixels of an empty
outer or inner ring edge inserts a node at the nearest projected edge coordinate, welds the same
coordinate into every coincident loaded building or part wall, and starts a drag in the same pointer
gesture. The inserted node and every welded copy preview continuously; releasing without pointer
movement still commits the insertion at its initial edge coordinate.

An existing selected node retains its nine-pixel priority over an edge. Pressing it starts the normal
shared-node drag and creates nothing, so a click at an existing node can never stack a duplicate.
Clicking another visible building outline or part away from the selected target's nodes and edges
selects it and retargets Add node without leaving the mode. Clicking the map background is inert and
cannot accidentally clear the current selection. Existing and newly inserted nodes use the normal
visible-boundary, right-angle and LOD1 snap behavior while dragging. Escape exits Add node mode; if a
new-node drag is still in progress, the effect cleanup discards its uncommitted preview and restores
map panning.

A node inserted and moved within one gesture remains an insertion in the pending geometry metadata,
not a move from its temporary edge coordinate. Existing-node drags continue to record their original
OSM coordinate so submission modifies that node rather than replacing it. Add node mode stays active
after a completed insertion or a map-click selection of another editable element, but exits when the
selection changes through another interaction, live-OSM zoom is left, another geometry tool is
chosen, photo alignment starts, or the changes sidebar opens.

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

Switching between the outline and parts of the same parent also keeps that runtime mounted. The
building and neighbor meshes, terrain, decoded cloud, and LiDAR position buffer are parent-scoped;
only camera focus and the selection-dependent discrepancy colours change. In-flight terrain and
LiDAR reads continue across that switch instead of being aborted and restarted.

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

The map has two zoom-dependent states (see [ADR 0001](../../adr/0001-live-osm-data-for-editing.md)):

- **Normal basemap** — geographic context below z15.5, without a separate building overlay or edit targets.
- **Live OSM API** — everything editable, at map zoom z >= 15.5, using fixed-grid z16 tiles and always through the cached proxy required by [ADR 0002](../../adr/0002-cached-rate-limited-osm-proxy.md).

Two local reference datasets sit beside them, imported to the same z16 grid and served from disk:
Stockholm LOD1 blocks ([ADR 0003](../../adr/0003-lod1-as-advice-not-import.md)) and the 2023 laser
point cloud ([ADR 0004](../../adr/0004-laser-point-cloud-as-raw-evidence.md)). Neither is ever an
edit target.

Mapterhorn z13 terrain is read through the app's fixed-grid `/api/terrain` route and decoded in the
3D preview. It defines ground elevation only and is never an edit target or a source of OSM height
tags.

Height and color logic follows OSM tags as delivered in FT-03 of [EP-001](../../plans/epics/EP-001-osm-editing/index.md).
