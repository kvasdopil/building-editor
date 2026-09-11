import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { appendHistory, describeEdit, historyStateAt, moveHistoryCursor } =
  await import("../../src/lib/edit-history.ts");

const empty = { edits: {}, geometryEdits: {}, createdParts: {} };

test("history labels identify geometry intent and reverts", () => {
  const cut = {
    ...empty,
    geometryEdits: {
      "way/1": {
        kind: "hole",
        geometry: { type: "Polygon", coordinates: [] },
      },
    },
  };
  assert.equal(describeEdit(empty, cut), "Cut hole");
  assert.equal(describeEdit(cut, empty), "Revert geometry");
});

test("history labels identify tag edits", () => {
  const tagged = {
    ...empty,
    edits: {
      "way/1": { changed: { height: "12" }, original: {}, updatedAt: 1 },
    },
  };
  assert.equal(describeEdit(empty, tagged), "Edit tags");
  assert.equal(describeEdit(tagged, empty), "Revert tags");
});

test("undo and redo restore a compound tag and geometry state", () => {
  const compound = {
    edits: {
      "way/-1": {
        changed: { "building:part": "yes" },
        original: {},
        updatedAt: 1,
      },
    },
    geometryEdits: {
      "way/1": {
        kind: "add-part",
        geometry: { type: "Polygon", coordinates: [] },
      },
    },
    createdParts: {
      "way/-1": {
        type: "Feature",
        id: "way/-1",
        properties: {},
        geometry: { type: "Polygon", coordinates: [] },
      },
    },
  };
  const document = appendHistory(
    { schemaVersion: 1, entries: [], cursor: 0 },
    compound,
    "entry-1",
    1,
  );

  assert.deepEqual(historyStateAt(document, document.cursor), compound);
  const undone = moveHistoryCursor(document, 0);
  assert.deepEqual(historyStateAt(undone, undone.cursor), empty);
  const redone = moveHistoryCursor(undone, 1);
  assert.deepEqual(historyStateAt(redone, redone.cursor), compound);
});

test("editing after undo truncates the redo branch", () => {
  const first = {
    ...empty,
    edits: {
      "way/1": { changed: { height: "12" }, original: {}, updatedAt: 1 },
    },
  };
  const second = {
    ...empty,
    edits: {
      "way/1": { changed: { height: "14" }, original: {}, updatedAt: 2 },
    },
  };
  const replacement = {
    ...empty,
    edits: {
      "way/1": { changed: { height: "10" }, original: {}, updatedAt: 3 },
    },
  };
  let document = appendHistory({ schemaVersion: 1, entries: [], cursor: 0 }, first, "entry-1", 1);
  document = appendHistory(document, second, "entry-2", 2);
  document = moveHistoryCursor(document, 1);
  document = appendHistory(document, replacement, "entry-3", 3);

  assert.equal(document.entries.length, 2);
  assert.equal(document.entries[1].id, "entry-3");
  assert.deepEqual(historyStateAt(document, document.cursor), replacement);
});
