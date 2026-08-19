import type { BuildingProperties } from "./buildings";

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface VerticalExtent {
  /** Height of the top of the element above ground, meters. */
  top: number;
  /** Height of the bottom of the element above ground, meters. */
  base: number;
}

/**
 * Compute the vertical extent of a building or part:
 * - `height` (meters) wins; otherwise `num_floors` × 3 m for residential
 *   buildings (apartments etc.) or × 4 m for everything else.
 * - `min_height` wins for the base; otherwise `min_floor` × the same
 *   per-floor height.
 * Parts inherit the parent building's subtype for the per-floor estimate.
 */
export function verticalExtent(
  properties: BuildingProperties,
  parentSubtype?: string,
): VerticalExtent {
  const subtype = properties.subtype ?? parentSubtype;
  const perFloor = subtype === "residential" ? 3 : 4;

  const minFloor = num(properties.min_floor);
  const base = num(properties.min_height) ?? (minFloor !== undefined ? minFloor * perFloor : 0);

  const floors = num(properties.num_floors);
  let top = num(properties.height) ?? (floors !== undefined ? floors * perFloor : undefined);
  if (top === undefined) top = base + perFloor;

  if (top <= base) top = base + 0.5;
  return { top, base };
}
