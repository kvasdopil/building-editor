import { featureCollection } from "@turf/helpers";
import { union } from "@turf/union";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type {
  BuildingElement,
  BuildingProperties,
  BuildingSelection,
  BuildingWithParts,
} from "./buildings";
import { toFootprints } from "./geometry";
import { assembleSelection } from "./selection";

/** Overture buildings theme: current release PMTiles archive. */
export const BUILDINGS_PMTILES_URL =
  "https://tiles.overturemaps.org/2026-07-22.0/buildings.pmtiles";

type PolygonFeature = Feature<Polygon | MultiPolygon>;

interface FragmentFeature {
  geometry: Polygon | MultiPolygon;
  properties: BuildingProperties | null;
}

function isPolygonal(geometry: FragmentFeature["geometry"]): boolean {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

/**
 * Merge tile fragments of one feature into a single geometry. Vector tiles clip
 * features at tile borders, so a building can arrive as several overlapping
 * pieces; union stitches them back together.
 */
function mergeFragments(fragments: FragmentFeature[]): PolygonFeature | null {
  const features = fragments
    .filter((f) => isPolygonal(f.geometry))
    .map((f): PolygonFeature => ({ type: "Feature", geometry: f.geometry, properties: {} }));
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];
  try {
    return union(featureCollection(features));
  } catch {
    return features[0];
  }
}

function toElement(id: string, fragments: FragmentFeature[]): BuildingElement | null {
  const merged = mergeFragments(fragments);
  if (!merged) return null;
  const polygons = toFootprints(merged.geometry);
  if (polygons.length === 0) return null;
  const properties = fragments.find((f) => f.properties)?.properties ?? {};
  return { id, properties, polygons };
}

function groupBy(
  fragments: FragmentFeature[],
  key: (properties: BuildingProperties) => unknown,
): Map<string, FragmentFeature[]> {
  const groups = new Map<string, FragmentFeature[]>();
  for (const fragment of fragments) {
    if (!fragment.properties) continue;
    const id = key(fragment.properties);
    if (typeof id !== "string") continue;
    const group = groups.get(id) ?? [];
    group.push(fragment);
    groups.set(id, group);
  }
  return groups;
}

function partsOf(fragments: FragmentFeature[] | undefined): BuildingElement[] {
  if (!fragments) return [];
  return [...groupBy(fragments, (p) => p.id).entries()]
    .map(([id, group]) => toElement(id, group))
    .filter((part): part is BuildingElement => part !== null);
}

/**
 * Assemble a selection from the raw tile features of the whole loaded source.
 * Overture links parts to their building with `building_id`, so pairing is a
 * lookup rather than a spatial test.
 */
export function buildSelection(
  buildingId: string,
  buildingFragments: FragmentFeature[],
  partFragments: FragmentFeature[],
): BuildingSelection | null {
  const buildingsById = groupBy(buildingFragments, (p) => p.id);
  const partsByBuilding = groupBy(partFragments, (p) => p.building_id);

  const selectedFragments = buildingsById.get(buildingId);
  if (!selectedFragments) return null;
  const building = toElement(buildingId, selectedFragments);
  if (!building) return null;

  const withParts = (id: string, element: BuildingElement): BuildingWithParts => ({
    building: element,
    parts: partsOf(partsByBuilding.get(id)),
  });

  const candidates = [...buildingsById.entries()]
    .filter(([id]) => id !== buildingId)
    .map(([id, fragments]) => {
      const element = toElement(id, fragments);
      return element ? withParts(id, element) : null;
    })
    .filter((candidate): candidate is BuildingWithParts => candidate !== null);

  return assembleSelection(withParts(buildingId, building), candidates);
}
