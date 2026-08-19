import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingProperties, LngLat } from "../buildings";
import { pointInRing, ringCenter } from "../geometry";

/**
 * Turns an OSM API `/map.json` response into building and building:part
 * polygons. OSM tags are normalized onto the shared property names used by the
 * height rules and map colors (see src/lib/buildings.ts), while the raw tags
 * ride along under `tags` for the inspector. OSM identity — element type, id,
 * version and node ids — is preserved because editing will need it.
 */

type OsmTags = Record<string, string>;

interface OsmNode {
  type: "node";
  id: number;
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
function parseMeters(value: string | undefined): number | undefined {
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

function feature(
  osmType: "way" | "relation",
  element: OsmWay | OsmRelation,
  role: "building" | "part",
  geometry: Polygon | MultiPolygon,
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
      // Node ids are what a future changeset has to move; keep them.
      node_ids: element.type === "way" ? element.nodes : undefined,
    },
  };
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

    const segmentsFor = (wantedRole: string) =>
      relation.members
        .filter(
          (m) =>
            m.type === "way" &&
            (m.role === wantedRole || (wantedRole === "outer" && m.role === "")),
        )
        .map((m) => ways.get(m.ref))
        .filter((way): way is OsmWay => way !== undefined)
        .map((way) => {
          const points = way.nodes
            .map((id) => nodes.get(id))
            .filter((node): node is OsmNode => node !== undefined)
            .map((node): LngLat => [node.lon, node.lat]);
          if (points.length === way.nodes.length) consumedByRelation.add(way.id);
          return points;
        })
        .filter((points) => points.length >= 2);

    const outers = assembleRings(segmentsFor("outer"));
    if (outers.length === 0) continue;
    const inners = assembleRings(segmentsFor("inner"));

    const polygons: LngLat[][][] = outers.map((outer) => [outer]);
    for (const inner of inners) {
      const center = ringCenter(inner);
      const host = polygons.find((rings) => pointInRing(center, rings[0])) ?? polygons[0];
      host.push(inner);
    }
    features.push(
      feature("relation", relation, role, { type: "MultiPolygon", coordinates: polygons }),
    );
  }

  for (const way of ways.values()) {
    const role = roleOf(way.tags ?? {});
    if (!role || consumedByRelation.has(way.id)) continue;
    const ring = ringOf(way, nodes);
    if (!ring) continue;
    features.push(feature("way", way, role, { type: "Polygon", coordinates: [ring] }));
  }

  return { type: "FeatureCollection", features };
}
