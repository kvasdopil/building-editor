import type { Feature, FeatureCollection } from "geojson";
import type { BuildingProperties, LngLat } from "../buildings";
import type { EditMap } from "../edits";
import type { CreatedPartMap, EditableGeometry, GeometryEditMap } from "../geometry-edits";
import { closestPointOnSegment, openRing } from "../geometry";
import { issue, type Issue } from "./issues";
import { buildNodeIndex, findExistingNode, NODE_REUSE_METERS } from "./nodes";
import { formatCoordinate, metersBetween, roundToOsmGrid } from "./precision";
import { drawnId } from "./ref";
import { selectFromOsm } from "./select";

/**
 * Turn the local pending changes into the elements an OSM changeset would carry.
 * Nothing here talks to the network: the result is a reviewable plan, and the
 * upload step (EP-001 FT-06) only has to POST it.
 *
 * Three things make this more than a serialization pass:
 *
 * - **Node identity.** Every vertex is resolved against the nodes already in the
 *   loaded data, so an unchanged wall keeps its nodes and a slice along a shared
 *   wall adds two nodes rather than forty (see ./nodes.ts).
 * - **Versions.** A modify must carry the version we read, so the API can reject
 *   it with a conflict instead of silently overwriting a newer edit.
 * - **Element shape.** A way holds exactly one ring. Cutting a hole therefore
 *   converts the way into a `type=multipolygon` relation — tags move to the
 *   relation, the way stays as the untagged outer member — which is what the
 *   multipolygon wiki prescribes and what JOSM's "create multipolygon" does.
 */

type Tags = Record<string, string>;

type OsmElementType = "node" | "way" | "relation";

interface ChangesetMember {
  type: OsmElementType;
  ref: number;
  role: string;
}

interface ChangesetNode {
  /** Negative placeholder id; the API assigns the real one on upload. */
  id: number;
  coordinates: LngLat;
}

interface ChangesetWay {
  ref: string;
  id: number;
  version?: number;
  action: "create" | "modify";
  /** Closed node list: the first id is repeated at the end. */
  nodes: number[];
  tags: Tags;
}

interface ChangesetRelation {
  ref: string;
  id: number;
  version?: number;
  action: "create" | "modify";
  members: ChangesetMember[];
  tags: Tags;
}

interface TagChange {
  key: string;
  from?: string;
  to?: string;
}

/** One reviewable line in the submit dialog: what happens to one entity. */
export interface ChangesetEntry {
  /** App element id: `way/123` upstream, `way/-1` for something drawn here. */
  ref: string;
  action: "create" | "modify";
  /** What is written upstream, e.g. `way/123` or `new way`. */
  target: string;
  version?: number;
  tagChanges: TagChange[];
  geometry?: { reusedNodes: number; newNodes: number; sharedWith: string[] };
  /** Structural consequences worth spelling out for a reviewer. */
  notes: string[];
}

export interface ChangesetPlan {
  /** Created nodes only: existing nodes are reused in place, never moved. */
  nodes: ChangesetNode[];
  ways: ChangesetWay[];
  relations: ChangesetRelation[];
  entries: ChangesetEntry[];
  /** Vertices resolved onto a node that already exists in OSM. */
  reusedNodes: number;
  /** Vertices that collapsed onto another new node at the same position. */
  mergedNodes: number;
  /** Pending changes that would write nothing and were left out. */
  dropped: string[];
  /** Problems found while structuring the changeset. */
  issues: Issue[];
}

/** API limits (`/api/capabilities`); exceeded ones have to be split, not truncated. */
export const MAX_WAY_NODES = 2000;
export const MAX_CHANGESET_ELEMENTS = 10_000;

const CREATED_BY = "building-editor";

export interface ChangesetInput {
  /** Raw OSM features as loaded, before local edits. */
  features: FeatureCollection;
  tagEdits: EditMap;
  geometryEdits: GeometryEditMap;
  createdParts: CreatedPartMap;
}

function tagsOf(properties: BuildingProperties): Tags {
  const tags = properties.tags;
  return tags && typeof tags === "object" ? ({ ...tags } as Tags) : {};
}

/**
 * The tags to write: pending overrides on top of what OSM has. An override with
 * an empty value removes the tag, which is how OSM expresses a tag deletion.
 */
function mergeTags(base: Tags, changed: Tags | undefined): Tags {
  const tags = { ...base };
  for (const [key, raw] of Object.entries(changed ?? {})) {
    const value = raw.trim();
    if (value === "") delete tags[key];
    else tags[key] = value;
  }
  return tags;
}

function tagChanges(base: Tags, next: Tags): TagChange[] {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(next)])].sort();
  return keys
    .filter((key) => base[key] !== next[key])
    .map((key) => ({ key, from: base[key], to: next[key] }));
}

function ringsOf(geometry: EditableGeometry): LngLat[][][] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((rings) => rings.map((ring) => ring.map((p): LngLat => [p[0], p[1]])));
}

/**
 * How far along the segment `point` sits, or null when it is not on the segment.
 * Endpoints are excluded: a vertex on one would have matched that node exactly.
 */
function positionOnSegment(point: LngLat, start: LngLat, end: LngLat): number | null {
  const { at, closest } = closestPointOnSegment(point, start, end);
  if (at <= 0 || at >= 1) return null;
  return metersBetween(point, closest) <= NODE_REUSE_METERS ? at : null;
}

export function buildChangeset(input: ChangesetInput): ChangesetPlan {
  const { features, tagEdits, geometryEdits, createdParts } = input;
  const index = buildNodeIndex(features);
  const existingPositions = new Map<number, LngLat>();
  for (const node of index.byKey.values()) existingPositions.set(node.id, node.coordinates);
  const rawById = new Map<string, Feature>();
  for (const feature of features.features) {
    const id = (feature.properties as BuildingProperties | null)?.id;
    if (typeof id === "string") rawById.set(id, feature);
  }

  const nodes: ChangesetNode[] = [];
  const newNodeByKey = new Map<string, number>();
  const ways = new Map<string, ChangesetWay>();
  const relations = new Map<string, ChangesetRelation>();
  const entries = new Map<string, ChangesetEntry>();
  const issues: Issue[] = [];
  const dropped: string[] = [];
  const createdNodes: { id: number; coordinates: LngLat; ref: string }[] = [];
  // Drawn elements already carry the placeholder id they will be uploaded with,
  // so extra elements start below the lowest of them.
  let nextPlaceholder =
    Object.keys(createdParts).reduce((lowest, ref) => Math.min(lowest, drawnId(ref) ?? 0), 0) - 1;
  let reusedNodes = 0;
  let mergedNodes = 0;

  const groups = new Map<string, Set<string>>();
  /** The building an edit is about, plus its parts: the scope for node reuse. */
  const groupOf = (elementId: string): Set<string> => {
    const cached = groups.get(elementId);
    if (cached) return cached;
    const selection = selectFromOsm(features, elementId);
    const group = new Set<string>([elementId]);
    if (selection) {
      group.add(selection.building.id);
      for (const part of selection.parts) group.add(part.id);
    }
    groups.set(elementId, group);
    return group;
  };

  const entryFor = (ref: string, base: Omit<ChangesetEntry, "notes" | "tagChanges">) => {
    const existing = entries.get(ref);
    if (existing) return existing;
    const entry: ChangesetEntry = { ...base, tagChanges: [], notes: [] };
    entries.set(ref, entry);
    return entry;
  };

  const resolveRing = (ring: LngLat[], ref: string, scope: Set<string>) => {
    const ids: number[] = [];
    const sharedWith = new Set<string>();
    let reused = 0;
    let created = 0;
    for (const vertex of openRing(ring)) {
      const point = roundToOsmGrid(vertex);
      const found = findExistingNode(index, point, scope);
      if (found) {
        ids.push(found.node.id);
        reused++;
        reusedNodes++;
        for (const owner of found.node.ownerIds) if (owner !== ref) sharedWith.add(owner);
        continue;
      }
      const key = `${point[0]},${point[1]}`;
      const merged = newNodeByKey.get(key);
      if (merged !== undefined) {
        // Two drawn vertices at one position are one node, or the parts either
        // side of a slice would not be joined.
        ids.push(merged);
        mergedNodes++;
        continue;
      }
      const id = nextPlaceholder--;
      newNodeByKey.set(key, id);
      nodes.push({ id, coordinates: point });
      createdNodes.push({ id, coordinates: point, ref });
      ids.push(id);
      created++;
    }
    return { nodes: ids.length > 0 ? [...ids, ids[0]] : ids, reused, created, sharedWith };
  };

  /**
   * Plan the elements for one polygonal geometry. A single ring is one way;
   * anything with holes or several polygons needs a multipolygon relation, and
   * an existing way then becomes its untagged outer member.
   */
  const planGeometry = (
    ref: string,
    geometry: EditableGeometry,
    tags: Tags,
    existing: { type: "way"; id: number; version: number } | null,
    entry: ChangesetEntry,
  ) => {
    const polygons = ringsOf(geometry);
    if (polygons.length === 0 || polygons[0].length === 0) {
      issues.push(issue("error", "empty-geometry", "The edited geometry has no rings.", [ref]));
      return;
    }
    const scope = groupOf(ref);
    const simple = polygons.length === 1 && polygons[0].length === 1;

    const wayFor = (ring: LngLat[], wayRef: string, wayTags: Tags): ChangesetWay | null => {
      const resolved = resolveRing(ring, wayRef, scope);
      if (resolved.nodes.length < 4) {
        issues.push(
          issue("error", "degenerate-ring", "A ring collapsed to fewer than three nodes.", [ref]),
        );
        return null;
      }
      const reuseOfExisting = existing && wayRef === ref;
      const drawn = wayRef === ref ? drawnId(ref) : null;
      const way: ChangesetWay = {
        ref: wayRef,
        id: reuseOfExisting ? existing.id : (drawn ?? nextPlaceholder--),
        version: reuseOfExisting ? existing.version : undefined,
        action: reuseOfExisting ? "modify" : "create",
        nodes: resolved.nodes,
        tags: wayTags,
      };
      ways.set(wayRef, way);
      if (wayRef === ref || wayRef === `${ref}#ring-1`) {
        entry.geometry = {
          reusedNodes: resolved.reused,
          newNodes: resolved.created,
          sharedWith: [...resolved.sharedWith],
        };
      }
      return way;
    };

    if (simple) {
      wayFor(polygons[0][0], ref, tags);
      return;
    }

    // Multipolygon: one way per ring, all untagged, tags on the relation.
    const members: ChangesetMember[] = [];
    let ringNumber = 0;
    for (const [polygonIndex, rings] of polygons.entries()) {
      for (const [ringIndex, ring] of rings.entries()) {
        const isOuterOfExisting = existing && polygonIndex === 0 && ringIndex === 0;
        const wayRef = isOuterOfExisting ? ref : `${ref}#ring-${++ringNumber}`;
        const way = wayFor(ring, wayRef, {});
        if (!way) return;
        members.push({ type: "way", ref: way.id, role: ringIndex === 0 ? "outer" : "inner" });
      }
    }

    // The drawn element becomes the relation, so it keeps the placeholder id.
    const relationRef = existing ? `${ref}#multipolygon` : ref;
    relations.set(relationRef, {
      ref: relationRef,
      id: drawnId(ref) ?? nextPlaceholder--,
      action: "create",
      members,
      tags: { ...tags, type: "multipolygon" },
    });
    if (!existing) entry.target = "new relation";
    entry.notes.push(
      existing
        ? `A way holds one ring, so ${ref} becomes the untagged outer member of a new type=multipolygon relation, which carries the tags.`
        : "Holes need a type=multipolygon relation: one new way per ring, tags on the relation.",
    );
  };

  /** The identity a modify needs: the element as loaded, with its version. */
  const loadedTarget = (
    ref: string,
  ): { properties: BuildingProperties; osmId: number; version: number } | null => {
    const raw = rawById.get(ref);
    if (!raw) {
      issues.push(
        drawnId(ref) !== null
          ? issue(
              "error",
              "drawn-element-missing",
              `${ref} has pending tags but the drawn geometry they belong to is gone. Revert it and draw it again.`,
              [ref],
            )
          : issue(
              "error",
              "element-not-loaded",
              `${ref} is not in the loaded data — pan back to it so its current version can be read.`,
              [ref],
            ),
      );
      return null;
    }
    const properties = raw.properties as BuildingProperties;
    const osmId = properties.osm_id;
    const version = properties.version;
    if (typeof osmId !== "number" || typeof version !== "number") {
      issues.push(
        issue(
          "error",
          "missing-version",
          `${ref} has no version, so modifying it would risk overwriting a newer edit.`,
          [ref],
        ),
      );
      return null;
    }
    return { properties, osmId, version };
  };

  // 1. Created parts: new ways (or a new multipolygon) with the drawn geometry.
  for (const [ref, feature] of Object.entries(createdParts)) {
    const properties = feature.properties;
    const tags = mergeTags(tagsOf(properties), tagEdits[ref]?.changed);
    const entry = entryFor(ref, { ref, action: "create", target: "new way" });
    entry.tagChanges = tagChanges({}, tags);
    const parentId = typeof properties.parent_id === "string" ? properties.parent_id : null;
    if (parentId) groups.set(ref, groupOf(parentId));
    planGeometry(ref, feature.geometry, tags, null, entry);
  }

  // 2. Geometry overrides on existing elements.
  for (const [ref, override] of Object.entries(geometryEdits)) {
    const target = loadedTarget(ref);
    if (!target) continue;
    const { properties, osmId, version } = target;
    if (properties.osm_type !== "way") {
      // Ring geometry is assembled across member ways, so we cannot tell which
      // member changed. Editing relation geometry needs its own slice.
      issues.push(
        issue(
          "error",
          "relation-geometry-unsupported",
          `${ref} is a multipolygon relation; changing relation geometry is not supported yet.`,
          [ref],
        ),
      );
      continue;
    }
    const base = tagsOf(properties);
    const tags = mergeTags(base, tagEdits[ref]?.changed);
    const entry = entryFor(ref, { ref, action: "modify", target: ref, version });
    entry.tagChanges = tagChanges(base, tags);
    entry.notes.push(override.kind === "hole" ? "A hole was cut." : "The footprint was sliced.");
    planGeometry(ref, override.geometry, tags, { type: "way", id: osmId, version }, entry);
  }

  // 3. Tag-only edits on existing elements: the element is resent unchanged
  //    apart from its tags, so ways need their node list and relations their
  //    members.
  for (const [ref, edit] of Object.entries(tagEdits)) {
    if (ref in createdParts || ref in geometryEdits) continue;
    const target = loadedTarget(ref);
    if (!target) continue;
    const { properties, osmId, version } = target;
    const base = tagsOf(properties);
    const tags = mergeTags(base, edit.changed);
    const changes = tagChanges(base, tags);
    if (changes.length === 0) {
      // The pending value already matches OSM: writing it would bump the version
      // for nothing.
      dropped.push(ref);
      continue;
    }
    const entry = entryFor(ref, { ref, action: "modify", target: ref, version });
    entry.tagChanges = changes;

    if (properties.osm_type === "way") {
      const nodeIds = properties.node_ids;
      if (!Array.isArray(nodeIds) || nodeIds.length < 4) {
        issues.push(issue("error", "missing-node-list", `${ref} has no usable node list.`, [ref]));
        continue;
      }
      ways.set(ref, {
        ref,
        id: osmId,
        version,
        action: "modify",
        nodes: nodeIds as number[],
        tags,
      });
      continue;
    }

    const members = properties.members;
    if (!Array.isArray(members) || members.length === 0) {
      issues.push(
        issue(
          "error",
          "missing-member-list",
          `${ref} has no member list, so resending it would empty the relation.`,
          [ref],
        ),
      );
      continue;
    }
    relations.set(ref, {
      ref,
      id: osmId,
      version,
      action: "modify",
      members: (members as { type: string; ref: number; role: string }[]).map((member) => ({
        type: member.type as OsmElementType,
        ref: member.ref,
        role: member.role,
      })),
      tags,
    });
  }

  // Existing nodes keep the position OSM has; only drawn vertices are new.
  const positionOf = (nodeId: number): LngLat | undefined =>
    nodeId < 0
      ? createdNodes.find((node) => node.id === nodeId)?.coordinates
      : existingPositions.get(nodeId);

  glueNewNodes({ createdNodes, ways, entries, rawById, positionOf, issues, groupOf });

  return {
    nodes,
    ways: [...ways.values()],
    relations: [...relations.values()],
    entries: [...entries.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    reusedNodes,
    mergedNodes,
    dropped,
    issues,
  };
}

/**
 * Join new vertices that landed on an existing wall into that wall's way.
 *
 * A slice ends on the building outline, so its end vertices sit on an outline
 * segment without being nodes of it. Left that way, the part boundary crosses
 * the outline with nothing shared — what JOSM reports as crossing building ways,
 * and what comes apart the first time somebody drags the wall. Inserting the
 * node into the host way is the same fix JOSM's "join node to way" performs.
 */
function glueNewNodes(context: {
  createdNodes: { id: number; coordinates: LngLat; ref: string }[];
  ways: Map<string, ChangesetWay>;
  entries: Map<string, ChangesetEntry>;
  rawById: Map<string, Feature>;
  /** Position of any node the plan can refer to, existing or new. */
  positionOf: (nodeId: number) => LngLat | undefined;
  issues: Issue[];
  groupOf: (elementId: string) => Set<string>;
}) {
  const { createdNodes, ways, entries, rawById, positionOf, issues, groupOf } = context;
  if (createdNodes.length === 0) return;

  /** Candidate hosts: the buildings and parts the new nodes were drawn against. */
  const hostIds = new Set<string>();
  for (const node of createdNodes) for (const id of groupOf(node.ref)) hostIds.add(id);

  for (const hostId of hostIds) {
    const raw = rawById.get(hostId);
    if (!raw) continue;
    const properties = raw.properties as BuildingProperties;
    const candidates = createdNodes.filter((node) => node.ref !== hostId);
    if (candidates.length === 0) continue;

    const planned = ways.get(hostId);
    const nodeIds = planned?.nodes ?? (properties.node_ids as number[] | undefined);
    // The ring is read back from the node list going upstream, not from the
    // loaded geometry, so a host whose own footprint was just sliced is measured
    // as it will be — and the positions we find index that same list.
    const ring = nodeIds?.map(positionOf);
    if (properties.osm_type !== "way" || !nodeIds || !ring?.every((point) => point)) {
      // Only a way can take the node. A relation outline would need the change
      // applied to the right member way, which we cannot resolve from assembled
      // ring geometry, so say so rather than uploading walls that only look
      // coincident.
      const rings =
        raw.geometry.type === "Polygon"
          ? [raw.geometry.coordinates]
          : raw.geometry.type === "MultiPolygon"
            ? raw.geometry.coordinates
            : [];
      const touching = candidates.filter((node) =>
        rings.some((polygon) =>
          polygon.some((edge) =>
            edge.some(
              (point, i) =>
                i > 0 &&
                positionOnSegment(
                  node.coordinates,
                  [edge[i - 1][0], edge[i - 1][1]],
                  [point[0], point[1]],
                ) !== null,
            ),
          ),
        ),
      );
      if (touching.length > 0) {
        issues.push(
          issue(
            "warning",
            "node-not-joined-to-host",
            `${touching.length} new ${touching.length === 1 ? "node lies" : "nodes lie"} on ${hostId}, which is not a plain way: they cannot be joined to it, so the shared wall will only look shared.`,
            [hostId],
            touching[0].coordinates,
          ),
        );
      }
      continue;
    }

    const hostRing = ring as LngLat[];
    const insertions = new Map<number, { at: number; id: number }[]>();
    for (const node of candidates) {
      if (nodeIds.includes(node.id)) continue;
      for (let i = 1; i < hostRing.length; i++) {
        const at = positionOnSegment(node.coordinates, hostRing[i - 1], hostRing[i]);
        if (at === null) continue;
        const list = insertions.get(i - 1) ?? [];
        list.push({ at, id: node.id });
        insertions.set(i - 1, list);
        break;
      }
    }
    if (insertions.size === 0) continue;

    const next: number[] = [];
    for (const [i, id] of nodeIds.entries()) {
      next.push(id);
      const list = insertions.get(i);
      if (!list) continue;
      // Several nodes on one segment keep their order along it.
      for (const inserted of [...list].sort((a, b) => a.at - b.at)) next.push(inserted.id);
    }

    const added = next.length - nodeIds.length;
    const version = properties.version;
    const osmId = properties.osm_id;
    if (typeof version !== "number" || typeof osmId !== "number") continue;
    ways.set(hostId, {
      ...(planned ?? {
        ref: hostId,
        id: osmId,
        version,
        action: "modify" as const,
        tags: (properties.tags ?? {}) as Tags,
      }),
      nodes: next,
    });

    const entry = entries.get(hostId) ?? {
      ref: hostId,
      action: "modify" as const,
      target: hostId,
      version,
      tagChanges: [],
      notes: [],
    };
    entry.notes.push(
      `${added} node${added === 1 ? "" : "s"} inserted into this wall, so the new geometry shares it instead of crossing it.`,
    );
    entries.set(hostId, entry);
  }
}

export function changesetSize(plan: ChangesetPlan): number {
  return plan.nodes.length + plan.ways.length + plan.relations.length;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tagXml(tags: Tags, indent: string): string {
  return Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${indent}<tag k="${escapeXml(key)}" v="${escapeXml(value)}"/>`)
    .join("\n");
}

/** Changeset tags. `created_by` is expected of every editor. */
export function changesetTags(input: { comment: string; source?: string }): Tags {
  const tags: Tags = { created_by: CREATED_BY, comment: input.comment.trim() };
  const source = input.source?.trim();
  if (source) tags.source = source;
  return tags;
}

/** The body of `PUT /api/0.6/changeset/create`. */
export function toChangesetXml(tags: Tags): string {
  return [
    `<osm version="0.6" generator="${CREATED_BY}">`,
    `  <changeset>`,
    tagXml(tags, "    "),
    `  </changeset>`,
    `</osm>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The `osmChange` document for `POST /api/0.6/changeset/:id/upload`. Written
 * without a changeset id until one exists, which also makes it a valid `.osc`
 * file for checking the same edit in JOSM.
 */
export function toOsmChangeXml(plan: ChangesetPlan, changesetId?: number): string {
  const attribute = changesetId === undefined ? "" : ` changeset="${changesetId}"`;
  const lines: string[] = [`<osmChange version="0.6" generator="${CREATED_BY}">`];

  const nodeXml = (node: ChangesetNode) =>
    `    <node id="${node.id}"${attribute} lon="${formatCoordinate(node.coordinates[0])}" lat="${formatCoordinate(node.coordinates[1])}"/>`;

  const wayXml = (way: ChangesetWay) => {
    const version = way.version === undefined ? "" : ` version="${way.version}"`;
    const body = [
      ...way.nodes.map((id) => `      <nd ref="${id}"/>`),
      tagXml(way.tags, "      "),
    ].filter((line) => line !== "");
    return [`    <way id="${way.id}"${version}${attribute}>`, ...body, `    </way>`].join("\n");
  };

  const relationXml = (relation: ChangesetRelation) => {
    const version = relation.version === undefined ? "" : ` version="${relation.version}"`;
    const body = [
      ...relation.members.map(
        (member) =>
          `      <member type="${member.type}" ref="${member.ref}" role="${escapeXml(member.role)}"/>`,
      ),
      tagXml(relation.tags, "      "),
    ].filter((line) => line !== "");
    return [
      `    <relation id="${relation.id}"${version}${attribute}>`,
      ...body,
      `    </relation>`,
    ].join("\n");
  };

  for (const action of ["create", "modify"] as const) {
    const ways = plan.ways.filter((way) => way.action === action);
    const relations = plan.relations.filter((relation) => relation.action === action);
    const nodes = action === "create" ? plan.nodes : [];
    if (nodes.length === 0 && ways.length === 0 && relations.length === 0) continue;
    lines.push(`  <${action}>`);
    // Referenced elements come first, so placeholder ids are always defined
    // before they are used.
    lines.push(...nodes.map(nodeXml), ...ways.map(wayXml), ...relations.map(relationXml));
    lines.push(`  </${action}>`);
  }

  lines.push(`</osmChange>`);
  return lines.join("\n");
}
