import type { LngLat } from "../buildings";

/**
 * The only coordinate grid OSM has. The API stores latitude and longitude as
 * fixed-point integers scaled by 1e7, so 7 decimals — about 1.1 cm — is the
 * finest position any node can hold, and rounding to it is lossless.
 *
 * There is deliberately no coarser grid here. Snapping existing nodes to one
 * would *move* them, and adjacent OSM buildings routinely share nodes (see
 * `PART_OVERLAP_MIN` in src/lib/parts.ts), so a move meant for one building
 * would silently drag its neighbours along.
 */
const OSM_COORDINATE_DECIMALS = 7;

const SCALE = 10 ** OSM_COORDINATE_DECIMALS;

/** A coordinate as the API will store it. Values read back from OSM are unchanged. */
export function roundToOsmGrid([lon, lat]: LngLat): LngLat {
  return [Math.round(lon * SCALE) / SCALE, Math.round(lat * SCALE) / SCALE];
}

/** Identity key for a node position: two vertices share it iff OSM stores them alike. */
export function coordinateKey(point: LngLat): string {
  const [lon, lat] = roundToOsmGrid(point);
  return `${lon},${lat}`;
}

/** Lossless decimal text for an upload, without exponent notation. */
export function formatCoordinate(value: number): string {
  return value.toFixed(OSM_COORDINATE_DECIMALS);
}

/** Metres per degree of latitude; longitude scales this by the cosine of the latitude. */
export const METERS_PER_DEG_LAT = 111320;

/** Approximate distance in meters, good enough over the few meters we compare. */
export function metersBetween(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (a[0] - b[0]) * cosLat * METERS_PER_DEG_LAT;
  const dy = (a[1] - b[1]) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}
