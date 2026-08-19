import type { Feature, FeatureCollection } from "geojson";
import type {
  BuildingElement,
  BuildingProperties,
  BuildingSelection,
  BuildingWithParts,
} from "../buildings";
import { elementCenter, pointInElement, toFootprints } from "../geometry";
import { assembleSelection } from "../selection";

/**
 * Build a selection from live OSM features. Unlike Overture, OSM has no
 * `building_id` on parts — Simple 3D Buildings associates a part with whatever
 * building outline it sits inside — so pairing is a spatial test.
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
  return parts.filter((part) => {
    if (pointInElement(elementCenter(part), building)) return true;
    // Concave outlines can put a part's center outside; a shared vertex still counts.
    return part.polygons.some((polygon) =>
      polygon.outer.some((vertex) => pointInElement(vertex, building)),
    );
  });
}

/**
 * Assemble the clicked building, its parts and its neighbors out of the loaded
 * live-OSM feature collection.
 */
export function selectFromOsm(
  collection: FeatureCollection,
  buildingId: string,
): BuildingSelection | null {
  const buildings: BuildingElement[] = [];
  const parts: BuildingElement[] = [];
  for (const feature of collection.features) {
    const element = toElement(feature);
    if (!element) continue;
    if (element.properties.role === "part") parts.push(element);
    else buildings.push(element);
  }

  const target = buildings.find((building) => building.id === buildingId);
  if (!target) return null;

  const withParts = (building: BuildingElement): BuildingWithParts => ({
    building,
    parts: partsInside(building, parts),
  });
  return assembleSelection(
    withParts(target),
    buildings.filter((building) => building.id !== buildingId).map(withParts),
  );
}
