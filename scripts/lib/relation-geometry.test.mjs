import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { buildChangeset } = await import("../../src/lib/osm/changeset.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");

const first = [
  [0, 0],
  [0.001, 0],
  [0.001, 0.001],
  [0, 0.001],
  [0, 0],
];
const second = [
  [0.002, 0],
  [0.003, 0],
  [0.003, 0.001],
  [0.002, 0.001],
  [0.002, 0],
];

const member = (id, nodes, coordinates) => ({
  id,
  version: 2,
  role: "outer",
  nodes,
  coordinates,
  node_versions: nodes.map(() => 1),
  tags: {},
});

function relation() {
  const members = [
    member(11, [101, 102, 103, 104, 101], first),
    member(12, [201, 202, 203, 204, 201], second),
  ];
  return {
    type: "Feature",
    id: "relation/1",
    geometry: { type: "MultiPolygon", coordinates: [[first], [second]] },
    properties: {
      ...normalizeOsmTags({ type: "multipolygon", building: "yes" }, "building"),
      id: "relation/1",
      osm_type: "relation",
      osm_id: 1,
      version: 4,
      members: members.map(({ id, role }) => ({ type: "way", ref: id, role })),
      member_ways: members,
    },
  };
}

test("relation rings are mapped by node anchors when polygon order changes", () => {
  const raw = relation();
  const editedSecond = [second[0], [0.0025, 0], ...second.slice(1)];
  const plan = buildChangeset({
    features: { type: "FeatureCollection", features: [raw] },
    tagEdits: {},
    geometryEdits: {
      "relation/1": {
        kind: "add-node",
        geometry: { type: "MultiPolygon", coordinates: [[editedSecond], [first]] },
      },
    },
    createdParts: {},
  });

  assert.equal(
    plan.issues.some((issue) => issue.check === "relation-geometry-unsupported"),
    false,
  );
  assert.deepEqual(
    plan.ways.map((way) => way.ref),
    ["way/12"],
  );
  assert.equal(plan.ways[0].nodes.length, 6);
});

test("relation/1658671-shaped geometry survives reordered inner rings", () => {
  const outer = [
    [0, 0],
    [0.004, 0],
    [0.004, 0.004],
    [0, 0.004],
    [0, 0],
  ];
  const firstInner = [
    [0.0005, 0.0005],
    [0.0015, 0.0005],
    [0.0015, 0.0015],
    [0.0005, 0.0015],
    [0.0005, 0.0005],
  ];
  const secondInner = [
    [0.0025, 0.0025],
    [0.0035, 0.0025],
    [0.0035, 0.0035],
    [0.0025, 0.0035],
    [0.0025, 0.0025],
  ];
  const members = [
    { ...member(103210686, [1, 2, 3, 4, 1], outer), role: "outer" },
    { ...member(103210681, [11, 12, 13, 14, 11], firstInner), role: "inner" },
    { ...member(103210683, [21, 22, 23, 24, 21], secondInner), role: "inner" },
  ];
  const raw = {
    type: "Feature",
    id: "relation/1658671",
    geometry: { type: "MultiPolygon", coordinates: [[outer, firstInner, secondInner]] },
    properties: {
      ...normalizeOsmTags({ type: "multipolygon", building: "office" }, "building"),
      id: "relation/1658671",
      osm_type: "relation",
      osm_id: 1658671,
      version: 5,
      members: members.map(({ id, role }) => ({ type: "way", ref: id, role })),
      member_ways: members,
    },
  };
  const editedInner = [secondInner[0], [0.003, 0.0025], ...secondInner.slice(1)];
  const plan = buildChangeset({
    features: { type: "FeatureCollection", features: [raw] },
    tagEdits: {},
    geometryEdits: {
      "relation/1658671": {
        kind: "add-node",
        geometry: { type: "MultiPolygon", coordinates: [[outer, editedInner, firstInner]] },
      },
    },
    createdParts: {},
  });

  assert.equal(
    plan.issues.some((issue) => issue.check === "relation-geometry-unsupported"),
    false,
  );
  assert.deepEqual(
    plan.ways.map((way) => way.ref),
    ["way/103210683"],
  );
});
