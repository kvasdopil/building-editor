import type { LngLat } from "../buildings";

/**
 * One way member retained alongside an assembled multipolygon feature.
 *
 * Rendering needs only the assembled rings, but editing a relation boundary
 * must write the member way that owns that ring. Keeping its node identities,
 * versions, tags and coordinates makes that translation deterministic.
 */
export interface RelationMemberWay {
  id: number;
  version: number;
  role: string;
  nodes: number[];
  coordinates: LngLat[];
  node_versions: number[];
  node_tags?: Record<string, Record<string, string>>;
  tags: Record<string, string>;
}

export function relationMemberWays(value: unknown): RelationMemberWay[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is RelationMemberWay =>
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as RelationMemberWay).id === "number" &&
      typeof (candidate as RelationMemberWay).version === "number" &&
      Array.isArray((candidate as RelationMemberWay).nodes) &&
      Array.isArray((candidate as RelationMemberWay).coordinates),
  );
}
