import area from "@turf/area";
import difference from "@turf/difference";
import intersect from "@turf/intersect";
import { featureCollection, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingProperties, LngLat } from "./buildings";
import {
  closeRing,
  closestPointOnSegment,
  openRing,
  orientRing,
  pointInRing,
  segmentsIntersect,
  signedRingArea,
} from "./geometry";
import { normalizeOsmTags } from "./osm/parse";
import { metersBetween } from "./osm/precision";
import { drawnId } from "./osm/ref";

export type EditableGeometry = Polygon | MultiPolygon;

export interface RingIntersection {
  /** Zero-based indexes of the two non-adjacent segments. */
  segments: [number, number];
  /** The point where the segments meet. */
  at: LngLat;
}

export interface LocalBacktrackRepair {
  /** The vertex whose removal turns the local fold back into a simple ring. */
  nodeIndex: number;
  coordinate: LngLat;
  at: LngLat;
}

/** An existing OSM node dragged from one position to another. */
export interface NodeMove {
  /** Where the node sits in OSM, which is what identifies it. */
  from: LngLat;
  to: LngLat;
}

interface GeometryOverride {
  geometry: EditableGeometry;
  kind: "hole" | "slice" | "add-part" | "glue" | "reshape";
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

/**
 * Join one vertex to an existing vertex. Adjacent duplicates collapse to the
 * surviving corner, matching the node list an OSM node merge produces.
 * Non-adjacent repeats are deliberately retained: they describe a self-touch
 * that validation must reject instead of silently deleting an arbitrary arc.
 */
export function mergeSharedGeometryVertices(
  geometry: EditableGeometry,
  original: LngLat,
  target: LngLat,
): EditableGeometry {
  const polygons = polygonsOf(geometry).map((rings) =>
    rings.map((ring) => {
      const replaced = openRing(ring).map((point) =>
        sameCoordinate(point, original) ? ([...target] as LngLat) : ([...point] as LngLat),
      );
      const merged = replaced.filter(
        (point, index) => index === 0 || !sameCoordinate(replaced[index - 1], point),
      );
      if (merged.length > 1 && sameCoordinate(merged[0], merged[merged.length - 1])) merged.pop();
      return closeRing(merged);
    }),
  );
  return rebuildGeometry(geometry, polygons);
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

function polygonsOf(geometry: EditableGeometry): LngLat[][][] {
  return (
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
  ) as LngLat[][][];
}

function rebuildGeometry(geometry: EditableGeometry, polygons: LngLat[][][]): EditableGeometry {
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

/** Every corner of polygonal geometry, closing coordinates excluded. */
export function geometryVertices(geometry: EditableGeometry): LngLat[] {
  return polygonsOf(geometry).flatMap((rings) => rings.flatMap((ring) => openRing(ring)));
}

/**
 * How far along the segment `point` sits, or null when it is not on it. The
 * endpoints are excluded: a point there is the corner itself, not a place to put
 * a new one. `tolerance` is in meters.
 */
export function positionOnSegment(
  point: LngLat,
  start: LngLat,
  end: LngLat,
  tolerance: number,
): number | null {
  const { at, closest } = closestPointOnSegment(point, start, end);
  if (at <= 0 || at >= 1) return null;
  return metersBetween(point, closest) <= tolerance ? at : null;
}

interface Insertion {
  at: number;
  point: LngLat;
}

/** Insert points into whichever segments of one geometry they sit on. */
function weldIntoGeometry(
  geometry: EditableGeometry,
  points: LngLat[],
  tolerance: number,
): EditableGeometry | null {
  const polygons = polygonsOf(geometry);
  const corners = geometryVertices(geometry);
  const insertions = new Map<string, Map<number, Insertion[]>>();

  for (const point of points) {
    // Already a corner of this element: it shares the position as it is.
    if (corners.some((corner) => metersBetween(corner, point) <= tolerance)) continue;
    let best: { key: string; segment: number; at: number; distance: number } | null = null;
    for (const [polygonIndex, rings] of polygons.entries()) {
      for (const [ringIndex, ring] of rings.entries()) {
        const open = openRing(ring);
        for (let index = 0; index < open.length; index++) {
          const start = open[index];
          const end = open[(index + 1) % open.length];
          const at = positionOnSegment(point, start, end, tolerance);
          if (at === null) continue;
          const distance = metersBetween(point, closestPointOnSegment(point, start, end).closest);
          if (best && distance >= best.distance) continue;
          best = { key: `${polygonIndex}/${ringIndex}`, segment: index, at, distance };
        }
      }
    }
    if (!best) continue;
    const ringInsertions = insertions.get(best.key) ?? new Map<number, Insertion[]>();
    ringInsertions.set(best.segment, [
      ...(ringInsertions.get(best.segment) ?? []),
      { at: best.at, point },
    ]);
    insertions.set(best.key, ringInsertions);
  }
  if (insertions.size === 0) return null;

  return rebuildGeometry(
    geometry,
    polygons.map((rings, polygonIndex) =>
      rings.map((ring, ringIndex) => {
        const ringInsertions = insertions.get(`${polygonIndex}/${ringIndex}`);
        if (!ringInsertions) return ring.map((point) => [...point] as LngLat);
        const welded: LngLat[] = [];
        openRing(ring).forEach((corner, index) => {
          welded.push([...corner] as LngLat);
          const found = ringInsertions.get(index);
          // Several points on one segment keep their order along it.
          if (found) {
            for (const insertion of [...found].sort((a, b) => a.at - b.at)) {
              welded.push([...insertion.point] as LngLat);
            }
          }
        });
        return closeRing(welded);
      }),
    ),
  );
}

/** Insert explicit shared points into every candidate wall they lie on. */
export function weldVerticesIntoGeometries(input: {
  candidates: Record<string, EditableGeometry>;
  points: LngLat[];
  tolerance: number;
}): Record<string, EditableGeometry> {
  const { candidates, points, tolerance } = input;
  const unique: LngLat[] = [];
  for (const point of points) {
    if (unique.some((candidate) => metersBetween(candidate, point) <= tolerance)) continue;
    unique.push(point);
  }

  const welded: Record<string, EditableGeometry> = {};
  for (const [id, geometry] of Object.entries(candidates)) {
    const next = weldIntoGeometry(geometry, unique, tolerance);
    if (next) welded[id] = next;
  }
  return welded;
}

/**
 * Give every element a corner where a new one landed on its wall.
 *
 * Cutting a part in two puts nodes on the walls it ends against, and those walls
 * usually belong to more than the two pieces: the building outline, and any
 * sibling part on the other side. Left out of their rings, the new boundary
 * merely crosses theirs — what JOSM reports as crossing building ways, and what
 * comes apart the first time somebody drags the wall. This is "join node to way"
 * applied to the local model, so the map, the 3D view and the next edit all see
 * one shared corner rather than a coincidence of coordinates.
 *
 * Only genuinely new corners weld. Boolean geometry sends every vertex through a
 * projection round-trip, so an untouched corner comes back a fraction of a
 * millimetre off; `existing` is what tells those apart from a real new node.
 */
export function weldNewVertices(input: {
  /** Rings a new corner may be inserted into, by element id. */
  candidates: Record<string, EditableGeometry>;
  /** Every corner that existed before the edit. */
  existing: LngLat[];
  /** The geometry the edit produced. */
  produced: EditableGeometry[];
  /** How close counts as the same place, in meters. */
  tolerance: number;
}): Record<string, EditableGeometry> {
  const { candidates, existing, produced, tolerance } = input;
  const fresh: LngLat[] = [];
  for (const geometry of produced) {
    for (const vertex of geometryVertices(geometry)) {
      if (existing.some((corner) => metersBetween(corner, vertex) <= tolerance)) continue;
      if (fresh.some((corner) => metersBetween(corner, vertex) <= tolerance)) continue;
      fresh.push(vertex);
    }
  }
  if (fresh.length === 0) return {};

  return weldVerticesIntoGeometries({ candidates, points: fresh, tolerance });
}

function segmentIntersectionPoint(a: LngLat, b: LngLat, c: LngLat, d: LngLat): LngLat {
  const ab: LngLat = [b[0] - a[0], b[1] - a[1]];
  const cd: LngLat = [d[0] - c[0], d[1] - c[1]];
  const denominator = ab[0] * cd[1] - ab[1] * cd[0];
  if (Math.abs(denominator) > 1e-20) {
    const ac: LngLat = [c[0] - a[0], c[1] - a[1]];
    const amount = (ac[0] * cd[1] - ac[1] * cd[0]) / denominator;
    const otherAmount = (ac[0] * ab[1] - ac[1] * ab[0]) / denominator;
    if (amount >= -1e-9 && amount <= 1 + 1e-9 && otherAmount >= -1e-9 && otherAmount <= 1 + 1e-9)
      return [a[0] + amount * ab[0], a[1] + amount * ab[1]];
  }

  // Collinear overlaps have no single mathematical intersection. Returning the
  // first endpoint on the other segment still gives the reviewer the right spot.
  for (const point of [a, b, c, d]) {
    const first = closestPointOnSegment(point, a, b).closest;
    const second = closestPointOnSegment(point, c, d).closest;
    if (metersBetween(point, first) < 0.001 && metersBetween(point, second) < 0.001) return point;
  }
  return closestPointOnSegment(c, a, b).closest;
}

/** Every non-adjacent pair of ring edges that crosses or touches. */
export function ringIntersections(nodes: LngLat[]): RingIntersection[] {
  const open = openRing(nodes);
  const intersections: RingIntersection[] = [];
  const count = open.length;
  for (let i = 0; i < count; i++) {
    const a = open[i];
    const b = open[(i + 1) % count];
    for (let j = i + 1; j < count; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === count - 1)) continue;
      const c = open[j];
      const d = open[(j + 1) % count];
      if (!segmentsIntersect(a, b, c, d)) continue;
      intersections.push({ segments: [i, j], at: segmentIntersectionPoint(a, b, c, d) });
    }
  }
  return intersections;
}

/** A ring that neither repeats a corner nor crosses itself (JOSM: SelfIntersectingWay). */
export function ringIsSimple(nodes: LngLat[]): boolean {
  const open = openRing(nodes);
  return (
    open.length >= 3 &&
    new Set(open.map((point) => point.join(","))).size === open.length &&
    ringIntersections(open).length === 0
  );
}

function withoutRingNode(nodes: LngLat[], nodeIndex: number): LngLat[] {
  return nodes.filter((_, index) => index !== nodeIndex);
}

/**
 * Find the one safe automatic repair for a common boolean-geometry artefact.
 *
 * `A → B → C → D` locally folds back when C lands on the earlier A-B edge.
 * Removing B preserves the new attachment C and the exterior C-D path. This is
 * deliberately narrow: a general bow-tie has two plausible interiors and must
 * be fixed by the mapper, not guessed at by the editor.
 */
export function localBacktrackRepair(
  nodes: LngLat[],
  toleranceMeters = 0.03,
): LocalBacktrackRepair | null {
  const open = openRing(nodes);
  const repairs: LocalBacktrackRepair[] = [];
  for (const crossing of ringIntersections(open)) {
    for (const [first, second] of [crossing.segments, [...crossing.segments].reverse()] as [
      number,
      number,
    ][]) {
      if ((second - first + open.length) % open.length !== 2) continue;
      const a = open[first];
      const bIndex = (first + 1) % open.length;
      const b = open[bIndex];
      const c = open[second];
      const closest = closestPointOnSegment(c, a, b);
      if (closest.at <= 0 || closest.at >= 1 || metersBetween(c, closest.closest) > toleranceMeters)
        continue;
      const repaired = withoutRingNode(open, bIndex);
      if (!ringIsSimple(repaired)) continue;
      repairs.push({ nodeIndex: bIndex, coordinate: b, at: crossing.at });
    }
  }
  const unique = [...new Map(repairs.map((repair) => [repair.nodeIndex, repair])).values()];
  return unique.length === 1 ? unique[0] : null;
}

/** Remove one validator-approved ring vertex, guarding against stale review data. */
export function removeGeometryRingNode(
  geometry: EditableGeometry,
  polygonIndex: number,
  ringIndex: number,
  nodeIndex: number,
  expected: LngLat,
): EditableGeometry | null {
  const polygons = polygonsOf(geometry).map((rings) =>
    rings.map((ring) => ring.map((point) => [...point] as LngLat)),
  );
  const ring = polygons[polygonIndex]?.[ringIndex];
  if (!ring) return null;
  const open = openRing(ring);
  const found = open[nodeIndex];
  if (!found || !sameCoordinate(found, expected) || open.length <= 3) return null;
  const repaired = withoutRingNode(open, nodeIndex);
  if (!ringIsSimple(repaired)) return null;
  polygons[polygonIndex][ringIndex] = closeRing(repaired);
  return rebuildGeometry(geometry, polygons);
}

/** Clean only unambiguous local folds from boolean-operation output. */
export function repairGeometryBacktracks(geometry: EditableGeometry): EditableGeometry {
  const polygons = polygonsOf(geometry).map((rings) =>
    rings.map((ring) => {
      let open = openRing(ring);
      for (;;) {
        const repair = localBacktrackRepair(open);
        if (!repair) break;
        open = withoutRingNode(open, repair.nodeIndex);
      }
      return closeRing(open);
    }),
  );
  return rebuildGeometry(geometry, polygons);
}

function containsPoint(rings: LngLat[][], point: LngLat): boolean {
  return pointInRing(point, rings[0]) && !rings.slice(1).some((hole) => pointInRing(point, hole));
}

const BOOLEAN_AREA_EPSILON_M2 = 1e-6;

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

/**
 * Remove a drawn hole from any solid it overlaps. Unlike `cutHole`, this does
 * not require the complete loop to sit inside the subject: a courtyard can
 * cross several part boundaries, leaving a notch in each part it intersects.
 */
export function subtractHoleFromGeometry(
  geometry: EditableGeometry,
  nodes: LngLat[],
): { changed: boolean; geometry: EditableGeometry | null } | null {
  if (!ringIsSimple(nodes)) return null;
  const closed: LngLat[] = [...nodes, nodes[0]];
  const hole = polygon([closed]);
  const subject: Feature<EditableGeometry> = { type: "Feature", properties: {}, geometry };
  try {
    const shared = intersect(featureCollection([subject, hole]));
    if (!shared || area(shared) <= BOOLEAN_AREA_EPSILON_M2) return { changed: false, geometry };
    const remainder = difference(featureCollection([subject, hole]));
    if (!remainder || area(remainder) <= BOOLEAN_AREA_EPSILON_M2)
      return { changed: true, geometry: null };
    return { changed: true, geometry: remainder.geometry as EditableGeometry };
  } catch {
    return null;
  }
}
