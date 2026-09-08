import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The CGAL/Wasm skeleton is built for the browser and refuses to load without
// these; the renderer supplies them natively. Set before importing the module.
globalThis.self = globalThis;
globalThis.window = globalThis;

register("./ts-hooks.mjs", import.meta.url);
const { roofSurface, initializeHippedRoofGeometry } = await import("../../src/lib/roofs.ts");

const footprint = (outer) => ({ outer, holes: [] });
const plan = (shape, orientation = "along") => ({
  shape,
  orientation,
  directionFromCompass: false,
  eaves: 4,
  top: 9,
});

const RECTANGLE = footprint([
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
]);
// A 20x10 wing meeting a 10x20 wing: both are 10 m wide, so one equal-pitch
// roof should ride both. The minimum rectangle spans the empty notch as well.
const L_SHAPE = footprint([
  [0, 0],
  [20, 0],
  [20, 10],
  [10, 10],
  [10, 30],
  [0, 30],
]);

const surfaceFor = (shape, shapeFootprint, orientation) => {
  const built = roofSurface(plan(shape, orientation), [shapeFootprint], [shapeFootprint]);
  assert.ok(built, `${shape} surface`);
  return built;
};
const digest = (surface) => ({
  positions: [...surface.positions].map((value) => value.toFixed(6)).join(","),
  indices: surface.indices ? [...surface.indices].join(",") : null,
  walls: surface.wallPositions
    ? [...surface.wallPositions].map((v) => v.toFixed(6)).join(",")
    : null,
});

// Captured before the engine loads: this is the bounding-rectangle sweep, the
// only roof builder the advice CLI and the first render frame ever have.
const withoutEngine = {
  rectangleGabled: surfaceFor("gabled", RECTANGLE),
  rectangleGambrel: surfaceFor("gambrel", RECTANGLE),
  lShapeGabled: surfaceFor("gabled", L_SHAPE),
  lShapeAcross: surfaceFor("gabled", L_SHAPE, "across"),
};

const engineReady = await initializeHippedRoofGeometry();

/** Roof height at a plan position, read off the built triangles. */
function heightAt(surface, [x, y]) {
  const { positions, indices } = surface;
  const count = indices ? indices.length : positions.length / 3;
  let best = null;
  for (let i = 0; i < count; i += 3) {
    const at = (offset) => (indices ? indices[i + offset] : i + offset) * 3;
    const [a, b, c] = [at(0), at(1), at(2)];
    const corner = (index) => [positions[index], positions[index + 2]];
    const [ax, ay] = corner(a);
    const [bx, by] = corner(b);
    const [cx, cy] = corner(c);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / area;
    const v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
    if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
    const height =
      positions[a + 1] +
      u * (positions[b + 1] - positions[a + 1]) +
      v * (positions[c + 1] - positions[a + 1]);
    best = Math.max(best ?? height, height);
  }
  return best;
}

test("the skeleton engine loads", () => {
  assert.equal(engineReady, true);
});

test("a rectangular gabled roof is byte-identical with the engine loaded", () => {
  assert.deepEqual(digest(surfaceFor("gabled", RECTANGLE)), digest(withoutEngine.rectangleGabled));
});

test("a rectangular gambrel roof is byte-identical with the engine loaded", () => {
  assert.deepEqual(
    digest(surfaceFor("gambrel", RECTANGLE)),
    digest(withoutEngine.rectangleGambrel),
  );
});

test("roof:orientation=across keeps its bounding-rectangle ridge", () => {
  assert.deepEqual(
    digest(surfaceFor("gabled", L_SHAPE, "across")),
    digest(withoutEngine.lShapeAcross),
  );
});

test("a concave gabled roof leaves the bounding rectangle behind", () => {
  assert.notDeepEqual(digest(surfaceFor("gabled", L_SHAPE)), digest(withoutEngine.lShapeGabled));
});

test("a concave gabled ridge reaches the end wall of every wing", () => {
  const surface = surfaceFor("gabled", L_SHAPE);
  // Both wings are 10 m wide, so both ridges reach the full tagged height.
  assert.ok(Math.abs(heightAt(surface, [20, 5]) - 9) < 1e-6, "wing along +x");
  assert.ok(Math.abs(heightAt(surface, [5, 30]) - 9) < 1e-6, "wing along +y");
  // One bounding-rectangle ridge runs along the taller wing only. It leaves the
  // other wing's end wall at the eaves and its own end wall part way up.
  assert.ok(Math.abs(heightAt(withoutEngine.lShapeGabled, [20, 5]) - 4) < 1e-6, "was eaves");
  assert.ok(Math.abs(heightAt(withoutEngine.lShapeGabled, [5, 30]) - 6.5) < 1e-6, "was mid slope");
});

test("a concave gabled roof sits at the eaves along every unsuppressed wall", () => {
  const surface = surfaceFor("gabled", L_SHAPE);
  for (const point of [
    [10, 0.001],
    [0.001, 15],
    [19.999, 5],
  ]) {
    const height = heightAt(surface, point);
    assert.ok(height !== null, `covered at ${point.join(",")}`);
  }
  assert.ok(Math.abs(heightAt(surface, [10, 0.001]) - 4) < 0.01, "long wall is eaves");
  assert.ok(Math.abs(heightAt(surface, [0.001, 15]) - 4) < 0.01, "other long wall is eaves");
});

test("a concave gabled roof closes its gable ends with wall fill", () => {
  const surface = surfaceFor("gabled", L_SHAPE);
  assert.ok(surface.wallPositions, "gable end walls");
  const tops = [];
  for (let i = 1; i < surface.wallPositions.length; i += 3) tops.push(surface.wallPositions[i]);
  assert.ok(Math.max(...tops) > 8.99, "wall fill reaches the ridge");
});

test("a concave gambrel breaks at one height across both wings", () => {
  const surface = surfaceFor("gambrel", L_SHAPE);
  // 45 degrees over a 5 m run breaks into a 60 and a 30 degree panel, so the
  // break sits above the midpoint of the rise rather than at it.
  const heights = new Set(
    [...surface.positions].filter((_, i) => i % 3 === 1).map((v) => v.toFixed(4)),
  );
  assert.ok(heights.size >= 3, `eaves, break and ridge, got ${[...heights].join(" ")}`);
  assert.ok(Math.abs(heightAt(surface, [20, 5]) - 9) < 1e-6, "ridge still reaches the gable");
  const slope = heightAt(surface, [20, 1.25]);
  const gabled = heightAt(surfaceFor("gabled", L_SHAPE), [20, 1.25]);
  assert.ok(slope > gabled + 0.1, `steeper lower panel: ${slope} vs ${gabled}`);
});
