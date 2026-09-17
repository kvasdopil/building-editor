import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { canIgnoreIssue, issue } = await import("../../src/lib/osm/issues.ts");

test("a written part outside its outline can be explicitly accepted", () => {
  assert.equal(
    canIgnoreIssue(
      issue("error", "part-outside-outline", "outside", ["way/75120309", "way/715073073"]),
    ),
    true,
  );
  assert.equal(canIgnoreIssue(issue("warning", "part-outside-outline", "outside", [])), false);
});

test("ignoring quality findings does not bypass upload prerequisites", () => {
  for (const check of [
    "changeset-comment-missing",
    "changeset-empty",
    "changeset-too-large",
    "missing-version",
    "element-not-loaded",
    "relation-geometry-unsupported",
    "degenerate-ring",
    "way-too-many-nodes",
    "unknown-future-check",
  ]) {
    assert.equal(canIgnoreIssue(issue("error", check, "blocked", [])), false, check);
  }
});
