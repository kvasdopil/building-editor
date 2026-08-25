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

/** Nearest building outlines eligible for 3D context, before parts are associated. */
export function nearbyBuildings(
  target: BuildingElement,
  candidates: BuildingElement[],
): BuildingElement[] {
  const targetBounds = elementBounds(target);
  const searchArea = padBounds(targetBounds, NEIGHBOR_PADDING_M);
  const origin = boundsCenter(targetBounds);
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);

  return candidates
    .filter((candidate) => candidate.id !== target.id)
    .map((candidate) => ({ candidate, bounds: elementBounds(candidate) }))
    .filter(({ bounds }) => boundsOverlap(bounds, searchArea))
    .map(({ candidate, bounds }) => ({
      candidate,
      distance: distanceSq(boundsCenter(bounds), origin, cosLat),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_NEIGHBORS)
    .map(({ candidate }) => candidate);
}

/** Change only the active entity while retaining its parent's assembled 3D context. */
export function retargetSelection(
  selection: BuildingSelection,
  selected: BuildingElement,
): BuildingSelection {
  const wholeBuilding = selected.id === selection.building.id;
  const outline = featureCollection(
    wholeBuilding
      ? [
          footprintFeature(selection.building, "building"),
          ...selection.parts.map((part) => footprintFeature(part, "part")),
        ]
      : [footprintFeature(selected, "part")],
  );
  return { ...selection, selected, outline };
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
  const byId = new Map(candidates.map((candidate) => [candidate.building.id, candidate] as const));
  const neighbors = nearbyBuildings(
    target.building,
    candidates.map((candidate) => candidate.building),
  ).flatMap((building) => {
    const candidate = byId.get(building.id);
    return candidate ? [candidate] : [];
  });
  return retargetSelection(
    {
      ...target,
      selected: target.building,
      neighbors,
      outline: featureCollection([]),
    },
    selected,
  );
}
