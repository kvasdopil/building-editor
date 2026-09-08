import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

globalThis.self = globalThis;
globalThis.window = globalThis;

register("./ts-hooks.mjs", import.meta.url);
const {
  MANSARD_BREAK_HEIGHT,
  MANSARD_BREAK_PROGRESS,
  initializeHippedRoofGeometry,
  mansardRoofProgress,
  roofPlan,
  roofSurface,
} = await import("../../src/lib/roofs.ts");

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("mansard is a supported OSM roof shape", () => {
  const plan = roofPlan({ roof_shape: "mansard", roof_height: 5 }, { base: 0, top: 12 });
  assert.equal(plan.shape, "mansard");
  assert.equal(plan.eaves, 7);
  assert.equal(plan.top, 12);
});

test("mansard profile has the Streets.gl 30%-run, 60%-rise crease", () => {
  close(mansardRoofProgress(0), 0);
  close(mansardRoofProgress(MANSARD_BREAK_PROGRESS), MANSARD_BREAK_HEIGHT);
  close(mansardRoofProgress(1), 1);
  close(mansardRoofProgress(0.15), 0.3);
  close(mansardRoofProgress(0.65), 0.8);
});

test("mansard profile clamps propagation progress to the roof extent", () => {
  close(mansardRoofProgress(-1), 0);
  close(mansardRoofProgress(2), 1);
});

test("mansard geometry splits skeleton faces at the hard crease", async () => {
  assert.equal(await initializeHippedRoofGeometry(), true);
  const footprint = {
    outer: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    holes: [],
  };
  const surface = roofSurface(
    {
      shape: "mansard",
      orientation: "along",
      directionFromCompass: false,
      eaves: 4,
      top: 9,
    },
    [footprint],
  );
  assert.ok(surface);
  const heights = new Set(
    [...surface.positions].filter((_, index) => index % 3 === 1).map((height) => height.toFixed(6)),
  );
  assert.deepEqual([...heights].sort(), ["4.000000", "7.000000", "9.000000"]);
});
