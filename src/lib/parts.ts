import area from "@turf/area";
import intersect from "@turf/intersect";
import { featureCollection } from "@turf/helpers";
import type { BuildingElement } from "./buildings";
import { boundsOverlap, elementBounds, elementFeature } from "./geometry";

/**
 * How much of a part must fall inside a building outline before we treat it as
 * belonging to that building. Adjacent buildings in OSM routinely share walls,
 * and therefore vertices, so touching is not evidence of ownership — only real
 * overlap is.
 */
const PART_OVERLAP_MIN = 0.5;

function overlapArea(a: BuildingElement, b: BuildingElement): number {
  if (!boundsOverlap(elementBounds(a), elementBounds(b))) return 0;
  try {
    const shared = intersect(featureCollection([elementFeature(a), elementFeature(b)]));
    return shared ? area(shared) : 0;
  } catch {
    // Self-intersecting or otherwise broken geometry: treat as no overlap
    // rather than guessing.
    return 0;
  }
}

/** Fraction of `inner` that lies inside `outer`, 0 when they only touch. */
export function overlapFraction(part: BuildingElement, building: BuildingElement): number {
  const partArea = area(elementFeature(part));
  if (partArea <= 0) return 0;
  return overlapArea(part, building) / partArea;
}

export function belongsToBuilding(part: BuildingElement, building: BuildingElement): boolean {
  return overlapFraction(part, building) >= PART_OVERLAP_MIN;
}

/**
 * Fraction of the building footprint its parts cover. Parts are summed rather
 * than unioned, so overlapping parts can push this above 1; callers only
 * compare it against a threshold.
 */
export function partsCoverage(building: BuildingElement, parts: BuildingElement[]): number {
  if (parts.length === 0) return 0;
  const footprint = area(elementFeature(building));
  if (footprint <= 0) return 0;
  const covered = parts.reduce((total, part) => total + overlapArea(part, building), 0);
  return covered / footprint;
}
