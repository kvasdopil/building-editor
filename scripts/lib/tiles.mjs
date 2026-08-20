/**
 * The z16 tile grid the app addresses every dataset by, mirroring
 * src/lib/osm/tiles.ts. Imported datasets are cut to the same grid so one
 * building's tile lookup works for all of them (see ADR 0002).
 */

/** The only zoom the app's tile routes accept. */
export const TILE_ZOOM = 16;

/** The z16 tile a lon/lat falls in. */
export function tileFor(lon, lat) {
  const scale = 2 ** TILE_ZOOM;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * scale),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale),
  };
}

function tileLat(y) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** TILE_ZOOM;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** [west, south, east, north] of one z16 tile. */
export function tileBounds(x, y) {
  const n = 2 ** TILE_ZOOM;
  return [(x / n) * 360 - 180, tileLat(y + 1), ((x + 1) / n) * 360 - 180, tileLat(y)];
}
