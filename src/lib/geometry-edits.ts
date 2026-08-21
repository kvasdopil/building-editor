import area from "@turf/area";
import intersect from "@turf/intersect";
import { featureCollection, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingProperties, LngLat } from "./buildings";
import {
  closeRing,
  openRing,
  orientRing,
  pointInRing,
  segmentsIntersect,
  signedRingArea,
} from "./geometry";
import { normalizeOsmTags } from "./osm/parse";
import { drawnId } from "./osm/ref";

export type EditableGeometry = Polygon | MultiPolygon;

/** An existing OSM node dragged from one position to another. */
export interface NodeMove {
  /** Where the node sits in OSM, which is what identifies it. */
  from: LngLat;
  to: LngLat;
}

interface GeometryOverride {
  geometry: EditableGeometry;
  kind: "hole" | "slice" | "reshape";
  /**
   * Which vertices of this element were dragged. The edited geometry alone
   * cannot say: a corner in a new place looks exactly like a new corner, and an
   * upload that guessed wrong would abandon the node every unloaded fence, path
   * and neighbouring outline still hangs on (see osm/nodes.ts).
   */
  movedNodes?: NodeMove[];
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
            geometry_edit_kind: override.kind,
          },
        };
      }),
      ...Object.values(createdParts),
    ],
  };
}

function sameCoordinate(a: readonly number[], b: LngLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Fold one drag into the moves already recorded for an element. Dragging the
 * same node a second time is still one move, from where OSM has it; dragging it
 * back to where it started is no move at all.
 */
export function recordNodeMove(
  moves: NodeMove[] | undefined,
  from: LngLat,
  to: LngLat,
): NodeMove[] {
  const earlier = moves?.find((move) => sameCoordinate(move.to, from));
  const origin = earlier ? earlier.from : from;
  const rest = (moves ?? []).filter((move) => move !== earlier);
  return sameCoordinate(origin, to) ? rest : [...rest, { from: origin, to }];
}

/** Whether polygonal geometry contains a vertex at this exact OSM coordinate. */
export function geometryHasVertex(geometry: EditableGeometry, coordinates: LngLat): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) =>
    polygon.some((ring) => ring.some((point) => sameCoordinate(point, coordinates))),
  );
}

/** Move every occurrence of one shared coordinate, including ring closures. */
export function moveSharedGeometryVertex(
  geometry: EditableGeometry,
  original: LngLat,
  coordinates: LngLat,
): EditableGeometry {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const movedPolygons = polygons.map((polygon) =>
    polygon.map((ring) =>
      ring.map((point) => (sameCoordinate(point, original) ? coordinates : [...point])),
    ),
  );
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: movedPolygons[0] }
    : { type: "MultiPolygon", coordinates: movedPolygons };
}

/** Insert a vertex after one ring segment and keep its GeoJSON ring closed. */
export function insertGeometryVertex(
  geometry: EditableGeometry,
  polygonIndex: number,
  ringIndex: number,
  segmentIndex: number,
  coordinates: LngLat,
): EditableGeometry | null {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const ring = polygons[polygonIndex]?.[ringIndex] as LngLat[] | undefined;
  const nodes = ring ? openRing(ring).map((point) => [...point] as LngLat) : [];
  if (!ring || nodes.length < 3 || segmentIndex < 0 || segmentIndex >= nodes.length) return null;
  if (nodes.some((point) => point[0] === coordinates[0] && point[1] === coordinates[1]))
    return null;

  nodes.splice(segmentIndex + 1, 0, coordinates);
  const insertedRing = closeRing(nodes);
  const insertedPolygons = polygons.map((polygon, candidatePolygonIndex) =>
    polygon.map((candidateRing, candidateRingIndex) =>
      candidatePolygonIndex === polygonIndex && candidateRingIndex === ringIndex
        ? insertedRing
        : candidateRing.map((point) => [...point]),
    ),
  );

  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: insertedPolygons[0] }
    : { type: "MultiPolygon", coordinates: insertedPolygons };
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
