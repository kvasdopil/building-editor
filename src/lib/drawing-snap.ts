import type { Feature, LineString } from "geojson";
import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import type { BuildingElement, LngLat } from "./buildings";
import { openRing } from "./geometry";
import { coordinateKey, roundToOsmGrid } from "./osm/precision";

export const EDGE_SNAP_PIXELS = 12;
export interface BoundarySnap {
  targetId: string;
  coordinates: LngLat;
  distance: number;
  kind: "edge" | "node";
  guides?: Feature<LineString>[];
}
export interface OrthogonalSnap {
  targetId: "orthogonal";
  coordinates: LngLat;
  distance: number;
  kind: "orthogonal";
  guides: Feature<LineString>[];
}
export type DrawingSnap = BoundarySnap | OrthogonalSnap;

/** Longest outer side defines the building axes; holes cannot change the frame. */
export function dominantSide(map: MaplibreMap, building: BuildingElement): [number, number] | null {
  let length = 0;
  let direction: [number, number] | null = null;
  for (const footprint of building.polygons) {
    const ring = openRing(footprint.outer);
    ring.forEach((node, index) => {
      const a = map.project(node);
      const b = map.project(ring[(index + 1) % ring.length]);
      const size = Math.hypot(b.x - a.x, b.y - a.y);
      if (size > length) {
        length = size;
        direction = [(b.x - a.x) / size, (b.y - a.y) / size];
      }
    });
  }
  return direction;
}

/** Shared priority and pixel tolerance for every polyline drawing tool. */
export function resolveDrawingSnap(
  map: MaplibreMap,
  point: { x: number; y: number },
  nodes: LngLat[],
  building: BuildingElement | undefined,
  boundary: BoundarySnap | null,
  reference: BoundarySnap | null,
  disabled: boolean,
  groups: BoundaryGroup[] = [],
): DrawingSnap | null {
  if (disabled) return null;
  boundary ??= nearestBoundary(groups, point);
  if (boundary?.kind === "node") return boundary;
  const direction = building && dominantSide(map, building);
  const anchor = nodes.at(-1);
  if (!direction || !anchor) return boundary ?? reference;
  const origin = map.project(anchor);
  let result: OrthogonalSnap | null = null;
  let intersection: BoundarySnap | null = null;
  for (const [dx, dy] of [direction, [-direction[1], direction[0]]]) {
    const along = (point.x - origin.x) * dx + (point.y - origin.y) * dy;
    if (Math.abs(along) < 1) continue;
    const x = origin.x + along * dx;
    const y = origin.y + along * dy;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance > EDGE_SNAP_PIXELS) continue;
    const coordinate = (sx: number, sy: number): LngLat => {
      const p = map.unproject([sx, sy]);
      return [p.lng, p.lat];
    };
    const guidesAt = (cx: number, cy: number): Feature<LineString>[] =>
      [-4, 4].map((offset) => ({
        type: "Feature",
        properties: { role: "snap-guide" },
        geometry: {
          type: "LineString",
          coordinates: [-8, 8].map((end) =>
            coordinate(cx + end * dx - offset * dy, cy + end * dy + offset * dx),
          ),
        },
      }));
    // Intersect the axis through the previous node with finite boundary segments.
    // Keep boundary identity: these points are valid slice ends / part attachments.
    for (const group of groups) {
      for (const ring of group.rings) {
        for (const [index, start] of ring.entries()) {
          const end = ring[(index + 1) % ring.length];
          const ex = end.x - start.x;
          const ey = end.y - start.y;
          const denominator = dx * ey - dy * ex;
          if (Math.abs(denominator) < 1e-8 * Math.max(1, Math.hypot(ex, ey))) continue;
          const amount = ((start.x - origin.x) * dy - (start.y - origin.y) * dx) / denominator;
          if (amount < 0 || amount > 1) continue;
          const ix = start.x + amount * ex;
          const iy = start.y + amount * ey;
          if (Math.hypot(ix - origin.x, iy - origin.y) < 1) continue;
          const gap = Math.hypot(point.x - ix, point.y - iy);
          if (gap > EDGE_SNAP_PIXELS || (intersection && intersection.distance <= gap)) continue;
          intersection = {
            targetId: group.targetId,
            kind: "edge",
            distance: gap,
            coordinates: [
              start.coordinates[0] + amount * (end.coordinates[0] - start.coordinates[0]),
              start.coordinates[1] + amount * (end.coordinates[1] - start.coordinates[1]),
            ],
            guides: guidesAt(ix, iy),
          };
        }
      }
    }
    if (!result || distance < result.distance)
      result = {
        targetId: "orthogonal",
        kind: "orthogonal",
        distance,
        coordinates: coordinate(x, y),
        guides: guidesAt(x, y),
      };
  }
  return intersection ?? boundary ?? reference ?? result;
}

/** Re-evaluate a stationary pointer immediately when Shift changes. */
export function drawingSnapModifiers(
  map: MaplibreMap,
  refresh: (point: { x: number; y: number }) => void,
) {
  let disabled = false;
  let point: { x: number; y: number } | null = null;
  const track = (event: MapMouseEvent) => {
    point = event.point;
    disabled = event.originalEvent.shiftKey;
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Shift") return;
    disabled = event.type === "keydown";
    if (point) refresh(point);
  };
  const blur = () => {
    disabled = false;
    if (point) refresh(point);
  };
  map.on("mousemove", track);
  map.on("click", track);
  window.addEventListener("keydown", key);
  window.addEventListener("keyup", key);
  window.addEventListener("blur", blur);
  return {
    disabled: () => disabled,
    dispose: () => {
      map.off("mousemove", track);
      map.off("click", track);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
    },
  };
}

export interface ProjectedBoundaryNode {
  coordinates: LngLat;
  x: number;
  y: number;
}

export function projectBoundaryRings(
  map: MaplibreMap,
  rings: LngLat[][],
): ProjectedBoundaryNode[][] {
  return rings.map((ring) =>
    openRing(ring).map((coordinates) => {
      const point = map.project(coordinates);
      return { coordinates, x: point.x, y: point.y };
    }),
  );
}

export function nearestProjectedBoundary(
  projectedRings: ProjectedBoundaryNode[][],
  click: { x: number; y: number },
  targetId: string,
  tolerance: number,
  excludedVertex?: LngLat,
): BoundarySnap | null {
  let nearestNode: BoundarySnap | null = null;
  let nearestEdge: BoundarySnap | null = null;
  const nodeTolerance = Math.min(tolerance, 9);
  const excludedKey = excludedVertex ? coordinateKey(roundToOsmGrid(excludedVertex)) : undefined;
  for (const ring of projectedRings) {
    for (const node of ring) {
      if (excludedKey === coordinateKey(roundToOsmGrid(node.coordinates))) continue;
      const distance = Math.hypot(click.x - node.x, click.y - node.y);
      if (distance > nodeTolerance || (nearestNode && distance >= nearestNode.distance)) continue;
      nearestNode = { targetId, coordinates: node.coordinates, distance, kind: "node" };
    }
    for (let index = 0; index < ring.length; index++) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      if (
        excludedKey &&
        (excludedKey === coordinateKey(roundToOsmGrid(start.coordinates)) ||
          excludedKey === coordinateKey(roundToOsmGrid(end.coordinates)))
      )
        continue;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const amount =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((click.x - start.x) * dx + (click.y - start.y) * dy) / lengthSquared),
            );
      const x = start.x + amount * dx;
      const y = start.y + amount * dy;
      const distance = Math.hypot(click.x - x, click.y - y);
      if (distance > tolerance || (nearestEdge && distance >= nearestEdge.distance)) continue;
      nearestEdge = {
        targetId,
        coordinates: [
          start.coordinates[0] + amount * (end.coordinates[0] - start.coordinates[0]),
          start.coordinates[1] + amount * (end.coordinates[1] - start.coordinates[1]),
        ],
        distance,
        kind: "edge",
      };
    }
  }
  return nearestNode ?? nearestEdge;
}

export interface BoundaryGroup {
  targetId: string;
  rings: ProjectedBoundaryNode[][];
}

export function nearestBoundary(
  groups: BoundaryGroup[],
  point: { x: number; y: number },
  tolerance = EDGE_SNAP_PIXELS,
  excludedVertex?: LngLat,
): BoundarySnap | null {
  let node: BoundarySnap | null = null;
  let edge: BoundarySnap | null = null;
  for (const group of groups) {
    const candidate = nearestProjectedBoundary(
      group.rings,
      point,
      group.targetId,
      tolerance,
      excludedVertex,
    );
    if (candidate?.kind === "node" && (!node || candidate.distance < node.distance))
      node = candidate;
    if (candidate?.kind === "edge" && (!edge || candidate.distance < edge.distance))
      edge = candidate;
  }
  return node ?? edge;
}

/** A transient segment; the cursor never becomes a committed draft vertex. */
export function drawingPreviewSegment(
  nodes: LngLat[],
  cursor: LngLat | null | undefined,
  snap: DrawingSnap | null,
): Feature<LineString> | null {
  const previous = nodes.at(-1);
  if (!previous || !cursor) return null;
  return {
    type: "Feature",
    properties: { role: "cursor-edge" },
    geometry: { type: "LineString", coordinates: [previous, snap?.coordinates ?? cursor] },
  };
}
