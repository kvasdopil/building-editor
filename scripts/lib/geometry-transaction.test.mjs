import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { planGeometryGesture, planSliceGeometry, geometryTransactionIssue } =
  await import("../../src/lib/geometry-transaction.ts");
const {
  recordNodeMoves,
  recordNodeMove,
  moveSharedGeometryVertex,
  mergeSharedGeometryVertices,
  moveSharedGeometryVertices,
  geometryHasVertex,
  applyGeometryEdits,
} = await import("../../src/lib/geometry-edits.ts");
const { appendHistory, historyStateAt, geometryRevertReason } =
  await import("../../src/lib/edit-history.ts");
const { buildChangeset } = await import("../../src/lib/osm/changeset.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");
const { selectFromOsm } = await import("../../src/lib/osm/select.ts");
const { sliceBuilding } = await import("../../src/lib/slice.ts");
const { coordinateKey } = await import("../../src/lib/osm/precision.ts");

// Synthetic member topology, not a downloaded copy of the reported relation.
const ring = [
  [0, 0],
  [0.001, 0],
  [0.001, 0.001],
  [0, 0.001],
  [0, 0],
];
const nodeIds = [101, 102, 103, 104, 101];
const empty = () => ({ edits: {}, geometryEdits: {}, createdParts: {} });
function fixture(withPart = false) {
  const relation = {
    type: "Feature",
    geometry: { type: "MultiPolygon", coordinates: [[ring]] },
    properties: {
      ...normalizeOsmTags({ building: "yes", type: "multipolygon", height: "10" }, "building"),
      id: "relation/1",
      osm_type: "relation",
      osm_id: 1,
      version: 1,
      members: [{ type: "way", ref: 11, role: "outer" }],
      member_ways: [
        {
          id: 11,
          version: 1,
          role: "outer",
          coordinates: ring,
          nodes: nodeIds,
          node_versions: nodeIds.map(() => 1),
          tags: {},
        },
      ],
    },
  };
  const part = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      ...normalizeOsmTags({ "building:part": "yes", height: "10" }, "part"),
      id: "way/2",
      osm_type: "way",
      osm_id: 2,
      version: 1,
      node_ids: nodeIds,
      node_versions: nodeIds.map(() => 1),
    },
  };
  return { type: "FeatureCollection", features: withPart ? [relation, part] : [relation] };
}
const exportPlan = (features, state) =>
  buildChangeset({
    features,
    tagEdits: state.edits,
    geometryEdits: state.geometryEdits,
    createdParts: state.createdParts,
  });
function drag(features, state, from, to, only) {
  const displayed = applyGeometryEdits(features, state.geometryEdits, state.createdParts);
  const geometries = Object.fromEntries(
    displayed.features
      .filter((f) => (!only || only === f.properties.id) && geometryHasVertex(f.geometry, from))
      .map((f) => [f.properties.id, moveSharedGeometryVertex(f.geometry, from, to)]),
  );
  return {
    ...state,
    ...planGeometryGesture({ features, ...state, geometries, moves: [{ from, to }] }),
  };
}
function slice(features, state) {
  const selection = selectFromOsm(
    applyGeometryEdits(features, state.geometryEdits, state.createdParts),
    "relation/1",
  );
  const result = sliceBuilding(
    selection.building,
    selection.parts,
    [
      [0.0005, 0],
      [0.0005, 0.001],
    ],
    false,
  );
  assert.ok(result, "slice must partition the fixture");
  const planned = planSliceGeometry(state, selection.building, selection.parts, result, 1);
  return {
    edits: state.edits,
    geometryEdits: planned.geometryEdits,
    createdParts: planned.createdParts,
  };
}

test("projection round-off does not split a shared vertex or its move chain", () => {
  const from = [0.001, 0.001];
  const to = [0.002, 0.001];
  const roundTrip = [to[0] + 1e-16, to[1] - 1e-16];
  assert.deepEqual(recordNodeMove([{ from, to }], roundTrip, [0.003, 0.001]), [
    { from, to: [0.003, 0.001] },
  ]);
  assert.deepEqual(recordNodeMove([{ from, to }], roundTrip, from), []);
  const geometry = { type: "Polygon", coordinates: [[to, [0.004, 0], [0.004, 0.004], to]] };
  assert.ok(geometryHasVertex(geometry, roundTrip));
  assert.ok(!geometryHasVertex(moveSharedGeometryVertex(geometry, roundTrip, from), to));
});

test("wall moves compose simultaneously when one destination equals another source", () => {
  const a = [0, 0],
    b = [0.001, 0],
    c = [0.002, 0];
  const old = [
    { from: [-0.001, 0], to: a },
    { from: [0.004, 0], to: b },
  ];
  const result = recordNodeMoves(old, [
    { from: a, to: b },
    { from: b, to: c },
  ]);
  assert.deepEqual(result, [
    { from: [-0.001, 0], to: b },
    { from: [0.004, 0], to: c },
  ]);
});

test("all identities at a merged corner follow a subsequent drag", () => {
  const a = [0, 0],
    b = [0.001, 0],
    c = [0.002, 0];
  const result = recordNodeMoves([{ nodeId: 1, from: a, to: b }], [{ nodeId: 2, from: b, to: c }]);
  assert.deepEqual(result, [
    { nodeId: 1, from: a, to: c },
    { nodeId: 2, from: b, to: c },
  ]);
});

test("slice, shared drag twice, undo/redo, and reload retain one node destination", () => {
  const features = fixture();
  const initial = empty();
  const sliced = slice(features, initial);
  assert.equal(geometryTransactionIssue(features, initial, sliced), null);
  assert.deepEqual(exportPlan(features, sliced).issues, []);
  let history = appendHistory({ schemaVersion: 1, cursor: 0, entries: [] }, sliced, "slice", 1);
  assert.match(geometryRevertReason(history, sliced, "relation/1"), /footprints together/);
  const moved = drag(features, sliced, ring[0], [-0.0001, 0]);
  const twice = drag(features, moved, [-0.0001 + 1e-16, 0], [-0.0002, 0]);
  assert.equal(geometryTransactionIssue(features, moved, twice), null);
  const plan = exportPlan(features, twice);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(
    plan.nodes
      .filter((node) => node.action === "modify")
      .map((node) => [node.id, node.coordinates]),
    [[101, [-0.0002, 0]]],
  );
  assert.ok(
    Object.values(twice.createdParts).some((part) =>
      geometryHasVertex(part.geometry, [-0.0002, 0]),
    ),
  );
  history = appendHistory(history, twice, "drag", 2);
  const restored = JSON.parse(JSON.stringify(history));
  assert.deepEqual(historyStateAt(restored, 0), initial);
  assert.deepEqual(historyStateAt(restored, 1), JSON.parse(JSON.stringify(sliced)));
  assert.deepEqual(exportPlan(features, historyStateAt(restored, 2)), plan);
});

test("slicing an already moved existing part preserves its original OSM node", () => {
  const features = fixture(true);
  const moved = drag(features, empty(), ring[0], [-0.0001, 0]);
  const sliced = slice(features, moved);
  assert.ok(sliced.geometryEdits["way/2"].movedNodes.length);
  assert.deepEqual(exportPlan(features, sliced).issues, []);
  const twice = drag(features, sliced, [-0.0001, 0], [-0.0002, 0]);
  assert.deepEqual(exportPlan(features, twice).issues, []);
  assert.deepEqual(
    exportPlan(features, twice)
      .nodes.filter((node) => node.action === "modify")
      .map((node) => node.id),
    [101],
  );
});

test("a drag after a legacy parent-only revert reconciles the part's old destination", () => {
  const features = fixture(true);
  const moved = drag(features, empty(), ring[0], [-0.0001, 0]);
  const legacy = { ...moved, geometryEdits: { "way/2": moved.geometryEdits["way/2"] } };
  const repaired = drag(features, legacy, ring[0], [-0.0002, 0], "relation/1");
  assert.deepEqual(exportPlan(features, repaired).issues, []);
  for (const override of Object.values(repaired.geometryEdits)) {
    assert.ok(geometryHasVertex(override.geometry, [-0.0002, 0]));
    assert.equal(override.movedNodes[0].nodeId, 101);
  }
});

test("dragging the part after a legacy parent revert materializes the parent node move", () => {
  const features = fixture(true);
  const moved = drag(features, empty(), ring[0], [-0.0001, 0]);
  const legacy = { ...moved, geometryEdits: { "way/2": moved.geometryEdits["way/2"] } };
  const repaired = drag(features, legacy, [-0.0001, 0], [-0.0002, 0], "way/2");
  assert.ok(geometryHasVertex(repaired.geometryEdits["relation/1"].geometry, [-0.0002, 0]));
  assert.deepEqual(exportPlan(features, repaired).issues, []);
});

test("unsupported relation changes are rejected without mutating their input", () => {
  const features = fixture();
  const before = empty();
  const encoded = JSON.stringify(before);
  const after = {
    ...before,
    geometryEdits: {
      "relation/1": {
        kind: "slice",
        geometry: { type: "MultiPolygon", coordinates: [[[ring[0], ring[2], ring[3], ring[0]]]] },
      },
    },
  };
  assert.match(geometryTransactionIssue(features, before, after), /Edit not applied.*multipolygon/);
  assert.equal(JSON.stringify(before), encoded);
});

test("a reversed assembled ring with inserted corners maps back to the member's original direction", () => {
  const features = fixture();
  const after = {
    ...empty(),
    geometryEdits: {
      "relation/1": {
        kind: "slice",
        geometry: {
          type: "MultiPolygon",
          coordinates: [[[ring[0], [0.0005, 0], ...ring.slice(1)].reverse()]],
        },
      },
    },
  };
  assert.equal(geometryTransactionIssue(features, empty(), after), null);
  const plan = exportPlan(features, after);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(
    plan.ways[0].nodes.filter((id) => id > 0),
    nodeIds,
  );
});

test("unrelated pre-existing conflicts do not block edits on a different building", () => {
  const features = fixture();
  const before = {
    ...empty(),
    geometryEdits: {
      "way/999": { kind: "reshape", geometry: { type: "Polygon", coordinates: [ring] } },
    },
  };
  const next = drag(features, before, ring[0], [-0.0001, 0]);
  assert.equal(geometryTransactionIssue(features, before, next), null);
});

test("a wall gesture updates every moved node on a footprint simultaneously", () => {
  const features = fixture(true);
  const moves = [
    { from: ring[0], to: [-0.0001, 0] },
    { from: ring[1], to: [0.0009, 0] },
  ];
  const geometries = Object.fromEntries(
    features.features.map((feature) => [
      feature.properties.id,
      moveSharedGeometryVertices(
        feature.geometry,
        new Map(moves.map((move) => [coordinateKey(move.from), move.to])),
      ),
    ]),
  );
  const after = { ...empty(), ...planGeometryGesture({ features, ...empty(), geometries, moves }) };
  assert.deepEqual(exportPlan(features, after).issues, []);
  assert.equal(
    exportPlan(features, after).nodes.filter((node) => node.action === "modify").length,
    2,
  );
});

test("moving a merged way corner retains its surviving node instead of stacking two nodes", () => {
  const features = fixture(true);
  features.features = [features.features[1]];
  const geometry = mergeSharedGeometryVertices(features.features[0].geometry, ring[0], ring[1]);
  const merged = {
    ...empty(),
    ...planGeometryGesture({
      features,
      ...empty(),
      geometries: { "way/2": geometry },
      moves: [{ from: ring[0], to: ring[1] }],
    }),
  };
  assert.equal(merged.geometryEdits["way/2"].movedNodes[0].targetNodeId, 102);
  const moved = drag(features, merged, ring[1], [0.0011, 0]);
  const plan = exportPlan(features, moved);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(
    plan.nodes.filter((node) => node.action === "modify").map((node) => node.id),
    [102],
  );
  assert.ok(!plan.ways[0].nodes.includes(101));
});

test("missing member data is rejected even when the remaining outer ring is drawable", () => {
  const features = fixture();
  features.features[0].properties.members.push({ type: "way", ref: 999, role: "inner" });
  const after = drag(features, empty(), ring[0], [-0.0001, 0]);
  assert.match(
    geometryTransactionIssue(features, empty(), after),
    /Edit not applied.*multipolygon/,
  );
});

test("a self-crossing reordering of relation anchors is still rejected", () => {
  const features = fixture();
  const after = {
    ...empty(),
    geometryEdits: {
      "relation/1": {
        kind: "reshape",
        geometry: {
          type: "MultiPolygon",
          coordinates: [[[ring[0], ring[2], ring[1], ring[3], ring[0]]]],
        },
      },
    },
  };
  assert.match(
    geometryTransactionIssue(features, empty(), after),
    /Edit not applied.*multipolygon/,
  );
});

test("isolated geometry reverts and tag-only edits remain available", () => {
  const features = fixture();
  const after = drag(features, empty(), ring[0], [-0.0001, 0]);
  const history = appendHistory({ schemaVersion: 1, entries: [], cursor: 0 }, after, "drag", 1);
  assert.equal(geometryRevertReason(history, after, "relation/1"), null);
  assert.equal(
    geometryRevertReason(history, { ...empty(), edits: { "relation/1": {} } }, "relation/1"),
    null,
  );
});

test("preflight rejects two explicit destinations for the same node", () => {
  const features = fixture(true);
  const after = drag(features, empty(), ring[0], [-0.0001, 0]);
  after.geometryEdits["way/2"] = {
    ...after.geometryEdits["way/2"],
    movedNodes: [{ nodeId: 101, from: ring[0], to: [-0.0002, 0] }],
  };
  assert.match(geometryTransactionIssue(features, empty(), after), /two different places/);
});

test("an unrelated gesture does not silently resolve a legacy move conflict", () => {
  const previous = [
    { nodeId: 101, from: ring[0], to: [-0.0001, 0] },
    { nodeId: 101, from: ring[0], to: [-0.0002, 0] },
  ];
  assert.equal(recordNodeMoves(previous, []).length, 2);
  const explicit = recordNodeMoves(previous, [
    { nodeId: 101, from: [-0.0002, 0], to: [-0.0003, 0] },
  ]);
  assert.deepEqual(explicit, [{ nodeId: 101, from: ring[0], to: [-0.0003, 0] }]);
});

test("a simultaneous translation does not merge into a node leaving its old position", () => {
  const features = fixture(true);
  features.features = [features.features[1]];
  const moves = ring.slice(0, -1).map((from) => ({ from, to: [from[0] + 0.001, from[1]] }));
  const geometry = moveSharedGeometryVertices(
    features.features[0].geometry,
    new Map(moves.map((move) => [coordinateKey(move.from), move.to])),
  );
  const state = {
    ...empty(),
    ...planGeometryGesture({ features, ...empty(), geometries: { "way/2": geometry }, moves }),
  };
  const plan = exportPlan(features, state);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.mergedNodes, 0);
  assert.equal(plan.nodes.filter((node) => node.action === "modify").length, 4);
  assert.equal(plan.ways.length, 0);
});

test("a complete wall move repairs both parent corners after a legacy parent revert", () => {
  const features = fixture(true);
  const moved = drag(
    features,
    drag(features, empty(), ring[0], [-0.0001, 0]),
    ring[1],
    [0.0009, 0],
  );
  const legacy = { ...moved, geometryEdits: { "way/2": moved.geometryEdits["way/2"] } };
  const moves = [
    { from: [-0.0001, 0], to: [-0.0002, 0] },
    { from: [0.0009, 0], to: [0.0008, 0] },
  ];
  const geometry = moveSharedGeometryVertices(
    legacy.geometryEdits["way/2"].geometry,
    new Map(moves.map((move) => [coordinateKey(move.from), move.to])),
  );
  const state = {
    ...legacy,
    ...planGeometryGesture({ features, ...legacy, geometries: { "way/2": geometry }, moves }),
  };
  assert.ok(geometryHasVertex(state.geometryEdits["relation/1"].geometry, [-0.0002, 0]));
  assert.ok(geometryHasVertex(state.geometryEdits["relation/1"].geometry, [0.0008, 0]));
  assert.deepEqual(exportPlan(features, state).issues, []);
});
