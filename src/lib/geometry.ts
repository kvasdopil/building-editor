import type { MultiPolygon, Polygon } from "geojson";
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

function pointInFootprint(point: LngLat, footprint: Footprint): boolean {
  if (!pointInRing(point, footprint.outer)) return false;
  return !footprint.holes.some((hole) => pointInRing(point, hole));
}

export function pointInElement(point: LngLat, element: BuildingElement): boolean {
  return element.polygons.some((polygon) => pointInFootprint(point, polygon));
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

export function elementCenter(element: BuildingElement): LngLat {
  return boundsCenter(elementBounds(element));
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
