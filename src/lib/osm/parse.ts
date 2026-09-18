import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingProperties, LngLat } from "../buildings";
import { pointInRing, ringCenter } from "../geometry";
import { type RelationMemberWay, relationMemberWays } from "./member-way";

/**
 * Turns an OSM API `/map.json` response into building and building:part
 * polygons. OSM tags are normalized onto the shared property names used by the
 * height rules and map colors (see src/lib/buildings.ts), while the raw tags
 * ride along under `tags` for the inspector. OSM identity — element type, id,
 * version and node ids — is preserved because editing will need it, and so are
 * the version and tags of every node a way uses: dragging a corner modifies that
 * node in place, and a modify has to carry both (see ./nodes.ts).
 */

type OsmTags = Record<string, string>;

interface OsmNode {
  type: "node";
  id: number;
  version: number;
  lat: number;
  lon: number;
  tags?: OsmTags;
}

interface OsmWay {
  type: "way";
  id: number;
  version: number;
  nodes: number[];
  tags?: OsmTags;
}

interface OsmRelation {
  type: "relation";
  id: number;
  version: number;
  members: { type: string; ref: number; role: string }[];
  tags?: OsmTags;
}

type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OsmMapResponse {
  elements: OsmElement[];
}

/** Building types where one level is assumed to be 3 m tall; others get 4 m. */
const RESIDENTIAL_TYPES = new Set([
  "apartments",
  "residential",
  "house",
  "detached",
  "semidetached_house",
  "terrace",
  "dormitory",
  "bungalow",
]);

/** Parse an OSM height value ("12", "12.5 m", "40 ft", `20'`) into meters. */
export function parseMeters(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*(m|meters?|ft|feet|')?$/i);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2]?.toLowerCase();
  return unit === "ft" || unit === "feet" || unit === "'" ? amount * 0.3048 : amount;
}

function parseCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const count = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(count) ? count : undefined;
}

function isTruthyTag(value: string | undefined): boolean {
  return value !== undefined && value !== "no" && value !== "false";
}

/** Map OSM tags onto the shared normalized properties, keeping the raw tags. */
export function normalizeOsmTags(tags: OsmTags, role: "building" | "part"): BuildingProperties {
  const type = tags.building ?? tags["building:part"] ?? "yes";
  const properties: BuildingProperties = { role, tags };

  if (RESIDENTIAL_TYPES.has(type)) properties.subtype = "residential";
  if (type !== "yes") properties.class = type;
  if (tags.name) properties["@name"] = tags.name;

  const height = parseMeters(tags.height);
  if (height !== undefined) properties.height = height;

  const levels = parseCount(tags["building:levels"]);
  if (levels !== undefined) properties.num_floors = levels;

  const minHeight = parseMeters(tags.min_height);
  if (minHeight !== undefined) properties.min_height = minHeight;

  const minLevel = parseCount(tags["building:min_level"]);
  if (minLevel !== undefined) properties.min_floor = minLevel;

  if (tags["roof:shape"]) properties.roof_shape = tags["roof:shape"];

  if (tags["roof:orientation"]) properties.roof_orientation = tags["roof:orientation"];

  if (tags["roof:direction"]) properties.roof_direction = tags["roof:direction"];

  const roofHeight = parseMeters(tags["roof:height"]);
  if (roofHeight !== undefined) properties.roof_height = roofHeight;

  return properties;
}

function ringOf(way: OsmWay, nodes: Map<number, OsmNode>): LngLat[] | null {
  const ring: LngLat[] = [];
  for (const id of way.nodes) {
    const node = nodes.get(id);
    // Ways can reference nodes outside the requested bbox; those are unusable.
    if (!node) return null;
    ring.push([node.lon, node.lat]);
  }
  if (ring.length < 4) return null;
  const [first] = ring;
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  return ring;
}

const pointKey = (point: LngLat) => `${point[0]},${point[1]}`;

/** Join open way segments into closed rings by matching endpoints. */
function assembleRings(segments: LngLat[][]): LngLat[][] {
  const rings: LngLat[][] = [];
  const pool = segments.map((segment) => [...segment]);
  while (pool.length > 0) {
    let ring = pool.pop() as LngLat[];
    let extended = true;
    while (extended && pointKey(ring[0]) !== pointKey(ring[ring.length - 1])) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const segment = pool[i];
        const head = ring[ring.length - 1];
        if (pointKey(segment[0]) === pointKey(head)) {
          ring = ring.concat(segment.slice(1));
        } else if (pointKey(segment[segment.length - 1]) === pointKey(head)) {
          ring = ring.concat(segment.slice(0, -1).reverse());
        } else {
          continue;
        }
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4 && pointKey(ring[0]) === pointKey(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function roleOf(tags: OsmTags): "building" | "part" | null {
  if (isTruthyTag(tags["building:part"])) return "part";
  if (isTruthyTag(tags.building)) return "building";
  return null;
}

/** The tags of the few way nodes that have any, keyed by node id. */
function taggedNodes(
  way: OsmWay,
  nodes: Map<number, OsmNode>,
): Record<string, OsmTags> | undefined {
  const tagged: Record<string, OsmTags> = {};
  for (const id of way.nodes) {
    const nodeTags = nodes.get(id)?.tags;
    if (nodeTags && Object.keys(nodeTags).length > 0) tagged[id] = nodeTags;
  }
  return Object.keys(tagged).length > 0 ? tagged : undefined;
}

function feature(
  osmType: "way" | "relation",
  element: OsmWay | OsmRelation,
  role: "building" | "part",
  geometry: Polygon | MultiPolygon,
  nodes: Map<number, OsmNode>,
  memberWays?: RelationMemberWay[],
): Feature<Polygon | MultiPolygon> {
  const tags = element.tags ?? {};
  return {
    type: "Feature",
    id: `${osmType}/${element.id}`,
    geometry,
    properties: {
      ...normalizeOsmTags(tags, role),
      id: `${osmType}/${element.id}`,
      osm_type: osmType,
      osm_id: element.id,
      version: element.version,
      // Node ids are what a changeset has to reuse or add; keep them. Index i
      // is the node at outer-ring vertex i, because `ringOf` walks `way.nodes`
      // in order.
      node_ids: element.type === "way" ? element.nodes : undefined,
      // Moving a node is a modify, and a modify replaces the whole element: it
      // needs the version we read, or the API cannot reject a conflict, and the
      // node's own tags, or the upload would silently delete them. A zero
      // version means the node was not in the response and must not be moved.
      node_versions:
        element.type === "way" ? element.nodes.map((id) => nodes.get(id)?.version ?? 0) : undefined,
      node_tags: element.type === "way" ? taggedNodes(element, nodes) : undefined,
      // A relation modify must resend the full member list, so keep it. Ring
      // geometry is assembled across members, so it carries no node identity.
      members: element.type === "relation" ? element.members : undefined,
      // Unlike the assembled GeoJSON rings, these retain which upstream way
      // owns each node. Slice can therefore insert a shared boundary node into
      // the member way without rewriting or guessing the relation topology.
      member_ways: element.type === "relation" ? memberWays : undefined,
    },
  };
}

/**
 * Assemble the rings a relation's member ways describe. A member is either a
 * closed ring of its own or an open segment that only closes once joined to its
 * neighbours, so outers and inners are stitched separately and each inner is
 * then nested into whichever outer contains it. Null when no outer closes,
 * which is how a relation read across a tile edge reports that it has nothing
 * drawable yet rather than drawing a wrong shape.
 */
function multiPolygonFromMemberWays(members: RelationMemberWay[]): MultiPolygon | null {
  const segmentsFor = (wantedRole: string) =>
    members
      .filter((member) => member.role === wantedRole)
      .map((member) => member.coordinates)
      .filter((points) => points.length >= 2);

  const outers = assembleRings(segmentsFor("outer"));
  if (outers.length === 0) return null;

  const polygons: LngLat[][][] = outers.map((outer) => [outer]);
  for (const inner of assembleRings(segmentsFor("inner"))) {
    const center = ringCenter(inner);
    const host = polygons.find((rings) => pointInRing(center, rings[0])) ?? polygons[0];
    host.push(inner);
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

/**
 * Merge two tile reads of the same element, the newer read winning.
 *
 * A multipolygon relation whose members straddle a tile boundary comes back
 * from every tile it touches, but each read only carries the members that
 * tile's bbox reached: Palais de Chaillot is two detached wings 200 m apart, so
 * the tile holding both reads it whole while the two tiles beside it each read
 * a single wing. Taking the later read whole would drop whichever wing that
 * tile missed, and which one survived would depend on the order tiles happened
 * to arrive. Union the member ways instead and reassemble the rings from the
 * union.
 */
export function mergeTileReads(previous: Feature, next: Feature): Feature {
  // A version bump means the element changed upstream between the two reads, so
  // the older one may describe members the relation no longer has.
  if (previous.properties?.version !== next.properties?.version) {
    return Number(previous.properties?.version) > Number(next.properties?.version)
      ? previous
      : next;
  }

  const known = relationMemberWays(previous.properties?.member_ways);
  const incoming = relationMemberWays(next.properties?.member_ways);
  if (known.length === 0 || incoming.length === 0) return next;

  const byId = new Map(known.map((member) => [member.id, member]));
  for (const member of incoming) {
    const existing = byId.get(member.id);
    if (!existing || member.version >= existing.version) byId.set(member.id, member);
  }
  if (byId.size === incoming.length && incoming.every((member) => byId.get(member.id) === member))
    return next;

  // Follow the relation's own member order, so the merged list does not depend
  // on which tile arrived first.
  const refs = next.properties?.members;
  const order = Array.isArray(refs)
    ? (refs as { type: string; ref: number }[])
        .filter((member) => member.type === "way")
        .map((member) => member.ref)
    : [...byId.keys()];
  const members = order
    .map((ref) => byId.get(ref))
    .filter((member): member is RelationMemberWay => member !== undefined);

  const geometry = multiPolygonFromMemberWays(members);
  if (!geometry) return next;
  return { ...next, geometry, properties: { ...next.properties, member_ways: members } };
}

/**
 * Extract buildings and parts as GeoJSON. Multipolygon relations are assembled
 * from their member ways; relation members outside the bbox are skipped rather
 * than drawn wrong.
 */
export function osmToBuildings(response: OsmMapResponse): FeatureCollection {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const element of response.elements) {
    if (element.type === "node") nodes.set(element.id, element);
    else if (element.type === "way") ways.set(element.id, element);
    else relations.push(element);
  }

  const features: Feature<Polygon | MultiPolygon>[] = [];
  const consumedByRelation = new Set<number>();

  for (const relation of relations) {
    const tags = relation.tags ?? {};
    const role = roleOf(tags);
    if (!role || tags.type !== "multipolygon") continue;

    const memberWays = relation.members
      .filter((member) => member.type === "way")
      .map((member): RelationMemberWay | null => {
        const way = ways.get(member.ref);
        if (!way) return null;
        const coordinates = way.nodes.map((id) => nodes.get(id));
        if (coordinates.some((node) => node === undefined)) return null;
        return {
          id: way.id,
          version: way.version,
          role: member.role || "outer",
          nodes: [...way.nodes],
          coordinates: coordinates.map((node) => [node!.lon, node!.lat]),
          node_versions: way.nodes.map((id) => nodes.get(id)?.version ?? 0),
          node_tags: taggedNodes(way, nodes),
          tags: { ...way.tags },
        };
      })
      .filter((member): member is RelationMemberWay => member !== null);

    const geometry = multiPolygonFromMemberWays(memberWays);
    if (!geometry) continue;
    // Only the ways that became rings are the relation's outline. A member in
    // some other role stays a feature of its own if it is tagged as one.
    for (const member of memberWays) {
      if (member.role === "outer" || member.role === "inner") consumedByRelation.add(member.id);
    }

    features.push(feature("relation", relation, role, geometry, nodes, memberWays));
  }

  for (const way of ways.values()) {
    const role = roleOf(way.tags ?? {});
    if (!role || consumedByRelation.has(way.id)) continue;
    const ring = ringOf(way, nodes);
    if (!ring) continue;
    features.push(feature("way", way, role, { type: "Polygon", coordinates: [ring] }, nodes));
  }

  return { type: "FeatureCollection", features };
}
