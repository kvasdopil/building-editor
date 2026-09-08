# ADR 0010 - Concave gabled and gambrel roofs build on the straight skeleton

Status: Draft (2026-09-08)

Records why a gabled or gambrel outline that turns inward is built on the footprint's interior
straight skeleton with its capped walls suppressed, while every convex outline keeps the
minimum-area bounding-rectangle sweep.

Related documents:

- [Building Explorer domain spec](../spec/domain/building-explorer.md): The normative roof geometry
  rules for every shape. Read it for the behavior this decision implements.
- [The laser measures roof tags](0007-laser-roof-advice.md): Why `roof:shape` is advised from the
  point cloud. Read it before assuming the renderer and the advice CLI can build the same shapes.

## Decision

- A `gabled` or `gambrel` outline builds on the same interior straight skeleton as `hipped` when the
  outer ring has a reflex corner or carries a hole. Every other outline, rectangles included, keeps
  the bounding-rectangle band sweep byte for byte.
- The walls a gable replaces are identified from the skeleton, not from edge length: a face that
  collapses to a point at half its own edge's length is where a hip end would sit. The apex is
  measured against that edge rather than against the whole roof, which is what separates a narrow
  wing from a shallow bay window.
- Those walls are suppressed by pushing them outward along their own normals before the skeleton is
  built, so their hip faces land outside the outline. Clipping the lifted skeleton back to the
  outline then cuts the ridge vertically at each of them.
- Propagation time is normalized against the **unsuppressed** skeleton's maximum, so the pitch
  matches the hipped roof's for the same `roof:height`.
- A gambrel's break is measured from the eaves against the outline's inradius instead of a
  rectangle's half width. Each face is split along that isoline so the break stays a hard crease,
  and the gable end walls inherit the split.
- `roof:orientation=across`, an outline with no capped wall, a skeleton that cannot be built, and a
  missing engine all fall back to the bounding-rectangle sweep rather than failing.
- The skeleton is derived from the **frame** footprints and clipped to the rendered footprints, so a
  part sharing its outline's roof still lands on that outline's ridge.

## Why

- One bounding rectangle cannot carry two ridges. On a 20x10 plus 10x20 L, the rectangle spans the
  empty notch, so the single ridge runs across the wings: measured at the two wing end walls, the
  old sweep produced 4.0 m (the eaves) and 6.5 m (mid slope) where the tagged ridge is 9.0 m. The
  skeleton reaches 9.0 m at both.
- Hipped, gabled and gambrel differ only in two knobs — which walls are suppressed, and the height
  ramp. Building them from one skeleton makes that explicit instead of keeping two unrelated
  constructions, and it is why gambrel needed no new plan geometry, only a piecewise ramp.
- Suppressing a wall by moving it outward reproduces an infinitely weighted skeleton edge. CGAL
  supports weighted skeletons but the `straight-skeleton` Wasm binding exposes coordinates only, and
  moving a wall away provably cannot change propagation time inside the outline.
- The break wrapping every wing at one height is how a gambrel is actually framed, and it falls out
  of parameterizing by offset distance rather than by a per-rectangle fraction.

## Trade-offs

- The engine is browser-only: `initializeHippedRoofGeometry()` returns false under Node, so
  `yarn advice` and the first render frame use the bounding-rectangle sweep. This is why that sweep
  stays a required path and not a legacy one, and why concave gabled advice is unchanged.
- `across` is unavailable on a branched ridge, because a rectangle's shorter edge has no analogue
  there. Concave outlines tagged `across` keep the old geometry.
- A shallow bay window wider than twice its depth reads as a capped wing and renders as a lower
  cross-gable rather than a hip. Both are plausible roofs over such a bay, so the classifier is left
  simple rather than given a special case.
- A wing wider than the outline's inradius clamps at ridge height, giving a short plateau instead of
  a raised ridge segment. Equal pitch across an outline is the property worth keeping.
- Tests polyfill `self` and `window` to load the browser Wasm build under Node. That the engine runs
  there at all suggests the advice CLI could offer skeleton shapes too; that is not done here.
