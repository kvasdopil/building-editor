import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { minimumRoofHeight } = await import("../../src/lib/roofs.ts");
const { validateChangeset } = await import("../../src/lib/osm/validate.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");
const { elementFeature } = await import("../../src/lib/geometry.ts");

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
const parent = element("way/1", { building: "yes", height: "30" }, undefined, "building");
const overlap = [rectangle(8, 2, 12, 4)];
const lower = (shape, extra = {}) =>
  element("way/2", {
    "building:part": "yes",
    height: "20",
    "roof:shape": shape,
    "roof:height": "8",
    ...extra,
  });
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 0.001, `${actual} != ${expected}`);

test("flat and unmodelled roofs keep the effective top", () => {
  for (const shape of ["flat", "unsupported"])
    close(minimumRoofHeight(lower(shape), parent, overlap, 4), 20);
  close(minimumRoofHeight(lower("dome", { "roof:height": "0" }), parent, overlap, 4), 20);
});

test("an offset tower reaches the low side of a gable, not the ridge or global eaves", () => {
  close(minimumRoofHeight(lower("gabled"), parent, overlap, 4), 15.2);
});

test("roof orientation and skillion direction change the support height", () => {
  close(
    minimumRoofHeight(lower("gabled", { "roof:orientation": "across" }), parent, overlap, 4),
    18.4,
  );
  close(minimumRoofHeight(lower("skillion", { "roof:direction": "90" }), parent, overlap, 4), 15.2);
  close(
    minimumRoofHeight(lower("skillion", { "roof:direction": "180" }), parent, overlap, 4),
    16.8,
  );
});

test("curved roofs lower the base only by the local roof drop", () => {
  for (const shape of ["round", "dome", "onion", "gambrel", "pyramidal", "hipped", "mansard"]) {
    const height = minimumRoofHeight(lower(shape), parent, overlap, 4);
    assert.ok(height > 12 && height < 20, `${shape}: ${height}`);
  }
});

test("sparse parts retain the parent's roof height and frame", () => {
  const roofParent = element(
    "way/1",
    { building: "yes", height: "20", "roof:shape": "gabled", "roof:height": "8" },
    [rectangle(0, 0, 40, 20)],
    "building",
  );
  const sparse = element("way/2", { "building:part": "yes", height: "20" });
  close(minimumRoofHeight(sparse, roofParent, overlap, 4), 13.6);
});

test("disjoint overlap regions and holes are preserved", () => {
  close(minimumRoofHeight(lower("gabled"), parent, [...overlap, rectangle(8, 1, 12, 2)], 4), 13.6);
  const ring = rectangle(8, 2, 12, 8);
  ring.holes.push(rectangle(9, 3, 11, 7).outer);
  close(minimumRoofHeight(lower("gabled"), parent, [ring], 4), 15.2);
});

function overlapIssue(base, tower) {
  const displayed = {
    type: "FeatureCollection",
    features: [parent, base, tower].map((item) => ({
      ...elementFeature(item),
      properties: item.properties,
    })),
  };
  const plan = {
    nodes: [],
    ways: [],
    relations: [],
    dropped: [],
    issues: [],
    entries: [{ ref: tower.id, tagChanges: [] }],
  };
  return validateChangeset({ displayed, plan }).issues.find(
    (issue) => issue.check === "overlapping-volumes",
  );
}

test("validation fixes the tower using the roof and does not repeat the same fix", () => {
  const tower = element("way/3", { "building:part": "yes", height: "30" }, overlap);
  const base = lower("gabled");
  const found = overlapIssue(base, tower);
  assert.equal(found.fix.entity, tower.id);
  assert.equal(found.fix.key, "min_height");
  close(Number(found.fix.value), 15.2);
  tower.properties.min_height = Number(found.fix.value);
  // A flat base intersects the high side of a curved roof; still reviewable,
  // but Fix must not repeatedly offer an unchanged tag.
  assert.equal(overlapIssue(base, tower).fix, undefined);
});

test("flat-roof fixes are unchanged and elevated supports are not auto-stacked", () => {
  const tower = element("way/3", { "building:part": "yes", height: "30" }, overlap);
  assert.equal(overlapIssue(lower("flat"), tower).fix.value, "20");
  assert.equal(overlapIssue(lower("gabled", { min_height: "5" }), tower).fix, undefined);
});
