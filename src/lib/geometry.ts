import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { BuildingElement, Footprint, LngLat } from "./buildings";

/** [west, south, east, north] */
export type Bounds = [number, number, number, number];

const EMPTY_BOUNDS: Bounds = [180, 90, -180, -90];

const METERS_PER_DEG_LAT = 111320;

function growBounds(bounds: Bounds, ring: LngLat[]): Bounds {
  let [west, south, east, north] = bounds;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

function footprintsBounds(footprints: Footprint[]): Bounds {
  return footprints.reduce<Bounds>((bounds, f) => growBounds(bounds, f.outer), EMPTY_BOUNDS);
}

export function elementBounds(element: BuildingElement): Bounds {
  return footprintsBounds(element.polygons);
}

export function boundsCenter([west, south, east, north]: Bounds): LngLat {
  return [(west + east) / 2, (south + north) / 2];
}

export function padBounds([west, south, east, north]: Bounds, meters: number): Bounds {
  const dLat = meters / METERS_PER_DEG_LAT;
  const cosLat = Math.max(Math.cos((((south + north) / 2) * Math.PI) / 180), 0.01);
  const dLon = dLat / cosLat;
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Squared distance between two lon/lat points, longitude scaled to match. */
export function distanceSq(a: LngLat, b: LngLat, cosLat: number): number {
  const dx = (a[0] - b[0]) * cosLat;
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

export function pointInRing(point: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function ringCenter(ring: LngLat[]): LngLat {
  let lon = 0;
  let lat = 0;
  for (const point of ring) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / ring.length, lat / ring.length];
}

/**
 * Where `point` falls on the segment: `at` is the unclamped parametric position,
 * so 0 and 1 are the endpoints and anything outside that is past them, while
 * `closest` is the nearest point on the segment itself. Longitude is scaled by
 * latitude, so "nearest" means nearest on the ground rather than in degrees.
 */
export function closestPointOnSegment(
  point: LngLat,
  start: LngLat,
  end: LngLat,
): { at: number; closest: LngLat } {
  const cosLat = Math.cos((point[1] * Math.PI) / 180);
  const dx = (end[0] - start[0]) * cosLat;
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { at: 0, closest: start };
  const at = ((point[0] - start[0]) * cosLat * dx + (point[1] - start[1]) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, at));
  return {
    at,
    closest: [start[0] + clamped * (end[0] - start[0]), start[1] + clamped * (end[1] - start[1])],
  };
}

function cross(a: LngLat, b: LngLat, c: LngLat): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: LngLat, b: LngLat, point: LngLat): boolean {
  const epsilon = 1e-12;
  return (
    Math.abs(cross(a, b, point)) < epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon
  );
}

/** Whether segments a-b and c-d meet, touching at an endpoint included. */
export function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/**
 * Signed area of a ring, in squared coordinate units: positive counter-clockwise,
 * negative clockwise. Only the sign is meaningful — use `@turf/area` for meters.
 *
 * OSM itself has no winding convention for buildings ("the direction of the ways
 * does not matter" per the multipolygon wiki, and JOSM only checks the direction
 * of `natural=coastline` and `natural=land`), so this is never a reason to
 * rewrite an existing way. It exists for our own geometry: GeoJSON RFC 7946
 * wants outer rings counter-clockwise and holes clockwise, and turf, MapLibre
 * and the 3D extrusion all read that.
 */
export function signedRingArea(ring: LngLat[]): number {
  const open = openRing(ring);
  let sum = 0;
  for (let index = 0; index < open.length; index++) {
    const current = open[index];
    const next = open[(index + 1) % open.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

/** The ring without its repeated closing point. */
export function openRing(ring: LngLat[]): LngLat[] {
  const last = ring[ring.length - 1];
  return ring.length > 1 && ring[0][0] === last[0] && ring[0][1] === last[1]
    ? ring.slice(0, -1)
    : ring;
}

/** The ring with its closing point repeated, as GeoJSON requires. */
export function closeRing(ring: LngLat[]): LngLat[] {
  const open = openRing(ring);
  return open.length > 0 ? [...open, open[0]] : open;
}

/** The ring re-wound to the requested direction, without its closing point. */
export function orientRing(ring: LngLat[], winding: "ccw" | "cw"): LngLat[] {
  const open = openRing(ring);
  const clockwise = signedRingArea(open) < 0;
  return clockwise === (winding === "cw") ? open : [...open].reverse();
}

/** Convert GeoJSON polygonal geometry into footprints, dropping degenerate rings. */
export function toFootprints(geometry: Polygon | MultiPolygon): Footprint[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .filter((rings) => rings.length > 0 && rings[0].length >= 4)
    .map((rings) => ({
      outer: rings[0].map((p): LngLat => [p[0], p[1]]),
      holes: rings.slice(1).map((ring) => ring.map((p): LngLat => [p[0], p[1]])),
    }));
}

/** The element as a single GeoJSON feature, for turf operations and outlines. */
export function elementFeature(element: BuildingElement): Feature<MultiPolygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiPolygon",
      coordinates: element.polygons.map((p) => [p.outer, ...p.holes]),
    },
  };
}

/** Half-diagonal of a lon/lat bounds, in meters. */
export function boundsRadiusMeters([west, south, east, north]: Bounds): number {
  const cosLat = Math.max(Math.cos((((south + north) / 2) * Math.PI) / 180), 0.01);
  return (
    Math.hypot((east - west) * cosLat * METERS_PER_DEG_LAT, (north - south) * METERS_PER_DEG_LAT) /
    2
  );
}
