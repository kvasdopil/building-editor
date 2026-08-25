import type { BuildingProperties } from "./buildings";

/** Roof details become part-owned when an outline is first divided into parts. */
export const PART_ROOF_KEYS = [
  "roof:shape",
  "roof:direction",
  "roof:orientation",
  "roof:height",
] as const;

function rawTags(properties: BuildingProperties): Record<string, string> {
  return properties.tags && typeof properties.tags === "object"
    ? { ...(properties.tags as Record<string, string>) }
    : {};
}

/**
 * A generic region has no differences from its parent yet. Height is the one
 * value every generated part carries explicitly; other parent values remain
 * effective defaults in the editor instead of duplicated OSM tags.
 */
export function inheritedPartTags(parent: BuildingProperties): Record<string, string> {
  const height = rawTags(parent).height;
  return {
    "building:part": "yes",
    ...(height === undefined ? {} : { height }),
  };
}

function explicitRoofTags(parent: BuildingProperties): Record<string, string> {
  const tags = rawTags(parent);
  return Object.fromEntries(PART_ROOF_KEYS.flatMap((key) => (tags[key] ? [[key, tags[key]]] : [])));
}

/** The first parts take explicit ownership of the outline's roof definition. */
export function firstPartTags(parent: BuildingProperties): Record<string, string> {
  return { ...inheritedPartTags(parent), ...explicitRoofTags(parent) };
}

/** A closed-loop tower starts at the same explicit vertical extent as its parent. */
export function inheritedTowerPartTags(parent: BuildingProperties): Record<string, string> {
  const { height, min_height } = rawTags(parent);
  return {
    "building:part": "yes",
    ...(height === undefined ? {} : { height }),
    ...(min_height === undefined ? {} : { min_height }),
  };
}

/** A first tower keeps its base-height semantics and receives the transferred roof. */
export function firstTowerPartTags(parent: BuildingProperties): Record<string, string> {
  return { ...inheritedTowerPartTags(parent), ...explicitRoofTags(parent) };
}

/** Preserve explicit height plus values that differ from the parent outline. */
export function copiedPartTags(
  properties: BuildingProperties,
  parent: BuildingProperties,
): Record<string, string> {
  const tags = rawTags(properties);
  const parentTags = rawTags(parent);
  for (const [key, value] of Object.entries(tags)) {
    if (key !== "building:part" && key !== "height" && parentTags[key] === value) delete tags[key];
  }
  delete tags.building;
  tags["building:part"] ??= "yes";
  if (tags.height === undefined && parentTags.height !== undefined) tags.height = parentTags.height;
  return tags;
}
