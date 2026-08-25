import type { Feature, FeatureCollection } from "geojson";
import type { BuildingElement, BuildingProperties, BuildingWithParts } from "../buildings";
import { toFootprints } from "../geometry";
import { overlapFraction, PART_OVERLAP_MIN } from "../parts";

export interface OsmBuildingGroup extends BuildingWithParts {
  /** The requested entity: either the outline or one of this building's parts. */
  selected: BuildingElement;
}

function toElement(feature: Feature): BuildingElement | null {
  const properties = (feature.properties ?? {}) as BuildingProperties;
  const id = properties.id;
  if (typeof id !== "string") return null;
  if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") return null;
  const polygons = toFootprints(feature.geometry);
  if (polygons.length === 0) return null;
  return { id, properties, polygons };
}

/**
 * Parsed, lazily-associated view of one loaded OSM feature collection.
 *
 * Submission needs only an element's building group. Reusing the map-selection
 * helper for that used to rebuild every building's 3D-neighbour context for
 * every changeset entry, including a building × part polygon-overlap pass each
 * time. This lookup parses the collection once and computes only the requested
 * groups, caching them for sibling edits on the same building.
 */
export class OsmBuildingLookup {
  readonly buildings: BuildingElement[] = [];
  readonly parts: BuildingElement[] = [];

  private readonly byId = new Map<string, BuildingElement>();
  private readonly groups = new Map<string, BuildingWithParts>();
  private readonly parents = new Map<string, BuildingElement | null>();

  constructor(collection: FeatureCollection) {
    for (const feature of collection.features) {
      const element = toElement(feature);
      if (!element) continue;
      this.byId.set(element.id, element);
      if (element.properties.role === "part") this.parts.push(element);
      else this.buildings.push(element);
    }
  }

  groupForBuilding(building: BuildingElement): BuildingWithParts {
    const cached = this.groups.get(building.id);
    if (cached) return cached;
    const group = {
      building,
      parts: this.parts.filter((part) => overlapFraction(part, building) >= PART_OVERLAP_MIN),
    };
    this.groups.set(building.id, group);
    return group;
  }

  private parentFor(part: BuildingElement): BuildingElement | null {
    if (this.parents.has(part.id)) return this.parents.get(part.id) ?? null;
    let parent: BuildingElement | null = null;
    let greatestOverlap = PART_OVERLAP_MIN;
    for (const building of this.buildings) {
      const overlap = overlapFraction(part, building);
      if (overlap < PART_OVERLAP_MIN) continue;
      if (parent && overlap <= greatestOverlap) continue;
      parent = building;
      greatestOverlap = overlap;
    }
    this.parents.set(part.id, parent);
    return parent;
  }

  select(elementId: string): OsmBuildingGroup | null {
    const selected = this.byId.get(elementId);
    if (!selected) return null;
    if (selected.properties.role !== "part") {
      return { ...this.groupForBuilding(selected), selected };
    }
    const building = this.parentFor(selected);
    if (!building) return { building: selected, parts: [], selected };
    return { ...this.groupForBuilding(building), selected };
  }
}
