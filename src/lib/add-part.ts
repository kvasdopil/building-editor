import area from "@turf/area";
import intersect from "@turf/intersect";
import union from "@turf/union";
import { featureCollection, polygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { BuildingElement, LngLat } from "./buildings";
import { closestPointOnSegment, closeRing, elementFeature, openRing } from "./geometry";
import { type EditableGeometry, repairGeometryBacktracks, ringIsSimple } from "./geometry-edits";
import { firstPartTags, inheritedPartTags } from "./part-tags";

const MIN_PART_AREA_M2 = 0.1;
const MAX_INTERIOR_OVERLAP_M2 = 0.01;
const BOUNDARY_TOLERANCE_M = 0.01;
const METERS_PER_DEGREE = 111320;

interface PartAddition {
  geometry: EditableGeometry;
  tags: Record<string, string>;
}

export interface AddPartResult {
  outline: EditableGeometry;
  addition: PartAddition;
  /** Required when the building had no parts before this operation. */
  base: PartAddition | null;
}

function elementGeometry(element: BuildingElement): MultiPolygon {
  return {
    type: "MultiPolygon",
    coordinates: element.polygons.map((footprint) => [footprint.outer, ...footprint.holes]),
  };
}

function samePoint(first: LngLat, second: LngLat): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function distanceMeters(first: LngLat, second: LngLat): number {
  const cosLat = Math.cos((((first[1] + second[1]) / 2) * Math.PI) / 180);
  return Math.hypot(
    (first[0] - second[0]) * cosLat * METERS_PER_DEGREE,
    (first[1] - second[1]) * METERS_PER_DEGREE,
  );
}

interface BoundaryLocation {
  polygonIndex: number;
  /** Segment index plus position along it, normalized into the open ring. */
  position: number;
}

function boundaryLocations(building: BuildingElement, point: LngLat): BoundaryLocation[] {
  const locations: BoundaryLocation[] = [];
  building.polygons.forEach((footprint, polygonIndex) => {
    const ring = openRing(footprint.outer);
    ring.forEach((start, segmentIndex) => {
      const end = ring[(segmentIndex + 1) % ring.length];
      const closest = closestPointOnSegment(point, start, end);
      if (distanceMeters(point, closest.closest) > BOUNDARY_TOLERANCE_M) return;
      const rawPosition = segmentIndex + closest.at;
      const position = rawPosition >= ring.length - 1e-9 ? 0 : rawPosition;
      if (
        !locations.some(
          (location) =>
            location.polygonIndex === polygonIndex &&
            Math.abs(location.position - position) <= 1e-9,
        )
      )
        locations.push({ polygonIndex, position });
    });
  });
  return locations;
}

/** Existing ring vertices encountered from one snapped point to the other. */
function boundaryVertices(ring: LngLat[], from: number, to: number, forward: boolean): LngLat[] {
  const size = ring.length;
  const distanceToTarget = forward ? (to - from + size) % size : (from - to + size) % size;
  return ring
    .map((point, index) => ({
      point,
      distance: forward ? (index - from + size) % size : (from - index + size) % size,
    }))
    .filter(({ distance }) => distance > 1e-9 && distance < distanceToTarget - 1e-9)
    .sort((first, second) => first.distance - second.distance)
    .map(({ point }) => point);
}

/**
 * Close the drawn exterior path along either direction of the same existing
 * outer ring. Following the ring, rather than drawing one chord between the
 * snaps, lets a new part wrap around one or several building corners.
 */
function additionRings(building: BuildingElement, nodes: LngLat[]): LngLat[][] {
  const starts = boundaryLocations(building, nodes[0]);
  const ends = boundaryLocations(building, nodes[nodes.length - 1]);
  const candidates: LngLat[][] = [];
  for (const start of starts) {
    for (const end of ends) {
      if (start.polygonIndex !== end.polygonIndex) continue;
      const ring = openRing(building.polygons[start.polygonIndex].outer);
      for (const forward of [true, false]) {
        const candidate = closeRing([
          ...nodes,
          ...boundaryVertices(ring, end.position, start.position, forward),
        ]);
        if (
          ringIsSimple(openRing(candidate)) &&
          !candidates.some((existing) => JSON.stringify(existing) === JSON.stringify(candidate))
        )
          candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function polygonCount(geometry: Polygon | MultiPolygon): number {
  return geometry.type === "Polygon" ? 1 : geometry.coordinates.length;
}

function geometryIsSimple(geometry: Polygon | MultiPolygon): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.every((rings) => rings.every((ring) => ringIsSimple(openRing(ring as LngLat[]))));
}

/**
 * Expand an outline with a newly drawn exterior part. The first and last nodes
 * sit on the old outer boundary; the loop closes along that boundary, including
 * any corners between them, so the existing path becomes the shared wall.
 * Interior overlap is rejected, as is a footprint that only touches at a point
 * and would add another disconnected polygon to the outline.
 */
export function addPartToBuilding(
  building: BuildingElement,
  existingPartCount: number,
  nodes: LngLat[],
): AddPartResult | null {
  if (nodes.length < 3 || samePoint(nodes[0], nodes[nodes.length - 1])) return null;

  const original: Feature<Polygon | MultiPolygon> = elementFeature(building);
  const valid: {
    addition: Feature<Polygon>;
    merged: Feature<Polygon | MultiPolygon>;
    area: number;
  }[] = [];
  for (const ring of additionRings(building, nodes)) {
    const addition = polygon([ring]);
    const additionArea = area(addition);
    if (additionArea < MIN_PART_AREA_M2) continue;
    const shapes = featureCollection<Polygon | MultiPolygon>([original, addition]);
    try {
      const overlap = intersect(shapes);
      if (overlap && area(overlap) > MAX_INTERIOR_OVERLAP_M2) continue;

      const merged = union(shapes) as Feature<Polygon | MultiPolygon> | null;
      if (!merged || polygonCount(merged.geometry) > polygonCount(original.geometry)) continue;
      if (area(merged) - area(original) < MIN_PART_AREA_M2) continue;
      const repaired = repairGeometryBacktracks(merged.geometry);
      if (!geometryIsSimple(repaired)) continue;
      valid.push({ addition, merged: { ...merged, geometry: repaired }, area: additionArea });
    } catch {
      // Try the other direction around the existing outer ring.
    }
  }
  const selected = valid.sort((first, second) => first.area - second.area)[0];
  if (!selected) return null;

  const tags =
    existingPartCount === 0
      ? firstPartTags(building.properties)
      : inheritedPartTags(building.properties);
  return {
    outline: selected.merged.geometry,
    addition: { geometry: selected.addition.geometry, tags },
    base:
      existingPartCount === 0 ? { geometry: elementGeometry(building), tags: { ...tags } } : null,
  };
}
