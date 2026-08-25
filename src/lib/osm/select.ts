import type { FeatureCollection } from "geojson";
import type { BuildingSelection } from "../buildings";
import { assembleSelection, nearbyBuildings, retargetSelection } from "../selection";
import { OsmBuildingLookup } from "./building-lookup";

/**
 * Build a selection from live OSM features. Unlike Overture, OSM has no
 * `building_id` on parts — Simple 3D Buildings associates a part with the
 * building outline it sits inside — so pairing is a geometric test.
 */

class OsmMapSelectionLookup {
  private readonly lookup: OsmBuildingLookup;
  private readonly contexts = new Map<string, BuildingSelection>();

  constructor(collection: FeatureCollection) {
    this.lookup = new OsmBuildingLookup(collection);
  }

  select(elementId: string): BuildingSelection | null {
    const group = this.lookup.select(elementId);
    if (!group) return null;

    let context = this.contexts.get(group.building.id);
    if (!context) {
      // Associating every loaded building with every loaded part dominated the
      // click handler. Bounds and distance are enough to choose the at-most-60
      // context outlines; run exact polygon overlap only for those groups.
      const nearby = nearbyBuildings(group.building, this.lookup.buildings);
      context = assembleSelection(
        group,
        nearby.map((building) => this.lookup.groupForBuilding(building)),
        group.building,
      );
      this.contexts.set(group.building.id, context);
    }
    return retargetSelection(context, group.selected);
  }
}

/** One parsed and geometrically associated lookup per immutable displayed snapshot. */
const lookups = new WeakMap<FeatureCollection, OsmMapSelectionLookup>();

/**
 * Assemble the clicked building or part, its parent building, sibling parts,
 * and neighbors out of the loaded live-OSM feature collection.
 */
export function selectFromOsm(
  collection: FeatureCollection,
  elementId: string,
): BuildingSelection | null {
  let lookup = lookups.get(collection);
  if (!lookup) {
    lookup = new OsmMapSelectionLookup(collection);
    lookups.set(collection, lookup);
  }
  return lookup.select(elementId);
}
