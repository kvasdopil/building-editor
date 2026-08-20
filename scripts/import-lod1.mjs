/**
 * Import Stockholm's LOD1 building models into z16 tiles the app can serve.
 *
 * Source: "SBK 3D-Byggnader (LOD1) generaliserade" from Stockholm's data portal
 * — 3D blocks whose heights come from airborne laser data. Shapefiles hold
 * MultiPatch solids in SWEREF99 18 00 (EPSG:3011); the first ring of each solid
 * is its horizontal base, i.e. the footprint. Heights come from the DBF:
 * MARK_Z (ground), TAKMIN_Z (eaves), TAK_Z (roof median), TAKMAX_Z (ridge).
 *
 *   node scripts/import-lod1.mjs [--zip <file>] [--src <dir>] [--out <dir>]
 *
 * With neither --zip nor --src it downloads the published archive.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { parseArgs } from "./lib/args.mjs";
import { makeSweref99Inverse } from "./lib/sweref99.mjs";
import { TILE_ZOOM, tileFor } from "./lib/tiles.mjs";

const SOURCE_URL =
  "https://dataportalen.stockholm.se/dataportalen/Data/Stadsbyggnadskontoret/LOD1_stadsdelsnamnder_SHP.zip";

/** Ignore blocks smaller than this footprint; they are sheds, not buildings. */
const MIN_AREA_M2 = 10;

// ------------------------------------------------------------------ shapefile

/** Read the base ring of every MultiPatch solid, in source coordinates. */
function readFootprints(shpBuffer) {
  const view = new DataView(shpBuffer.buffer, shpBuffer.byteOffset, shpBuffer.byteLength);
  const footprints = [];
  let offset = 100;

  while (offset + 8 <= view.byteLength) {
    const contentLength = view.getInt32(offset + 4, false) * 2;
    const body = offset + 8;
    const shapeType = view.getInt32(body, true);
    offset = body + contentLength;
    // 31 is MultiPatch; anything else in this dataset is a null shape.
    if (shapeType !== 31) {
      footprints.push(null);
      continue;
    }
    const numParts = view.getInt32(body + 36, true);
    const numPoints = view.getInt32(body + 40, true);
    if (numParts < 1 || numPoints < 4) {
      footprints.push(null);
      continue;
    }
    const partsAt = body + 44;
    const pointsAt = partsAt + numParts * 8; // part offsets, then part types
    // The solid's first ring is its horizontal base: the footprint.
    const end = numParts > 1 ? view.getInt32(partsAt + 4, true) : numPoints;
    const ring = [];
    for (let i = 0; i < end; i++) {
      ring.push([
        view.getFloat64(pointsAt + i * 16, true),
        view.getFloat64(pointsAt + i * 16 + 8, true),
      ]);
    }
    footprints.push(ring.length >= 4 ? ring : null);
  }
  return footprints;
}

/** DBF field names are null-padded; keep the text before the first NUL. */
function nullTerminated(text) {
  const end = text.indexOf("\u0000");
  return end === -1 ? text : text.slice(0, end);
}

/** Read a DBF into plain objects, decoding the Latin-1 text fields. */
function readDbf(dbfBuffer) {
  const view = new DataView(dbfBuffer.buffer, dbfBuffer.byteOffset, dbfBuffer.byteLength);
  const decoder = new TextDecoder("latin1");
  const recordCount = view.getInt32(4, true);
  const headerLength = view.getInt16(8, true);
  const recordLength = view.getInt16(10, true);

  const fields = [];
  for (let p = 32; p < headerLength - 1; p += 32) {
    const name = nullTerminated(
      decoder.decode(new Uint8Array(dbfBuffer.buffer, dbfBuffer.byteOffset + p, 11)),
    );
    if (!name) break;
    fields.push({
      name,
      type: String.fromCharCode(view.getUint8(p + 11)),
      length: view.getUint8(p + 16),
    });
  }

  const rows = [];
  for (let r = 0; r < recordCount; r++) {
    const start = headerLength + r * recordLength;
    if (start + recordLength > dbfBuffer.byteLength) break;
    const raw = decoder.decode(
      new Uint8Array(dbfBuffer.buffer, dbfBuffer.byteOffset + start, recordLength),
    );
    let cursor = 1; // first byte is the deletion flag
    const row = {};
    for (const field of fields) {
      const text = raw.slice(cursor, cursor + field.length).trim();
      cursor += field.length;
      if (field.type === "N" || field.type === "F") {
        const value = Number.parseFloat(text);
        row[field.name] = Number.isFinite(value) ? value : undefined;
      } else {
        row[field.name] = text || undefined;
      }
    }
    rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------- geometry

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// --------------------------------------------------------------------- main

async function collectShapefiles({ zip, src }) {
  if (src) {
    const found = [];
    for (const entry of await readdir(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(src, entry.name);
      for (const file of await readdir(dir)) {
        if (file.toLowerCase().endsWith(".shp")) {
          const base = path.join(dir, file.replace(/\.shp$/i, ""));
          found.push({
            name: entry.name,
            shp: await readFile(`${base}.shp`),
            dbf: await readFile(`${base}.dbf`),
          });
        }
      }
    }
    return found;
  }

  let archive;
  if (zip) {
    archive = await readFile(zip);
  } else {
    console.log(`downloading ${SOURCE_URL}`);
    const response = await fetch(SOURCE_URL, { headers: { "User-Agent": "building-editor/0.1" } });
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }

  const entries = unzipSync(new Uint8Array(archive));
  const grouped = new Map();
  for (const [name, bytes] of Object.entries(entries)) {
    const match = name.match(/^(.*)\.(shp|dbf)$/i);
    if (!match) continue;
    const [, base, extension] = match;
    const group = grouped.get(base) ?? {};
    group[extension.toLowerCase()] = Buffer.from(bytes);
    group.name = base;
    grouped.set(base, group);
  }
  return [...grouped.values()].filter((group) => group.shp && group.dbf);
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out ?? "data/lod1";
  const toWgs84 = makeSweref99Inverse();

  const shapefiles = await collectShapefiles(args);
  if (shapefiles.length === 0) throw new Error("no shapefiles found");
  console.log(`${shapefiles.length} shapefile(s)`);

  const tiles = new Map();
  let kept = 0;
  let skipped = 0;

  for (const { name, shp, dbf } of shapefiles) {
    const footprints = readFootprints(shp);
    const rows = readDbf(dbf);
    for (let i = 0; i < rows.length; i++) {
      const ring = footprints[i];
      const row = rows[i];
      if (!ring || !row) {
        skipped++;
        continue;
      }
      if (ringArea(ring) < MIN_AREA_M2) {
        skipped++;
        continue;
      }
      const ground = row.MARK_Z;
      const ridge = row.TAKMAX_Z;
      const eaves = row.TAKMIN_Z;
      const median = row.TAK_Z;
      if (ground === undefined || ridge === undefined) {
        skipped++;
        continue;
      }

      const coordinates = ring.map(([easting, northing]) => {
        const [lon, lat] = toWgs84(easting, northing);
        return [round(lon, 7), round(lat, 7)];
      });
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);

      const properties = {
        id: row.UUID ?? `${row.OID ?? i}`,
        /** Ground to top of roof: what OSM `height` means. */
        height: round(ridge - ground, 1),
        /** Ground to eaves, the facade height used to estimate levels. */
        eaves_height: eaves === undefined ? undefined : round(eaves - ground, 1),
        /** Ground to roof median, the figure the dataset is documented by. */
        median_height: median === undefined ? undefined : round(median - ground, 1),
        roof_height: eaves === undefined ? undefined : round(ridge - eaves, 1),
        area: row.BYGG_A,
        category: row.KATEGORI,
        group: row.GRUPP,
      };
      for (const key of Object.keys(properties)) {
        if (properties[key] === undefined) delete properties[key];
      }

      let lonSum = 0;
      let latSum = 0;
      for (const [lon, lat] of coordinates) {
        lonSum += lon;
        latSum += lat;
      }
      const { x, y } = tileFor(lonSum / coordinates.length, latSum / coordinates.length);
      const key = `${x}/${y}`;
      const bucket = tiles.get(key) ?? [];
      bucket.push({
        type: "Feature",
        properties,
        geometry: { type: "Polygon", coordinates: [coordinates] },
      });
      tiles.set(key, bucket);
      kept++;
    }
    console.log(`  ${name}: ${rows.length} records`);
  }

  for (const [key, features] of tiles) {
    const [x, y] = key.split("/");
    const dir = path.join(outDir, String(TILE_ZOOM), x);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${y}.json`),
      JSON.stringify({ type: "FeatureCollection", features }),
    );
  }

  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        source: SOURCE_URL,
        dataset: "SBK 3D-Byggnader (LOD1) generaliserade, Stockholms stad",
        importedZoom: TILE_ZOOM,
        buildings: kept,
        tiles: tiles.size,
      },
      null,
      2,
    ),
  );
  console.log(`\n${kept} buildings in ${tiles.size} tiles -> ${outDir} (skipped ${skipped})`);
}

await main();
