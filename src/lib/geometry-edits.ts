import area from "@turf/area";
import intersect from "@turf/intersect";
import { featureCollection, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingProperties, LngLat } from "./buildings";
import { closeRing, orientRing, pointInRing, segmentsIntersect, signedRingArea } from "./geometry";
import { normalizeOsmTags } from "./osm/parse";
import { drawnId } from "./osm/ref";

export type EditableGeometry = Polygon | MultiPolygon;
interface GeometryOverride {
  geometry: EditableGeometry;
  kind: "hole" | "slice";
}
export type GeometryEditMap = Record<string, GeometryOverride>;
export type CreatedPartMap = Record<string, Feature<EditableGeometry, BuildingProperties>>;

export function createPartFeature(
  id: string,
  parentId: string,
  geometry: EditableGeometry,
  tags: Record<string, string>,
): Feature<EditableGeometry, BuildingProperties> {
  const partTags: Record<string, string> = {
    ...tags,
    "building:part": tags["building:part"] ?? "yes",
  };
  delete partTags.building;
  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      ...normalizeOsmTags(partTags, "part"),
      id,
      // A drawn part is a way that does not exist upstream yet, not a kind of its
      // own: the negative id in `id` is what says it is new (see osm/ref.ts).
      osm_type: "way",
      osm_id: drawnId(id) ?? 0,
      version: 0,
      parent_id: parentId,
      tags: partTags,
      locally_modified: true,
      geometry_modified: true,
    },
  };
}

/** Layer local geometry overrides over raw features without mutating tile data. */
export function applyGeometryEdits(
  collection: FeatureCollection,
  edits: GeometryEditMap,
  createdParts: CreatedPartMap = {},
): FeatureCollection {
  return {
    ...collection,
    features: [
      ...collection.features.map((feature) => {
        const id = feature.properties?.id;
        const override = typeof id === "string" ? edits[id] : undefined;
        if (!override) return feature;
        return {
          ...feature,
          geometry: override.geometry,
          properties: {
            ...(feature.properties as BuildingProperties),
            locally_modified: true,
            geometry_modified: true,
          },
        };
      }),
      ...Object.values(createdParts),
    ],
  };
}

/** A ring that neither repeats a corner nor crosses itself (JOSM: SelfIntersectingWay). */
export function ringIsSimple(nodes: LngLat[]): boolean {
  if (nodes.length < 3 || new Set(nodes.map((point) => point.join(","))).size !== nodes.length)
    return false;
  const count = nodes.length;
  for (let i = 0; i < count; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % count];
    for (let j = i + 1; j < count; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === count - 1)) continue;
      const c = nodes[j];
      const d = nodes[(j + 1) % count];
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

function containsPoint(rings: LngLat[][], point: LngLat): boolean {
  return pointInRing(point, rings[0]) && !rings.slice(1).some((hole) => pointInRing(point, hole));
}

/**
 * Add a valid interior ring to polygonal geometry. The loop must be simple,
 * non-trivial, and entirely inside one existing solid (not an existing hole).
 */
export function cutHole(geometry: EditableGeometry, nodes: LngLat[]): EditableGeometry | null {
  if (!ringIsSimple(nodes)) return null;
  const closed: LngLat[] = [...nodes, nodes[0]];
  const hole = polygon([closed]);
  const holeArea = area(hole);
  if (holeArea < 0.1) return null;

  const target: Feature<EditableGeometry> = { type: "Feature", properties: {}, geometry };
  try {
    const shared = intersect(featureCollection([target, hole]));
    if (!shared || area(shared) / holeArea < 0.999) return null;
  } catch {
    return null;
  }

  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const hostIndex = polygons.findIndex((rings) => containsPoint(rings as LngLat[][], nodes[0]));
  if (hostIndex < 0) return null;

  const host = polygons[hostIndex] as LngLat[][];
  // A hole winds opposite its outer ring (GeoJSON RFC 7946).
  const oriented = closeRing(orientRing(closed, signedRingArea(host[0]) > 0 ? "cw" : "ccw"));
  const next = polygons.map((rings, index) =>
    index === hostIndex ? [...rings, oriented] : rings.map((ring) => [...ring]),
  );
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: next[0] }
    : { type: "MultiPolygon", coordinates: next };
}
