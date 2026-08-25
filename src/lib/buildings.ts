import type { FeatureCollection } from "geojson";

export type LngLat = [number, number];

/** A polygon footprint in lon/lat: one outer ring plus optional holes. */
export interface Footprint {
  outer: LngLat[];
  holes: LngLat[][];
}

/**
 * Normalized properties that every source maps onto, so height rules, map
 * colors and the 3D view stay source-agnostic. Each adapter also keeps the
 * source's own raw fields on the same object, for the inspector to show.
 */
export interface BuildingProperties {
  id?: string;
  building_id?: string;
  subtype?: string;
  class?: string;
  height?: number;
  num_floors?: number;
  min_height?: number;
  min_floor?: number;
  roof_shape?: string;
  roof_height?: number;
  roof_orientation?: string;
  roof_direction?: string;
  has_parts?: boolean;
  /** Pending local edits exist for this element; used by derived map styling. */
  locally_modified?: boolean;
  /** A local footprint override exists. */
  geometry_modified?: boolean;
  /** Why the local geometry differs, so 3D can distinguish holes from reshaping. */
  geometry_edit_kind?: "hole" | "slice" | "add-part" | "glue" | "reshape";
  "@name"?: string;
  [key: string]: unknown;
}

/** A building or building part with assembled polygon geometry. */
export interface BuildingElement {
  id: string;
  properties: BuildingProperties;
  polygons: Footprint[];
}

/** A building together with its parts, if it has any. */
export interface BuildingWithParts {
  building: BuildingElement;
  parts: BuildingElement[];
}

/** The result of picking a building on the map. */
export interface BuildingSelection extends BuildingWithParts {
  /** The entity the user picked: either the building outline or one of its parts. */
  selected: BuildingElement;
  /** Nearby buildings, drawn as context in the 3D view. */
  neighbors: BuildingWithParts[];
  /** Geometry to highlight for the active building or part. */
  outline: FeatureCollection;
}
