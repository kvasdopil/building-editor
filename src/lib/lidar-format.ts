import type { Bounds } from "./geometry";

/**
 * The "LDR1" point tile: one binary per z16 tile, planar so the browser can
 * view the arrays without parsing or copying. Written by two producers — the
 * local importer (scripts/import-lidar.mjs) and the on-demand Skog route — and
 * read by the 3D view, so the layout lives here rather than in any of them.
 *
 *   0  "LDR1"          magic
 *   4  uint32          point count
 *   8  float32         zBase, the published orthometric metre level the heights count from
 *   12 uint32          source id (zero is the original Stockholm import)
 *   16 uint16[count]   x, as a fraction of the tile's longitude span
 *      uint16[count]   y, as a fraction of the tile's latitude span
 *      uint16[count]   height above zBase, centimetres
 *      uint16[count]   colour, RGB565
 *      uint8[count]    LAS classification, plus 0x80 for a single return
 */

/**
 * A point that reflected once. Lantmäteriet's national survey labels ground,
 * water and bridges and leaves roofs and vegetation together as unclassified,
 * where the return count is the only separator available: a roof reflects once,
 * a canopy several times. LAS classes fit in the low bits, so the hint rides
 * along in the top one rather than costing another array.
 */
const SINGLE_RETURN = 0x80;

const HEADER_BYTES = 16;
const BYTES_PER_POINT = 9;

const MAGIC = [0x4c, 0x44, 0x52, 0x31]; // "LDR1"

/**
 * Stable ids carried by an LDR1 tile. Zero deliberately remains Stockholm so
 * tiles written before this field was assigned keep their original meaning.
 */
export const LIDAR_SOURCE_ID = {
  STOCKHOLM_2023: 0,
  LASERDATA_SKOG: 1,
  ICGC_TERRITORIAL: 2,
} as const;

export type LidarSourceId = (typeof LIDAR_SOURCE_ID)[keyof typeof LIDAR_SOURCE_ID];

/** Points of a laser cloud, as the tile format stores them. */
export interface PointArrays {
  lon: ArrayLike<number>;
  lat: ArrayLike<number>;
  /** Published orthometric survey height, meters. */
  z: ArrayLike<number>;
  /** RGB565 per point. */
  colour: ArrayLike<number>;
  classification: ArrayLike<number>;
}

/** A tile's planar arrays, viewed in place over the received buffer. */
export interface RawTile {
  count: number;
  zBase: number;
  sourceId: number;
  x: Uint16Array;
  y: Uint16Array;
  z: Uint16Array;
  colour: Uint16Array;
  classes: Uint8Array;
}

/** An empty tile, for everywhere a producer has no points. */
export function emptyTile(): Uint8Array {
  const empty = new Uint8Array(HEADER_BYTES);
  empty.set(MAGIC);
  return empty;
}

/**
 * Quantize points into one tile. Coordinates are stored as a fraction of the
 * tile's own span, so a tile is self-describing given its z/x/y, and heights as
 * centimetres above the tile's lowest point — 655 m of headroom.
 */
export function encodeTile(
  points: PointArrays,
  [west, south, east, north]: Bounds,
  sourceId: LidarSourceId = LIDAR_SOURCE_ID.STOCKHOLM_2023,
): Uint8Array {
  const total = points.z.length;
  let zBase = Infinity;
  for (let i = 0; i < total; i++) zBase = Math.min(zBase, points.z[i]);
  zBase = total > 0 ? Math.floor(zBase) : 0;

  const buffer = new ArrayBuffer(HEADER_BYTES + total * BYTES_PER_POINT);
  const bytes = new Uint8Array(buffer);
  bytes.set(MAGIC);
  const header = new DataView(buffer);
  header.setUint32(4, total, true);
  header.setFloat32(8, zBase, true);
  header.setUint32(12, sourceId, true);

  const x = new Uint16Array(total);
  const y = new Uint16Array(total);
  const z = new Uint16Array(total);
  const colour = new Uint16Array(total);
  const classes = new Uint8Array(total);
  const lonSpan = east - west;
  const latSpan = north - south;
  const clampU16 = (value: number) => Math.min(0xffff, Math.max(0, Math.round(value)));

  for (let i = 0; i < total; i++) {
    x[i] = clampU16(((points.lon[i] - west) / lonSpan) * 0xffff);
    y[i] = clampU16(((points.lat[i] - south) / latSpan) * 0xffff);
    z[i] = clampU16((points.z[i] - zBase) * 100);
    colour[i] = points.colour[i];
    classes[i] = points.classification[i];
  }

  let at = HEADER_BYTES;
  for (const array of [x, y, z, colour]) {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
    at += array.byteLength;
  }
  bytes.set(classes, at);
  return bytes;
}

/** View one tile's planar arrays in place, or null when it is not a tile. */
export function decodeTile(buffer: ArrayBuffer): RawTile | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const magic = new Uint8Array(buffer, 0, 4);
  if (!MAGIC.every((byte, index) => magic[index] === byte)) return null;

  const header = new DataView(buffer);
  const count = header.getUint32(4, true);
  if (buffer.byteLength < HEADER_BYTES + count * BYTES_PER_POINT) return null;

  let at = HEADER_BYTES;
  const take = () => {
    const array = new Uint16Array(buffer, at, count);
    at += count * 2;
    return array;
  };
  return {
    count,
    zBase: header.getFloat32(8, true),
    sourceId: header.getUint32(12, true),
    x: take(),
    y: take(),
    z: take(),
    colour: take(),
    classes: new Uint8Array(buffer, at, count),
  };
}

/** The LAS class of a stored classification byte, without the return flag. */
export function classOf(stored: number): number {
  return stored & ~SINGLE_RETURN;
}

/** Tag a classification byte as a single return, for producers that know. */
export function withSingleReturn(classification: number): number {
  return classification | SINGLE_RETURN;
}

/** Whether a stored classification byte carries the single-return flag. */
export function isSingleReturn(stored: number): boolean {
  return (stored & SINGLE_RETURN) !== 0;
}

/** Pack 8-bit channels into the RGB565 the tile format carries. */
export function packColour(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}
