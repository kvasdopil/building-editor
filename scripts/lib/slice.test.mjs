import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { sliceBuilding } = await import("../../src/lib/slice.ts");

const element = (id, role, outer, holes = []) => ({
  id,
  role,
  polygons: [{ outer, holes }],
  properties: role === "building" ? { building: "yes" } : { "building:part": "yes" },
});

const outer = [
  [0, 0],
  [0.0001, 0],
  [0.0001, 0.0001],
  [0, 0.0001],
  [0, 0],
];
const buildingHole = [
  [0.00002, 0.00002],
  [0.00002, 0.00008],
  [0.00008, 0.00008],
  [0.00008, 0.00002],
  [0.00002, 0.00002],
];
const partHole = [
  [0.00003, 0.00003],
  [0.00003, 0.00007],
  [0.00007, 0.00007],
  [0.00007, 0.00003],
  [0.00003, 0.00003],
];

test("an open slice may follow a part courtyard that differs from the parent hole", () => {
  const building = element("way/1", "building", outer, [buildingHole]);
  const part = element("relation/2", "part", outer, [partHole]);
  const result = sliceBuilding(
    building,
    [part],
    [
      [0.00005, 0.0001],
      [0.00005, 0.00007],
      [0.00007, 0.00007],
      [0.0001, 0.00005],
    ],
    false,
  );

  assert.ok(result);
  assert.ok(result.replacements[part.id]);
  assert.equal(result.additions.length, 1);
});

test("a closed tower loop must still stay inside the parent building", () => {
  const building = element("way/1", "building", outer, [buildingHole]);
  const part = element("relation/2", "part", outer, [partHole]);
  const result = sliceBuilding(
    building,
    [part],
    [
      [0.000025, 0.00004],
      [0.000025, 0.00006],
      [0.000029, 0.00005],
    ],
    true,
  );

  assert.equal(result, null);
});
