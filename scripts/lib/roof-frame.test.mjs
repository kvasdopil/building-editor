import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { resolvedRoofPlan } = await import("../../src/lib/roofs.ts");
const { levelHeight } = await import("../../src/lib/heights.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");

// Local metres at the equator, in the roof renderer's east/south plane.
const point = (x, y) => [x / 111320, -y / 111320];
const rectangle = (x1, y1, x2, y2) => ({
  outer: [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ].map(([x, y]) => point(x, y)),
  holes: [],
});
function element(id, tags, polygons = [rectangle(0, 0, 20, 10)], role = "part") {
  return { id, polygons, properties: { id, ...normalizeOsmTags(tags, role) } };
}
const resolve = (part, outline) => resolvedRoofPlan(part, outline, levelHeight(outline.properties));

// The Eiffel Tower: a 330 m pyramidal outline over 3 m ticket kiosks that
// carry no roof tags at all.
const tower = element(
  "way/1",
  { building: "tower", height: "330", "roof:shape": "pyramidal", "roof:height": "330" },
  [rectangle(0, 0, 174, 174)],
  "building",
);

test("a part with its own height keeps it instead of the outline's roof frame", () => {
  const kiosk = element("way/2", { "building:part": "yes", height: "3" }, [
    rectangle(4, 4, 14, 14),
  ]);
  const resolved = resolve(kiosk, tower);
  assert.equal(resolved.shared, false);
  assert.equal(resolved.frameElement.id, kiosk.id);
  assert.equal(resolved.plan.top, 3);
  assert.equal(resolved.plan.eaves, 0);
});

test("a level count of its own counts as a stated height too", () => {
  const kiosk = element("way/2", { "building:part": "yes", "building:levels": "1" });
  const resolved = resolve(kiosk, tower);
  assert.equal(resolved.shared, false);
  assert.equal(resolved.plan.top, levelHeight(tower.properties));
});

test("a part matching the outline's height still shares its roof frame", () => {
  const house = element(
    "way/1",
    { building: "yes", height: "20", "roof:shape": "gabled", "roof:height": "8" },
    [rectangle(0, 0, 40, 20)],
    "building",
  );
  for (const tags of [{ "building:part": "yes" }, { "building:part": "yes", height: "20" }]) {
    const resolved = resolve(element("way/2", tags), house);
    assert.equal(resolved.shared, true);
    assert.equal(resolved.frameElement.id, house.id);
    assert.equal(resolved.plan.eaves, 12);
    assert.equal(resolved.plan.top, 20);
  }
});

test("an independent part still reads shape and profile from the outline", () => {
  const house = element(
    "way/1",
    { building: "yes", height: "20", "roof:shape": "gabled", "roof:height": "8" },
    [rectangle(0, 0, 40, 20)],
    "building",
  );
  const wing = element("way/2", { "building:part": "yes", height: "12" });
  const resolved = resolve(wing, house);
  assert.equal(resolved.shared, false);
  assert.equal(resolved.plan.shape, "gabled");
  assert.equal(resolved.plan.top, 12);
  assert.equal(resolved.plan.eaves, 4);
});
