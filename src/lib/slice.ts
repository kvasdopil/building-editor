import Flatten from "@flatten-js/core";
import type { MultiPolygon, Polygon } from "geojson";
import type { BuildingElement, BuildingProperties, LngLat } from "./buildings";
import { orientRing, segmentsIntersect } from "./geometry";
import type { EditableGeometry } from "./geometry-edits";

const METERS_PER_DEGREE = 111320;
const MIN_PART_AREA_M2 = 0.1;

const INHERITED_PART_TAGS = [
  "height",
  "min_height",
  "building:levels",
  "building:min_level",
  "building:material",
  "building:colour",
  "roof:shape",
  "roof:height",
  "roof:levels",
  "roof:direction",
  "roof:orientation",
  "roof:angle",
  "roof:material",
  "roof:colour",
] as const;

interface Projection {
  point(coordinates: LngLat): Flatten.Point;
  coordinates(point: Flatten.Point): LngLat;
}

interface Region {
  geometry: EditableGeometry;
  area: number;
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
    .filter((island) => island.area() >= MIN_PART_AREA_M2)
    .map((island) => {
      const faces = [...island.faces].sort((a, b) => b.area() - a.area());
      const coordinates = faces.map((face) => ringFromPoints(face.vertices, projection));
      return {
        geometry: { type: "Polygon", coordinates } satisfies Polygon,
        area: island.area(),
      };
    });
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

function rawTags(properties: BuildingProperties): Record<string, string> {
  return properties.tags && typeof properties.tags === "object"
    ? { ...(properties.tags as Record<string, string>) }
    : {};
}

function tagsForExistingPart(properties: BuildingProperties): Record<string, string> {
  const tags = rawTags(properties);
  delete tags.building;
  tags["building:part"] ??= "yes";
  return tags;
}

function tagsForNewPart(properties: BuildingProperties): Record<string, string> {
  const source = rawTags(properties);
  const tags: Record<string, string> = { "building:part": "yes" };
  for (const key of INHERITED_PART_TAGS) {
    if (source[key] !== undefined) tags[key] = source[key];
  }
  return tags;
}

/**
 * Partition a building and every existing part with one open boundary-to-boundary
 * polyline or one closed loop. The building outline remains unchanged; uncovered
 * regions become new generic parts, while split existing parts keep their tags.
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

  const points = nodes.map((node) => projection.point(node));
  const cuttingSegments = segments(points, closed);
  if (cuttingSegments.some((segment) => !buildingPolygon.contains(segment))) return null;
  if (!closed) {
    if (!buildingPolygon.findEdgeByPoint(points[0])) return null;
    if (!buildingPolygon.findEdgeByPoint(points[points.length - 1])) return null;
  } else {
    const loop = new Flatten.Polygon(points);
    if (!loop.isValid() || loop.area() < MIN_PART_AREA_M2 || !buildingPolygon.contains(loop))
      return null;
  }

  try {
    const originalIslands = buildingPolygon.splitToIslands().length;
    const buildingRegions = partition(buildingPolygon, cuttingSegments, closed, projection);
    if (buildingRegions.length <= originalIslands) return null;

    const replacements: Record<string, EditableGeometry> = {};
    const additions: SliceAddition[] = [];
    let uncovered = buildingPolygon.clone();

    for (const part of parts) {
      const partPolygon = geometryPolygon(elementGeometry(part), projection);
      uncovered = Flatten.BooleanOperations.subtract(uncovered, partPolygon);
      const regions = partition(partPolygon, cuttingSegments, closed, projection).sort(
        (a, b) => b.area - a.area,
      );
      if (regions.length <= 1) continue;
      replacements[part.id] = regions[0].geometry;
      additions.push(
        ...regions
          .slice(1)
          .map((region) => ({ ...region, tags: tagsForExistingPart(part.properties) })),
      );
    }

    additions.push(
      ...partition(uncovered, cuttingSegments, closed, projection).map((region) => ({
        ...region,
        tags: tagsForNewPart(building.properties),
      })),
    );
    return additions.length > 0 || Object.keys(replacements).length > 0
      ? { replacements, additions }
      : null;
  } catch {
    return null;
  }
}
