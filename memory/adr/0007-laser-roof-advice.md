# ADR 0007 - The laser measures roof tags, and shows how far off it is

Status: Draft (2026-08-30)

Records why the point cloud now derives `height`, `roof:height` and `roof:shape` as per-element advice, which readings are allowed to be chosen by minimizing the fit error and which are not, and why every suggestion carries the distance between the roof it describes and the points.

Related documents:

- [LOD1 is advice, never an import](0003-lod1-as-advice-not-import.md): The pattern this follows — a measurement offered per building and accepted one tag at a time. Read it first.
- [The laser point cloud is raw evidence](0004-laser-point-cloud-as-raw-evidence.md): Amended here. It required the cloud to suggest nothing; that held while the cloud was only drawn, and stopped holding once the surface grid gave it a shape to measure.
- [National laser data is read on demand](0005-national-laser-data-read-on-demand.md): The source most of this advice is measured from, at ~2 points/m².
- [Mapterhorn defines the 3D ground datum](0006-mapterhorn-defines-3d-ground.md): Unchanged. Advice heights are read against ground-class returns beside the footprint, not against the scene datum, and never move it.
- [Building Explorer domain spec](../spec/domain/building-explorer.md): The normative behavior of the advice rows and the fit indicator.

## Decision

- The selected building's cloud is rasterized into the half-metre surface grid (`src/lib/surface-grid.ts`), and `src/lib/roof-advice.ts` reads three tags per element from it — for the outline and for each `building:part` separately, which is what LOD1 cannot do.
- `height` is the 99th percentile of raw per-cell maxima above **this building's own ground**: the 10th percentile of ground-class returns within 2 m of the outline, widened outwards only when that ring is too thin. A raw return standing more than 1.5 m above the surface fitted around it is discarded first, as a chimney, an antenna or an overhanging branch.
- `roof:shape` is read from what the roof does where it meets each stretch of wall — falling over it, running along it as a gable end, or climbing away from it as the high side of a single pitch — weighted by wall length.
- Every suggestion carries an **error**: the roof those tags describe is built with the app's own `roofSurface()` and measured against the cells, as the mean distance over the closest-fitting 90%. The panel shows it beside `roof:shape` together with the same measurement for the element's current tags, and applies the whole combination in one press.
- That error may choose `roof:height` and nothing else, and only where the modelled roof already lands within 0.5 m of the points. It never chooses `height`, and never chooses the shape.

## Why

- ADR 0004's rule was that the cloud suggests nothing, because a summary of it (LOD1) is what fails for parts. That reasoning argued against _importing_ a summary, not against measuring — and the same clipping that makes points work for parts is what makes a per-part measurement possible. Advice keeps ADR 0003's shape: per element, per tag, accepted by a mapper.
- Ground is the whole error on a slope, and it fails in both directions. The cloud's level for its entire 200 m box put a waterfront house 4 m above its own ground; a 15 m skirt then read a shed on the Kastellet cliff 3 m too tall by measuring from the shoreline six metres away. Two metres is close enough that only ground touching the building is in it, which is also what OSM means by measuring from the lowest ground point.
- A percentile cannot reject a chimney on a small roof: at seventy peak cells the 99th percentile _is_ the maximum. The smithy at Kastellet read 12.5 m at its chimney against a 6.4 m ridge, and the inflated height then put the eaves floor above the whole roof, so `roof:height` disappeared as well. Rejecting on the gap to the locally fitted surface is independent of sample size.
- Measured over 256 tagged buildings in Hammarby Sjöstad, where roof tags are well maintained, the laser reads `height` to 1.09 m and `roof:height` to 0.84 m of mean absolute error, against LOD1's 1.58 m and 1.55 m on the same buildings. In the dense old town LOD1 is still better on height (2.53 m against 3.26 m), where narrow streets leave few ground returns.
- What the error is allowed to choose was measured rather than assumed, over the same 256 buildings:

  | the error may choose                    | `height` | `roof:height` |
  | --------------------------------------- | -------- | ------------- |
  | nothing                                 | 1.09 m   | 0.94 m        |
  | the rise, where the fit is within 0.5 m | 1.09 m   | **0.84 m**    |
  | the rise, always                        | 1.09 m   | 1.14 m        |
  | the rise and the height, within 0.5 m   | 1.14 m   | 0.80 m        |
  | the rise and the height, always         | 1.75 m   | 1.14 m        |

- `height` names the ridge, and a percentile of cell maxima reads a ridge directly. Letting the error move it drags it half a metre down on average: the mean miss is dominated by the broad surfaces near the eaves, and lowering the apex buys their agreement at the ridge's expense. On a building the model does not describe — Skanstull's bridge piers read as hipped, missing by 0.9 m and 3.5 m — the minimum of the error surface is a minimum of noise, which the 0.5 m gate keeps out.
- The shape is not chosen by the error either, and this was measured three times: an aspect histogram over the whole roof (64/112), idealized surfaces fitted to the cell heights, and the app's real roof geometry placed at each shape's own robust best fit with the model blurred to match the measurement (43/112 to 55/112). At ~2 points/m² a gable, a hip and a barrel vault leave height residuals within centimetres of each other, well inside the noise from roof equipment and the 2.5 m fit window, so the argmin is decided by noise. Slope _direction_ survives that noise where elevation does not, which is why the walls are read instead — 68/112, against 66/112 for tagging everything `gabled`.

## Trade-offs

- `roof:shape` is a judgement, not a measurement. It agrees with 68 of 112 tagged roofs, and most of the rest are the genuine hip/gable ambiguity: a block with hipped ends is routinely tagged `gabled` by whoever looked at it. It is therefore always offered unconfident, and the panel draws it muted. In the old town it drops to 51%, where half the roofs are `gambrel`, `mansard`, `half-hipped` or `many` — shapes this does not distinguish and never suggests.
- The fit error is a quality signal, not an objective. Where it is large the advice beside it is wrong in some way the shape does not describe, and the mapper is expected to look; where a mapper finds a closer combination by hand, the indicator will say so plainly rather than pretend otherwise.
- Reading advice costs a surface grid per selection and one roof surface per measurement. Both are recomputed when the selection or the cloud changes, not on every tag edit, and the grid is built from the OSM geometry rather than the edited one — so a reshaped footprint is not re-measured until the element is selected again.
- LOD1 keeps precedence wherever it has a confident opinion, because it is the city's own per-building model. The laser fills in the rest: `roof:shape` always, every `building:part`, and any building whose LOD1 block spans several structures.
