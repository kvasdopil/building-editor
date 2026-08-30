/**
 * Read a building's roof from the laser and print what it says about `height`,
 * `roof:height` and `roof:shape` — the same measurement the side panel shows,
 * without opening the app.
 *
 *   node scripts/roof-advice.mjs way/123456 relation/78 …
 *   node scripts/roof-advice.mjs --bbox 18.095,59.301,18.115,59.309
 *
 * Every element it can measure prints the laser value beside the OSM tag and
 * the difference between them, so a run over an area with well-tagged roofs is
 * a scoring pass: the summary at the end is the error against those tags.
 *
 *   --bbox w,s,e,n   every building in the box instead of named ids
 *   --all            in a box, include buildings with none of the three tags
 *   --no-parts       skip the building:parts of each building
 *   --json           the same results as JSON, for further processing
 *   --png <dir>      write each building's surface grid there as a PNG
 *
 * It reaches the same two upstreams the server does, through the same limiter
 * and the same `.cache` — OSM for geometry and tags, Lantmäteriet's Laserdata
 * Skog for the points — so the first run over an area is slow and the rest are
 * not, and warming the cache here warms it for the dev server too. Imported
 * Stockholm tiles under `data/lidar` are read when they exist, as in the app.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { encodePng } from "./lib/png.mjs";

register("./lib/ts-hooks.mjs", import.meta.url);

// Hipped roofs are built by a CGAL/Wasm engine that expects a browser. It runs
// under Node once the two globals it looks for exist, and without it that shape
// silently builds as a pyramid and is never fitted under its own name.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

// The Geotorget credential the laser reads need lives in .env, like the server's.
try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch {
  // No .env: the laser read will report the missing credential itself.
}

const [
  { default: area },
  { osmToBuildings },
  { OsmBuildingLookup },
  { fetchUpstream },
  { isFresh, readCachedTile, writeCachedTile },
  { OSM_TILE_SCHEMA, tileBounds, tilesForBounds },
  { cloudBounds, mergeTiles },
  { decodeTile, encodeTile },
  { cachedBlob },
  { skogPointsForBounds },
  { buildSurfaceGrid, surfaceGridImage },
  { roofAdviceFor },
  { lod1TilesFor, matchLod1, suggestionsFor },
  { localTilePath },
  { initializeHippedRoofGeometry },
  { elementBounds, elementFeature, padBounds },
] = await Promise.all([
  import("@turf/area"),
  import("../src/lib/osm/parse.ts"),
  import("../src/lib/osm/building-lookup.ts"),
  import("../src/lib/osm/limiter.ts"),
  import("../src/lib/osm/cache.ts"),
  import("../src/lib/osm/tiles.ts"),
  import("../src/lib/lidar.ts"),
  import("../src/lib/lidar-format.ts"),
  import("../src/lib/skog/cache.ts"),
  import("../src/lib/skog/copc.ts"),
  import("../src/lib/surface-grid.ts"),
  import("../src/lib/roof-advice.ts"),
  import("../src/lib/lod1.ts"),
  import("../src/lib/local-data.ts"),
  import("../src/lib/roofs.ts"),
  import("../src/lib/geometry.ts"),
]);

if (!(await initializeHippedRoofGeometry())) {
  console.error("warning: hipped roof geometry unavailable, that shape will not be offered");
}

const OSM_API = process.env.OSM_API_BASE ?? "https://api.openstreetmap.org";

/** The tags this tool measures, in the order they are printed. */
const KEYS = ["height", "roof:height", "roof:shape"];

/** How far past an element to look for its parts and its parent outline. */
const NEIGHBOURHOOD_M = 30;

/** Buildings measured at once. The laser reads dominate, and they are I/O. */
const CONCURRENCY = 4;

/** Half-metre cells need magnifying before a roof is legible on screen. */
const PNG_SCALE = 6;

// ----------------------------------------------------------------- arguments

function parseCommandLine(argv) {
  const options = { ids: [], bbox: null, parts: true, all: false, json: false, png: null };
  for (const argument of argv.slice(2)) {
    if (argument === "--no-parts") options.parts = false;
    else if (argument === "--all") options.all = true;
    else if (argument === "--json") options.json = true;
    else if (argument.startsWith("--bbox=")) options.bbox = argument.slice(7);
    else if (argument.startsWith("--png=")) options.png = argument.slice(6);
    else if (options.png === "") options.png = argument;
    else if (argument === "--png") options.png = "";
    else if (options.bbox === "") options.bbox = argument;
    else if (argument === "--bbox") options.bbox = "";
    else if (/^(way|relation)\/\d+$/.test(argument)) options.ids.push(argument);
    else throw new Error(`Unexpected argument "${argument}"`);
  }
  if (options.bbox) {
    const numbers = options.bbox.split(",").map(Number);
    if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) {
      throw new Error("--bbox wants west,south,east,north in degrees");
    }
    options.bbox = numbers;
  }
  return options;
}

// ----------------------------------------------------------------------- OSM

/**
 * A cached OSM read, sharing the dev server's cache keys so the two warm each
 * other. Freshness is the cache's own rule; a stale entry is simply re-read.
 */
async function cachedFeatures(key, url) {
  const cached = await readCachedTile(key);
  if (cached && isFresh(cached)) return cached.data;
  const parsed = JSON.parse(await fetchUpstream(url));
  return (await writeCachedTile(key, osmToBuildings(parsed))).data;
}

function osmTile(tile) {
  const bbox = tileBounds(tile)
    .map((value) => value.toFixed(7))
    .join(",");
  return cachedFeatures(
    [OSM_TILE_SCHEMA, String(tile.z), String(tile.x), String(tile.y)],
    `${OSM_API}/api/0.6/map.json?bbox=${bbox}`,
  );
}

function osmElement(id) {
  const [type, number] = id.split("/");
  return cachedFeatures(
    [OSM_TILE_SCHEMA, "element", type, number],
    `${OSM_API}/api/0.6/${type}/${number}/full.json`,
  );
}

function mergeCollections(collections) {
  const features = new Map();
  for (const collection of collections) {
    for (const feature of collection.features) features.set(feature.properties.id, feature);
  }
  return { type: "FeatureCollection", features: [...features.values()] };
}

/**
 * Every building around `bounds`, read tile by tile. Parts are separate OSM
 * elements that only overlap their building, so an element is never complete
 * on its own: the tiles it sits in are what associate the two.
 */
async function featuresAround(bounds) {
  const tiles = tilesForBounds(bounds);
  const collections = [];
  for (const tile of tiles) collections.push(await osmTile(tile));
  return mergeCollections(collections);
}

// --------------------------------------------------------------------- laser

/** One z16 laser tile, from the imported Stockholm scan or from Skog. */
async function loadTile(tile) {
  const loaded = [];
  const file = localTilePath("lidar", tile, ".bin");
  try {
    const bytes = await readFile(file);
    const raw = decodeTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    if (raw && raw.count > 0) loaded.push({ tile, raw, source: "Stockholm 2023" });
  } catch {
    // Outside the imported area, which is nearly everywhere.
  }
  const bounds = tileBounds(tile);
  const { data } = await cachedBlob([String(tile.z), String(tile.x), String(tile.y)], async () =>
    encodeTile(await skogPointsForBounds(bounds), bounds),
  );
  const raw = decodeTile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (raw && raw.count > 0) loaded.push({ tile, raw, source: "Laserdata Skog" });
  return loaded;
}

/** The point cloud around one building, clipped exactly as the app clips it. */
async function cloudFor(building) {
  const bounds = cloudBounds(building);
  const tiles = await Promise.all(tilesForBounds(bounds).map(loadTile));
  return mergeTiles(tiles.flat(), bounds);
}

// ---------------------------------------------------------------------- LOD1

/**
 * Stockholm's LOD1 blocks for a building, from the tiles `import-lod1.mjs`
 * writes. They are the second opinion on the heights — laser-derived too, but
 * measured by the city rather than here — and they say nothing about the roof
 * shape, which is the tag with no other source.
 */
async function lod1For(building) {
  const collections = await Promise.all(
    lod1TilesFor(building).map(async (tile) => {
      const file = localTilePath("lod1", tile, ".json");
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch {
        // Outside the imported area, or a tile with no blocks.
        return { type: "FeatureCollection", features: [] };
      }
    }),
  );
  const match = matchLod1(building, collections);
  if (!match) return null;
  const advice = suggestionsFor(building, match, {});
  return {
    values: Object.fromEntries(advice.map((suggestion) => [suggestion.key, suggestion.value])),
    coverage: match.coverage,
    confident: match.confident,
  };
}

// ------------------------------------------------------------------ measuring

function tagsOf(element) {
  const raw = element.properties.tags;
  return raw && typeof raw === "object" ? raw : {};
}

function nameOf(element) {
  return element.properties["@name"] ?? element.properties.class ?? "";
}

/**
 * What the laser reads for one element. Advice is asked for against empty tags
 * on purpose: that returns a value for every key it can measure, including the
 * ones OSM already agrees with, which is what a comparison needs.
 */
function measure(grid, element) {
  const reading = roofAdviceFor(grid, element.polygons, tagsOf(element));
  const measured = reading?.advice ?? [];
  const tags = tagsOf(element);
  return {
    id: element.id,
    name: nameOf(element),
    role: element.properties.role === "part" ? "part" : "building",
    area: area(elementFeature(element)),
    laser: reading
      ? {
          height: reading.recommended.height,
          "roof:height": reading.recommended.roofHeight,
          "roof:shape": reading.recommended.shape || undefined,
        }
      : {},
    miss: reading?.miss,
    currentMiss: reading?.currentMiss,
    osm: Object.fromEntries(KEYS.filter((key) => tags[key]).map((key) => [key, tags[key]])),
    // Zero cells means the element is too small or too hidden to measure.
    cells: reading?.cells ?? 0,
    confident: measured.length === 0 || measured[0].confident,
  };
}

/** Laser advice for a building and, unless turned off, each of its parts. */
async function measureBuilding(group, options) {
  const cloud = await cloudFor(group.building);
  if (!cloud) return { id: group.building.id, error: "no laser points" };
  const grid = buildSurfaceGrid(cloud, group.building.polygons);
  if (!grid) return { id: group.building.id, error: "footprint too small to raster" };
  const result = measure(grid, group.building);
  result.points = cloud.count;
  result.source = cloud.source;
  result.ground = grid.ground;
  result.requested = group.requested;
  // LOD1 describes whole blocks, so only the outline has a second opinion.
  const lod1 = await lod1For(group.building);
  result.lod1 = lod1?.values ?? {};
  result.lod1Note = lod1
    ? `LOD1 covers ${Math.round(lod1.coverage * 100)}%${lod1.confident ? "" : ", block is bigger than this building"}`
    : "no LOD1 block";
  result.parts = options.parts ? group.parts.map((part) => measure(grid, part)) : [];
  if (options.png) {
    // The same three-channel picture the map's Surface mode draws: hue is the
    // direction the surface faces, saturation its steepness, brightness its
    // height. Looking at it is how a misread shape gets diagnosed.
    await mkdir(options.png, { recursive: true });
    result.png = path.join(options.png, `${group.building.id.replace("/", "-")}.png`);
    await writeFile(
      result.png,
      encodePng(surfaceGridImage(grid), grid.columns, grid.rows, PNG_SCALE),
    );
  }
  return result;
}

async function measureAll(groups, options) {
  const results = Array.from({ length: groups.length });
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const at = next++;
      try {
        results[at] = await measureBuilding(groups[at], options);
      } catch (error) {
        results[at] = { id: groups[at].building.id, error: String(error.message ?? error) };
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

// ------------------------------------------------------------------ reporting

const parseMetres = (value) => {
  const match = /^(-?\d+(?:\.\d+)?)/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : undefined;
};

/** One measured value against the OSM tag, as it reads in a row. */
function reading(name, key, value, osm) {
  if (value === undefined) return `${name} —`;
  if (osm === undefined) return `${name} ${value}`;
  if (key === "roof:shape") return `${name} ${value} ${value === osm ? "ok" : "MISMATCH"}`;
  const delta = parseMetres(value) - parseMetres(osm);
  return `${name} ${value} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`;
}

function printMeasurement(result, indent, requested) {
  const pad = " ".repeat(indent);
  const title = [
    result.id,
    result.name,
    result.role,
    result.area === undefined ? "" : `${Math.round(result.area)} m²`,
  ]
    .filter(Boolean)
    .join(" · ");
  console.log(`${pad}${title}${result.id === requested ? "  ← requested" : ""}`);
  if (result.error) {
    console.log(`${pad}  ${result.error}`);
    return;
  }
  if (result.points !== undefined) {
    console.log(
      `${pad}  ${result.points.toLocaleString()} pts · ${result.source} · ${result.cells} cells · ` +
        `ground ${result.ground.toFixed(1)} m${result.confident ? "" : " · thin coverage"} · ` +
        result.lod1Note,
    );
  }
  if (result.cells === 0) {
    console.log(`${pad}  too few fitted cells under this element to measure`);
    return;
  }
  if (result.miss !== undefined) {
    console.log(
      `${pad}  advised roof sits ${result.miss.toFixed(2)} m from the laser` +
        (result.currentMiss === undefined
          ? ""
          : `, the tagged one ${result.currentMiss.toFixed(2)} m`),
    );
  }
  for (const key of KEYS) {
    const laser = result.laser[key];
    const lod1 = result.lod1?.[key];
    const osm = result.osm[key];
    if (laser === undefined && lod1 === undefined && osm === undefined) continue;
    const row = [
      `${key.padEnd(12)}`,
      `osm ${String(osm ?? "—")}`.padEnd(14),
      reading("laser", key, laser, osm).padEnd(24),
      result.lod1 ? reading("lod1", key, lod1, osm) : "",
    ];
    console.log(`${pad}  ${row.join("").trimEnd()}`);
  }
}

function errorLine(label, deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const absolute = deltas.map(Math.abs).sort((a, b) => a - b);
  const mean = absolute.reduce((total, value) => total + value, 0) / absolute.length;
  return (
    `  ${label.padEnd(18)} n=${String(deltas.length).padEnd(4)} ` +
    `median=${sorted[sorted.length >> 1].toFixed(2).padStart(5)} ` +
    `MAE=${mean.toFixed(2)} p90=${absolute[Math.floor(absolute.length * 0.9)].toFixed(2)}`
  );
}

function summarise(results) {
  const flat = results.flatMap((result) => [result, ...(result.parts ?? [])]);
  const errors = new Map();
  const shapes = new Map();
  let correct = 0;
  let shapeTotal = 0;
  for (const result of flat) {
    if (!result.laser) continue;
    for (const key of ["height", "roof:height"]) {
      const osm = parseMetres(result.osm[key]);
      if (osm === undefined) continue;
      for (const source of ["laser", "lod1"]) {
        const value = parseMetres(result[source]?.[key]);
        if (value === undefined) continue;
        const label = `${key} ${source}`;
        errors.set(label, [...(errors.get(label) ?? []), value - osm]);
      }
    }
    const osmShape = result.osm["roof:shape"];
    if (!osmShape) continue;
    shapeTotal++;
    const laserShape = result.laser["roof:shape"] ?? "none";
    if (laserShape === osmShape) correct++;
    const pair = `${osmShape} -> ${laserShape}`;
    shapes.set(pair, (shapes.get(pair) ?? 0) + 1);
  }
  if (shapeTotal === 0 && errors.size === 0) return;

  console.log("\nagainst the OSM tags:");
  for (const key of ["height", "roof:height"]) {
    for (const source of ["laser", "lod1"]) {
      const deltas = errors.get(`${key} ${source}`);
      if (deltas?.length) console.log(errorLine(`${key} ${source}`, deltas));
    }
  }
  if (shapeTotal > 0) {
    console.log(`  roof:shape laser   ${correct}/${shapeTotal} correct`);
    for (const [pair, count] of [...shapes].sort((a, b) => b[1] - a[1])) {
      const [tagged, read] = pair.split(" -> ");
      if (tagged !== read) console.log(`    ${pair.padEnd(28)} ${count}`);
    }
  }
}

// ----------------------------------------------------------------------- main

/** The building groups to measure: named elements, or a box full of them. */
async function groupsFor(options) {
  if (options.bbox) {
    const lookup = new OsmBuildingLookup(await featuresAround(options.bbox));
    const [west, south, east, north] = options.bbox;
    return lookup.buildings
      .filter((building) => {
        const [bWest, bSouth, bEast, bNorth] = elementBounds(building);
        if (bWest > east || bEast < west || bSouth > north || bNorth < south) return false;
        const tags = tagsOf(building);
        return options.all || KEYS.some((key) => tags[key]);
      })
      .map((building) => lookup.groupForBuilding(building));
  }

  const groups = [];
  for (const id of options.ids) {
    const element = await osmElement(id);
    const wanted = element.features.find((feature) => feature.properties.id === id);
    if (!wanted) {
      console.error(`${id}: not a building or building:part`);
      continue;
    }
    const bounds = padBounds(
      elementBounds({ id, properties: {}, polygons: toPolygons(wanted) }),
      NEIGHBOURHOOD_M,
    );
    const lookup = new OsmBuildingLookup(mergeCollections([element, await featuresAround(bounds)]));
    const selected = lookup.select(id);
    if (!selected) {
      console.error(`${id}: no geometry`);
      continue;
    }
    // A part is measured inside its building's raster, so the whole group goes
    // through: the printout marks which element was asked for.
    groups.push({ ...selected, requested: id });
  }
  return groups;
}

/** Rings of a parsed feature, as the footprints an element carries. */
function toPolygons(feature) {
  const { coordinates, type } = feature.geometry;
  const polygons = type === "Polygon" ? [coordinates] : coordinates;
  return polygons.map((rings) => ({ outer: rings[0], holes: rings.slice(1) }));
}

async function main() {
  const options = parseCommandLine(process.argv);
  if (options.ids.length === 0 && !options.bbox) {
    console.error("Usage: node scripts/roof-advice.mjs way/<id>… | --bbox w,s,e,n");
    process.exitCode = 1;
    return;
  }

  const groups = await groupsFor(options);
  if (groups.length === 0) {
    console.error("Nothing to measure");
    process.exitCode = 1;
    return;
  }
  if (groups.length > 1) console.error(`measuring ${groups.length} buildings…`);

  const results = await measureAll(groups, options);
  if (options.json) {
    console.log(JSON.stringify(results, null, 1));
    return;
  }
  for (const result of results) {
    printMeasurement(result, 0, result.requested);
    for (const part of result.parts ?? []) printMeasurement(part, 2, result.requested);
    console.log("");
  }
  summarise(results);
}

await main();
