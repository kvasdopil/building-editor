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

const SOURCE_URL =
  "https://dataportalen.stockholm.se/dataportalen/Data/Stadsbyggnadskontoret/LOD1_stadsdelsnamnder_SHP.zip";

const TILE_ZOOM = 16;

/** Ignore blocks smaller than this footprint; they are sheds, not buildings. */
const MIN_AREA_M2 = 10;

// ---------------------------------------------------------------- projection

/**
 * Inverse Gauss conformal projection (Transverse Mercator) for SWEREF99 18 00,
 * following Lantmäteriet's published Krüger series. GRS80 ellipsoid, central
 * meridian 18°, scale 1, false easting 150000.
 */
function makeSweref99Inverse({ lon0 = 18, k0 = 1, falseEasting = 150000, falseNorthing = 0 } = {}) {
  const axis = 6378137.0;
  const flattening = 1 / 298.257222101;

  const e2 = flattening * (2 - flattening);
  const n = flattening / (2 - flattening);
  const aRoof = (axis / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);

  const delta1 = n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96 - n ** 4 / 360;
  const delta2 = n ** 2 / 48 + n ** 3 / 15 - (437 * n ** 4) / 1440;
  const delta3 = (17 * n ** 3) / 480 - (37 * n ** 4) / 840;
  const delta4 = (4397 * n ** 4) / 161280;

  const aStar = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const bStar = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const cStar = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const dStar = -(4279 * e2 ** 4) / 1260;

  const degrees = (radians) => (radians * 180) / Math.PI;

  return function toWgs84(easting, northing) {
    const xi = (northing - falseNorthing) / (k0 * aRoof);
    const eta = (easting - falseEasting) / (k0 * aRoof);

    const xiPrim =
      xi -
      delta1 * Math.sin(2 * xi) * Math.cosh(2 * eta) -
      delta2 * Math.sin(4 * xi) * Math.cosh(4 * eta) -
      delta3 * Math.sin(6 * xi) * Math.cosh(6 * eta) -
      delta4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
    const etaPrim =
      eta -
      delta1 * Math.cos(2 * xi) * Math.sinh(2 * eta) -
      delta2 * Math.cos(4 * xi) * Math.sinh(4 * eta) -
      delta3 * Math.cos(6 * xi) * Math.sinh(6 * eta) -
      delta4 * Math.cos(8 * xi) * Math.sinh(8 * eta);

    const phiStar = Math.asin(Math.sin(xiPrim) / Math.cosh(etaPrim));
    const deltaLambda = Math.atan(Math.sinh(etaPrim) / Math.cos(xiPrim));

    const sinPhi2 = Math.sin(phiStar) ** 2;
    const latitude =
      phiStar +
      Math.sin(phiStar) *
        Math.cos(phiStar) *
        (aStar + bStar * sinPhi2 + cStar * sinPhi2 ** 2 + dStar * sinPhi2 ** 3);

    return [lon0 + degrees(deltaLambda), degrees(latitude)];
  };
}

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

function tileFor(lon, lat) {
  const scale = 2 ** TILE_ZOOM;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * scale),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale),
  };
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// --------------------------------------------------------------------- main

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

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
