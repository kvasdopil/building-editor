import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { validateChangeset } = await import("../../src/lib/osm/validate.ts");
const { normalizeOsmTags } = await import("../../src/lib/osm/parse.ts");

function feature(id, role, tags = {}, offset = 0) {
  return {
    type: "Feature",
    properties: { id, ...normalizeOsmTags(tags, role) },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [offset, 0],
          [offset + 0.001, 0],
          [offset + 0.001, 0.001],
          [offset, 0.001],
          [offset, 0],
        ],
      ],
    },
  };
}
const parent = (tags = {}) => feature("way/1", "building", { building: "yes", ...tags });
const part = (id = "way/2") => feature(id, "part", { "building:part": "yes", height: "12" });
function validate(features, written = ["way/2"]) {
  return validateChangeset({
    displayed: { type: "FeatureCollection", features },
    plan: {
      // One valid planned node prevents the independent empty-changeset error.
      nodes: [{ id: -1, action: "create", coordinates: [0, 0] }],
      ways: [],
      relations: [],
      dropped: [],
      issues: [],
      entries: written.map((ref) => ({ ref, tagChanges: [] })),
    },
  });
}
const parentIssues = (result) =>
  result.issues.filter((issue) => issue.check.startsWith("part-parent-"));

test("a part's own height cannot replace its parent's height", () => {
  const result = validate([parent(), part()]);
  assert.equal(result.submittable, false);
  assert.equal(parentIssues(result).length, 1);
  assert.equal(parentIssues(result)[0].check, "part-parent-missing-height");
  assert.equal(parentIssues(result)[0].level, "error");
  assert.deepEqual(parentIssues(result)[0].entities, ["way/1"]);
  assert.deepEqual(parentIssues(result)[0].fix, {
    kind: "set-tag",
    entity: "way/1",
    key: "height",
    value: "12",
  });
});

test("positive parent height or levels allow upload, including supported length units", () => {
  for (const tags of [{ height: "12" }, { height: "40 ft" }, { "building:levels": "3" }]) {
    const result = validate([parent(tags), part()]);
    assert.deepEqual(parentIssues(result), []);
    assert.equal(result.submittable, true);
  }
});

test("blank, malformed, zero and negative heights do not count", () => {
  for (const tags of [
    { height: "" },
    { height: "unknown" },
    { height: "0" },
    { height: "-1" },
    { "building:levels": "0" },
    { "building:levels": "-1" },
    { min_height: "5", "roof:height": "3" },
  ]) {
    assert.equal(
      parentIssues(validate([parent(tags), part()]))[0].check,
      "part-parent-missing-height",
    );
  }
  for (const height of [NaN, Infinity, -Infinity]) {
    const outline = parent();
    outline.properties.height = height;
    assert.equal(validate([outline, part()]).submittable, false);
  }
});

test("siblings produce one error per parent, including a newly drawn part", () => {
  const result = validate([parent(), part(), part("way/-1")], ["way/2", "way/-1"]);
  assert.equal(parentIssues(result).length, 1);
});

test("missing parent height offers no guessed fix when its parts also lack height", () => {
  const sparse = feature("way/2", "part", { "building:part": "yes" });
  assert.equal(parentIssues(validate([parent(), sparse]))[0].fix, undefined);
});

test("pending parent height additions clear the error and removals restore it", () => {
  const features = [parent(), part()];
  assert.equal(validate(features).submittable, false);
  features[0] = parent({ height: "12" });
  assert.equal(validate(features, ["way/1", "way/2"]).submittable, true);
  features[0] = parent();
  assert.equal(validate(features, ["way/1"]).submittable, false);
});

test("buildings without parts and unrelated loaded building groups are unaffected", () => {
  const unrelated = feature("way/10", "building", { building: "yes" }, 1);
  assert.deepEqual(parentIssues(validate([unrelated], ["way/10"])), []);
  assert.deepEqual(parentIssues(validate([parent(), part(), unrelated], ["way/10"])), []);
});

test("a part without a loaded parent is not accepted as its own parent", () => {
  const result = validate([part()]);
  assert.equal(result.submittable, false);
  assert.equal(parentIssues(result)[0].check, "part-parent-not-found");
  assert.deepEqual(parentIssues(result)[0].entities, ["way/2"]);
});
