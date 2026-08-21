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
 *
 * The same entries carry what it takes to *move* a node rather than replace it.
 * That distinction matters most for the ways this index cannot see: a fence, a
 * path, or a building outside the loaded tiles keeps referencing the node, so
 * moving it in place carries them along, while creating a new node next to it
 * would leave them behind on a corner the mapper thought they had dragged.
 */

export interface ExistingNode {
  id: number;
  coordinates: LngLat;
  /**
   * The version read from OSM. Moving this node is a `modify`, which needs it so
   * the API can reject a conflict instead of overwriting a newer edit. Zero when
   * the loaded data does not carry one, and then the node must not be moved.
   */
  version: number;
  /** The node's own tags. A modify replaces the element, so they are resent. */
  tags: Record<string, string>;
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
    // Both are written by the same parser, index for index with `node_ids`. A
    // tile cached before they existed simply has no versions, which reads back
    // as "unknown" and blocks a move rather than guessing one.
    const versions = Array.isArray(properties.node_versions) ? properties.node_versions : [];
    const nodeTags = (properties.node_tags ?? {}) as Record<string, Record<string, string>>;

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
      const version = versions[index];
      const node: ExistingNode = {
        id,
        coordinates,
        version: typeof version === "number" ? version : 0,
        tags: nodeTags[id] ?? {},
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

/**
 * The node standing at exactly this position, if any. Exact is the only match
 * that means "the same node" on its own, which is what resolving a drag's origin
 * back to the node being moved requires.
 */
export function nodeAt(index: NodeIndex, point: LngLat): ExistingNode | null {
  return index.byKey.get(coordinateKey(point)) ?? null;
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
