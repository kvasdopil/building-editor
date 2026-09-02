/**
 * Import a dense airborne laser survey into the z16 tiles served by /api/lidar.
 *
 * Stockholm (the backward-compatible default):
 *
 *   node scripts/import-lidar.mjs [--src <file|dir>] [--out <dir>]
 *
 * ICGC LiDAR Territorial over a chosen Catalonia area:
 *
 *   node scripts/import-lidar.mjs --dataset icgc --bbox west,south,east,north
 *   node scripts/import-lidar.mjs --dataset icgc --src <file|dir>
 *
 * The ICGC form resolves the intersecting EPSG:25831 kilometre sheets and
 * downloads their public LAZ files. `--padding <metres>` defaults to the 100 m
 * context used by the viewer; `--max-source-tiles <n>` (default 16) guards
 * against accidentally requesting a large part of Catalonia.
 *
 * Both LAS and LAZ are read twice. The first pass counts points and establishes
 * each output tile's z base; the second retains a uniform storage-order sample
 * directly in typed arrays. That keeps a 20+ million point ICGC source sheet
 * bounded in memory without scrambling the scanner order drawn by LiDAR Lines.
 */

import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { Las } from "copc";
import { parseArgs } from "./lib/args.mjs";
import { icgcSourceTiles } from "./lib/icgc-lidar.mjs";
import { makeSweref99Inverse } from "./lib/sweref99.mjs";
import { TILE_ZOOM, tileBounds, tileFor } from "./lib/tiles.mjs";

const STOCKHOLM_URL =
  "https://dataportalen.stockholm.se/dataportalen/Data/Stadsbyggnadskontoret/Punktmoln_2023_testomrade.las";
const SOURCE_ID = { stockholm: 0, icgc: 2 };
const DEFAULT_MAX_PER_TILE = 500_000;
const DEFAULT_CONTEXT_M = 100;
const DEFAULT_MAX_SOURCE_TILES = 16;
const READ_BATCH = 1 << 16;

const DATASETS = {
  stockholm: {
    id: SOURCE_ID.stockholm,
    name: "SBK Punktmoln - flygburen laserskanning (2023), Stockholms stad",
    epsg: 3011,
    crs: "EPSG:3011 -> WGS84, heights RH2000",
    inverse: makeSweref99Inverse(),
    noise: new Set([7]),
  },
  icgc: {
    id: SOURCE_ID.icgc,
    name: "LiDAR Territorial 2021-2023, ICGC",
    epsg: 25831,
    crs: "EPSG:25831 -> WGS84, orthometric heights",
    inverse: makeSweref99Inverse({ lon0: 3, k0: 0.9996, falseEasting: 500000 }),
    noise: new Set([7, 18]),
  },
};

function readHeader(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.subarray(0, 4).toString("latin1") !== "LASF") throw new Error("not a LAS file");
  const versionMinor = buffer[25];
  let count = view.getUint32(107, true);
  if (versionMinor >= 4) count = Number(view.getBigUint64(247, true)) || count;
  return {
    headerSize: view.getUint16(94, true),
    vlrCount: view.getUint32(100, true),
    pointsAt: view.getUint32(96, true),
    compressed: (buffer[104] & 0xc0) !== 0,
    format: buffer[104] & 0x3f,
    recordLength: view.getUint16(105, true),
    count,
    scale: [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)],
    offset: [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)],
  };
}

function readEpsg(buffer, header) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let at = header.headerSize;
  for (let i = 0; i < header.vlrCount && at + 54 <= buffer.byteLength; i++) {
    const recordId = view.getUint16(at + 18, true);
    const length = view.getUint16(at + 20, true);
    if (recordId === 34735 && at + 54 + length <= buffer.byteLength) {
      const keys = view.getUint16(at + 54 + 6, true);
      for (let key = 0; key < keys; key++) {
        const entry = at + 54 + 8 + key * 8;
        if (view.getUint16(entry, true) === 3072) return view.getUint16(entry + 6, true);
      }
    }
    at += 54 + length;
  }
  return null;
}

function recordLayout(format) {
  const legacy = format <= 5;
  const rgb = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[format] ?? null;
  return { classAt: legacy ? 15 : 16, classMask: legacy ? 0x1f : 0xff, rgbAt: rgb };
}

async function inspectFile(file, dataset) {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(375);
    await handle.read(head, 0, head.length, 0);
    const header = readHeader(head);
    const prologue = Buffer.alloc(Math.max(header.pointsAt, head.length));
    await handle.read(prologue, 0, prologue.length, 0);
    const epsg = readEpsg(prologue, header);
    if (epsg !== null && epsg !== dataset.epsg) {
      throw new Error(`${path.basename(file)} is EPSG:${epsg}, expected ${dataset.epsg}`);
    }
    return { header, layout: recordLayout(header.format) };
  } finally {
    await handle.close();
  }
}

let lazPerfPromise;

async function lazPerf() {
  lazPerfPromise ??= Las.PointData.createLazPerf();
  return lazPerfPromise;
}

async function forEachLazPoint(file, metadata, visit) {
  const compressed = await readFile(file);
  const decoder = await lazPerf();
  let filePointer = 0;
  let pointPointer = 0;
  let reader;
  try {
    filePointer = decoder._malloc(compressed.byteLength);
    pointPointer = decoder._malloc(metadata.header.recordLength);
    decoder.HEAPU8.set(compressed, filePointer);
    reader = new decoder.LASZip();
    reader.open(filePointer, compressed.byteLength);
    let view = new DataView(decoder.HEAPU8.buffer);
    for (let index = 0; index < metadata.header.count; index++) {
      reader.getPoint(pointPointer);
      if (view.buffer !== decoder.HEAPU8.buffer) view = new DataView(decoder.HEAPU8.buffer);
      visit(decoder.HEAPU8, view, pointPointer);
    }
  } finally {
    reader?.delete();
    if (pointPointer) decoder._free(pointPointer);
    if (filePointer) decoder._free(filePointer);
  }
}

async function forEachLasPoint(file, metadata, visit) {
  const { header } = metadata;
  const handle = await open(file, "r");
  try {
    const batch = Buffer.alloc(READ_BATCH * header.recordLength);
    for (let read = 0; read < header.count; read += READ_BATCH) {
      const points = Math.min(READ_BATCH, header.count - read);
      const bytes = points * header.recordLength;
      await handle.read(batch, 0, bytes, header.pointsAt + read * header.recordLength);
      const view = new DataView(batch.buffer, batch.byteOffset, bytes);
      for (let index = 0; index < points; index++) visit(batch, view, index * header.recordLength);
    }
  } finally {
    await handle.close();
  }
}

async function forEachDecodedPoint(file, dataset, metadata, visit, classes) {
  const { header, layout } = metadata;
  const [scaleX, scaleY, scaleZ] = header.scale;
  const [offsetX, offsetY, offsetZ] = header.offset;
  const consume = (bytes, view, at) => {
    const classification = bytes[at + layout.classAt] & layout.classMask;
    if (classes) classes[classification] = (classes[classification] ?? 0) + 1;
    if (dataset.noise.has(classification)) return;
    const easting = view.getInt32(at, true) * scaleX + offsetX;
    const northing = view.getInt32(at + 4, true) * scaleY + offsetY;
    const z = view.getInt32(at + 8, true) * scaleZ + offsetZ;
    const [lon, lat] = dataset.inverse(easting, northing);

    let colour = 0xffff;
    if (layout.rgbAt !== null) {
      const red = view.getUint16(at + layout.rgbAt, true) >> 8;
      const green = view.getUint16(at + layout.rgbAt + 2, true) >> 8;
      const blue = view.getUint16(at + layout.rgbAt + 4, true) >> 8;
      colour = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
    }
    visit({ lon, lat, z, colour, classification });
  };
  if (header.compressed || file.toLowerCase().endsWith(".laz")) {
    await forEachLazPoint(file, metadata, consume);
  } else {
    await forEachLasPoint(file, metadata, consume);
  }
}

function clampU16(value) {
  return Math.min(0xffff, Math.max(0, Math.round(value)));
}

function tileKey(x, y) {
  return `${x}/${y}`;
}

function countPoint(counts, point) {
  const { x, y } = tileFor(point.lon, point.lat);
  const key = tileKey(x, y);
  const current = counts.get(key);
  if (current) {
    current.total++;
    current.minZ = Math.min(current.minZ, point.z);
  } else {
    counts.set(key, { x, y, total: 1, minZ: point.z });
  }
}

function makeBuckets(counts, maxPerTile) {
  const buckets = new Map();
  for (const [key, counted] of counts) {
    const stride = Math.max(1, Math.ceil(counted.total / maxPerTile));
    const capacity = Math.ceil(counted.total / stride);
    buckets.set(key, {
      ...counted,
      bounds: tileBounds(counted.x, counted.y),
      stride,
      seen: 0,
      written: 0,
      zBase: Math.floor(counted.minZ),
      xValues: new Uint16Array(capacity),
      yValues: new Uint16Array(capacity),
      zValues: new Uint16Array(capacity),
      colours: new Uint16Array(capacity),
      classes: new Uint8Array(capacity),
    });
  }
  return buckets;
}

function storePoint(buckets, point) {
  const { x, y } = tileFor(point.lon, point.lat);
  const bucket = buckets.get(tileKey(x, y));
  if (!bucket) return;
  const seen = bucket.seen++;
  if (seen % bucket.stride !== 0) return;
  const at = bucket.written++;
  const [west, south, east, north] = bucket.bounds;
  bucket.xValues[at] = clampU16(((point.lon - west) / (east - west)) * 0xffff);
  bucket.yValues[at] = clampU16(((point.lat - south) / (north - south)) * 0xffff);
  bucket.zValues[at] = clampU16((point.z - bucket.zBase) * 100);
  bucket.colours[at] = point.colour;
  bucket.classes[at] = point.classification;
}

function encodeBucket(bucket, sourceId) {
  const count = bucket.written;
  const buffer = Buffer.alloc(16 + count * 9);
  buffer.write("LDR1", 0, "latin1");
  buffer.writeUInt32LE(count, 4);
  buffer.writeFloatLE(bucket.zBase, 8);
  buffer.writeUInt32LE(sourceId, 12);
  let at = 16;
  for (const array of [bucket.xValues, bucket.yValues, bucket.zValues, bucket.colours]) {
    Buffer.from(array.buffer, array.byteOffset, count * 2).copy(buffer, at);
    at += count * 2;
  }
  Buffer.from(bucket.classes.buffer, bucket.classes.byteOffset, count).copy(buffer, at);
  return buffer;
}

async function localFiles(src) {
  if ((await stat(src)).isDirectory()) {
    return (await readdir(src))
      .filter((name) => /\.laz?$/i.test(name))
      .sort()
      .map((name) => path.join(src, name));
  }
  return [src];
}

async function download(url, destination) {
  try {
    if ((await stat(destination)).size > 0) {
      console.log(`using ${destination}`);
      return;
    }
  } catch {
    // Missing source: download it below.
  }
  console.log(`downloading ${url}`);
  const response = await fetch(url, { headers: { "User-Agent": "building-editor/0.1" } });
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, destination);
}

function parseBbox(value) {
  const bbox = String(value ?? "")
    .split(",")
    .map(Number);
  if (bbox.length !== 4 || bbox.some((number) => !Number.isFinite(number))) {
    throw new Error("--bbox must be west,south,east,north");
  }
  const [west, south, east, north] = bbox;
  if (west >= east || south >= north) throw new Error("--bbox has inverted or empty bounds");
  return bbox;
}

function padBbox([west, south, east, north], metres) {
  const midLat = (south + north) / 2;
  const latPad = metres / 111320;
  const lonPad = metres / (111320 * Math.cos((midLat * Math.PI) / 180));
  return [west - lonPad, south - latPad, east + lonPad, north + latPad];
}

async function collectFiles(args, datasetKey, outDir) {
  if (args.src) return localFiles(args.src);
  if (datasetKey === "stockholm") {
    const destination = path.join(outDir, "source", "stockholm", "testomrade.las");
    await download(STOCKHOLM_URL, destination);
    return [destination];
  }
  const padding = Number(args.padding ?? DEFAULT_CONTEXT_M);
  if (!Number.isFinite(padding) || padding < 0)
    throw new Error("--padding must be zero or greater");
  const sheets = icgcSourceTiles(padBbox(parseBbox(args.bbox), padding));
  const maxSources = Number(args["max-source-tiles"] ?? DEFAULT_MAX_SOURCE_TILES);
  if (sheets.length > maxSources) {
    throw new Error(
      `${sheets.length} ICGC source sheets exceed --max-source-tiles ${maxSources}; narrow the bbox or raise the guard explicitly`,
    );
  }
  const files = [];
  for (const sheet of sheets) {
    const destination = path.join(outDir, "source", "icgc", sheet.name);
    await download(sheet.url, destination);
    files.push(destination);
  }
  return files;
}

async function writeManifest(outDir, imported) {
  const file = path.join(outDir, "manifest.json");
  let imports = [];
  try {
    const previous = JSON.parse(await readFile(file, "utf8"));
    imports = Array.isArray(previous.imports) ? previous.imports : [previous];
  } catch {
    // First import.
  }
  const sourceIdOf = (entry) =>
    entry.sourceId ?? (String(entry.dataset ?? "").startsWith("SBK Punktmoln") ? 0 : null);
  imports = [...imports.filter((entry) => sourceIdOf(entry) !== imported.sourceId), imported];
  await writeFile(file, JSON.stringify({ imports }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const datasetKey = String(args.dataset ?? "stockholm").toLowerCase();
  const dataset = DATASETS[datasetKey];
  if (!dataset) throw new Error(`unknown --dataset ${datasetKey}; use stockholm or icgc`);
  const outDir = args.out ?? "data/lidar";
  const maxPerTile = Number(args["max-per-tile"] ?? DEFAULT_MAX_PER_TILE);
  if (!Number.isSafeInteger(maxPerTile) || maxPerTile < 1) {
    throw new Error("--max-per-tile must be a positive integer");
  }

  const files = await collectFiles(args, datasetKey, outDir);
  if (files.length === 0) throw new Error("no .las or .laz files found");
  console.log(`${files.length} ${datasetKey} source file(s)`);
  const metadata = new Map();
  for (const file of files) {
    const inspected = await inspectFile(file, dataset);
    metadata.set(file, inspected);
    console.log(
      `  ${path.basename(file)}: ${inspected.header.count.toLocaleString()} points, format ${inspected.header.format}${inspected.header.compressed ? " LAZ" : " LAS"}`,
    );
  }

  const counts = new Map();
  const classes = {};
  console.log("pass 1/2: counting output tiles");
  for (const file of files) {
    await forEachDecodedPoint(
      file,
      dataset,
      metadata.get(file),
      (point) => countPoint(counts, point),
      classes,
    );
  }

  const buckets = makeBuckets(counts, maxPerTile);
  console.log("pass 2/2: retaining ordered samples");
  for (const file of files) {
    await forEachDecodedPoint(file, dataset, metadata.get(file), (point) =>
      storePoint(buckets, point),
    );
  }

  let written = 0;
  let dropped = 0;
  for (const bucket of buckets.values()) {
    const dir = path.join(outDir, String(TILE_ZOOM), String(bucket.x));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${bucket.y}.bin`), encodeBucket(bucket, dataset.id));
    written += bucket.written;
    dropped += bucket.total - bucket.written;
    console.log(
      `  ${TILE_ZOOM}/${bucket.x}/${bucket.y}: ${bucket.written.toLocaleString()} points`,
    );
  }

  await writeManifest(outDir, {
    sourceId: dataset.id,
    source: files.map((file) => path.basename(file)),
    dataset: dataset.name,
    license:
      datasetKey === "icgc" ? "CC BY 4.0, Institut Cartografic i Geologic de Catalunya" : undefined,
    crs: dataset.crs,
    importedZoom: TILE_ZOOM,
    points: written,
    tiles: buckets.size,
    maxPerTile,
    classes,
  });
  console.log(
    `\n${written.toLocaleString()} points in ${buckets.size} tiles -> ${outDir} (thinned away ${dropped.toLocaleString()})`,
  );
}

await main();
