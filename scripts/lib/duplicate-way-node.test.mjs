import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { removeGeometryRingNode } = await import("../../src/lib/geometry-edits.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");
const { buildSubmissionReview } = await import("../../src/lib/osm/submission-review.ts");

const parentRing = [
  [0, 0],
  [0.001, 0],
  [0.001, 0.001],
  [0, 0.001],
  [0, 0],
];

function parent() {
  return {
    type: "Feature",
    properties: {
      id: "way/1",
      osm_type: "way",
      osm_id: 1,
      version: 3,
      node_ids: [101, 102, 103, 104, 101],
      node_versions: [1, 1, 1, 1, 1],
      ...normalizeOsmTags({ building: "yes", height: "12" }, "building"),
    },
    geometry: { type: "Polygon", coordinates: [parentRing] },
  };
}

function drawnPart(geometry) {
  return {
    type: "Feature",
    properties: {
      id: "way/-35",
      parent_id: "way/1",
      ...normalizeOsmTags({ "building:part": "yes", height: "12" }, "part"),
    },
    geometry,
  };
}

function review(geometry) {
  const rawParent = parent();
  const part = drawnPart(geometry);
  return buildSubmissionReview({
    input: {
      features: { type: "FeatureCollection", features: [rawParent] },
      tagEdits: {},
      geometryEdits: {},
      createdParts: { "way/-35": part },
    },
    displayed: { type: "FeatureCollection", features: [rawParent, part] },
  });
}

test("a consecutive reused node offers a guarded local Fix", () => {
  const nearExistingNode = [0.0000001, 0];
  const geometry = {
    type: "Polygon",
    coordinates: [[[0, 0], nearExistingNode, [0.0005, 0], [0.0005, 0.0005], [0, 0.0005], [0, 0]]],
  };
  const first = review(geometry);
  const duplicated = first.validation.issues.filter(
    (found) => found.check === "duplicated-way-nodes",
  );

  assert.equal(duplicated.length, 1);
  assert.deepEqual(duplicated[0].entities, ["way/-35"]);
  assert.deepEqual(duplicated[0].fix, {
    kind: "remove-ring-node",
    entity: "way/-35",
    polygonIndex: 0,
    ringIndex: 0,
    nodeIndex: 1,
    coordinate: nearExistingNode,
  });

  const fixed = removeGeometryRingNode(
    geometry,
    duplicated[0].fix.polygonIndex,
    duplicated[0].fix.ringIndex,
    duplicated[0].fix.nodeIndex,
    duplicated[0].fix.coordinate,
  );
  assert.ok(fixed);
  const second = review(fixed);
  assert.equal(
    second.validation.issues.some((found) => found.check === "duplicated-way-nodes"),
    false,
  );
  assert.equal(
    second.plan.ways[0].nodes.some(
      (node, index, nodes) => index > 0 && index < nodes.length - 1 && node === nodes[index - 1],
    ),
    false,
  );
});
