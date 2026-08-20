import type { BuildingElement } from "./buildings";
import { type Bounds, elementBounds, padBounds } from "./geometry";
import { type TileId, tileBounds, tilesForBounds } from "./osm/tiles";

/**
 * Stockholm's airborne laser point cloud, read from the tiles produced by
 * scripts/import-lidar.mjs.
 *
 * The cloud is raw measurement, not a model: it is the same laser data the LOD1
 * heights were derived from, before generalization into one block per terrace.
 * Heights arrive in RH2000, the same vertical datum as LOD1's own levels, so a
 * ground reference has to be subtracted before they mean anything in a scene
 * whose buildings start at zero.
 */

/** Bytes before the first coordinate array; see the importer for the layout. */
const HEADER_BYTES = 16;

/** LAS classification for ground returns, used to find the ground level. */
const GROUND_CLASS = 2;

/**
 * How far past the building the cloud is kept. The 3D view draws neighbors
 * within 80 m, and points beyond them are only download and draw cost.
 */
const CLOUD_PADDING_M = 100;

/** Points of a laser cloud in lon/lat plus RH2000 height, parallel arrays. */
export interface LidarCloud {
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  /** Height above the RH2000 zero level, meters. */
  z: Float32Array;
  /** Orthophoto colour per point, as 0-1 RGB triples. */
  colours: Float32Array;
  /** LAS classification per point. */
  classes: Uint8Array;
  /**
   * RH2000 level of the ground under the building: the median of the ground
   * returns nearby, or the lowest point of any class when the roof hides the
   * ground completely.
   */
  groundZ: number;
}

/** z16 tiles the cloud is read from for one building, padded for context. */
function lidarTilesFor(building: BuildingElement): TileId[] {
  return tilesForBounds(cloudBounds(building));
}

function cloudBounds(building: BuildingElement): Bounds {
  return padBounds(elementBounds(building), CLOUD_PADDING_M);
}

interface RawTile {
  count: number;
  zBase: number;
  x: Uint16Array;
  y: Uint16Array;
  z: Uint16Array;
  colour: Uint16Array;
  classes: Uint8Array;
}

/** Read one tile's planar arrays in place, or null when it is not a tile file. */
function readTile(buffer: ArrayBuffer): RawTile | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const header = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== "LDR1") return null;
  const count = header.getUint32(4, true);
  if (buffer.byteLength < HEADER_BYTES + count * 9) return null;

  let at = HEADER_BYTES;
  const take = () => {
    const array = new Uint16Array(buffer, at, count);
    at += count * 2;
    return array;
  };
  return {
    count,
    zBase: header.getFloat32(8, true),
    x: take(),
    y: take(),
    z: take(),
    colour: take(),
    classes: new Uint8Array(buffer, at, count),
  };
}

/**
 * The orthophoto colour is sRGB, the same as every pixel of the aerial image it
 * was sampled from, while Three.js reads vertex colours as linear values.
 */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** RGB565 back to the 0-1 linear channels Three.js wants for vertex colours. */
function unpackColour(packed: number, into: Float32Array, at: number): void {
  into[at] = toLinear(((packed >> 11) & 0x1f) / 31);
  into[at + 1] = toLinear(((packed >> 5) & 0x3f) / 63);
  into[at + 2] = toLinear((packed & 0x1f) / 31);
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Merge the tiles into one cloud, keeping only the points inside `bounds`. A
 * z16 tile is ~300 m across and holds far more of the city than one building's
 * 3D view ever shows.
 */
function mergeTiles(tiles: { tile: TileId; raw: RawTile }[], bounds: Bounds): LidarCloud | null {
  const [west, south, east, north] = bounds;
  const lon: number[] = [];
  const lat: number[] = [];
  const height: number[] = [];
  const packed: number[] = [];
  const classes: number[] = [];
  const groundLevels: number[] = [];
  let lowest = Infinity;

  for (const { tile, raw } of tiles) {
    const [tileWest, tileSouth, tileEast, tileNorth] = tileBounds(tile);
    const lonSpan = tileEast - tileWest;
    const latSpan = tileNorth - tileSouth;
    for (let i = 0; i < raw.count; i++) {
      const pointLon = tileWest + (raw.x[i] / 0xffff) * lonSpan;
      if (pointLon < west || pointLon > east) continue;
      const pointLat = tileSouth + (raw.y[i] / 0xffff) * latSpan;
      if (pointLat < south || pointLat > north) continue;
      const pointZ = raw.zBase + raw.z[i] / 100;
      lon.push(pointLon);
      lat.push(pointLat);
      height.push(pointZ);
      packed.push(raw.colour[i]);
      classes.push(raw.classes[i]);
      if (raw.classes[i] === GROUND_CLASS) groundLevels.push(pointZ);
      if (pointZ < lowest) lowest = pointZ;
    }
  }

  const count = lon.length;
  if (count === 0) return null;

  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) unpackColour(packed[i], colours, i * 3);

  return {
    count,
    lon: Float64Array.from(lon),
    lat: Float64Array.from(lat),
    z: Float32Array.from(height),
    colours,
    classes: Uint8Array.from(classes),
    groundZ: groundLevels.length > 0 ? median(groundLevels) : lowest,
  };
}

/**
 * Fetch the laser cloud around one building. Returns null outside the imported
 * area, which is most of the world: only tiles the importer has run over exist.
 */
export async function fetchLidarCloud(
  building: BuildingElement,
  signal?: AbortSignal,
): Promise<LidarCloud | null> {
  const results = await Promise.all(
    lidarTilesFor(building).map(async (tile) => {
      try {
        const response = await fetch(`/api/lidar/tile/${tile.z}/${tile.x}/${tile.y}`, { signal });
        if (!response.ok) return null;
        const raw = readTile(await response.arrayBuffer());
        return raw ? { tile, raw } : null;
      } catch {
        return null;
      }
    }),
  );
  const loaded = results.filter((entry): entry is { tile: TileId; raw: RawTile } => entry !== null);
  if (loaded.length === 0) return null;
  return mergeTiles(loaded, cloudBounds(building));
}
