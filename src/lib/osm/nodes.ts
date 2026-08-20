import type { FeatureCollection } from "geojson";
import type { BuildingProperties, LngLat } from "../buildings";
import { coordinateKey, metersBetween, roundToOsmGrid } from "./precision";

/**
 * An index of the OSM nodes we already know about, so an upload can reuse them
 * instead of stacking a second node on the same spot. Every vertex our drawing
 * tools produce is either an existing node (the user snapped to it, or the ring
 * was never touched) or genuinely new — and only node identity tells the two
 * apart, since coordinates alone would make a slice along a shared wall look
 * like forty new nodes.
 *
 * The index is built from the loaded tile features, which contain buildings and
 * parts only. That bounds reuse to building geometry by construction: a vertex
 * can never be glued onto a highway or a fence node, because those were never
 * parsed.
 */

interface ExistingNode {
  id: number;
  coordinates: LngLat;
  /** Ids of the elements using this node, e.g. `["way/1", "way/2"]`. */
  ownerIds: string[];
}

interface NodeIndex {
  /** Exact position -> node. Two ways sharing a wall share these entries. */
  byKey: Map<string, ExistingNode>;
  /** The same nodes bucketed into ~1 m cells, for near-miss lookups. */
  buckets: Map<string, ExistingNode[]>;
}

/** ~1.1 m cells: five decimal places of a degree. */
const BUCKET_DECIMALS = 5;
const BUCKET_SCALE = 10 ** BUCKET_DECIMALS;

function bucketKey(lon: number, lat: number): string {
  return `${Math.floor(lon * BUCKET_SCALE)},${Math.floor(lat * BUCKET_SCALE)}`;
}

/**
 * How far from an existing node a new vertex may land and still be treated as
 * that node. Two grid steps: close enough that OSM could not meaningfully hold
 * them apart, far enough to absorb the rounding in an edge snap.
 */
export const NODE_REUSE_METERS = 0.03;

export function buildNodeIndex(collection: FeatureCollection): NodeIndex {
  const byKey = new Map<string, ExistingNode>();
  const buckets = new Map<string, ExistingNode[]>();

  for (const feature of collection.features) {
    const properties = (feature.properties ?? {}) as BuildingProperties;
    const nodeIds = properties.node_ids;
    if (properties.osm_type !== "way" || !Array.isArray(nodeIds)) continue;
    if (feature.geometry.type !== "Polygon") continue;
    const ring = feature.geometry.coordinates[0];
    if (!ring || ring.length !== nodeIds.length) continue;

    for (const [index, id] of nodeIds.entries()) {
      if (typeof id !== "number") continue;
      const coordinates = roundToOsmGrid([ring[index][0], ring[index][1]]);
      const key = coordinateKey(coordinates);
      const known = byKey.get(key);
      if (known) {
        if (typeof properties.id === "string" && !known.ownerIds.includes(properties.id)) {
          known.ownerIds.push(properties.id);
        }
        continue;
      }
      const node: ExistingNode = {
        id,
        coordinates,
        ownerIds: typeof properties.id === "string" ? [properties.id] : [],
      };
      byKey.set(key, node);
      const bucket = bucketKey(coordinates[0], coordinates[1]);
      const cell = buckets.get(bucket);
      if (cell) cell.push(node);
      else buckets.set(bucket, [node]);
    }
  }

  return { byKey, buckets };
}

function nearbyNodes(index: NodeIndex, [lon, lat]: LngLat): ExistingNode[] {
  const step = 1 / BUCKET_SCALE;
  const found: ExistingNode[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = index.buckets.get(bucketKey(lon + dx * step, lat + dy * step));
      if (cell) found.push(...cell);
    }
  }
  return found;
}

/**
 * The node an upload should reuse for this vertex, if any.
 *
 * An exact position match is always the same node — nothing else can hold that
 * position. A near miss is only accepted for `allowedOwnerIds`, the elements the
 * edit is actually about: absorbing a vertex into an unrelated building's node
 * would tie the two together, so that stays a deliberate, explicit act.
 */
export function findExistingNode(
  index: NodeIndex,
  point: LngLat,
  allowedOwnerIds?: Set<string>,
): { node: ExistingNode; exact: boolean } | null {
  const rounded = roundToOsmGrid(point);
  const exact = index.byKey.get(coordinateKey(rounded));
  if (exact) return { node: exact, exact: true };

  let best: ExistingNode | null = null;
  let bestDistance = NODE_REUSE_METERS;
  for (const candidate of nearbyNodes(index, rounded)) {
    if (allowedOwnerIds && !candidate.ownerIds.some((id) => allowedOwnerIds.has(id))) continue;
    const distance = metersBetween(rounded, candidate.coordinates);
    if (distance > bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best ? { node: best, exact: false } : null;
}
