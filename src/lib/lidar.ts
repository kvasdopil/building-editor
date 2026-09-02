import type { BuildingElement } from "./buildings";
import { type Bounds, elementBounds, padBounds } from "./geometry";
import { LIDAR_SOURCE_ID, type RawTile, classOf, decodeTile } from "./lidar-format";
import { type TileId, tileBounds, tilesForBounds } from "./osm/tiles";

/**
 * Airborne laser point clouds for the selected building, from three sources that
 * speak the same tile format (see `lidar-format.ts`):
 *
 * - `/api/lidar` — imported dense scans: Stockholm's 2023 survey or ICGC's
 *   2021-2023 LiDAR Territorial over a chosen Catalonia area.
 * - `/api/skog` — Lantmäteriet's national "Laserdata Skog" at 1.4 points/m²,
 *   read on demand from upstream COPC files. Sparser and without colour, but
 *   covering the whole country.
 *
 * Both routes are read where available. Dense imported points suppress
 * overlapping Skog points spatially, rather than suppressing a whole tile — a
 * local scan can end halfway through a z16 tile. Heights stay as survey levels
 * here; the 3D overlay aligns each survey to Mapterhorn terrain separately.
 */

/** LAS classification for ground returns, used to find the ground level. */
const GROUND_CLASS = 2;

const METERS_PER_DEG_LAT = 111320;

/**
 * How far past the building the cloud is kept. The 3D view draws neighbors
 * within 80 m, and points beyond them are only download and draw cost.
 */
const CLOUD_PADDING_M = 100;

/** Resolution of the dense survey's spatial coverage mask. */
const DENSE_PRIORITY_CELL_M = 1;

/** Which survey a cloud's points came from. Several can appear at a border. */
export type LidarSurvey = "Stockholm 2023" | "Laserdata Skog" | "ICGC LiDAR Territorial 2021–2023";
export type LidarSource = LidarSurvey | "multiple surveys";

const SURVEY_ID: Record<LidarSurvey, number> = {
  "Stockholm 2023": LIDAR_SOURCE_ID.STOCKHOLM_2023,
  "Laserdata Skog": LIDAR_SOURCE_ID.LASERDATA_SKOG,
  "ICGC LiDAR Territorial 2021–2023": LIDAR_SOURCE_ID.ICGC_TERRITORIAL,
};

/** Zero is the backward-compatible id of every pre-existing local tile. */
function importedSurvey(raw: RawTile): LidarSurvey {
  return raw.sourceId === LIDAR_SOURCE_ID.ICGC_TERRITORIAL
    ? "ICGC LiDAR Territorial 2021–2023"
    : "Stockholm 2023";
}

/** Points in lon/lat plus the source's orthometric height, parallel arrays. */
export interface LidarCloud {
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  /** Published orthometric height, meters. */
  z: Float32Array;
  /** Orthophoto colour per point, as 0-1 RGB triples. */
  colours: Float32Array;
  /** LAS classification per point. */
  classes: Uint8Array;
  /** Stable `LIDAR_SOURCE_ID` value for each point's survey. */
  surveys: Uint8Array;
  /**
   * Legacy flat-scene fallback: median nearby ground-return level, or the
   * lowest point when no ground is visible. Mapterhorn replaces this as soon as
   * terrain is available and remains the source of truth.
   */
  groundZ: number;
  /**
   * Typical distance between neighbouring points, meters. The surveys
   * differ by a factor of four in spacing, so the 3D view sizes its dots from
   * this instead of a constant: dots the size of the spacing read as a surface,
   * while city-sized dots on national data read as a faint dusting.
   */
  spacing: number;
  /** The survey behind these points, for the inspector to name. */
  source: LidarSource;
}

/** z16 tiles the cloud is read from for one building, padded for context. */
function lidarTilesFor(building: BuildingElement): TileId[] {
  return tilesForBounds(cloudBounds(building));
}

/**
 * The lon/lat box a building's cloud covers. Exported because a caller that
 * reads tiles itself — the server-side CLI in scripts/roof-advice.mjs — has to
 * clip to the same box as the browser does, or measure a different cloud.
 */
export function cloudBounds(building: BuildingElement): Bounds {
  return padBounds(elementBounds(building), CLOUD_PADDING_M);
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
export function mergeTiles(tiles: LoadedTile[], bounds: Bounds): LidarCloud | null {
  const [west, south, east, north] = bounds;
  const cosLat = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const area = (east - west) * METERS_PER_DEG_LAT * cosLat * ((north - south) * METERS_PER_DEG_LAT);
  const lon: number[] = [];
  const lat: number[] = [];
  const height: number[] = [];
  const packed: number[] = [];
  const classes: number[] = [];
  const surveys: number[] = [];
  const groundLevels: number[] = [];
  const sources = new Set<LidarSurvey>();
  const denseCells = new Set<string>();
  let lowest = Infinity;

  const cellFor = (pointLon: number, pointLat: number): [number, number] => [
    Math.floor(((pointLon - west) * METERS_PER_DEG_LAT * cosLat) / DENSE_PRIORITY_CELL_M),
    Math.floor(((pointLat - south) * METERS_PER_DEG_LAT) / DENSE_PRIORITY_CELL_M),
  ];
  const nearDensePoint = (cellX: number, cellY: number) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (denseCells.has(`${cellX + dx}/${cellY + dy}`)) return true;
      }
    }
    return false;
  };

  // Dense imported data is visited first so it can establish the spatial
  // priority mask before the Swedish national fallback is considered.
  const ordered = [...tiles].sort(
    (a, b) => Number(a.source === "Laserdata Skog") - Number(b.source === "Laserdata Skog"),
  );
  for (const { tile, raw, source } of ordered) {
    const [tileWest, tileSouth, tileEast, tileNorth] = tileBounds(tile);
    const lonSpan = tileEast - tileWest;
    const latSpan = tileNorth - tileSouth;
    for (let i = 0; i < raw.count; i++) {
      const pointLon = tileWest + (raw.x[i] / 0xffff) * lonSpan;
      if (pointLon < west || pointLon > east) continue;
      const pointLat = tileSouth + (raw.y[i] / 0xffff) * latSpan;
      if (pointLat < south || pointLat > north) continue;
      const pointZ = raw.zBase + raw.z[i] / 100;
      const [cellX, cellY] = cellFor(pointLon, pointLat);
      if (source === "Laserdata Skog" && nearDensePoint(cellX, cellY)) continue;
      if (source !== "Laserdata Skog") denseCells.add(`${cellX}/${cellY}`);
      lon.push(pointLon);
      lat.push(pointLat);
      height.push(pointZ);
      packed.push(raw.colour[i]);
      classes.push(raw.classes[i]);
      surveys.push(SURVEY_ID[source]);
      sources.add(source);
      if (classOf(raw.classes[i]) === GROUND_CLASS) groundLevels.push(pointZ);
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
    surveys: Uint8Array.from(surveys),
    groundZ: groundLevels.length > 0 ? median(groundLevels) : lowest,
    spacing: Math.sqrt(area / count),
    source: sources.size === 1 ? [...sources][0] : "multiple surveys",
  };
}

/** One decoded tile with the survey it came from, ready to merge. */
export interface LoadedTile {
  tile: TileId;
  raw: RawTile;
  source: LidarSurvey;
}

/** Every applicable survey for a tile; overlap is resolved after decoding. */
async function loadTile(tile: TileId, signal?: AbortSignal): Promise<LoadedTile[]> {
  const routes = [
    { route: "lidar", source: null },
    { route: "skog", source: "Laserdata Skog" as const },
  ] as const;
  const loaded = await Promise.all(
    routes.map(async ({ route, source }): Promise<LoadedTile | null> => {
      try {
        const response = await fetch(`/api/${route}/tile/${tile.z}/${tile.x}/${tile.y}`, {
          signal,
        });
        if (!response.ok) return null;
        const raw = decodeTile(await response.arrayBuffer());
        if (!raw || raw.count === 0) return null;
        return { tile, raw, source: source ?? importedSurvey(raw) };
      } catch {
        // Aborted or offline: treat as no data, like any tile without points.
        return null;
      }
    }),
  );
  return loaded.filter((entry): entry is LoadedTile => entry !== null);
}

/**
 * Fetch the laser cloud around one building. Returns null where no imported
 * survey has points and the Swedish national source is unavailable.
 */
export async function fetchLidarCloud(
  building: BuildingElement,
  signal?: AbortSignal,
): Promise<LidarCloud | null> {
  const results = await Promise.all(lidarTilesFor(building).map((tile) => loadTile(tile, signal)));
  const loaded = results.flat();
  if (loaded.length === 0) return null;
  return mergeTiles(loaded, cloudBounds(building));
}
