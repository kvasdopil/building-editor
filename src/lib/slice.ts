import Flatten from "@flatten-js/core";
import type { MultiPolygon, Polygon } from "geojson";
import type { BuildingElement, LngLat } from "./buildings";
import { orientRing, segmentsIntersect } from "./geometry";
import type { EditableGeometry } from "./geometry-edits";
import {
  copiedPartTags,
  firstPartTags,
  firstTowerPartTags,
  inheritedPartTags,
  inheritedTowerPartTags,
} from "./part-tags";

const METERS_PER_DEGREE = 111320;
const MIN_PART_AREA_M2 = 0.1;

interface Projection {
  point(coordinates: LngLat): Flatten.Point;
  coordinates(point: Flatten.Point): LngLat;
}

interface Region {
  geometry: EditableGeometry;
  area: number;
}

interface PartShape {
  element: BuildingElement;
  polygon: Flatten.Polygon;
}

interface SliceAddition extends Region {
  tags: Record<string, string>;
}

interface SliceResult {
  replacements: Record<string, EditableGeometry>;
  additions: SliceAddition[];
}

function elementGeometry(element: BuildingElement): MultiPolygon {
  return {
    type: "MultiPolygon",
    coordinates: element.polygons.map((footprint) => [footprint.outer, ...footprint.holes]),
  };
}

function makeProjection(building: BuildingElement): Projection {
  const points = building.polygons.flatMap((footprint) => footprint.outer);
  const origin: LngLat = points.length
    ? [
        points.reduce((sum, point) => sum + point[0], 0) / points.length,
        points.reduce((sum, point) => sum + point[1], 0) / points.length,
      ]
    : [0, 0];
  const longitudeScale = METERS_PER_DEGREE * Math.cos((origin[1] * Math.PI) / 180);
  return {
    point([longitude, latitude]) {
      return Flatten.point(
        (longitude - origin[0]) * longitudeScale,
        (latitude - origin[1]) * METERS_PER_DEGREE,
      );
    },
    coordinates(point) {
      return [origin[0] + point.x / longitudeScale, origin[1] + point.y / METERS_PER_DEGREE];
    },
  };
}

function geometryPolygon(geometry: EditableGeometry, projection: Projection): Flatten.Polygon {
  const result = new Flatten.Polygon();
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polygons) {
    if (rings.length === 0) continue;
    result.addFace(orientRing(rings[0] as LngLat[], "ccw").map((point) => projection.point(point)));
    for (const hole of rings.slice(1)) {
      result.addFace(orientRing(hole as LngLat[], "cw").map((point) => projection.point(point)));
    }
  }
  return result;
}

function ringFromPoints(points: Flatten.Point[], projection: Projection): LngLat[] {
  const ring = points.map((point) => projection.coordinates(point));
  return ring.length ? [...ring, ring[0]] : ring;
}

function polygonRegions(polygon: Flatten.Polygon, projection: Projection): Region[] {
  return polygon
    .splitToIslands()
    .map((island) => ({ island, area: island.area() }))
    .filter(({ area }) => area >= MIN_PART_AREA_M2)
    .map(({ island, area }) => {
      const faces = [...island.faces]
        .map((face) => ({ face, area: face.area() }))
        .sort((a, b) => b.area - a.area);
      const coordinates = faces.map(({ face }) => ringFromPoints(face.vertices, projection));
      return {
        geometry: { type: "Polygon", coordinates } satisfies Polygon,
        area,
      };
    });
}

function meaningfulIslandCount(polygon: Flatten.Polygon): number {
  return polygon.splitToIslands().filter((island) => island.area() >= MIN_PART_AREA_M2).length;
}

function segments(nodes: Flatten.Point[], closed: boolean): Flatten.Segment[] {
  const result = nodes.slice(1).map((point, index) => Flatten.segment(nodes[index], point));
  if (closed) result.push(Flatten.segment(nodes[nodes.length - 1], nodes[0]));
  return result;
}

function simplePath(nodes: LngLat[], closed: boolean): boolean {
  const edgeCount = closed ? nodes.length : nodes.length - 1;
  if (edgeCount < (closed ? 3 : 1)) return false;
  if (new Set(nodes.map((point) => point.join(","))).size !== nodes.length) return false;
  for (let first = 0; first < edgeCount; first++) {
    const a = nodes[first];
    const b = nodes[(first + 1) % nodes.length];
    for (let second = first + 1; second < edgeCount; second++) {
      if (second === first + 1 || (closed && first === 0 && second === edgeCount - 1)) continue;
      const c = nodes[second];
      const d = nodes[(second + 1) % nodes.length];
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

function partition(
  polygon: Flatten.Polygon,
  cuttingSegments: Flatten.Segment[],
  closed: boolean,
  projection: Projection,
): Region[] {
  if (polygon.isEmpty()) return [];
  if (!closed) {
    return polygonRegions(polygon.cut(new Flatten.Multiline(cuttingSegments)), projection);
  }
  const loop = new Flatten.Polygon(cuttingSegments.map((edge) => edge.start));
  const inside = Flatten.BooleanOperations.intersect(polygon, loop);
  const outside = Flatten.BooleanOperations.subtract(polygon, loop);
  return [...polygonRegions(outside, projection), ...polygonRegions(inside, projection)];
}

/** Count an open cut's output without converting every island back to GeoJSON. */
function partitionCount(polygon: Flatten.Polygon, cuttingSegments: Flatten.Segment[]): number {
  if (polygon.isEmpty()) return 0;
  return meaningfulIslandCount(polygon.cut(new Flatten.Multiline(cuttingSegments)));
}

/**
 * A slice end may rest on any outer or interior ring of the building outline
 * or an existing part: all are real boundaries of the region the polyline divides.
 */
function onAnyBoundary(point: Flatten.Point, polygons: Flatten.Polygon[]): boolean {
  return polygons.some((polygon) => polygon.findEdgeByPoint(point) !== undefined);
}

/**
 * Divide a building with one path, in one of two modes.
 *
 * An **open polyline**, whose ends rest on the outline or on an existing part,
 * partitions what it crosses: uncovered regions become new generic parts, split
 * existing parts keep explicit height plus tags that differ from the outline,
 * and the building outline is left alone.
 *
 * A **closed loop** creates the enclosed center part and leaves the building
 * outline unchanged. It also creates a full-footprint base part when this is
 * the building's first part; existing parts already provide its base geometry.
 */
export function sliceBuilding(
  building: BuildingElement,
  parts: BuildingElement[],
  nodes: LngLat[],
  closed: boolean,
): SliceResult | null {
  if (!simplePath(nodes, closed)) return null;
  const projection = makeProjection(building);
  const buildingPolygon = geometryPolygon(elementGeometry(building), projection);
  if (!buildingPolygon.isValid()) return null;

  const partShapes: PartShape[] = parts.map((element) => ({
    element,
    polygon: geometryPolygon(elementGeometry(element), projection),
  }));

  // A closed path has to wind counter-clockwise: Flatten reads a clockwise face
  // as a hole, and then intersect and subtract both hand back the loop itself
  // instead of the two sides of the cut, duplicating the region.
  const points = (closed ? orientRing(nodes, "ccw") : nodes).map((node) => projection.point(node));
  const cuttingSegments = segments(points, closed);
  if (cuttingSegments.some((segment) => !buildingPolygon.contains(segment))) return null;
  if (!closed) {
    const boundaries = [buildingPolygon, ...partShapes.map((shape) => shape.polygon)];
    if (!onAnyBoundary(points[0], boundaries)) return null;
    if (!onAnyBoundary(points[points.length - 1], boundaries)) return null;
  } else {
    const loop = new Flatten.Polygon(points);
    if (!loop.isValid() || loop.area() < MIN_PART_AREA_M2 || !buildingPolygon.contains(loop))
      return null;

    // A loop describes a tower sitting on the building's parts, not a
    // ring-shaped complement. When no parts exist yet, copy the complete
    // footprint once to establish that base. Otherwise preserve the existing
    // parts and add only the tower; the building=* outline is never replaced.
    try {
      const towerTags =
        parts.length === 0
          ? firstTowerPartTags(building.properties)
          : inheritedTowerPartTags(building.properties);
      const centerParts = polygonRegions(loop, projection).map((region) => ({
        ...region,
        tags: towerTags,
      }));
      if (centerParts.length === 0) return null;
      if (parts.length > 0) return { replacements: {}, additions: centerParts };
      const basePart: SliceAddition = {
        geometry: elementGeometry(building),
        area: buildingPolygon.area(),
        tags: firstPartTags(building.properties),
      };
      return { replacements: {}, additions: [basePart, ...centerParts] };
    } catch {
      return null;
    }
  }

  try {
    // From here the path is an open polyline, which does divide what it crosses.
    // It has to divide something: the outline, an existing part, or the area no
    // part covers yet. A cut that ends on a part boundary leaves the outline
    // whole, so the outline alone cannot decide this.
    const originalIslands = buildingPolygon.splitToIslands().length;
    let divided = partitionCount(buildingPolygon, cuttingSegments) > originalIslands;

    const replacements: Record<string, EditableGeometry> = {};
    const additions: SliceAddition[] = [];
    let uncovered = buildingPolygon.clone();

    for (const { element, polygon } of partShapes) {
      uncovered = Flatten.BooleanOperations.subtract(uncovered, polygon);
      const regions = partition(polygon, cuttingSegments, closed, projection).sort(
        (a, b) => b.area - a.area,
      );
      if (regions.length <= 1) continue;
      divided = true;
      replacements[element.id] = regions[0].geometry;
      additions.push(
        ...regions.slice(1).map((region) => ({
          ...region,
          tags: copiedPartTags(element.properties, building.properties),
        })),
      );
    }

    const uncoveredRegions = partition(uncovered, cuttingSegments, closed, projection);
    if (uncoveredRegions.length > meaningfulIslandCount(uncovered)) divided = true;
    if (!divided) return null;

    additions.push(
      ...uncoveredRegions.map((region) => ({
        ...region,
        tags:
          parts.length === 0
            ? firstPartTags(building.properties)
            : inheritedPartTags(building.properties),
      })),
    );
    return additions.length > 0 || Object.keys(replacements).length > 0
      ? { replacements, additions }
      : null;
  } catch {
    return null;
  }
}
