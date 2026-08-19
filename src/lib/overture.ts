import { featureCollection } from "@turf/helpers";
import { union } from "@turf/union";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

/** Overture buildings theme: current release PMTiles archive. */
export const BUILDINGS_PMTILES_URL =
  "https://tiles.overturemaps.org/2026-07-22.0/buildings.pmtiles";

export type LngLat = [number, number];

/** A polygon footprint in lon/lat: one outer ring plus optional holes. */
export interface Footprint {
  outer: LngLat[];
  holes: LngLat[][];
}

/** Properties carried by Overture building / building_part tile features. */
export interface OvertureProperties {
  id?: string;
  building_id?: string;
  subtype?: string;
  class?: string;
  height?: number;
  num_floors?: number;
  min_height?: number;
  min_floor?: number;
  has_parts?: boolean;
  "@name"?: string;
  [key: string]: unknown;
}

/** An Overture building or building part with assembled polygon geometry. */
export interface BuildingElement {
  id: string;
  properties: OvertureProperties;
  polygons: Footprint[];
}

/** A building together with its parts, if it has any. */
export interface BuildingWithParts {
  building: BuildingElement;
  parts: BuildingElement[];
}

/** The result of picking a building on the map. */
export interface BuildingSelection extends BuildingWithParts {
  /** Nearby buildings, drawn as context in the 3D view. */
  neighbors: BuildingWithParts[];
  /** Outlines of the selected building and its parts, for map highlighting. */
  outline: FeatureCollection;
}

/** How far around the selected building to pull in context, in meters. */
const NEIGHBOR_PADDING_M = 80;

/** Upper bound on context buildings, so the 3D scene stays light. */
const MAX_NEIGHBORS = 60;

const METERS_PER_DEG_LAT = 111320;

type PolygonFeature = Feature<Polygon | MultiPolygon>;

interface FragmentFeature {
  geometry: Polygon | MultiPolygon;
  properties: OvertureProperties | null;
}

function isPolygonal(geometry: FragmentFeature["geometry"]): boolean {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

/**
 * Merge tile fragments of one feature into a single geometry. Vector tiles
 * clip features at tile borders, so a building can arrive as several
 * overlapping pieces; union stitches them back together.
 */
function mergeFragments(fragments: FragmentFeature[]): PolygonFeature | null {
  const features = fragments
    .filter((f) => isPolygonal(f.geometry))
    .map((f): PolygonFeature => ({ type: "Feature", geometry: f.geometry, properties: {} }));
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];
  try {
    return union(featureCollection(features));
  } catch {
    return features[0];
  }
}

function toFootprints(geometry: Polygon | MultiPolygon): Footprint[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .filter((rings) => rings.length > 0 && rings[0].length >= 4)
    .map((rings) => ({
      outer: rings[0].map((p): LngLat => [p[0], p[1]]),
      holes: rings.slice(1).map((ring) => ring.map((p): LngLat => [p[0], p[1]])),
    }));
}

function toElement(id: string, fragments: FragmentFeature[]): BuildingElement | null {
  const merged = mergeFragments(fragments);
  if (!merged) return null;
  const polygons = toFootprints(merged.geometry);
  if (polygons.length === 0) return null;
  const properties = fragments.find((f) => f.properties)?.properties ?? {};
  return { id, properties, polygons };
}

/** [west, south, east, north] */
type Bounds = [number, number, number, number];

function growBounds(bounds: Bounds, geometry: Polygon | MultiPolygon): Bounds {
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  let [west, south, east, north] = bounds;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return [west, south, east, north];
}

function fragmentsBounds(fragments: FragmentFeature[]): Bounds {
  return fragments.reduce<Bounds>(
    (bounds, fragment) => growBounds(bounds, fragment.geometry),
    [180, 90, -180, -90],
  );
}

function boundsCenter([west, south, east, north]: Bounds): LngLat {
  return [(west + east) / 2, (south + north) / 2];
}

function padBounds([west, south, east, north]: Bounds, meters: number): Bounds {
  const lat = (south + north) / 2;
  const dLat = meters / METERS_PER_DEG_LAT;
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Squared distance between two lon/lat points, in degrees-latitude units. */
function distanceSq(a: LngLat, b: LngLat, cosLat: number): number {
  const dx = (a[0] - b[0]) * cosLat;
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function footprintFeature(element: BuildingElement, role: "building" | "part"): PolygonFeature {
  return {
    type: "Feature",
    properties: { role },
    geometry: {
      type: "MultiPolygon",
      coordinates: element.polygons.map((p) => [p.outer, ...p.holes]),
    },
  };
}

function groupBy(
  fragments: FragmentFeature[],
  key: (properties: OvertureProperties) => unknown,
): Map<string, FragmentFeature[]> {
  const groups = new Map<string, FragmentFeature[]>();
  for (const fragment of fragments) {
    if (!fragment.properties) continue;
    const id = key(fragment.properties);
    if (typeof id !== "string") continue;
    const group = groups.get(id) ?? [];
    group.push(fragment);
    groups.set(id, group);
  }
  return groups;
}

function partsOf(fragments: FragmentFeature[] | undefined): BuildingElement[] {
  if (!fragments) return [];
  return [...groupBy(fragments, (p) => p.id).entries()]
    .map(([id, group]) => toElement(id, group))
    .filter((part): part is BuildingElement => part !== null);
}

/**
 * Assemble a selection from the raw tile features of the whole loaded source:
 * fragments are grouped by id, the clicked building and its parts are merged,
 * and buildings whose footprint falls within `NEIGHBOR_PADDING_M` of it are
 * merged too as 3D context (nearest first, capped at `MAX_NEIGHBORS`).
 */
export function buildSelection(
  buildingId: string,
  buildingFragments: FragmentFeature[],
  partFragments: FragmentFeature[],
): BuildingSelection | null {
  const buildingsById = groupBy(buildingFragments, (p) => p.id);
  const partsByBuilding = groupBy(partFragments, (p) => p.building_id);

  const selectedFragments = buildingsById.get(buildingId);
  if (!selectedFragments) return null;
  const building = toElement(buildingId, selectedFragments);
  if (!building) return null;
  const parts = partsOf(partsByBuilding.get(buildingId));

  const selectedBounds = fragmentsBounds(selectedFragments);
  const searchArea = padBounds(selectedBounds, NEIGHBOR_PADDING_M);
  const origin = boundsCenter(selectedBounds);
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);

  const neighbors = [...buildingsById.entries()]
    .filter(([id]) => id !== buildingId)
    .map(([id, fragments]) => ({ id, fragments, bounds: fragmentsBounds(fragments) }))
    .filter(({ bounds }) => boundsOverlap(bounds, searchArea))
    .map((candidate) => ({
      ...candidate,
      distance: distanceSq(boundsCenter(candidate.bounds), origin, cosLat),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_NEIGHBORS)
    .map(({ id, fragments }) => {
      const element = toElement(id, fragments);
      return element ? { building: element, parts: partsOf(partsByBuilding.get(id)) } : null;
    })
    .filter((neighbor): neighbor is BuildingWithParts => neighbor !== null);

  const outline = featureCollection([
    footprintFeature(building, "building"),
    ...parts.map((part) => footprintFeature(part, "part")),
  ]);
  return { building, parts, neighbors, outline };
}
