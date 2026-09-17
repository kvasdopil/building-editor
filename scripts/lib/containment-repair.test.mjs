import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./ts-hooks.mjs", import.meta.url);
const { containmentRepair, applyContainmentRepair, outsideArea, containmentGeometryKey } =
  await import("../../src/lib/osm/containment-repair.ts");
const { validateChangeset } = await import("../../src/lib/osm/validate.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");
const rectangle = (x1, y1, x2, y2) => ({
  type: "Polygon",
  coordinates: [
    [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
      [x1, y1],
    ],
  ],
});
const parent = rectangle(0, 0, 0.0002, 0.0002);
const part = rectangle(-0.0000004, 0.00002, 0.0001, 0.00018);
const feature = (id, geometry, role = "part") => ({
  type: "Feature",
  properties: {
    id,
    ...normalizeOsmTags(
      { [role === "part" ? "building:part" : "building"]: "yes", height: "10" },
      role,
    ),
  },
  geometry,
});
const collection = (features) => ({ type: "FeatureCollection", features });

test("a tiny overhang snaps onto and joins the parent boundary without deleting corners", () => {
  const moves = containmentRepair(part, parent);
  assert.equal(moves.length, 2);
  const result = applyContainmentRepair(
    collection([feature("way/1", parent, "building"), feature("way/2", part)]),
    {},
    {},
    moves,
  );
  const fixed = result.geometryEdits["way/2"];
  assert.equal(fixed.geometry.coordinates[0].length, part.coordinates[0].length);
  assert.deepEqual(
    fixed.movedNodes.map(({ from, to }) => ({ from, to })),
    moves,
  );
  assert.equal(result.geometryEdits["way/1"].geometry.coordinates[0].length, 7);
  assert.equal(outsideArea(fixed.geometry, result.geometryEdits["way/1"].geometry), 0);
  assert.equal(containmentRepair(fixed.geometry, result.geometryEdits["way/1"].geometry), null);
});

test("shared owners move together; drawn parts do not acquire upstream node moves", () => {
  const sibling = rectangle(-0.0000004, 0.00002, 0.00005, 0.0001);
  const drawn = feature("way/-1", part);
  const result = applyContainmentRepair(
    collection([
      feature("way/1", parent, "building"),
      feature("way/2", part),
      feature("way/3", sibling),
      drawn,
    ]),
    {},
    { "way/-1": drawn },
    containmentRepair(part, parent),
  );
  assert.deepEqual(
    result.geometryEdits["way/3"].movedNodes.map(({ from, to }) => ({ from, to })),
    [{ from: [-0.0000004, 0.00002], to: [0, 0.00002] }],
  );
  assert.equal(result.geometryEdits["way/-1"], undefined);
  assert.equal(outsideArea(result.createdParts["way/-1"].geometry, parent), 0);
});

test("large or deep protrusions and already-contained parts are not auto-fixed", () => {
  assert.equal(containmentRepair(rectangle(-0.00001, 0, 0.0001, 0.0001), parent), null);
  assert.equal(containmentRepair(rectangle(0.00001, 0.00001, 0.0001, 0.0001), parent), null);
  // Small percentage, but a long sliver exceeds the absolute area limit.
  assert.equal(
    containmentRepair(rectangle(-0.0000004, 0, 0.0001, 0.01), rectangle(0, 0, 0.0002, 0.01)),
    null,
  );
});

test("holes are boundaries too", () => {
  const holed = {
    ...parent,
    coordinates: [
      ...parent.coordinates,
      rectangle(0.00005, 0.00005, 0.00015, 0.00015).coordinates[0],
    ],
  };
  const nearHole = rectangle(0.00001, 0.00006, 0.0000501, 0.00014);
  const moves = containmentRepair(nearHole, holed);
  assert.equal(moves.length, 2);
  assert.ok(moves.every(({ to }) => to[0] === 0.00005));
});

test("validator offers a usable fix snapshot and points to the overhang", () => {
  const result = validateChangeset({
    displayed: collection([feature("way/1", parent, "building"), feature("way/2", part)]),
    plan: {
      nodes: [{ id: -1, action: "create", coordinates: [0, 0] }],
      ways: [],
      relations: [],
      dropped: [],
      issues: [],
      entries: [{ ref: "way/2", tagChanges: [] }],
    },
  });
  const found = result.issues.find((item) => item.check === "part-outside-outline");
  assert.equal(found.fix.kind, "snap-part-to-outline");
  assert.equal(found.fix.partGeometry, containmentGeometryKey(part));
  assert.equal(found.fix.parentGeometry, containmentGeometryKey(parent));
  assert.equal(found.at[0], -0.0000004);
});

test("repair refuses to collapse a shared owner's ring", () => {
  const collapsed = rectangle(-0.0000004, 0.00002, 0, 0.00018);
  assert.equal(
    applyContainmentRepair(
      collection([
        feature("way/1", parent, "building"),
        feature("way/2", part),
        feature("way/3", collapsed),
      ]),
      {},
      {},
      containmentRepair(part, parent),
    ),
    null,
  );
});

test("an earlier move retains its original OSM coordinate", () => {
  const result = applyContainmentRepair(
    collection([feature("way/1", parent, "building"), feature("way/2", part)]),
    {
      "way/2": {
        geometry: part,
        kind: "reshape",
        movedNodes: [{ from: [-0.000001, 0.00002], to: [-0.0000004, 0.00002] }],
      },
    },
    {},
    containmentRepair(part, parent),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.geometryEdits["way/2"].movedNodes[0])), {
    from: [-0.000001, 0.00002],
    to: [0, 0.00002],
  });
});
