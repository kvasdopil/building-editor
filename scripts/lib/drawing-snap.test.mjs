import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./ts-hooks.mjs", import.meta.url);
const { resolveDrawingSnap } = await import("../../src/lib/drawing-snap.ts");
const map = { project: ([x, y]) => ({ x, y }), unproject: ([lng, lat]) => ({ lng, lat }) };
const building = {
  polygons: [
    {
      outer: [
        [0, 0],
        [100, 0],
        [100, 40],
        [0, 40],
        [0, 0],
      ],
      holes: [],
    },
  ],
};
const snap = (x, y, disabled = false, boundary = null) =>
  resolveDrawingSnap(map, { x, y }, [[20, 20]], building, boundary, null, disabled);
test("parallel and perpendicular endpoints use the edge pixel threshold", () => {
  assert.deepEqual(snap(70, 31).coordinates, [70, 20]);
  assert.deepEqual(snap(31, 70).coordinates, [20, 70]);
  assert.equal(snap(70, 33), null);
  assert.equal(snap(70, 32).distance, 12);
});
test("Shift disables every target, exact boundaries retain priority", () => {
  const boundary = { kind: "node", coordinates: [70, 22], targetId: "way/1", distance: 1 };
  assert.equal(snap(70, 23, false, boundary), boundary);
  assert.equal(snap(70, 23, true, boundary), null);
  assert.equal(snap(70, 23, true), null);
});
test("rotated building axes and gizmo follow the segment", () => {
  const rotated = {
    polygons: [
      {
        outer: [
          [0, 0],
          [80, 80],
          [60, 100],
          [-20, 20],
          [0, 0],
        ],
        holes: [],
      },
    ],
  };
  const result = resolveDrawingSnap(map, { x: 50, y: 54 }, [[0, 0]], rotated, null, null, false);
  assert.ok(Math.abs(result.coordinates[0] - result.coordinates[1]) < 1e-9);
  assert.equal(result.guides.length, 2);
  for (const guide of result.guides) {
    const [a, b] = guide.geometry.coordinates;
    assert.ok(Math.abs(b[0] - a[0] - (b[1] - a[1])) < 1e-9);
  }
});
test("no direction snap without a previous node or a nondegenerate footprint", () => {
  assert.equal(resolveDrawingSnap(map, { x: 50, y: 2 }, [], building, null, null, false), null);
  assert.equal(
    resolveDrawingSnap(map, { x: 50, y: 2 }, [[0, 0]], { polygons: [] }, null, null, false),
    null,
  );
});

const { projectBoundaryRings, nearestBoundary } = await import("../../src/lib/drawing-snap.ts");
const groups = (rings) => [{ targetId: "way/1", rings: projectBoundaryRings(map, rings) }];
const wall = groups([
  [
    [100, -100],
    [100, 100],
  ],
]);
const resolve = (point, boundaries = wall, disabled = false) =>
  resolveDrawingSnap(map, point, [[20, 20]], building, null, null, disabled, boundaries);
test("axis/edge intersection wins over an ordinary edge projection and preserves identity", () => {
  const result = resolve({ x: 98, y: 26 });
  assert.equal(result.kind, "edge");
  assert.equal(result.targetId, "way/1");
  assert.deepEqual(result.coordinates, [100, 20]);
  assert.equal(result.guides.length, 2);
  assert.deepEqual(nearestBoundary(wall, { x: 98, y: 26 }).coordinates, [100, 26]);
});
test("intersection tolerance is radial and Shift disables combined snaps", () => {
  assert.equal(resolve({ x: 98, y: 34 }).guides, undefined);
  assert.equal(resolve({ x: 98, y: 26 }, wall, true), null);
});
test("intersection uses finite segments and skips parallel walls", () => {
  const short = groups([
    [
      [100, 30],
      [100, 70],
    ],
  ]);
  assert.equal(resolve({ x: 98, y: 28 }, short).guides, undefined);
  const parallel = groups([
    [
      [50, 23],
      [150, 23],
    ],
  ]);
  const result = resolve({ x: 100, y: 24 }, parallel);
  assert.deepEqual(result.coordinates, [100, 23]);
  assert.equal(result.guides, undefined);
});
test("existing nodes keep priority over intersections", () => {
  const boundaries = groups([
    [
      [100, 25],
      [100, 100],
    ],
  ]);
  const result = resolve({ x: 100, y: 26 }, boundaries);
  assert.equal(result.kind, "node");
  assert.deepEqual(result.coordinates, [100, 25]);
});
test("intersection search includes a farther edge when the nearest one has no valid crossing", () => {
  const boundaries = groups([
    [
      [90, 25],
      [90, 80],
    ],
    [
      [100, -100],
      [100, 100],
    ],
  ]);
  assert.deepEqual(resolve({ x: 92, y: 21 }, boundaries).coordinates, [90, 25]); // exact node priority
  const farther = groups([
    [
      [90, 23],
      [150, 23],
    ],
    [
      [100, -100],
      [100, 100],
    ],
  ]);
  assert.deepEqual(resolve({ x: 102, y: 26 }, farther).coordinates, [100, 20]);
});

const { drawingPreviewSegment } = await import("../../src/lib/drawing-snap.ts");
test("preview follows raw or snapped cursor without changing committed nodes", () => {
  const nodes = [[20, 20]];
  const cursor = [98, 26];
  assert.deepEqual(drawingPreviewSegment(nodes, cursor, null).geometry.coordinates, [
    [20, 20],
    [98, 26],
  ]);
  assert.deepEqual(
    drawingPreviewSegment(nodes, cursor, resolve({ x: 98, y: 26 })).geometry.coordinates,
    [
      [20, 20],
      [100, 20],
    ],
  );
  assert.deepEqual(nodes, [[20, 20]]);
  assert.equal(drawingPreviewSegment(nodes, null, null), null);
  assert.equal(drawingPreviewSegment([], cursor, null), null);
});
