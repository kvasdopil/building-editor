/**
 * Import Stockholm's airborne laser point cloud into z16 tiles the app can serve.
 *
 * Source: "SBK Punktmoln - flygburen laserskanning (2023)" from Stockholm's
 * data portal — LAS in SWEREF 99 18 00 (EPSG:3011) with heights in RH2000,
 * >16 points/m², coloured from the 2023 orthophoto. Only a 200 x 200 m test
 * area is published for direct download; the full municipality is ordered from
 * the city, so this script takes any number of local LAS files as well.
 *
 *   node scripts/import-lidar.mjs [--src <file|dir>] [--out <dir>] [--max-per-tile <n>]
 *
 * With no --src it downloads the published test area.
 *
 * Output is one binary per tile, planar so the browser can view the arrays
 * without copying (see src/lib/lidar.ts for the reader):
 *
 *   0  "LDR1"          magic
 *   4  uint32          point count
 *   8  float32         zBase, the RH2000 metre level the heights count from
 *   12 uint32          reserved
 *   16 uint16[count]   x, as a fraction of the tile's longitude span
 *      uint16[count]   y, as a fraction of the tile's latitude span
 *      uint16[count]   height above zBase, centimetres
 *      uint16[count]   colour, RGB565 from the orthophoto
 *      uint8[count]    LAS classification
 */

import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { makeSweref99Inverse } from "./lib/sweref99.mjs";
import { TILE_ZOOM, tileBounds, tileFor } from "./lib/tiles.mjs";

const SOURCE_URL =
  "https://dataportalen.stockholm.se/dataportalen/Data/Stadsbyggnadskontoret/Punktmoln_2023_testomrade.las";

/** The projection the city publishes point clouds in. */
const EXPECTED_EPSG = 3011;

/**
 * LAS class 7 is "high and low points", i.e. noise the vendor already flagged.
 * It is the one class that is never worth keeping.
 */
const NOISE_CLASS = 7;

/**
 * Points kept per tile. A full z16 tile at 16 points/m² holds ~1.5 M points,
 * which is a 13 MB download to look at one building. Thinning is uniform over
 * the file's own order, which is by flight line, so it stays evenly spread.
 */
const DEFAULT_MAX_PER_TILE = 500_000;

/** Points read from the file per pass, to keep a whole city cloud out of RAM. */
const READ_BATCH = 1 << 16;

// --------------------------------------------------------------------- header

/**
 * Parse the public header block. Fields sit at fixed offsets in every LAS
 * version; the 1.4 64-bit point count replaces the legacy 32-bit one.
 */
function readHeader(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.subarray(0, 4).toString("latin1") !== "LASF") throw new Error("not a LAS file");
  const versionMinor = buffer[25];
  const headerSize = view.getUint16(94, true);
  const format = buffer[104] & 0x3f;
  let count = view.getUint32(107, true);
  if (versionMinor >= 4) count = Number(view.getBigUint64(247, true)) || count;
  return {
    versionMinor,
    headerSize,
    vlrCount: view.getUint32(100, true),
    pointsAt: view.getUint32(96, true),
    format,
    recordLength: view.getUint16(105, true),
    count,
    scale: [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)],
    offset: [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)],
  };
}

/** The projected CRS from the GeoTIFF key directory VLR, when the file has one. */
function readEpsg(buffer, header) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let at = header.headerSize;
  for (let i = 0; i < header.vlrCount && at + 54 <= buffer.byteLength; i++) {
    const recordId = view.getUint16(at + 18, true);
    const length = view.getUint16(at + 20, true);
    if (recordId === 34735 && at + 54 + length <= buffer.byteLength) {
      const keys = view.getUint16(at + 54 + 6, true);
      for (let k = 0; k < keys; k++) {
        const entry = at + 54 + 8 + k * 8;
        // 3072 is ProjectedCSTypeGeoKey; its value is the EPSG code.
        if (view.getUint16(entry, true) === 3072) return view.getUint16(entry + 6, true);
      }
    }
    at += 54 + length;
  }
  return null;
}

/**
 * Byte offsets of the fields we read, per point data record format. Formats 0-5
 * keep the classification in the flag byte's low 5 bits; 6-10 give it a byte of
 * its own. Colour only exists in some formats.
 */
function recordLayout(format) {
  const legacy = format <= 5;
  const rgb = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[format] ?? null;
  return { classAt: legacy ? 15 : 16, classMask: legacy ? 0x1f : 0xff, rgbAt: rgb };
}

// ----------------------------------------------------------------------- read

/**
 * Read one LAS file, appending every point to its tile bucket. Buckets hold
 * plain arrays of lon/lat/z/colour/class, which the writer quantizes per tile.
 */
async function readLas(file, tiles, stats) {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(375);
    await handle.read(head, 0, head.length, 0);
    const header = readHeader(head);
    // The projection VLR sits between the header and the first point record.
    const prologue = Buffer.alloc(Math.max(header.pointsAt, head.length));
    await handle.read(prologue, 0, prologue.length, 0);
    const epsg = readEpsg(prologue, header);
    if (epsg !== null && epsg !== EXPECTED_EPSG) {
      throw new Error(`${path.basename(file)} is EPSG:${epsg}, expected ${EXPECTED_EPSG}`);
    }
    const { classAt, classMask, rgbAt } = recordLayout(header.format);
    const toWgs84 = makeSweref99Inverse();
    const [scaleX, scaleY, scaleZ] = header.scale;
    const [offsetX, offsetY, offsetZ] = header.offset;

    const batch = Buffer.alloc(READ_BATCH * header.recordLength);
    for (let read = 0; read < header.count; read += READ_BATCH) {
      const points = Math.min(READ_BATCH, header.count - read);
      const bytes = points * header.recordLength;
      await handle.read(batch, 0, bytes, header.pointsAt + read * header.recordLength);
      const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);

      for (let i = 0; i < points; i++) {
        const at = i * header.recordLength;
        const classification = batch[at + classAt] & classMask;
        stats.classes[classification] = (stats.classes[classification] ?? 0) + 1;
        if (classification === NOISE_CLASS) {
          stats.noise++;
          continue;
        }
        const easting = view.getInt32(at, true) * scaleX + offsetX;
        const northing = view.getInt32(at + 4, true) * scaleY + offsetY;
        const z = view.getInt32(at + 8, true) * scaleZ + offsetZ;
        const [lon, lat] = toWgs84(easting, northing);

        // LAS colour channels are 16-bit; this dataset fills the high byte.
        let colour = 0xffff;
        if (rgbAt !== null) {
          const r = view.getUint16(at + rgbAt, true) >> 8;
          const g = view.getUint16(at + rgbAt + 2, true) >> 8;
          const b = view.getUint16(at + rgbAt + 4, true) >> 8;
          colour = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
        }

        const { x, y } = tileFor(lon, lat);
        const key = `${x}/${y}`;
        let bucket = tiles.get(key);
        if (!bucket) {
          bucket = { x, y, lon: [], lat: [], z: [], colour: [], classification: [] };
          tiles.set(key, bucket);
        }
        bucket.lon.push(lon);
        bucket.lat.push(lat);
        bucket.z.push(z);
        bucket.colour.push(colour);
        bucket.classification.push(classification);
        stats.kept++;
      }
    }
    console.log(
      `  ${path.basename(file)}: ${header.count} points, format ${header.format}` +
        `${rgbAt === null ? " (no colour)" : ""}`,
    );
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------- write

/** Quantize one tile's points into the planar binary the browser reads. */
function encodeTile(bucket, maxPerTile) {
  const [west, south, east, north] = tileBounds(bucket.x, bucket.y);
  const total = bucket.lon.length;
  const stride = Math.max(1, Math.ceil(total / maxPerTile));
  const count = Math.ceil(total / stride);

  let zBase = Infinity;
  for (let i = 0; i < total; i += stride) zBase = Math.min(zBase, bucket.z[i]);
  zBase = Math.floor(zBase);

  const buffer = Buffer.alloc(16 + count * 9);
  buffer.write("LDR1", 0, "latin1");
  buffer.writeUInt32LE(count, 4);
  buffer.writeFloatLE(zBase, 8);

  const xs = new Uint16Array(count);
  const ys = new Uint16Array(count);
  const zs = new Uint16Array(count);
  const colours = new Uint16Array(count);
  const classes = new Uint8Array(count);
  const lonSpan = east - west;
  const latSpan = north - south;

  for (let i = 0, out = 0; i < total; i += stride, out++) {
    xs[out] = Math.min(
      0xffff,
      Math.max(0, Math.round(((bucket.lon[i] - west) / lonSpan) * 0xffff)),
    );
    ys[out] = Math.min(
      0xffff,
      Math.max(0, Math.round(((bucket.lat[i] - south) / latSpan) * 0xffff)),
    );
    // 655 m of headroom over the tile's lowest point, in centimetres.
    zs[out] = Math.min(0xffff, Math.max(0, Math.round((bucket.z[i] - zBase) * 100)));
    colours[out] = bucket.colour[i];
    classes[out] = bucket.classification[i];
  }

  let at = 16;
  for (const array of [xs, ys, zs, colours]) {
    Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(buffer, at);
    at += array.byteLength;
  }
  Buffer.from(classes.buffer).copy(buffer, at);
  return { buffer, count, dropped: total - count };
}

// ----------------------------------------------------------------------- main

async function collectFiles(src, downloadTo) {
  if (!src) {
    console.log(`downloading ${SOURCE_URL}`);
    const response = await fetch(SOURCE_URL, { headers: { "User-Agent": "building-editor/0.1" } });
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    await mkdir(path.dirname(downloadTo), { recursive: true });
    await writeFile(downloadTo, Buffer.from(await response.arrayBuffer()));
    return [downloadTo];
  }
  if ((await stat(src)).isDirectory()) {
    const names = await readdir(src);
    return names
      .filter((name) => name.toLowerCase().endsWith(".las"))
      .map((n) => path.join(src, n));
  }
  return [src];
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out ?? "data/lidar";
  const maxPerTile = Number(args["max-per-tile"] ?? DEFAULT_MAX_PER_TILE);

  const files = await collectFiles(args.src, path.join(outDir, "source", "testomrade.las"));
  if (files.length === 0) throw new Error("no .las files found");
  console.log(`${files.length} file(s)`);

  const tiles = new Map();
  const stats = { kept: 0, noise: 0, classes: {} };
  for (const file of files) await readLas(file, tiles, stats);

  let written = 0;
  let dropped = 0;
  for (const bucket of tiles.values()) {
    const { buffer, count, dropped: thinned } = encodeTile(bucket, maxPerTile);
    const dir = path.join(outDir, String(TILE_ZOOM), String(bucket.x));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${bucket.y}.bin`), buffer);
    written += count;
    dropped += thinned;
    console.log(`  ${TILE_ZOOM}/${bucket.x}/${bucket.y}: ${count} points`);
  }

  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        source: args.src ? files.map((f) => path.basename(f)) : SOURCE_URL,
        dataset: "SBK Punktmoln - flygburen laserskanning (2023), Stockholms stad",
        crs: `EPSG:${EXPECTED_EPSG} -> WGS84, heights RH2000`,
        importedZoom: TILE_ZOOM,
        points: written,
        tiles: tiles.size,
        maxPerTile,
        classes: stats.classes,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${written} points in ${tiles.size} tiles -> ${outDir}` +
      ` (dropped ${stats.noise} noise, thinned away ${dropped} over ${maxPerTile}/tile)`,
  );
}

await main();
