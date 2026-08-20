import type { Feature, FeatureCollection } from "geojson";
import type {
  BuildingElement,
  BuildingProperties,
  BuildingSelection,
  BuildingWithParts,
} from "../buildings";
import { toFootprints } from "../geometry";
import { belongsToBuilding, overlapFraction } from "../parts";
import { assembleSelection } from "../selection";

/**
 * Build a selection from live OSM features. Unlike Overture, OSM has no
 * `building_id` on parts — Simple 3D Buildings associates a part with the
 * building outline it sits inside — so pairing is a geometric test.
 */

function toElement(feature: Feature): BuildingElement | null {
  const properties = (feature.properties ?? {}) as BuildingProperties;
  const id = properties.id;
  if (typeof id !== "string") return null;
  if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") return null;
  const polygons = toFootprints(feature.geometry);
  if (polygons.length === 0) return null;
  return { id, properties, polygons };
}

function partsInside(building: BuildingElement, parts: BuildingElement[]): BuildingElement[] {
  return parts.filter((part) => belongsToBuilding(part, building));
}

/**
 * Assemble the clicked building or part, its parent building, sibling parts,
 * and neighbors out of the loaded live-OSM feature collection.
 */
export function selectFromOsm(
  collection: FeatureCollection,
  elementId: string,
): BuildingSelection | null {
  const buildings: BuildingElement[] = [];
  const parts: BuildingElement[] = [];
  for (const feature of collection.features) {
    const element = toElement(feature);
    if (!element) continue;
    if (element.properties.role === "part") parts.push(element);
    else buildings.push(element);
  }

  const withParts = (building: BuildingElement): BuildingWithParts => ({
    building,
    parts: partsInside(building, parts),
  });

  const selectedBuilding = buildings.find((building) => building.id === elementId);
  const selectedPart = parts.find((part) => part.id === elementId);
  const selected = selectedBuilding ?? selectedPart;
  if (!selected) return null;

  const parent = selectedBuilding
    ? selectedBuilding
    : buildings
        .filter((building) => belongsToBuilding(selected, building))
        .sort((a, b) => overlapFraction(selected, b) - overlapFraction(selected, a))[0];
  const target = parent ? withParts(parent) : { building: selected, parts: [] };

  return assembleSelection(
    target,
    buildings.filter((building) => building.id !== target.building.id).map(withParts),
    selected,
  );
}
