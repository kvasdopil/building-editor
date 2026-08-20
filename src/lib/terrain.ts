import type { BuildingElement, BuildingSelection, Footprint, LngLat } from "./buildings";
import { type Bounds, elementBounds, pointInRing } from "./geometry";
import type { TileId } from "./osm/tiles";
import { MAPTERHORN_ZOOM } from "./terrain-config";

/** Mapterhorn's requested DEM zoom. At Stockholm this is roughly 5 m per sample. */
export { MAPTERHORN_ZOOM } from "./terrain-config";

/** Mapterhorn publishes 512 px Terrarium-encoded WebP tiles. */
const TILE_SIZE = 512;

/** A little terrain past the outermost context building keeps the mesh readable. */
const TERRAIN_PADDING_M = 20;

const METERS_PER_DEG_LAT = 111320;

interface TerrainTile {
  id: TileId;
  elevations: Float32Array;
}

/** Decoded Mapterhorn terrain for one 3D scene. */
export interface TerrainModel {
  bounds: Bounds;
  tiles: Map<string, TerrainTile>;
  /** Mapterhorn elevation at the lowest sample inside the selected footprint. */
  referenceZ: number;
}

function tileKey({ z, x, y }: TileId): string {
  return `${z}/${x}/${y}`;
}

function clampLatitude(lat: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

function worldPixel([lon, latitude]: LngLat): [number, number] {
  const lat = clampLatitude(latitude);
  const radians = (lat * Math.PI) / 180;
  const scale = TILE_SIZE * 2 ** MAPTERHORN_ZOOM;
  return [
    ((lon + 180) / 360) * scale,
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale,
  ];
}

function lngLatAtWorldPixel(x: number, y: number): LngLat {
  const scale = TILE_SIZE * 2 ** MAPTERHORN_ZOOM;
  const mercator = Math.PI - (2 * Math.PI * y) / scale;
  return [(x / scale) * 360 - 180, (180 / Math.PI) * Math.atan(Math.sinh(mercator))];
}

function tilesForBounds([west, south, east, north]: Bounds): TileId[] {
  const [minX, minY] = worldPixel([west, north]);
  const [maxX, maxY] = worldPixel([east, south]);
  const firstX = Math.floor(minX / TILE_SIZE);
  const firstY = Math.floor(minY / TILE_SIZE);
  const lastX = Math.floor(maxX / TILE_SIZE);
  const lastY = Math.floor(maxY / TILE_SIZE);
  const tiles: TileId[] = [];
  for (let x = firstX; x <= lastX; x++) {
    for (let y = firstY; y <= lastY; y++) {
      tiles.push({ z: MAPTERHORN_ZOOM, x, y });
    }
  }
  return tiles;
}

function paddedSelectionBounds(selection: BuildingSelection): Bounds {
  const elements = [selection.building, ...selection.neighbors.map(({ building }) => building)];
  const bounds = elements.reduce<Bounds>(
    ([west, south, east, north], element) => {
      const next = elementBounds(element);
      return [
        Math.min(west, next[0]),
        Math.min(south, next[1]),
        Math.max(east, next[2]),
        Math.max(north, next[3]),
      ];
    },
    [180, 90, -180, -90],
  );
  const middleLat = (bounds[1] + bounds[3]) / 2;
  const latPadding = TERRAIN_PADDING_M / METERS_PER_DEG_LAT;
  const lonPadding = latPadding / Math.max(Math.cos((middleLat * Math.PI) / 180), 0.01);
  return [
    bounds[0] - lonPadding,
    bounds[1] - latPadding,
    bounds[2] + lonPadding,
    bounds[3] + latPadding,
  ];
}

function insideFootprint(point: LngLat, footprint: Footprint): boolean {
  return (
    pointInRing(point, footprint.outer) && !footprint.holes.some((hole) => pointInRing(point, hole))
  );
}

function insideElement(point: LngLat, element: BuildingElement): boolean {
  return element.polygons.some((footprint) => insideFootprint(point, footprint));
}

function rawElevation(model: TerrainModel, pixelX: number, pixelY: number): number | null {
  const tileX = Math.floor(pixelX / TILE_SIZE);
  const tileY = Math.floor(pixelY / TILE_SIZE);
  const tile = model.tiles.get(tileKey({ z: MAPTERHORN_ZOOM, x: tileX, y: tileY }));
  if (!tile) return null;
  const localX = ((pixelX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
  const localY = ((pixelY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
  return tile.elevations[localY * TILE_SIZE + localX];
}

/** Bilinearly sample Mapterhorn at a lon/lat coordinate. */
export function terrainElevation(model: TerrainModel, point: LngLat): number | null {
  const [x, y] = worldPixel(point);
  // Raster texels represent pixel centres. Shift the continuous coordinate so
  // integer indices address those centres before bilinear interpolation.
  const sampleX = x - 0.5;
  const sampleY = y - 0.5;
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const tx = sampleX - x0;
  const ty = sampleY - y0;
  const a = rawElevation(model, x0, y0);
  const b = rawElevation(model, x0 + 1, y0);
  const c = rawElevation(model, x0, y0 + 1);
  const d = rawElevation(model, x0 + 1, y0 + 1);
  if (a === null || b === null || c === null || d === null) return a ?? b ?? c ?? d;
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * Lowest Mapterhorn elevation inside an element. Raster sample centres are the
 * source of truth; boundary vertices are included so a footprint smaller than
 * one z13 pixel still receives a deterministic ground elevation.
 */
export function minimumTerrainElevation(model: TerrainModel, element: BuildingElement): number {
  const [west, south, east, north] = elementBounds(element);
  const [minX, minY] = worldPixel([west, north]);
  const [maxX, maxY] = worldPixel([east, south]);
  let minimum = Infinity;

  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
      const point = lngLatAtWorldPixel(x + 0.5, y + 0.5);
      if (!insideElement(point, element)) continue;
      const elevation = rawElevation(model, x, y);
      if (elevation !== null) minimum = Math.min(minimum, elevation);
    }
  }

  for (const footprint of element.polygons) {
    for (const point of footprint.outer) {
      const elevation = terrainElevation(model, point);
      if (elevation !== null) minimum = Math.min(minimum, elevation);
    }
  }

  if (Number.isFinite(minimum)) return minimum;
  const center: LngLat = [(west + east) / 2, (south + north) / 2];
  return terrainElevation(model, center) ?? model.referenceZ;
}

function decodeTerrarium(data: Uint8ClampedArray): Float32Array {
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let pixel = 0; pixel < elevations.length; pixel++) {
    const at = pixel * 4;
    elevations[pixel] = data[at] * 256 + data[at + 1] + data[at + 2] / 256 - 32768;
  }
  return elevations;
}

async function loadTile(id: TileId, signal?: AbortSignal): Promise<TerrainTile | null> {
  try {
    const response = await fetch(`/api/terrain/tile/${id.z}/${id.x}/${id.y}`, { signal });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
    bitmap.close();
    return {
      id,
      elevations: decodeTerrarium(context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data),
    };
  } catch {
    return null;
  }
}

/** Fetch and decode the z13 Mapterhorn terrain needed by one 3D scene. */
export async function fetchTerrain(
  selection: BuildingSelection,
  signal?: AbortSignal,
): Promise<TerrainModel | null> {
  const bounds = paddedSelectionBounds(selection);
  const loaded = await Promise.all(tilesForBounds(bounds).map((tile) => loadTile(tile, signal)));
  const tiles = new Map<string, TerrainTile>();
  for (const tile of loaded) {
    if (tile) tiles.set(tileKey(tile.id), tile);
  }
  if (tiles.size === 0) return null;

  const model: TerrainModel = { bounds, tiles, referenceZ: 0 };
  model.referenceZ = minimumTerrainElevation(model, selection.building);
  return model;
}
