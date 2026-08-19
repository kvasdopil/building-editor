import { featureCollection } from "@turf/helpers";
import type { Feature, MultiPolygon } from "geojson";
import type { BuildingElement, BuildingSelection, BuildingWithParts } from "./buildings";
import { boundsCenter, boundsOverlap, distanceSq, elementBounds, padBounds } from "./geometry";

/** How far around the selected building to pull in 3D context, in meters. */
const NEIGHBOR_PADDING_M = 80;

/** Upper bound on context buildings, so the 3D scene stays light. */
const MAX_NEIGHBORS = 60;

function footprintFeature(
  element: BuildingElement,
  role: "building" | "part",
): Feature<MultiPolygon> {
  return {
    type: "Feature",
    properties: { role },
    geometry: {
      type: "MultiPolygon",
      coordinates: element.polygons.map((p) => [p.outer, ...p.holes]),
    },
  };
}

/**
 * Finish a selection: pick the nearest neighboring buildings within
 * `NEIGHBOR_PADDING_M` as 3D context and build the map highlight outline.
 * Shared by every data source so context behaves identically.
 */
export function assembleSelection(
  target: BuildingWithParts,
  candidates: BuildingWithParts[],
): BuildingSelection {
  const targetBounds = elementBounds(target.building);
  const searchArea = padBounds(targetBounds, NEIGHBOR_PADDING_M);
  const origin = boundsCenter(targetBounds);
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);

  const neighbors = candidates
    .filter((candidate) => candidate.building.id !== target.building.id)
    .map((candidate) => ({ candidate, bounds: elementBounds(candidate.building) }))
    .filter(({ bounds }) => boundsOverlap(bounds, searchArea))
    .map(({ candidate, bounds }) => ({
      candidate,
      distance: distanceSq(boundsCenter(bounds), origin, cosLat),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_NEIGHBORS)
    .map(({ candidate }) => candidate);

  const outline = featureCollection([
    footprintFeature(target.building, "building"),
    ...target.parts.map((part) => footprintFeature(part, "part")),
  ]);
  return { ...target, neighbors, outline };
}
