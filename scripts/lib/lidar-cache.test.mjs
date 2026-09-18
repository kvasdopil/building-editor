import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-hooks.mjs", import.meta.url);
const { cachedLidarCloud, fetchLidarCloud } = await import("../../src/lib/lidar.ts");
const { emptyTile, encodeTile } = await import("../../src/lib/lidar-format.ts");
const { tileBounds } = await import("../../src/lib/osm/tiles.ts");

/** A square footprint of about 20 m, the smallest thing worth selecting. */
function building(lon, lat, id) {
  return {
    id,
    properties: {},
    polygons: [
      {
        outer: [
          [lon, lat],
          [lon + 0.0003, lat],
          [lon + 0.0003, lat + 0.0002],
          [lon, lat + 0.0002],
          [lon, lat],
        ],
        holes: [],
      },
    ],
  };
}

const A = building(18.0, 59.32, "a");
const NEIGHBOUR = building(18.0004, 59.3202, "b");
const FAR = building(12.0, 57.7, "far");

let requests = [];
let pointsPerTile = 1000;

/** Points spread evenly over the tile, so any building's box keeps some. */
function denseTile(tile) {
  const [west, south, east, north] = tileBounds(tile);
  const lon = [];
  const lat = [];
  const z = [];
  const colour = [];
  const classification = [];
  const across = 40;
  const down = Math.ceil(pointsPerTile / across);
  for (let i = 0; i < pointsPerTile; i++) {
    lon.push(west + ((i % across) / across) * (east - west));
    lat.push(south + (Math.floor(i / across) / down) * (north - south));
    z.push(10 + (i % 7));
    colour.push(0xffff);
    classification.push(i % 5 === 0 ? 2 : 6);
  }
  return encodeTile({ lon, lat, z, colour, classification }, [west, south, east, north], 0);
}

globalThis.fetch = async (url, init) => {
  if (init?.signal?.aborted) throw new Error("aborted");
  requests.push(url);
  const [, , route, , z, x, y] = url.split("/");
  const bytes =
    route === "lidar" ? denseTile({ z: Number(z), x: Number(x), y: Number(y) }) : emptyTile();
  return new Response(bytes, { status: 200 });
};

test("a neighbour inside the same tiles is served without reading them again", async () => {
  requests = [];
  const first = await fetchLidarCloud(A);
  assert.ok(first && first.count > 0);
  assert.ok(requests.length > 0, "the first building reads its tiles");

  requests = [];
  const second = await fetchLidarCloud(NEIGHBOUR);
  assert.ok(second && second.count > 0);
  assert.equal(requests.length, 0, "the neighbour reads nothing");

  // The synchronous path is what keeps the dots in the first frame of the
  // neighbour's scene instead of clearing them for the length of a read.
  const cached = cachedLidarCloud(NEIGHBOUR);
  assert.ok(cached && cached.count === second.count);
  assert.equal(requests.length, 0);
  assert.equal(cachedLidarCloud(FAR), null, "an unread area is not claimed as cached");
});

test("an abandoned read is not remembered as an empty area", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await fetchLidarCloud(FAR, controller.signal), null);
  assert.equal(cachedLidarCloud(FAR), null);

  requests = [];
  const retried = await fetchLidarCloud(FAR);
  assert.ok(requests.length > 0, "the area is read rather than answered from a poisoned cache");
  assert.ok(retried && retried.count > 0);
});

test("the least recently used tiles are dropped past the budget", async () => {
  // Real tiles hold hundreds of thousands of points; these are sized so that a
  // few far-apart areas pass the four-million-point budget.
  pointsPerTile = 1_200_000;
  for (const [lon, lat] of [
    [13.0, 55.6],
    [11.97, 57.7],
    [17.64, 59.86],
    [12.69, 56.05],
  ]) {
    const cloud = await fetchLidarCloud(building(lon, lat, `${lon}`));
    assert.ok(cloud && cloud.count > 0);
  }
  assert.equal(cachedLidarCloud(A), null, "the oldest area was dropped");

  requests = [];
  pointsPerTile = 1000;
  const reread = await fetchLidarCloud(A);
  assert.ok(requests.length > 0, "and is read again when it is looked at");
  assert.ok(reread && reread.count > 0);
});

test("selecting the same building over and over reads and remembers it once", async () => {
  // Its own area, because the tests above leave theirs cached.
  const repeated = building(13.19, 55.7, "repeated");
  requests = [];
  const first = await fetchLidarCloud(repeated);
  const reads = requests.length;
  assert.ok(reads > 0);

  requests = [];
  for (let i = 0; i < 50; i++) {
    const again = await fetchLidarCloud(repeated);
    assert.equal(again.count, first.count);
  }
  assert.equal(requests.length, 0, "every later selection is a hit");

  // A hit must not be re-counted against the budget: if it were, the area would
  // evict itself and start reading again.
  assert.ok(cachedLidarCloud(repeated), "the building is still cached after fifty visits");
});

test("areas with no points cannot accumulate entries forever", async () => {
  pointsPerTile = 0;
  const empty = building(20.0, 63.0, "empty");
  requests = [];
  assert.equal(await fetchLidarCloud(empty), null);
  const reads = requests.length;
  assert.ok(reads > 0);

  requests = [];
  assert.equal(await fetchLidarCloud(empty), null);
  assert.equal(requests.length, 0, "an empty answer is remembered");

  // Empty tiles weigh nothing against the point budget, so only the entry cap
  // can bound them.
  for (let i = 0; i < 300; i++) {
    await fetchLidarCloud(building(20.0 + i * 0.02, 63.0, `empty-${i}`));
  }
  requests = [];
  assert.equal(await fetchLidarCloud(empty), null);
  assert.equal(requests.length, reads, "the oldest empty area was evicted, not kept forever");
  pointsPerTile = 1000;
});
