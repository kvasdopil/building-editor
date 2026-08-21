import type { BuildingProperties } from "./buildings";

export type Point2 = [number, number];

export interface RoofPlan {
  shape: "pyramidal" | "dome" | "onion";
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
  /** The single apex shared by every face of the building part. */
  center: Point2;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the shaped-roof section of a solid. Total OSM `height` includes the
 * roof, so the facade ends at `top - roof:height`. Keeping this policy here
 * leaves the extrusion code independent of individual roof types.
 */
export function roofPlan(
  properties: BuildingProperties,
  extent: { base: number; top: number },
): RoofPlan | null {
  // Accept common descriptive aliases when reading existing data without ever
  // requiring them from the UI, which writes the standard OSM values.
  const rawShape = properties.roof_shape;
  const shape =
    rawShape === "pyramidal" || rawShape === "pyramid"
      ? "pyramidal"
      : rawShape === "dome" || rawShape === "sphere"
        ? "dome"
        : rawShape === "onion"
          ? "onion"
          : null;
  if (shape === null) return null;

  const requestedHeight = finiteNumber(properties.roof_height);
  const availableHeight = extent.top - extent.base;
  if (requestedHeight === undefined || requestedHeight <= 0 || availableHeight <= 0) return null;

  const height = Math.min(requestedHeight, availableHeight);
  return { shape, eaves: extent.top - height, top: extent.top };
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

/** Dispatch roof geometry without coupling the scene builder to roof types. */
export function roofSurface(
  plan: RoofPlan,
  outlines: Point2[][],
  groundOffset: number = 0,
): RoofSurface | null {
  const eaves = plan.eaves + groundOffset;
  const top = plan.top + groundOffset;
  if (plan.shape === "dome") return domedRoofSurface(outlines, eaves, top);
  if (plan.shape === "onion") return onionRoofSurface(outlines, eaves, top);
  return pyramidalRoofSurface(outlines, eaves, top);
}
