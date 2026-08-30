import Flatten from "@flatten-js/core";
import { ShapeUtils, Vector2 } from "three";
import type { BuildingElement, BuildingProperties } from "./buildings";
import { verticalExtent } from "./heights";

export type Point2 = [number, number];

export interface RoofFootprint {
  outer: Point2[];
  holes: Point2[][];
}

export type RoofShape =
  | "pyramidal"
  | "hipped"
  | "dome"
  | "onion"
  | "gabled"
  | "gambrel"
  | "round"
  | "skillion";
export type RoofOrientation = "along" | "across";

export interface RoofPlan {
  shape: RoofShape;
  /** Ridge alignment relative to the footprint's long axis. */
  orientation: RoofOrientation;
  /** Downslope compass bearing for a directional roof. */
  direction?: number;
  /** Compass text is a look direction that resolves to the hit edge's normal. */
  directionFromCompass: boolean;
  /** Height of the facade/roof join above the building datum. */
  eaves: number;
  /** Height of the roof apex above the building datum. */
  top: number;
}

export interface RoofSurface {
  /** XYZ vertices, ready for a Three.js position attribute. */
  positions: Float32Array;
  /** Present when faces share vertices for smooth normal calculation. */
  indices?: Uint32Array;
  /** Vertical fill between the flat facade extrusion and the shaped roof. */
  wallPositions?: Float32Array;
  /** Reference center used for roof placement and diagnostics. */
  center: Point2;
}

export interface ResolvedRoofPlan {
  plan: RoofPlan;
  /** The footprint whose minimum rectangle establishes the shared roof axis. */
  frameElement: BuildingElement;
  /** True when a part is clipped by the parent building's roof. */
  shared: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const COMPASS_BEARINGS: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

/** Whether the raw tag is one of OSM's named compass directions. */
export function isCompassRoofDirection(value: unknown): boolean {
  return typeof value === "string" && value.trim().toUpperCase() in COMPASS_BEARINGS;
}

/** Parse OSM compass text or degrees into a clockwise bearing from north. */
export function parseRoofDirection(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (normalized in COMPASS_BEARINGS) return COMPASS_BEARINGS[normalized];
  const degrees = Number(normalized.replace(/°$/, ""));
  if (!Number.isFinite(degrees) || degrees < 0 || degrees > 360) return undefined;
  return degrees === 360 ? 0 : degrees;
}

/**
 * Resolve the shaped-roof section of a solid. Total OSM `height` includes the
 * roof, so the facade ends at `top - roof:height`. Keeping this policy here
 * leaves the extrusion code independent of individual roof types.
 */
export function roofPlan(
  properties: BuildingProperties,
  extent: { base: number; top: number },
  parent?: BuildingProperties,
): RoofPlan | null {
  // Accept common descriptive aliases when reading existing data without ever
  // requiring them from the UI, which writes the standard OSM values.
  const rawShape = properties.roof_shape ?? parent?.roof_shape;
  const shape =
    rawShape === "pyramidal" || rawShape === "pyramid"
      ? "pyramidal"
      : rawShape === "hipped"
        ? "hipped"
        : rawShape === "dome" || rawShape === "sphere"
          ? "dome"
          : rawShape === "onion"
            ? "onion"
            : rawShape === "gabled"
              ? "gabled"
              : rawShape === "gambrel"
                ? "gambrel"
                : rawShape === "round"
                  ? "round"
                  : rawShape === "skillion"
                    ? "skillion"
                    : null;
  if (shape === null) return null;

  const requestedHeight = finiteNumber(properties.roof_height) ?? finiteNumber(parent?.roof_height);
  const availableHeight = extent.top - extent.base;
  if (requestedHeight === undefined || requestedHeight <= 0 || availableHeight <= 0) return null;

  const height = Math.min(requestedHeight, availableHeight);
  const rawOrientation = properties.roof_orientation ?? parent?.roof_orientation;
  const orientation: RoofOrientation = rawOrientation === "across" ? "across" : "along";
  const rawDirection = properties.roof_direction ?? parent?.roof_direction;
  const direction = parseRoofDirection(rawDirection);
  return {
    shape,
    orientation,
    direction,
    directionFromCompass: isCompassRoofDirection(rawDirection),
    eaves: extent.top - height,
    top: extent.top,
  };
}

/** Footprint that owns the independent roof frame for an element. */
export function roofFrameElement(
  element: BuildingElement,
  parent: BuildingElement,
): BuildingElement {
  const ownShape =
    typeof element.properties.roof_shape === "string" &&
    element.properties.roof_shape.trim() !== "";
  const ownHeight = finiteNumber(element.properties.roof_height) !== undefined;
  const ownOrientation =
    typeof element.properties.roof_orientation === "string" &&
    element.properties.roof_orientation.trim() !== "";
  const effectiveShape = element.properties.roof_shape ?? parent.properties.roof_shape;
  const ownDirection =
    effectiveShape === "skillion" &&
    typeof element.properties.roof_direction === "string" &&
    element.properties.roof_direction.trim() !== "";
  const shared =
    element.id !== parent.id && !ownShape && !ownHeight && !ownOrientation && !ownDirection;
  return shared ? parent : element;
}

/**
 * A part with its own shape, height, orientation, or direction is an independent roof.
 * Without any of them it is a clipping solid under the parent building's roof,
 * sharing the parent's height, profile and axis so adjacent untagged parts meet
 * on one continuous surface.
 */
export function resolvedRoofPlan(
  element: BuildingElement,
  parent: BuildingElement,
  metersPerLevel: number,
): ResolvedRoofPlan | null {
  const frameElement = roofFrameElement(element, parent);
  const shared = element.id !== parent.id && frameElement.id === parent.id;
  const extent = verticalExtent(
    frameElement.properties,
    metersPerLevel,
    frameElement.id === parent.id ? undefined : parent.properties,
  );
  const plan = roofPlan(
    frameElement.properties,
    extent,
    frameElement.id === parent.id ? undefined : parent.properties,
  );
  return plan ? { plan, frameElement, shared } : null;
}

/** Area-weighted centroid across all outer rings, with a vertex average fallback. */
export function roofCenter(outlines: Point2[][]): Point2 {
  let weightedX = 0;
  let weightedY = 0;
  let totalArea = 0;
  let fallbackX = 0;
  let fallbackY = 0;
  let fallbackCount = 0;

  for (const outline of outlines) {
    if (outline.length < 3) continue;
    let twiceArea = 0;
    let centroidX = 0;
    let centroidY = 0;
    for (let index = 0; index < outline.length; index++) {
      const current = outline[index];
      const next = outline[(index + 1) % outline.length];
      const cross = current[0] * next[1] - next[0] * current[1];
      twiceArea += cross;
      centroidX += (current[0] + next[0]) * cross;
      centroidY += (current[1] + next[1]) * cross;
      fallbackX += current[0];
      fallbackY += current[1];
      fallbackCount++;
    }
    if (Math.abs(twiceArea) < 1e-9) continue;
    const area = Math.abs(twiceArea) / 2;
    weightedX += (centroidX / (3 * twiceArea)) * area;
    weightedY += (centroidY / (3 * twiceArea)) * area;
    totalArea += area;
  }

  if (totalArea > 0) return [weightedX / totalArea, weightedY / totalArea];
  return fallbackCount > 0 ? [fallbackX / fallbackCount, fallbackY / fallbackCount] : [0, 0];
}

/**
 * Collapse the top outline of a building part to one center point. Each edge
 * becomes one hard-shaded triangular roof face; adding another roof type later
 * means adding another surface builder beside this one.
 */
export function pyramidalRoofSurface(
  outlines: Point2[][],
  eaves: number,
  top: number,
): RoofSurface | null {
  const usable = outlines.filter((outline) => outline.length >= 3);
  if (usable.length === 0 || top <= eaves) return null;
  const center = roofCenter(usable);
  const positions: number[] = [];

  for (const outline of usable) {
    for (let index = 0; index < outline.length; index++) {
      const start = outline[index];
      const end = outline[(index + 1) % outline.length];
      // Keep face normals pointing upward regardless of source ring winding.
      const edgeX = end[0] - start[0];
      const edgeY = end[1] - start[1];
      const apexX = center[0] - start[0];
      const apexY = center[1] - start[1];
      const normalY = edgeY * apexX - edgeX * apexY;
      const triangle =
        normalY >= 0
          ? [start[0], eaves, start[1], end[0], eaves, end[1], center[0], top, center[1]]
          : [end[0], eaves, end[1], start[0], eaves, start[1], center[0], top, center[1]];
      positions.push(...triangle);
    }
  }

  return { positions: Float32Array.from(positions), center };
}

type StraightSkeletonBuilder = (typeof import("straight-skeleton"))["SkeletonBuilder"];
type StraightSkeletonModule = typeof import("straight-skeleton") & {
  default?: typeof import("straight-skeleton");
};
type StraightSkeletonVertex = [number, number, number];

let straightSkeletonBuilder: StraightSkeletonBuilder | null = null;
let straightSkeletonInitialization: Promise<boolean> | null = null;

/** True once the skeleton engine can build hipped roofs rather than pyramids. */
export function hippedRoofGeometryReady(): boolean {
  return straightSkeletonBuilder !== null;
}

/** Initialize the browser-only CGAL/Wasm engine once before building hipped roofs. */
export function initializeHippedRoofGeometry(): Promise<boolean> {
  if (straightSkeletonBuilder) return Promise.resolve(true);
  if (straightSkeletonInitialization) return straightSkeletonInitialization;
  if (typeof window === "undefined") return Promise.resolve(false);

  straightSkeletonInitialization = import("straight-skeleton")
    .then(async (loadedModule) => {
      const skeletonModule = loadedModule as StraightSkeletonModule;
      const SkeletonBuilder =
        skeletonModule.SkeletonBuilder ?? skeletonModule.default?.SkeletonBuilder;
      if (!SkeletonBuilder) return false;
      await SkeletonBuilder.init();
      straightSkeletonBuilder = SkeletonBuilder;
      return true;
    })
    .catch(() => false);
  return straightSkeletonInitialization;
}

function samePoint(first: Point2, second: Point2): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function skeletonRing(points: Point2[], counterClockwise: boolean): Point2[] | null {
  const ring: Point2[] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
    if (!ring.length || !samePoint(ring[ring.length - 1], point)) ring.push(point);
  }
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
  if (ring.length < 3 || Math.abs(signedArea(ring)) <= 1e-9) return null;
  const directed = oriented(ring, counterClockwise);
  return [...directed, directed[0]];
}

function skeletonFace(vertices: StraightSkeletonVertex[]): StraightSkeletonVertex[] {
  const face: StraightSkeletonVertex[] = [];
  for (const vertex of vertices) {
    const previous = face[face.length - 1];
    if (!previous || previous[0] !== vertex[0] || previous[1] !== vertex[1]) face.push(vertex);
  }
  if (
    face.length > 1 &&
    face[0][0] === face[face.length - 1][0] &&
    face[0][1] === face[face.length - 1][1]
  )
    face.pop();
  return face;
}

/**
 * Lift every face of an interior straight skeleton into one equal-pitch roof
 * facet. Reflex footprint corners become valleys, so L, H and T outlines stay
 * one continuous hipped roof instead of being decomposed into rectangles.
 */
export function hippedRoofSurface(
  footprints: RoofFootprint[],
  eaves: number,
  top: number,
): RoofSurface | null {
  if (!straightSkeletonBuilder || footprints.length === 0 || top <= eaves) return null;

  const positions: number[] = [];
  const indices: number[] = [];
  const roofHeight = top - eaves;

  try {
    for (const footprint of footprints) {
      const outer = skeletonRing(footprint.outer, true);
      if (!outer) return null;
      const holes: Point2[][] = [];
      for (const footprintHole of footprint.holes) {
        const hole = skeletonRing(footprintHole, false);
        if (!hole) return null;
        holes.push(hole);
      }

      const skeleton = straightSkeletonBuilder.buildFromPolygon([outer, ...holes]);
      if (!skeleton) return null;
      const maximumTime = Math.max(...skeleton.vertices.map((vertex) => vertex[2]));
      if (!Number.isFinite(maximumTime) || maximumTime <= 1e-9) return null;

      for (const polygon of skeleton.polygons) {
        const face = skeletonFace(polygon.map((index) => skeleton.vertices[index]));
        if (face.length < 3) return null;
        const triangles = ShapeUtils.triangulateShape(
          face.map(([x, y]) => new Vector2(x, y)),
          [],
        );
        if (triangles.length === 0) return null;

        for (const triangle of triangles) {
          const triangleIndices = triangle.map((index) => {
            const [x, y, time] = face[index];
            const progress = Math.max(0, Math.min(1, time / maximumTime));
            return pushVertex(positions, [x, eaves + progress * roofHeight, y]);
          });
          pushUpwardTriangle(
            indices,
            positions,
            triangleIndices[0],
            triangleIndices[1],
            triangleIndices[2],
          );
        }
      }
    }
  } catch {
    return null;
  }

  if (indices.length === 0) return null;
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    center: roofCenter(footprints.map((footprint) => footprint.outer)),
  };
}

/** Number of curved bands between a dome's eaves and apex. */
export const DOME_SUBDIVISIONS = 8;

function pushVertex(positions: number[], point: [number, number, number]): number {
  positions.push(...point);
  return positions.length / 3 - 1;
}

/** Add a triangle with its normal facing upward, independent of ring winding. */
function pushUpwardTriangle(
  indices: number[],
  positions: number[],
  first: number,
  second: number,
  third: number,
): void {
  const offset = (index: number, axis: number) => positions[index * 3 + axis];
  const edgeX = offset(second, 0) - offset(first, 0);
  const edgeZ = offset(second, 2) - offset(first, 2);
  const otherX = offset(third, 0) - offset(first, 0);
  const otherZ = offset(third, 2) - offset(first, 2);
  const normalY = edgeZ * otherX - edgeX * otherZ;
  if (normalY >= 0) indices.push(first, second, third);
  else indices.push(second, first, third);
}

/**
 * Build a sphere-like dome by repeatedly lifting and shrinking copies of the
 * footprint ring. Sine controls height and cosine controls horizontal scale,
 * tracing a quarter circle from the eaves to the shared apex.
 */
export function domedRoofSurface(
  outlines: Point2[][],
  eaves: number,
  top: number,
  subdivisions: number = DOME_SUBDIVISIONS,
): RoofSurface | null {
  const usable = outlines.filter((outline) => outline.length >= 3);
  if (usable.length === 0 || top <= eaves) return null;
  const center = roofCenter(usable);
  const steps = Math.max(2, Math.floor(subdivisions));
  const positions: number[] = [];
  const indices: number[] = [];
  const roofHeight = top - eaves;

  for (const outline of usable) {
    const rings: number[][] = [];
    for (let level = 0; level < steps; level++) {
      const progress = level / steps;
      const angle = progress * (Math.PI / 2);
      const scale = Math.cos(angle);
      const height = eaves + Math.sin(angle) * roofHeight;
      rings.push(
        outline.map(([x, z]) =>
          pushVertex(positions, [
            center[0] + (x - center[0]) * scale,
            height,
            center[1] + (z - center[1]) * scale,
          ]),
        ),
      );
    }

    for (let level = 0; level < rings.length - 1; level++) {
      const lower = rings[level];
      const upper = rings[level + 1];
      for (let index = 0; index < outline.length; index++) {
        const next = (index + 1) % outline.length;
        pushUpwardTriangle(indices, positions, lower[index], lower[next], upper[next]);
        pushUpwardTriangle(indices, positions, lower[index], upper[next], upper[index]);
      }
    }

    const apex = pushVertex(positions, [center[0], top, center[1]]);
    const last = rings[rings.length - 1];
    for (let index = 0; index < outline.length; index++) {
      pushUpwardTriangle(indices, positions, last[index], last[(index + 1) % outline.length], apex);
    }
  }

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    center,
  };
}

/** More rings keep the onion's changing slope legible near its pointed apex. */
export const ONION_SUBDIVISIONS = 12;
/** Spread the pointed transition across the upper roof instead of hiding it at the apex. */
const ONION_SHOULDER_POWER = 2;

/**
 * A segmented onion profile whose slope changes continuously from 90 degrees
 * at the eaves to 45 degrees at the apex. The dome term supplies the vertical
 * eaves tangent; the radius correction narrows the upper rings and changes the
 * apex tangent from horizontal to 45 degrees without a separate conical tip.
 */
export function onionRoofSurface(
  outlines: Point2[][],
  eaves: number,
  top: number,
  subdivisions: number = ONION_SUBDIVISIONS,
): RoofSurface | null {
  const usable = outlines.filter((outline) => outline.length >= 3);
  if (usable.length === 0 || top <= eaves) return null;
  const center = roofCenter(usable);
  const steps = Math.max(3, Math.floor(subdivisions));
  const positions: number[] = [];
  const indices: number[] = [];
  const roofHeight = top - eaves;

  for (const outline of usable) {
    const rings: number[][] = [];
    for (let level = 0; level < steps; level++) {
      const progress = level / steps;
      // Cosine spacing keeps samples dense near both endpoint slopes, so the
      // first band reads as vertical and the final bands resolve the 45° apex.
      const angle = (Math.PI / 4) * (1 - Math.cos(Math.PI * progress));
      const scale = Math.cos(angle);
      rings.push(
        outline.map(([x, z], pointIndex) => {
          const radius = Math.hypot(x - center[0], z - center[1]);
          const currentRadius = radius * scale;
          const domeHeight = Math.sqrt(Math.max(0, 1 - scale * scale)) * roofHeight;
          const pointedHeight = domeHeight - currentRadius * (1 - scale) ** ONION_SHOULDER_POWER;
          const previous = rings[rings.length - 1]?.[pointIndex];
          const previousHeight = previous === undefined ? eaves : positions[previous * 3 + 1];
          // The final sampled segment lies exactly on the profile's 45-degree
          // apex tangent: its remaining rise equals its radial run.
          const requestedHeight = level === steps - 1 ? top - currentRadius : eaves + pointedHeight;
          return pushVertex(positions, [
            center[0] + (x - center[0]) * scale,
            Math.max(requestedHeight, previousHeight + (level === 0 ? 0 : 0.001)),
            center[1] + (z - center[1]) * scale,
          ]);
        }),
      );
    }

    for (let level = 0; level < rings.length - 1; level++) {
      const lower = rings[level];
      const upper = rings[level + 1];
      for (let index = 0; index < outline.length; index++) {
        const next = (index + 1) % outline.length;
        pushUpwardTriangle(indices, positions, lower[index], lower[next], upper[next]);
        pushUpwardTriangle(indices, positions, lower[index], upper[next], upper[index]);
      }
    }

    const apex = pushVertex(positions, [center[0], top, center[1]]);
    const last = rings[rings.length - 1];
    for (let index = 0; index < outline.length; index++) {
      pushUpwardTriangle(indices, positions, last[index], last[(index + 1) % outline.length], apex);
    }
  }

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    center,
  };
}

export interface RoofFrame {
  center: Point2;
  /** Ridge direction after applying roof:orientation. */
  axis: Point2;
  /** Unit direction across the two slopes, perpendicular to axis. */
  across: Point2;
  minAlong: number;
  maxAlong: number;
  minAcross: number;
  maxAcross: number;
}

function dot(point: Point2, direction: Point2): number {
  return point[0] * direction[0] + point[1] * direction[1];
}

function boundsAlong(points: Point2[], axis: Point2): Omit<RoofFrame, "center"> {
  const across: Point2 = [-axis[1], axis[0]];
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const point of points) {
    const along = dot(point, axis);
    const cross = dot(point, across);
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    minAcross = Math.min(minAcross, cross);
    maxAcross = Math.max(maxAcross, cross);
  }
  return { axis, across, minAlong, maxAlong, minAcross, maxAcross };
}

function convexHull(points: Point2[]): Point2[] {
  const sorted = [
    ...new Map(points.map((point) => [`${point[0]}/${point[1]}`, point])).values(),
  ].sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  if (sorted.length <= 2) return sorted;
  const turn = (first: Point2, second: Point2, third: Point2) =>
    (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
  const half = (ordered: Point2[]) => {
    const result: Point2[] = [];
    for (const point of ordered) {
      while (
        result.length >= 2 &&
        turn(result[result.length - 2], result[result.length - 1], point) <= 0
      )
        result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted);
  const upper = half(sorted.slice().reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Minimum-area oriented bounding rectangle. A minimum rectangle has a side
 * parallel to a convex-hull edge. The longer side is the default ridge axis;
 * `across` rotates the ridge onto the rectangle's shorter side.
 */
export function minimumRoofFrame(
  outlines: Point2[][],
  orientation: RoofOrientation = "along",
): RoofFrame | null {
  const usable = outlines.filter((outline) => outline.length >= 3);
  const points = usable.flat();
  const hull = convexHull(points);
  if (hull.length < 3) return null;

  let best: { area: number; axis: Point2; alongSpan: number; acrossSpan: number } | null = null;
  for (let index = 0; index < hull.length; index++) {
    const start = hull[index];
    const end = hull[(index + 1) % hull.length];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-9) continue;
    const axis: Point2 = [dx / length, dy / length];
    const candidate = boundsAlong(hull, axis);
    const alongSpan = candidate.maxAlong - candidate.minAlong;
    const acrossSpan = candidate.maxAcross - candidate.minAcross;
    const candidateArea = alongSpan * acrossSpan;
    if (best && candidateArea >= best.area - 1e-9) continue;
    best = { area: candidateArea, axis, alongSpan, acrossSpan };
  }
  if (!best) return null;

  const longAxis: Point2 =
    best.alongSpan >= best.acrossSpan ? best.axis : [-best.axis[1], best.axis[0]];
  const ridgeAxis: Point2 = orientation === "across" ? [-longAxis[1], longAxis[0]] : longAxis;
  const frame = boundsAlong(points, ridgeAxis);
  const alongMiddle = (frame.minAlong + frame.maxAlong) / 2;
  const acrossMiddle = (frame.minAcross + frame.maxAcross) / 2;
  return {
    ...frame,
    center: [
      frame.axis[0] * alongMiddle + frame.across[0] * acrossMiddle,
      frame.axis[1] * alongMiddle + frame.across[1] * acrossMiddle,
    ],
  };
}

/** Unit vector in the local east/south plane for a compass bearing. */
function roofDirectionVector(bearing: number): Point2 {
  const radians = (bearing * Math.PI) / 180;
  return [Math.sin(radians), -Math.cos(radians)];
}

/** A frame whose across axis points exactly downhill for roof:direction. */
function directionalRoofFrame(outlines: Point2[][], bearing: number): RoofFrame | null {
  const points = outlines.filter((outline) => outline.length >= 3).flat();
  if (points.length < 3) return null;
  const downhill = roofDirectionVector(bearing);
  const frame = boundsAlong(points, [downhill[1], -downhill[0]]);
  const alongMiddle = (frame.minAlong + frame.maxAlong) / 2;
  const acrossMiddle = (frame.minAcross + frame.maxAcross) / 2;
  return {
    ...frame,
    center: [
      frame.axis[0] * alongMiddle + frame.across[0] * acrossMiddle,
      frame.axis[1] * alongMiddle + frame.across[1] * acrossMiddle,
    ],
  };
}

function cross2(first: Point2, second: Point2): number {
  return first[0] * second[1] - first[1] * second[0];
}

/**
 * Cast from the centroid in a compass look direction and return the normal of
 * the first outer edge hit, oriented into the same half-plane as that look.
 */
export function edgeNormalRoofDirection(
  outlines: Point2[][],
  center: Point2,
  lookBearing: number,
): number {
  const look = roofDirectionVector(lookBearing);
  let best: { distance: number; alignment: number; normal: Point2 } | null = null;
  for (const outline of outlines) {
    for (let index = 0; index < outline.length; index++) {
      const start = outline[index];
      const end = outline[(index + 1) % outline.length];
      const edge: Point2 = [end[0] - start[0], end[1] - start[1]];
      const denominator = cross2(look, edge);
      if (Math.abs(denominator) <= 1e-12) continue;
      const offset: Point2 = [start[0] - center[0], start[1] - center[1]];
      const distance = cross2(offset, edge) / denominator;
      const alongEdge = cross2(offset, look) / denominator;
      if (distance <= 1e-9 || alongEdge < -1e-9 || alongEdge > 1 + 1e-9) continue;

      const length = Math.hypot(edge[0], edge[1]);
      if (length <= 1e-12) continue;
      let normal: Point2 = [-edge[1] / length, edge[0] / length];
      let alignment = dot(normal, look);
      if (alignment < 0) {
        normal = [-normal[0], -normal[1]];
        alignment = -alignment;
      }
      if (
        best &&
        (distance > best.distance + 1e-9 ||
          (Math.abs(distance - best.distance) <= 1e-9 && alignment <= best.alignment))
      )
        continue;
      best = { distance, alignment, normal };
    }
  }
  if (!best) return lookBearing;
  const bearing = (Math.atan2(best.normal[0], -best.normal[1]) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

function openOutline(outline: Point2[]): Point2[] {
  const last = outline[outline.length - 1];
  return outline.length > 1 && outline[0][0] === last[0] && outline[0][1] === last[1]
    ? outline.slice(0, -1)
    : outline;
}

/** Project an OSM footprint to the same local east/south plane as roof geometry. */
export function elementRoofOutlines(element: BuildingElement): Point2[][] {
  const geographic = element.polygons.map((footprint) => openOutline(footprint.outer as Point2[]));
  const points = geographic.flat();
  if (points.length === 0) return [];
  const minLon = Math.min(...points.map((point) => point[0]));
  const maxLon = Math.max(...points.map((point) => point[0]));
  const minLat = Math.min(...points.map((point) => point[1]));
  const maxLat = Math.max(...points.map((point) => point[1]));
  const origin: Point2 = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const cosLat = Math.max(Math.cos((origin[1] * Math.PI) / 180), 0.01);
  return geographic.map((outline) =>
    outline.map(([lon, lat]): Point2 => [(lon - origin[0]) * cosLat, origin[1] - lat]),
  );
}

/** Resolve an arbitrary centroid look ray to the aligned normal of the edge it hits. */
export function roofDirectionFromLook(element: BuildingElement, lookBearing: number): number {
  const outlines = elementRoofOutlines(element);
  const normalizedLook = ((lookBearing % 360) + 360) % 360;
  if (outlines.length === 0) return normalizedLook;
  return edgeNormalRoofDirection(outlines, roofCenter(outlines), normalizedLook);
}

function signedArea(points: Point2[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
}

function oriented(points: Point2[], counterClockwise: boolean): Point2[] {
  const isCounterClockwise = signedArea(points) > 0;
  return isCounterClockwise === counterClockwise ? points : points.slice().reverse();
}

function flattenFootprints(footprints: RoofFootprint[]): Flatten.Polygon {
  const polygon = new Flatten.Polygon();
  for (const footprint of footprints) {
    if (footprint.outer.length < 3) continue;
    polygon.addFace(oriented(footprint.outer, true).map(([x, y]) => Flatten.point(x, y)));
    for (const hole of footprint.holes) {
      if (hole.length >= 3)
        polygon.addFace(oriented(hole, false).map(([x, y]) => Flatten.point(x, y)));
    }
  }
  return polygon;
}

function pointAt(frame: RoofFrame, along: number, across: number): Point2 {
  return [
    frame.axis[0] * along + frame.across[0] * across,
    frame.axis[1] * along + frame.across[1] * across,
  ];
}

function bandPolygon(frame: RoofFrame, low: number, high: number): Flatten.Polygon {
  const span = Math.max(frame.maxAlong - frame.minAlong, frame.maxAcross - frame.minAcross, 1);
  const start = frame.minAlong - span;
  const end = frame.maxAlong + span;
  return new Flatten.Polygon([
    pointAt(frame, start, low),
    pointAt(frame, end, low),
    pointAt(frame, end, high),
    pointAt(frame, start, high),
  ]);
}

type RoofProfile = (progress: number, frame: RoofFrame, eaves: number, top: number) => number;

function profileHeight(
  point: Point2,
  frame: RoofFrame,
  eaves: number,
  top: number,
  profile: RoofProfile,
): number {
  const width = frame.maxAcross - frame.minAcross;
  if (width <= 1e-9) return eaves;
  const progress = Math.max(0, Math.min(1, (dot(point, frame.across) - frame.minAcross) / width));
  return eaves + profile(progress, frame, eaves, top) * (top - eaves);
}

function addTriangulatedIsland(
  island: Flatten.Polygon,
  bandIndex: number,
  smooth: boolean,
  frame: RoofFrame,
  eaves: number,
  top: number,
  profile: RoofProfile,
  positions: number[],
  indices: number[],
  vertices: Map<string, number>,
): void {
  const faces = ([...island.faces] as Flatten.Face[])
    .map((face) => ({ face, area: face.area() }))
    .sort((first, second) => second.area - first.area);
  const contour = faces[0]?.face.vertices.map((point): Point2 => [point.x, point.y]);
  if (!contour || contour.length < 3) return;
  const holes = faces
    .slice(1)
    .map(({ face }) => face.vertices.map((point): Point2 => [point.x, point.y]))
    .filter((hole) => hole.length >= 3);
  const triangles = ShapeUtils.triangulateShape(
    contour.map(([x, y]) => new Vector2(x, y)),
    holes.map((hole) => hole.map(([x, y]) => new Vector2(x, y))),
  );
  const points = [...contour, ...holes.flat()];
  const indexFor = (point: Point2): number => {
    const height = profileHeight(point, frame, eaves, top, profile);
    // Round bands share separator vertices for smooth normals. Gable halves
    // deliberately do not share the ridge, preserving its hard crease.
    const key = `${smooth ? "" : `${bandIndex}/`}${point[0].toFixed(7)}/${point[1].toFixed(7)}/${height.toFixed(7)}`;
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = pushVertex(positions, [point[0], height, point[1]]);
    vertices.set(key, index);
    return index;
  };
  for (const triangle of triangles) {
    pushUpwardTriangle(
      indices,
      positions,
      indexFor(points[triangle[0]]),
      indexFor(points[triangle[1]]),
      indexFor(points[triangle[2]]),
    );
  }
}

function splitRingAt(ring: Point2[], separators: number[], across: Point2): Point2[] {
  const result: Point2[] = [];
  for (let index = 0; index < ring.length; index++) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    result.push(start);
    const startAcross = dot(start, across);
    const delta = dot(end, across) - startAcross;
    if (Math.abs(delta) <= 1e-9) continue;
    const crossings = separators
      .map((separator) => ({ separator, at: (separator - startAcross) / delta }))
      .filter(({ at }) => at > 1e-8 && at < 1 - 1e-8)
      .sort((first, second) => first.at - second.at);
    for (const { at } of crossings) {
      result.push([start[0] + (end[0] - start[0]) * at, start[1] + (end[1] - start[1]) * at]);
    }
  }
  return result;
}

function roofWallPositions(
  footprints: RoofFootprint[],
  separators: number[],
  frame: RoofFrame,
  eaves: number,
  top: number,
  profile: RoofProfile,
): Float32Array | undefined {
  const positions: number[] = [];
  for (const footprint of footprints) {
    for (const ring of [footprint.outer, ...footprint.holes]) {
      const sampled = splitRingAt(ring, separators, frame.across);
      for (let index = 0; index < sampled.length; index++) {
        const start = sampled[index];
        const end = sampled[(index + 1) % sampled.length];
        const startTop = profileHeight(start, frame, eaves, top, profile);
        const endTop = profileHeight(end, frame, eaves, top, profile);
        if (startTop <= eaves + 1e-6 && endTop <= eaves + 1e-6) continue;
        positions.push(
          start[0],
          eaves,
          start[1],
          end[0],
          eaves,
          end[1],
          end[0],
          endTop,
          end[1],
          start[0],
          eaves,
          start[1],
          end[0],
          endTop,
          end[1],
          start[0],
          startTop,
          start[1],
        );
      }
    }
  }
  return positions.length > 0 ? Float32Array.from(positions) : undefined;
}

function axialRoofSurface(
  footprints: RoofFootprint[],
  frameFootprints: RoofFootprint[],
  eaves: number,
  top: number,
  subdivisions: number,
  profile: RoofProfile,
  smooth: boolean,
  profileSeparators?: (frame: RoofFrame, eaves: number, top: number) => number[],
  orientation: RoofOrientation = "along",
  direction?: number,
): RoofSurface | null {
  if (footprints.length === 0 || top <= eaves) return null;
  const frameOutlines = frameFootprints.map((footprint) => footprint.outer);
  const frame =
    direction === undefined
      ? minimumRoofFrame(frameOutlines, orientation)
      : directionalRoofFrame(frameOutlines, direction);
  if (!frame || frame.maxAcross - frame.minAcross <= 1e-9) return null;
  const polygon = flattenFootprints(footprints);
  if (polygon.isEmpty() || !polygon.isValid()) return null;

  const steps = Math.max(2, Math.floor(subdivisions));
  const separatorProgress = profileSeparators
    ? profileSeparators(frame, eaves, top)
    : Array.from({ length: steps + 1 }, (_, index) => index / steps);
  const separators = separatorProgress.map(
    (progress) =>
      frame.minAcross + (frame.maxAcross - frame.minAcross) * Math.max(0, Math.min(1, progress)),
  );
  const positions: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  try {
    for (let index = 0; index < steps; index++) {
      const band = bandPolygon(frame, separators[index], separators[index + 1]);
      const clipped = Flatten.BooleanOperations.intersect(polygon, band);
      for (const island of clipped.splitToIslands()) {
        addTriangulatedIsland(
          island,
          index,
          smooth,
          frame,
          eaves,
          top,
          profile,
          positions,
          indices,
          vertices,
        );
      }
    }
  } catch {
    return null;
  }
  if (indices.length === 0) return null;
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    wallPositions: roofWallPositions(
      footprints,
      separators.slice(1, -1),
      frame,
      eaves,
      top,
      profile,
    ),
    center: frame.center,
  };
}

/** Two planar slopes meeting at the oriented ridge of the minimum rectangle. */
export function gabledRoofSurface(
  footprints: RoofFootprint[],
  frameFootprints: RoofFootprint[],
  eaves: number,
  top: number,
  orientation: RoofOrientation = "along",
): RoofSurface | null {
  return axialRoofSurface(
    footprints,
    frameFootprints,
    eaves,
    top,
    2,
    (progress) => 1 - Math.abs(progress * 2 - 1),
    false,
    undefined,
    orientation,
  );
}

const GAMBREL_PITCH_OFFSET = Math.PI / 12;

/**
 * Split a gabled half into two equal-length panels rotated equally around its
 * original pitch. A 45° gable therefore becomes 60° below the break and 30°
 * above it while retaining the original eaves, ridge and `roof:height`.
 */
function gambrelBreak(
  frame: RoofFrame,
  eaves: number,
  top: number,
): {
  progress: number;
  height: number;
} {
  const halfRun = (frame.maxAcross - frame.minAcross) / 2;
  const rise = top - eaves;
  const pitch = Math.atan2(rise, halfRun);
  // Extremely shallow or steep tagged roofs cannot be rotated by the full
  // 15° without one panel becoming horizontal or folding back on itself.
  const offset = Math.max(
    0,
    Math.min(GAMBREL_PITCH_OFFSET, pitch - 1e-6, Math.PI / 2 - pitch - 1e-6),
  );
  const offsetTangent = Math.tan(offset);
  const lowerRun = (halfRun - rise * offsetTangent) / 2;
  const lowerRise = (rise + halfRun * offsetTangent) / 2;
  return {
    progress: lowerRun / (halfRun * 2),
    height: lowerRise / rise,
  };
}

/** Four planar bands whose break bisects the sloped path on each roof side. */
export function gambrelRoofSurface(
  footprints: RoofFootprint[],
  frameFootprints: RoofFootprint[],
  eaves: number,
  top: number,
  orientation: RoofOrientation = "along",
): RoofSurface | null {
  return axialRoofSurface(
    footprints,
    frameFootprints,
    eaves,
    top,
    4,
    (progress, frame, roofEaves, roofTop) => {
      const roofBreak = gambrelBreak(frame, roofEaves, roofTop);
      const distanceFromEdge = Math.min(progress, 1 - progress);
      return distanceFromEdge <= roofBreak.progress
        ? (distanceFromEdge / roofBreak.progress) * roofBreak.height
        : roofBreak.height +
            ((distanceFromEdge - roofBreak.progress) / (0.5 - roofBreak.progress)) *
              (1 - roofBreak.height);
    },
    false,
    (frame, roofEaves, roofTop) => {
      const roofBreak = gambrelBreak(frame, roofEaves, roofTop);
      return [0, roofBreak.progress, 0.5, 1 - roofBreak.progress, 1];
    },
    orientation,
  );
}

/** Number of strips used to approximate the circular cross-section of a round roof. */
export const ROUND_SUBDIVISIONS = 12;

/** A barrel roof: the gabled footprint cut against a segmented semicircular arch. */
export function roundRoofSurface(
  footprints: RoofFootprint[],
  frameFootprints: RoofFootprint[],
  eaves: number,
  top: number,
  subdivisions: number = ROUND_SUBDIVISIONS,
  orientation: RoofOrientation = "along",
): RoofSurface | null {
  return axialRoofSurface(
    footprints,
    frameFootprints,
    eaves,
    top,
    subdivisions,
    (progress) => Math.sqrt(Math.max(0, 1 - (progress * 2 - 1) ** 2)),
    true,
    undefined,
    orientation,
  );
}

/** A single plane falling from the high edge toward roof:direction. */
export function skillionRoofSurface(
  footprints: RoofFootprint[],
  frameFootprints: RoofFootprint[],
  eaves: number,
  top: number,
  direction?: number,
  directionFromCompass: boolean = false,
): RoofSurface | null {
  const frameOutlines = frameFootprints.map((footprint) => footprint.outer);
  const resolvedDirection =
    direction !== undefined && directionFromCompass
      ? edgeNormalRoofDirection(frameOutlines, roofCenter(frameOutlines), direction)
      : direction;
  return axialRoofSurface(
    footprints,
    frameFootprints,
    eaves,
    top,
    2,
    (progress) => 1 - progress,
    false,
    undefined,
    "along",
    resolvedDirection,
  );
}

/** Dispatch roof geometry without coupling the scene builder to roof types. */
export function roofSurface(
  plan: RoofPlan,
  footprints: RoofFootprint[],
  frameFootprints: RoofFootprint[] = footprints,
  groundOffset: number = 0,
): RoofSurface | null {
  const eaves = plan.eaves + groundOffset;
  const top = plan.top + groundOffset;
  const outlines = footprints.map((footprint) => footprint.outer);
  if (plan.shape === "hipped")
    return hippedRoofSurface(footprints, eaves, top) ?? pyramidalRoofSurface(outlines, eaves, top);
  if (plan.shape === "dome") return domedRoofSurface(outlines, eaves, top);
  if (plan.shape === "onion") return onionRoofSurface(outlines, eaves, top);
  if (plan.shape === "gabled")
    return gabledRoofSurface(footprints, frameFootprints, eaves, top, plan.orientation);
  if (plan.shape === "gambrel")
    return gambrelRoofSurface(footprints, frameFootprints, eaves, top, plan.orientation);
  if (plan.shape === "round")
    return roundRoofSurface(
      footprints,
      frameFootprints,
      eaves,
      top,
      ROUND_SUBDIVISIONS,
      plan.orientation,
    );
  if (plan.shape === "skillion")
    return skillionRoofSurface(
      footprints,
      frameFootprints,
      eaves,
      top,
      plan.direction,
      plan.directionFromCompass,
    );
  return pyramidalRoofSurface(outlines, eaves, top);
}
