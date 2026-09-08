import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { projectLambert93, unprojectLambert93 } = await import("../../src/lib/lambert93.ts");

test("EPSG:2154 projection round-trips the Eiffel Tower", () => {
  const projected = projectLambert93(2.2945, 48.8584);
  assert.ok(Math.abs(projected[0] - 648237.302) < 0.01);
  assert.ok(Math.abs(projected[1] - 6862271.682) < 0.01);

  const restored = unprojectLambert93(...projected);
  assert.ok(Math.abs(restored[0] - 2.2945) < 1e-9);
  assert.ok(Math.abs(restored[1] - 48.8584) < 1e-9);
});
