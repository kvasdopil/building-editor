/**
 * Fixed tile grid for OSM reads. Requests are addressed by tile, never by raw
 * viewport bbox: arbitrary bboxes produce keys that never repeat, so nothing
 * would ever hit cache. See ADR 0002.
 */

/** The only zoom the proxy accepts. z16 is ~600 m across at the equator. */
export const OSM_TILE_ZOOM = 16;

/**
 * Generation of the parsed tile shape, carried in the request URL and in every
 * cache key. A cached tile is a parsed FeatureCollection, so a tile stored by an
 * older parser is missing whatever the new one adds and has to be re-read rather
 * than served — v2 added the node versions and tags a node move needs, and a v1
 * tile would silently turn moving back into replacing. Bumping this misses every
 * cache at once: the browser's HTTP cache, the server memory LRU and its disk
 * store.
 */
export const OSM_TILE_SCHEMA = "v2";

import type { Bounds } from "../geometry";

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export function tileKey({ z, x, y }: TileId): string {
  return `${z}/${x}/${y}`;
}

function tileForLngLat(lng: number, lat: number, z: number = OSM_TILE_ZOOM): TileId {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clampedLat * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

function tileLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function tileBounds({ z, x, y }: TileId): Bounds {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, tileLat(y + 1, z), ((x + 1) / n) * 360 - 180, tileLat(y, z)];
}

function isValidTile({ z, x, y }: TileId): boolean {
  if (z !== OSM_TILE_ZOOM) return false;
  const n = 2 ** z;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < n && y < n;
}

/**
 * Every tile `bounds` touches. Used by the imported local datasets, which are
 * addressed by the same grid but read whole rather than by viewport.
 */
export function tilesForBounds([west, south, east, north]: Bounds): TileId[] {
  const min = tileForLngLat(west, north);
  const max = tileForLngLat(east, south);
  const tiles: TileId[] = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      const tile = { z: OSM_TILE_ZOOM, x, y };
      if (isValidTile(tile)) tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * Tiles covering `bounds`, nearest the center first and capped, so a zoomed-out
 * or fast-panning viewport can never queue an unbounded amount of work.
 */
export function tilesInBounds(bounds: Bounds, limit: number): TileId[] {
  const [west, south, east, north] = bounds;
  const min = tileForLngLat(west, north);
  const max = tileForLngLat(east, south);
  const centerX = (min.x + max.x) / 2;
  const centerY = (min.y + max.y) / 2;
  return tilesForBounds(bounds)
    .sort(
      (a, b) =>
        (a.x - centerX) ** 2 + (a.y - centerY) ** 2 - ((b.x - centerX) ** 2 + (b.y - centerY) ** 2),
    )
    .slice(0, limit);
}

/** Parse a `[z]/[x]/[y]` route segment triple, or null when off-grid. */
export function parseTileParams(params: { z: string; x: string; y: string }): TileId | null {
  const tile: TileId = {
    z: Number.parseInt(params.z, 10),
    x: Number.parseInt(params.x, 10),
    y: Number.parseInt(params.y, 10),
  };
  return isValidTile(tile) ? tile : null;
}
