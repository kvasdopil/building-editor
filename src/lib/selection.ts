import { featureCollection } from "@turf/helpers";
import type { Feature, MultiPolygon } from "geojson";
import type { BuildingElement, BuildingSelection, BuildingWithParts } from "./buildings";
import {
  boundsCenter,
  boundsOverlap,
  distanceSq,
  elementBounds,
  elementFeature,
  padBounds,
} from "./geometry";

/** How far around the selected building to pull in 3D context, in meters. */
const NEIGHBOR_PADDING_M = 80;

/** Upper bound on context buildings, so the 3D scene stays light. */
const MAX_NEIGHBORS = 60;

function footprintFeature(
  element: BuildingElement,
  role: "building" | "part",
): Feature<MultiPolygon> {
  return { ...elementFeature(element), properties: { id: element.id, role } };
}

/**
 * Finish a selection: pick the nearest neighboring buildings within
 * `NEIGHBOR_PADDING_M` as 3D context and build the map highlight outline.
 * Shared by every data source so context behaves identically.
 */
export function assembleSelection(
  target: BuildingWithParts,
  candidates: BuildingWithParts[],
  selected: BuildingElement = target.building,
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

  const wholeBuilding = selected.id === target.building.id;
  const outline = featureCollection(
    wholeBuilding
      ? [
          footprintFeature(target.building, "building"),
          ...target.parts.map((part) => footprintFeature(part, "part")),
        ]
      : [footprintFeature(selected, "part")],
  );
  return { ...target, selected, neighbors, outline };
}
