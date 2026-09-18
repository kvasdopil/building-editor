import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { sliceBuilding } = await import("../../src/lib/slice.ts");

const element = (id, role, outer, holes = []) => ({
  id,
  role,
  polygons: [{ outer, holes }],
  properties: role === "building" ? { building: "yes" } : { "building:part": "yes" },
});

const outer = [
  [0, 0],
  [0.0001, 0],
  [0.0001, 0.0001],
  [0, 0.0001],
  [0, 0],
];
const buildingHole = [
  [0.00002, 0.00002],
  [0.00002, 0.00008],
  [0.00008, 0.00008],
  [0.00008, 0.00002],
  [0.00002, 0.00002],
];
const partHole = [
  [0.00003, 0.00003],
  [0.00003, 0.00007],
  [0.00007, 0.00007],
  [0.00007, 0.00003],
  [0.00003, 0.00003],
];

test("an open slice may follow a part courtyard that differs from the parent hole", () => {
  const building = element("way/1", "building", outer, [buildingHole]);
  const part = element("relation/2", "part", outer, [partHole]);
  const result = sliceBuilding(
    building,
    [part],
    [
      [0.00005, 0.0001],
      [0.00005, 0.00007],
      [0.00007, 0.00007],
      [0.0001, 0.00005],
    ],
    false,
  );

  assert.ok(result);
  assert.ok(result.replacements[part.id]);
  assert.equal(result.additions.length, 1);
});

test("a closed tower loop must still stay inside the parent building", () => {
  const building = element("way/1", "building", outer, [buildingHole]);
  const part = element("relation/2", "part", outer, [partHole]);
  const result = sliceBuilding(
    building,
    [part],
    [
      [0.000025, 0.00004],
      [0.000025, 0.00006],
      [0.000029, 0.00005],
    ],
    true,
  );

  assert.equal(result, null);
});

const { readFile } = await import("node:fs/promises");
const { default: area } = await import("@turf/area");
const { default: intersect } = await import("@turf/intersect");
const { feature, featureCollection } = await import("@turf/helpers");
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/slice-relation-29065.json", import.meta.url)),
);
const asFeature = (element) =>
  feature({
    type: "MultiPolygon",
    coordinates: element.polygons.map((p) => [p.outer, ...p.holes]),
  });

function assertPartition(original, pieces) {
  const features = pieces.map((geometry) => feature(geometry));
  const originalArea = area(original);
  assert.ok(
    Math.abs(features.reduce((sum, f) => sum + area(f), 0) - originalArea) < 0.01,
    "area is conserved",
  );
  for (let i = 0; i < features.length; i++) {
    const clipped = intersect(featureCollection([original, features[i]]));
    assert.ok(
      clipped && Math.abs(area(clipped) - area(features[i])) < 0.01,
      "pieces stay in the source",
    );
    for (let j = 0; j < i; j++) {
      const overlap = intersect(featureCollection([features[i], features[j]]));
      assert.ok(!overlap || area(overlap) < 0.01, "pieces do not overlap");
    }
  }
}

for (const reverse of [false, true]) {
  test(`reported corner 3–5 cut works ${reverse ? "backwards" : "forwards"}`, () => {
    const nodes = [
      [18.0575781, 59.308892],
      [18.0576822, 59.3089765],
    ];
    const result = sliceBuilding(
      fixture.building,
      fixture.parts,
      reverse ? nodes.reverse() : nodes,
      false,
    );
    assert.ok(result?.replacements["way/1560006184"]);
    const original = asFeature(fixture.parts.find((p) => p.id === "way/1560006184"));
    const matching = result.additions.filter((p) => {
      const overlap = intersect(featureCollection([original, feature(p.geometry)]));
      return overlap && area(overlap) > 0.01;
    });
    assert.equal(matching.length, 1);
    assertPartition(original, [result.replacements["way/1560006184"], matching[0].geometry]);
  });

  test(`a cut ending where a courtyard touches the exterior works ${reverse ? "backwards" : "forwards"}`, () => {
    const part = fixture.parts.find((p) => p.id === "relation/21407689");
    const nodes = [
      [18.0547202, 59.3090995],
      [18.0559872, 59.3097142],
    ];
    // Isolate this footprint so all additions must belong to the split part.
    const result = sliceBuilding(
      { ...part, id: "building" },
      [part],
      reverse ? nodes.reverse() : nodes,
      false,
    );
    assert.ok(result?.replacements[part.id]);
    assert.equal(result.additions.length, 1);
    assertPartition(asFeature(part), [
      result.replacements[part.id],
      ...result.additions.map((p) => p.geometry),
    ]);
  });
}

const rectangle = (x0, y0, x1, y1) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ].map(([x, y]) => [x / 100000, y / 100000]);

test("a cut ending inside another part must not continue through that part", () => {
  const building = element("b", "building", rectangle(0, 0, 20, 20));
  const part = element("p", "part", rectangle(0, 0, 10, 20));
  const result = sliceBuilding(
    building,
    [part],
    [
      [0, 0.0001],
      [0.0001, 0.0001],
    ],
    false,
  );
  assert.ok(result?.replacements.p);
  assert.equal(result.additions.length, 2);
  assertPartition(asFeature(building), [
    result.replacements.p,
    ...result.additions.map((p) => p.geometry),
  ]);
});

test("a finite cut does not split an untouched island of a multipart part", () => {
  const building = element("b", "building", rectangle(0, 0, 30, 20));
  const part = element("p", "part", rectangle(0, 0, 10, 20));
  part.polygons.push({ outer: rectangle(20, 0, 30, 20), holes: [] });
  assert.equal(
    sliceBuilding(
      building,
      [part],
      [
        [0, 0.0001],
        [0.00005, 0.0001],
      ],
      false,
    ),
    null,
  );
});

test("an unrelated multipart part is not treated as newly divided", () => {
  const building = element("b", "building", rectangle(0, 0, 30, 20));
  const part = element("p", "part", rectangle(0, 0, 10, 5));
  part.polygons.push({ outer: rectangle(20, 0, 30, 5), holes: [] });
  const result = sliceBuilding(
    building,
    [part],
    [
      [0, 0.0001],
      [0.0003, 0.0001],
    ],
    false,
  );
  assert.ok(result);
  assert.equal(result.replacements.p, undefined);
});

test("coverage may switch between the outline and an overhanging part", () => {
  const building = element("b", "building", rectangle(0, 0, 10, 10));
  const part = element("p", "part", rectangle(5, 0, 15, 10));
  assert.ok(
    sliceBuilding(
      building,
      [part],
      [
        [0, 0.00005],
        [0.00015, 0.00005],
      ],
      false,
    ),
  );
});

test("a cut cannot jump an uncovered gap or a courtyard", () => {
  const building = element("b", "building", rectangle(0, 0, 10, 10));
  const part = element("p", "part", rectangle(11, 0, 20, 10));
  assert.equal(
    sliceBuilding(
      building,
      [part],
      [
        [0, 0.00005],
        [0.0002, 0.00005],
      ],
      false,
    ),
    null,
  );
  const courtyard = element("c", "building", outer, [buildingHole]);
  assert.equal(
    sliceBuilding(
      courtyard,
      [],
      [
        [0, 0.00005],
        [0.0001, 0.00005],
      ],
      false,
    ),
    null,
  );
});

test("a boundary-only path explains that it does not divide an area", () => {
  let message;
  assert.equal(
    sliceBuilding(element("b", "building", outer), [], [outer[0], outer[1]], false, (reason) => {
      message = reason;
    }),
    null,
  );
  assert.match(message, /does not divide/);
});

test("splitting one island does not extend the cut into a second island", () => {
  const part = element("p", "part", rectangle(0, 0, 10, 20));
  part.polygons.push({ outer: rectangle(20, 0, 30, 20), holes: [] });
  const result = sliceBuilding(
    { ...part, id: "b" },
    [part],
    [
      [0, 0.0001],
      [0.0001, 0.0001],
    ],
    false,
  );
  assert.ok(result?.replacements.p);
  const pieces = [result.replacements.p, ...result.additions.map((p) => p.geometry)];
  assert.equal(pieces.length, 3);
  assertPartition(asFeature(part), pieces);
  const secondIsland = asFeature({ polygons: [part.polygons[1]] });
  assert.equal(
    pieces.filter((geometry) => {
      const overlap = intersect(featureCollection([secondIsland, feature(geometry)]));
      return overlap && area(overlap) > 0.01;
    }).length,
    1,
  );
});
