import assert from "node:assert/strict";
import test from "node:test";
import { icgcSourceTiles } from "./icgc-lidar.mjs";
import { makeSweref99Forward, makeSweref99Inverse } from "./sweref99.mjs";

test("EPSG:25831 projection round-trips Sagrada Familia", () => {
  const parameters = { lon0: 3, k0: 0.9996, falseEasting: 500000 };
  const project = makeSweref99Forward(parameters);
  const unproject = makeSweref99Inverse(parameters);
  const projected = project(2.1744, 41.4036);
  assert.ok(Math.abs(projected[0] - 430990.746) < 0.01);
  assert.ok(Math.abs(projected[1] - 4583890.9) < 0.01);
  const restored = unproject(...projected);
  assert.ok(Math.abs(restored[0] - 2.1744) < 1e-9);
  assert.ok(Math.abs(restored[1] - 41.4036) < 1e-9);
});

test("Sagrada Familia crosses the two expected ICGC kilometre sheets", () => {
  const sheets = icgcSourceTiles([2.173, 41.4028, 2.176, 41.4045]);
  assert.deepEqual(
    sheets.map(({ code }) => code),
    ["430583", "431583"],
  );
  assert.match(sheets[0].url, /full10km4358\/lidar-territorial-full1km430583\.laz$/);
});
