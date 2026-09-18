import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
register("./ts-hooks.mjs", import.meta.url);
const { addPartToBuilding } = await import("../../src/lib/add-part.ts");
const { OsmBuildingLookup } = await import("../../src/lib/osm/building-lookup.ts");
const { buildChangeset } = await import("../../src/lib/osm/changeset.ts");
const { createPartFeature } = await import("../../src/lib/geometry-edits.ts");
const { geometryTransactionIssue } = await import("../../src/lib/geometry-transaction.ts");
const { createTileLoader } = await import("../../src/lib/osm/client.ts");
const { mergeTileReads } = await import("../../src/lib/osm/parse.ts");
const { default: area } = await import("@turf/area");
const { default: intersect } = await import("@turf/intersect");
const { feature, featureCollection } = await import("@turf/helpers");
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/add-part-relation-29065.json", import.meta.url)),
);
const group = new OsmBuildingLookup(fixture).select("way/1560006185");
const rawParent = fixture.features.find((f) => f.properties.id === group.building.id);
const empty = { edits: {}, geometryEdits: {}, createdParts: {} };
const beside = [
  [18.057761, 59.309228],
  [18.05777212, 59.309231572499996],
  [18.05776324, 59.309235144999995],
];
const across = [
  [18.05775652, 59.30921371],
  [18.057790999999998, 59.309228000000004],
  [18.05776548, 59.30924229],
];
function stateFor(result) {
  return {
    ...empty,
    geometryEdits: { [group.building.id]: { kind: "add-part", geometry: result.outline } },
    createdParts: {
      "way/-1": createPartFeature(
        "way/-1",
        group.building.id,
        result.addition.geometry,
        result.addition.tags,
      ),
    },
  };
}
function planFor(state, features = fixture) {
  return buildChangeset({
    features,
    tagEdits: state.edits,
    geometryEdits: state.geometryEdits,
    createdParts: state.createdParts,
  });
}
for (const reverse of [false, true])
  for (const { name, nodes } of [
    { name: "beside", nodes: beside },
    { name: "across", nodes: across },
  ]) {
    test(`small three-point addition ${name} the entrance, ${reverse ? "reverse" : "forward"}`, () => {
      const result = addPartToBuilding(
        group.building,
        group.parts.length,
        reverse ? [...nodes].reverse() : nodes,
      );
      assert.ok(result);
      assert.equal(result.base, null);
      const added = feature(result.addition.geometry),
        outline = feature(result.outline);
      assert.ok(Math.abs(area(outline) - area(rawParent) - area(added)) < 0.01);
      const overlap = intersect(featureCollection([rawParent, added]));
      assert.ok(!overlap || area(overlap) < 0.01);
      const after = stateFor(result);
      assert.equal(geometryTransactionIssue(fixture, empty, after), null);
      const plan = planFor(after);
      assert.ok(!plan.issues.some((i) => i.check === "relation-geometry-unsupported"));
      const outer = plan.ways.find((way) => way.id === 285255957);
      assert.ok(outer);
      // The original distant A-B-A backtrack must survive; it is not this edit.
      const original = rawParent.properties.member_ways.find((m) => m.id === outer.id);
      for (const id of original.nodes) {
        if (name === "across" && id === 1659654334) continue;
        assert.equal(
          outer.nodes.filter((n) => n === id).length,
          original.nodes.filter((n) => n === id).length,
        );
      }
      assert.ok(plan.ways.find((way) => way.ref === "way/-1").nodes.includes(1659654334));
      assert.ok(!plan.nodes.some((node) => node.id === 1659654334));
    });
  }

test("removing a relation anchor without retaining it on the new part stays blocked", () => {
  const result = addPartToBuilding(group.building, group.parts.length, across);
  const state = stateFor(result);
  state.createdParts = {};
  assert.match(geometryTransactionIssue(fixture, empty, state), /Edit not applied/);
});

test("inside, detached, self-crossing and point-only additions remain invalid", () => {
  const building = {
    id: "b",
    properties: { building: "yes" },
    polygons: [
      {
        outer: [
          [0, 0],
          [0.001, 0],
          [0.001, 0.001],
          [0, 0.001],
          [0, 0],
        ],
        holes: [],
      },
    ],
  };
  for (const nodes of [
    [
      [0, 0.0002],
      [0.0002, 0.0003],
      [0, 0.0004],
    ],
    [
      [-0.0002, 0.0002],
      [-0.0003, 0.0003],
      [-0.0002, 0.0004],
    ],
    [
      [0, 0.0002],
      [-0.0002, 0.0004],
      [-0.0002, 0.0002],
      [0, 0.0004],
    ],
    [
      [0, 0.0002],
      [-0.0002, 0.0003],
      [0, 0.0002],
    ],
  ])
    assert.equal(addPartToBuilding(building, 0, nodes), null);
});

test("the first addition creates a base and preserves collinear boundary nodes", () => {
  const outer = [
    [0, 0],
    [0.001, 0],
    [0.001, 0.0005],
    [0.001, 0.001],
    [0, 0.001],
    [0, 0],
  ];
  const b = { id: "b", properties: { building: "yes" }, polygons: [{ outer, holes: [] }] };
  const result = addPartToBuilding(b, 0, [
    [0, 0.0002],
    [-0.0001, 0.0003],
    [0, 0.0004],
  ]);
  assert.ok(result?.base);
  assert.deepEqual(result.base.geometry.coordinates[0][0], outer);
  for (const p of outer)
    assert.ok(
      result.outline.coordinates[0][0].some((q) => JSON.stringify(q) === JSON.stringify(p)),
    );
});

test("loader completes a selected relation once and rejects incomplete full reads", async (t) => {
  let requests = 0,
    latest;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return { ok: true, json: async () => fixture };
  });
  const loader = createTileLoader((features) => {
    latest = features;
  });
  await Promise.all([
    loader.ensureCompleteRelation("relation/29065"),
    loader.ensureCompleteRelation("relation/29065"),
  ]);
  assert.equal(requests, 1);
  await loader.ensureCompleteRelation("relation/29065");
  assert.equal(requests, 1);
  assert.equal(latest.features[0].properties.member_ways.length, 6);
  loader.stop();
  const incomplete = structuredClone(fixture);
  incomplete.features[0].properties.member_ways.pop();
  globalThis.fetch = async () => ({ ok: true, json: async () => incomplete });
  const broken = createTileLoader(() => assert.fail("incomplete data must not be published"));
  await assert.rejects(broken.ensureCompleteRelation("relation/29065"), /incomplete/);
  broken.stop();
});

test("late partial tile reads cannot downgrade completed relations or member ways", () => {
  const stale = structuredClone(rawParent);
  stale.properties.member_ways = stale.properties.member_ways.slice(0, 1);
  stale.properties.member_ways[0].version--;
  const merged = mergeTileReads(rawParent, stale);
  assert.equal(merged.properties.member_ways.length, 6);
  assert.equal(
    merged.properties.member_ways[0].version,
    rawParent.properties.member_ways[0].version,
  );
  stale.properties.version--;
  assert.equal(mergeTileReads(rawParent, stale), rawParent);
});
