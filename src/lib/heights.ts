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
 * Meters per level for one building, used for every part of it so that parts
 * stack instead of floating. A measured height divided by the level count beats
 * any assumption; otherwise fall back to 3 m for residential buildings
 * (apartments etc.) and 4 m for everything else.
 */
export function levelHeight(building: BuildingProperties): number {
  const height = num(building.height);
  const floors = num(building.num_floors);
  if (height !== undefined && floors !== undefined && floors > 0) return height / floors;
  return building.subtype === "residential" ? 3 : 4;
}

/**
 * Compute the vertical extent of a building or part:
 * - `height` (meters) wins; otherwise the level count × `metersPerLevel`.
 * - `min_height` wins for the base; otherwise the minimum level × the same
 *   per-level height.
 *
 * `metersPerLevel` should come from the parent building via `levelHeight`, so
 * every part of a building measures its levels the same way. Sparse part tags
 * may omit values identical to the outline: when `parent` is supplied, an
 * explicit part value wins, followed by the corresponding parent value, then
 * the normal default.
 */
export function verticalExtent(
  properties: BuildingProperties,
  metersPerLevel: number = levelHeight(properties),
  parent?: BuildingProperties,
): VerticalExtent {
  const minFloor = num(properties.min_floor);
  const parentMinFloor = num(parent?.min_floor);
  const base =
    num(properties.min_height) ??
    (minFloor !== undefined
      ? minFloor * metersPerLevel
      : (num(parent?.min_height) ??
        (parentMinFloor !== undefined ? parentMinFloor * metersPerLevel : 0)));

  const floors = num(properties.num_floors);
  const parentFloors = num(parent?.num_floors);
  let top =
    num(properties.height) ??
    (floors !== undefined
      ? floors * metersPerLevel
      : (num(parent?.height) ??
        (parentFloors !== undefined ? parentFloors * metersPerLevel : undefined)));
  if (top === undefined) top = base + metersPerLevel;

  if (top <= base) top = base + 0.5;
  return { top, base };
}
