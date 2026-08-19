import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingElement } from "./buildings";
import { elementBounds, toFootprints } from "./geometry";
import { levelHeight } from "./heights";
import { overlapFraction } from "./parts";
import { tileForLngLat, tileKey } from "./osm/tiles";

/**
 * Stockholm's LOD1 model as a source of advice for OSM tags.
 *
 * The dataset gives, per building, the ground level and the eaves, median and
 * ridge heights measured from airborne laser data. Mapped onto OSM:
 * - `height` is ground to top of roof, so the ridge.
 * - `roof:height` is ridge minus eaves.
 * - `building:levels` is estimated from the facade (eaves) height, because the
 *   roof space is not a full level. It is an estimate, not a measurement.
 */

/** A LOD1 match must cover at least this much of the OSM footprint. */
const MATCH_OVERLAP_MIN = 0.4;

interface Lod1Properties {
  id?: string;
  /** Ground to ridge, meters. */
  height?: number;
  /** Ground to eaves, meters. */
  eaves_height?: number;
  /** Ground to roof median, meters — the figure the dataset is defined by. */
  median_height?: number;
  roof_height?: number;
  area?: number;
  category?: string;
}

export interface Lod1Match {
  properties: Lod1Properties;
  /** Fraction of the OSM footprint covered by the LOD1 block. */
  coverage: number;
  /**
   * Fraction of the LOD1 block this OSM building accounts for. LOD1 footprints
   * are generalized, so one block can swallow a whole terrace; when this is
   * low, the block's heights describe several buildings and not this one.
   */
  blockShare: number;
  /** True when the block plausibly is this building. */
  confident: boolean;
}

/** A single piece of advice for one OSM tag. */
export interface Suggestion {
  key: string;
  /** Value to write into OSM, already formatted. */
  value: string;
  /** Existing OSM value, when there is one. */
  current?: string;
  kind: "missing" | "differs";
  /** Where the number comes from, for the tooltip. */
  note: string;
  /** False when the LOD1 block covers more than this building. */
  confident: boolean;
}

/** Below this share of the LOD1 block, its heights are not about this building. */
const BLOCK_SHARE_MIN = 0.5;

/** z16 tiles the building's footprint touches. */
export function lod1TilesFor(building: BuildingElement): { z: number; x: number; y: number }[] {
  const [west, south, east, north] = elementBounds(building);
  const corners = [
    tileForLngLat(west, north),
    tileForLngLat(east, north),
    tileForLngLat(west, south),
    tileForLngLat(east, south),
  ];
  const seen = new Set<string>();
  return corners.filter((tile) => {
    const key = tileKey(tile);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toElement(feature: Feature): BuildingElement | null {
  if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") return null;
  const polygons = toFootprints(feature.geometry as Polygon | MultiPolygon);
  if (polygons.length === 0) return null;
  return { id: "lod1", properties: {}, polygons };
}

/**
 * The LOD1 block covering most of the OSM building. LOD1 footprints are
 * generalized, so they rarely match an OSM outline exactly; the best overlap
 * wins, and the coverage is reported so the UI can show how good the match is.
 */
export function matchLod1(
  building: BuildingElement,
  collections: FeatureCollection[],
): Lod1Match | null {
  let best: Lod1Match | null = null;
  for (const collection of collections) {
    for (const feature of collection.features) {
      const candidate = toElement(feature);
      if (!candidate) continue;
      const coverage = overlapFraction(building, candidate);
      if (coverage < MATCH_OVERLAP_MIN) continue;
      const blockShare = overlapFraction(candidate, building);
      if (!best || coverage > best.coverage) {
        best = {
          properties: (feature.properties ?? {}) as Lod1Properties,
          coverage,
          blockShare,
          confident: blockShare >= BLOCK_SHARE_MIN,
        };
      }
    }
  }
  return best;
}

/** Format a height the way heights are usually written in OSM: plain meters. */
function formatMeters(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function compare(
  key: string,
  value: string,
  tags: Record<string, string>,
  note: string,
  confident: boolean,
): Suggestion | null {
  const current = tags[key];
  if (current === undefined || current === "")
    return { key, value, kind: "missing", note, confident };
  if (current.trim() === value) return null;
  return { key, value, current, kind: "differs", note, confident };
}

/**
 * Advice for one building: heights straight from the laser measurements, and a
 * level count estimated from the facade height using the building's own level
 * height.
 */
export function suggestionsFor(
  building: BuildingElement,
  match: Lod1Match,
  tags: Record<string, string>,
): Suggestion[] {
  const {
    height,
    eaves_height: eaves,
    roof_height: roof,
    median_height: median,
  } = match.properties;
  const suggestions: Suggestion[] = [];

  const note = (text: string) =>
    match.confident
      ? text
      : `${text} — LOD1 block is ${(1 / Math.max(match.blockShare, 0.01)).toFixed(1)}x this footprint, so it describes several buildings`;

  if (height !== undefined) {
    const suggestion = compare(
      "height",
      formatMeters(height),
      tags,
      note(
        `LOD1 ridge height (roof median ${median !== undefined ? `${formatMeters(median)} m` : "n/a"})`,
      ),
      match.confident,
    );
    if (suggestion) suggestions.push(suggestion);
  }

  // A roof taller than half the building means the block merges structures of
  // different heights, not that the roof is enormous.
  const plausibleRoof =
    roof !== undefined && roof > 0.5 && (height === undefined || roof < height / 2);
  if (plausibleRoof) {
    const suggestion = compare(
      "roof:height",
      formatMeters(roof),
      tags,
      note("LOD1 ridge minus eaves"),
      match.confident,
    );
    if (suggestion) suggestions.push(suggestion);
  }

  const facade = eaves ?? median ?? height;
  if (facade !== undefined) {
    const perLevel = levelHeight(building.properties);
    const levels = Math.max(1, Math.round(facade / perLevel));
    const suggestion = compare(
      "building:levels",
      String(levels),
      tags,
      note(
        `estimated from ${formatMeters(facade)} m facade at ${formatMeters(perLevel)} m per level`,
      ),
      match.confident,
    );
    if (suggestion) suggestions.push(suggestion);
  }

  return suggestions;
}
