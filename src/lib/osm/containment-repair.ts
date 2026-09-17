import area from "@turf/area";
import difference from "@turf/difference";
import { featureCollection, feature } from "@turf/helpers";
import type { FeatureCollection } from "geojson";
import type { LngLat } from "../buildings";
import { closestPointOnSegment, openRing, pointInRing } from "../geometry";
import {
  type EditableGeometry,
  type NodeMove,
  type GeometryEditMap,
  type CreatedPartMap,
  geometryVertices,
  geometryHasVertex,
  moveSharedGeometryVertices,
  weldVerticesIntoGeometries,
  ringIsSimple,
} from "../geometry-edits";
import { planGeometryGesture } from "../geometry-transaction";
import { coordinateKey, metersBetween, roundToOsmGrid } from "./precision";

const MAX_DISTANCE = 0.2;
const polygons = (geometry: EditableGeometry) =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as LngLat[][][];
/** Polygon and single-member MultiPolygon describe the same footprint. */
export const containmentGeometryKey = (geometry: EditableGeometry): string =>
  JSON.stringify(polygons(geometry));
const simple = (geometry: EditableGeometry) =>
  polygons(geometry).every((rings) =>
    rings.every((ring) => openRing(ring).length >= 3 && ringIsSimple(openRing(ring))),
  );

export function outsideArea(part: EditableGeometry, parent: EditableGeometry): number {
  const outside = difference(featureCollection([feature(part), feature(parent)]));
  return outside ? area(outside) : 0;
}

/** Conservative vertex-only repair: never clip a part, delete a corner, or split a ring. */
export function containmentRepair(
  part: EditableGeometry,
  parent: EditableGeometry,
): NodeMove[] | null {
  try {
    if (!simple(part) || !simple(parent)) return null;
    const excess = outsideArea(part, parent);
    if (excess <= 0 || excess > 2 || excess / area(feature(part)) >= 0.005) return null;
    const parentPolygons = polygons(parent);
    const edges = parentPolygons.flatMap((rings) =>
      rings.flatMap((ring) => {
        const nodes = openRing(ring);
        return nodes.map((start, index) => [start, nodes[(index + 1) % nodes.length]] as const);
      }),
    );
    const moves: NodeMove[] = [];
    for (const point of geometryVertices(part)) {
      if (moves.some((move) => coordinateKey(move.from) === coordinateKey(point))) continue;
      const nearest = edges
        .map(([start, end]) => closestPointOnSegment(point, start, end).closest)
        .sort((a, b) => metersBetween(point, a) - metersBetween(point, b))[0];
      if (!nearest || metersBetween(point, nearest) < 0.00001) continue;
      if (
        parentPolygons.some(
          ([outer, ...holes]) =>
            pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole)),
        )
      )
        continue;
      if (metersBetween(point, nearest) > MAX_DISTANCE) return null;
      const to = roundToOsmGrid(nearest);
      if (coordinateKey(point) === coordinateKey(to)) return null;
      moves.push({ from: point, to });
    }
    if (!moves.length) return null;
    const repaired = moveSharedGeometryVertices(
      part,
      new Map(moves.map(({ from, to }) => [coordinateKey(from), to])),
    );
    const weldedParent =
      weldVerticesIntoGeometries({
        candidates: { parent },
        points: moves.map((move) => move.to),
        tolerance: 0.01,
      }).parent ?? parent;
    if (!simple(repaired) || !simple(weldedParent) || outsideArea(repaired, weldedParent) > 0.0001)
      return null;
    return moves;
  } catch {
    return null;
  }
}

/** Apply the same move to every loaded owner and join the destination to its host walls. */
export function applyContainmentRepair(
  displayed: FeatureCollection,
  geometryEdits: GeometryEditMap,
  createdParts: CreatedPartMap,
  moves: NodeMove[],
  features: FeatureCollection = displayed,
): { geometryEdits: GeometryEditMap; createdParts: CreatedPartMap } | null {
  const originals: Record<string, EditableGeometry> = {};
  const changed: Record<string, EditableGeometry> = {};
  const destinations = new Map(moves.map(({ from, to }) => [coordinateKey(from), to]));
  for (const item of displayed.features) {
    const id = item.properties?.id;
    if (
      typeof id !== "string" ||
      (item.geometry.type !== "Polygon" && item.geometry.type !== "MultiPolygon")
    )
      continue;
    originals[id] = item.geometry;
    if (moves.some((move) => geometryHasVertex(item.geometry as EditableGeometry, move.from))) {
      changed[id] = moveSharedGeometryVertices(item.geometry, destinations);
    }
  }
  Object.assign(
    changed,
    weldVerticesIntoGeometries({
      candidates: { ...originals, ...changed },
      points: moves.map((move) => move.to),
      tolerance: 0.01,
    }),
  );
  if (Object.values(changed).some((geometry) => !simple(geometry))) return null;
  return planGeometryGesture({
    features,
    geometryEdits,
    createdParts,
    geometries: changed,
    moves,
    gluedEntities: new Set(
      Object.keys(changed).filter(
        (id) => !moves.some((move) => geometryHasVertex(originals[id], move.from)),
      ),
    ),
  });
}
