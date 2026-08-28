import type { Feature, FeatureCollection } from "geojson";
import type { BuildingProperties, LngLat } from "../buildings";
import type { EditMap } from "../edits";
import {
  type CreatedPartMap,
  type EditableGeometry,
  type GeometryEditMap,
  positionOnSegment,
} from "../geometry-edits";
import { openRing } from "../geometry";
import { issue, type Issue } from "./issues";
import {
  buildNodeIndex,
  type ExistingNode,
  findExistingNode,
  nodeAt,
  NODE_REUSE_METERS,
} from "./nodes";
import { coordinateKey, formatCoordinate, roundToOsmGrid } from "./precision";
import { drawnId } from "./ref";
import { OsmBuildingLookup } from "./building-lookup";
import { relationMemberWays } from "./member-way";

/**
 * Turn the local pending changes into the elements an OSM changeset would carry.
 * Nothing here talks to the network: the result is a reviewable plan, and the
 * upload step (EP-001 FT-06) only has to POST it.
 *
 * Three things make this more than a serialization pass:
 *
 * - **Node identity.** Every vertex is resolved against the nodes already in the
 *   loaded data, so an unchanged wall keeps its nodes and a slice along a shared
 *   wall adds two nodes rather than forty (see ./nodes.ts). A dragged corner
 *   *moves* its node rather than replacing it, so everything else attached to
 *   that node comes along.
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
  /** Negative placeholder on create — the API assigns the real one — else the node id. */
  id: number;
  action: "create" | "modify";
  coordinates: LngLat;
  /** Modify only: the version read, so the API can reject a conflict. */
  version?: number;
  /** Modify only: the node's own tags, which a modify has to resend or delete. */
  tags?: Tags;
}

interface ChangesetWay {
  ref: string;
  id: number;
  version?: number;
  action: "create" | "modify";
  /** Node list. Areas repeat the first id at the end; relation members may be open. */
  nodes: number[];
  area: boolean;
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
  geometry?: { reusedNodes: number; newNodes: number; movedNodes: number; sharedWith: string[] };
  /** Structural consequences worth spelling out for a reviewer. */
  notes: string[];
}

export interface ChangesetPlan {
  /** Nodes to write: the ones drawn here, plus the existing ones being moved. */
  nodes: ChangesetNode[];
  ways: ChangesetWay[];
  relations: ChangesetRelation[];
  entries: ChangesetEntry[];
  /** Vertices resolved onto a node that already exists in OSM. */
  reusedNodes: number;
  /** Drawn vertices or existing nodes that collapsed onto one surviving node. */
  mergedNodes: number;
  /** Existing nodes being moved to a new position rather than replaced. */
  movedNodes: number;
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

interface RoleRing {
  role: "outer" | "inner";
  coordinates: LngLat[];
}

function roleRingsOf(geometry: EditableGeometry): RoleRing[] {
  return ringsOf(geometry).flatMap((rings) =>
    rings.map((coordinates, index) => ({
      role: index === 0 ? ("outer" as const) : ("inner" as const),
      coordinates,
    })),
  );
}

function sameCoordinate(a: LngLat, b: LngLat): boolean {
  return coordinateKey(roundToOsmGrid(a)) === coordinateKey(roundToOsmGrid(b));
}

function effectiveRing(ring: LngLat[], movedByCoordinate: Map<string, LngLat>): LngLat[] {
  return ring.map((point) => movedByCoordinate.get(coordinateKey(roundToOsmGrid(point))) ?? point);
}

/**
 * Return a member's coordinates in the direction used by an assembled ring.
 * Member ways may be reversed while a multipolygon is assembled, so their XML
 * order cannot by itself tell us which edited arc belongs to them.
 */
function orientMemberInRing(memberCoordinates: LngLat[], assembledRing: LngLat[]): LngLat[] | null {
  const ring = openRing(assembledRing);
  const closed =
    memberCoordinates.length >= 2 &&
    sameCoordinate(memberCoordinates[0], memberCoordinates[memberCoordinates.length - 1]);
  const member = closed ? openRing(memberCoordinates) : memberCoordinates;
  if (ring.length === 0 || member.length < 2) return null;

  const candidates = [member, [...member].reverse()];
  for (const candidate of candidates) {
    for (let start = 0; start < ring.length; start++) {
      if (!sameCoordinate(ring[start], candidate[0])) continue;
      const matches = candidate.every((point, offset) =>
        sameCoordinate(ring[(start + offset) % ring.length], point),
      );
      if (!matches) continue;
      if (closed && candidate.length !== ring.length) continue;
      return candidate;
    }
  }
  return null;
}

/**
 * Extract the edited arc owned by a member from its surviving anchor nodes.
 * Extra vertices are accepted between consecutive anchors; every old anchor
 * must remain, in order. That makes boundary insertion and an add-part detour
 * deterministic without guessing from proximity.
 */
function editedMemberPath(
  editedRing: LngLat[],
  anchors: LngLat[],
  closed: boolean,
): LngLat[] | null {
  const ring = openRing(editedRing);
  if (ring.length === 0 || anchors.length < 2) return null;

  for (let start = 0; start < ring.length; start++) {
    if (!sameCoordinate(ring[start], anchors[0])) continue;
    const path: LngLat[] = [ring[start]];
    let anchorIndex = 1;
    const limit = closed ? ring.length : ring.length - 1;
    for (let offset = 1; offset <= limit; offset++) {
      const point = ring[(start + offset) % ring.length];
      path.push(point);
      if (anchorIndex < anchors.length && sameCoordinate(point, anchors[anchorIndex])) {
        anchorIndex++;
      }
      if (!closed && anchorIndex === anchors.length) return path;
    }
    if (closed && anchorIndex === anchors.length) return path;
  }
  return null;
}

export function buildChangeset(input: ChangesetInput): ChangesetPlan {
  const { features, tagEdits, geometryEdits, createdParts } = input;
  const index = buildNodeIndex(features);
  const buildingLookup = new OsmBuildingLookup(features);
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

  /**
   * The corners the mapper dragged, resolved back to the nodes they belong to.
   *
   * A moved vertex is indistinguishable from a new one by position alone, so
   * without the recorded drag the upload would create a node at the new corner
   * and abandon the old one: left in OSM untagged and unreferenced, stripped of
   * whatever it carried, and still holding every way this editor never loaded —
   * a fence, a path, a building outside the tiles — at the corner the mapper
   * believed they had moved. Modifying the node moves all of them with it.
   */
  const movedNodes = new Map<number, { node: ExistingNode; to: LngLat }>();
  /** Existing nodes replaced by the node already occupying their snap target. */
  const mergedExistingNodes = new Map<
    number,
    { node: ExistingNode; into: ExistingNode; to: LngLat }
  >();
  const movedToKey = new Map<string, { node: ExistingNode; kind: "merge" | "move" }>();
  for (const [ref, override] of Object.entries(geometryEdits)) {
    for (const move of override.movedNodes ?? []) {
      const from = roundToOsmGrid(move.from);
      const to = roundToOsmGrid(move.to);
      const node = nodeAt(index, from);
      // Nothing upstream stands there, so the vertex was drawn in this session:
      // there is no node to move and it resolves as a new one like any other.
      if (!node) continue;
      if (node.version <= 0) {
        issues.push(
          issue(
            "error",
            "node-version-unknown",
            `A dragged corner of ${ref} belongs to a node whose version is not in the loaded data, so moving it could overwrite a newer edit. Reload the area and drag it again.`,
            [ref],
            to,
          ),
        );
        continue;
      }
      const occupant = nodeAt(index, to);
      if (occupant && occupant.id !== node.id) {
        const previous = mergedExistingNodes.get(node.id);
        if (previous && previous.into.id !== occupant.id) {
          issues.push(
            issue(
              "error",
              "node-move-conflict",
              `Node ${node.id} is merged into two different nodes by the pending changes, so the upload cannot say which one is meant.`,
              [ref],
              to,
            ),
          );
          continue;
        }
        const moved = movedNodes.get(node.id);
        if (moved && coordinateKey(moved.to) !== coordinateKey(to)) {
          issues.push(
            issue(
              "error",
              "node-move-conflict",
              `Node ${node.id} is dragged to two different places by the pending changes, so the upload cannot say which one is meant.`,
              [ref],
              to,
            ),
          );
          continue;
        }
        mergedExistingNodes.set(node.id, { node, into: occupant, to });
        movedToKey.set(coordinateKey(to), { node: occupant, kind: "merge" });
        continue;
      }
      const merged = mergedExistingNodes.get(node.id);
      if (merged && coordinateKey(merged.to) !== coordinateKey(to)) {
        issues.push(
          issue(
            "error",
            "node-move-conflict",
            `Node ${node.id} is dragged to two different places by the pending changes, so the upload cannot say which one is meant.`,
            [ref],
            to,
          ),
        );
        continue;
      }
      const already = movedNodes.get(node.id);
      if (already && coordinateKey(already.to) !== coordinateKey(to)) {
        issues.push(
          issue(
            "error",
            "node-move-conflict",
            `Node ${node.id} is dragged to two different places by the pending changes, so the upload cannot say which one is meant.`,
            [ref],
            to,
          ),
        );
        continue;
      }
      movedNodes.set(node.id, { node, to });
      movedToKey.set(coordinateKey(to), { node, kind: "move" });
    }
  }
  for (const { node, to } of movedNodes.values()) {
    nodes.push({
      id: node.id,
      action: "modify",
      coordinates: to,
      version: node.version,
      // A modify replaces the element, so anything the node carried has to be
      // resent or the upload deletes it.
      tags: node.tags,
    });
    // Everything downstream, the wall-gluing pass included, has to measure
    // against the position the upload leaves the node at.
    existingPositions.set(node.id, to);
  }

  const groups = new Map<string, Set<string>>();
  /** The building an edit is about, plus its parts: the scope for node reuse. */
  const groupOf = (elementId: string): Set<string> => {
    const cached = groups.get(elementId);
    if (cached) return cached;
    const selection = buildingLookup.select(elementId);
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

  const resolveVertices = (vertices: LngLat[], ref: string, scope: Set<string>, close: boolean) => {
    const ids: number[] = [];
    const sharedWith = new Set<string>();
    let reused = 0;
    let created = 0;
    let moved = 0;
    for (const vertex of close ? openRing(vertices) : vertices) {
      const point = roundToOsmGrid(vertex);
      const relocated = movedToKey.get(coordinateKey(point));
      if (relocated) {
        ids.push(relocated.node.id);
        if (relocated.kind === "move") moved++;
        else {
          reused++;
          reusedNodes++;
        }
        for (const owner of relocated.node.ownerIds) if (owner !== ref) sharedWith.add(owner);
        continue;
      }
      const found = findExistingNode(index, point, scope);
      // A node that has been dragged away is not here any more, whatever the
      // index built from the pre-edit data still says. Reusing it would list the
      // same node twice in one ring.
      if (found && !movedNodes.has(found.node.id) && !mergedExistingNodes.has(found.node.id)) {
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
      nodes.push({ id, action: "create", coordinates: point });
      createdNodes.push({ id, coordinates: point, ref });
      ids.push(id);
      created++;
    }
    return {
      nodes: close && ids.length > 0 ? [...ids, ids[0]] : ids,
      reused,
      created,
      moved,
      sharedWith,
    };
  };
  const resolveRing = (ring: LngLat[], ref: string, scope: Set<string>) =>
    resolveVertices(ring, ref, scope, true);
  const resolvePath = (path: LngLat[], ref: string, scope: Set<string>) =>
    resolveVertices(path, ref, scope, false);

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
        area: true,
        tags: wayTags,
      };
      ways.set(wayRef, way);
      if (wayRef === ref || wayRef === `${ref}#ring-1`) {
        entry.geometry = {
          reusedNodes: resolved.reused,
          newNodes: resolved.created,
          movedNodes: resolved.moved,
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
      const memberWays = relationMemberWays(properties.member_ways);
      const base = tagsOf(properties);
      const tags = mergeTags(base, tagEdits[ref]?.changed);
      const changes = tagChanges(base, tags);
      const members = properties.members;

      const raw = rawById.get(ref);
      if (
        raw &&
        (raw.geometry.type === "Polygon" || raw.geometry.type === "MultiPolygon") &&
        memberWays.length > 0 &&
        Array.isArray(members) &&
        members.length > 0
      ) {
        const rawRings = roleRingsOf(raw.geometry);
        const editedRings = roleRingsOf(override.geometry);
        const movedByCoordinate = new Map<string, LngLat>();
        const movedMemberNodeIds = new Set<number>();
        let ambiguousMove = false;
        for (const member of memberWays) {
          for (const [index, point] of member.coordinates.entries()) {
            const moved = movedNodes.get(member.nodes[index]);
            const merged = mergedExistingNodes.get(member.nodes[index]);
            const destination = moved?.to ?? merged?.to;
            if (!destination) continue;
            if (moved) movedMemberNodeIds.add(moved.node.id);
            const key = coordinateKey(roundToOsmGrid(point));
            const previous = movedByCoordinate.get(key);
            if (previous && !sameCoordinate(previous, destination)) ambiguousMove = true;
            movedByCoordinate.set(key, destination);
          }
        }

        const ringPairs =
          !ambiguousMove && rawRings.length === editedRings.length
            ? rawRings.map((rawRing, index) => {
                const editedRing = editedRings[index];
                if (rawRing.role !== editedRing.role) return null;
                const anchors = openRing(effectiveRing(rawRing.coordinates, movedByCoordinate));
                return editedMemberPath(editedRing.coordinates, anchors, true)
                  ? { raw: rawRing, edited: editedRing }
                  : null;
              })
            : [];

        if (ringPairs.length === rawRings.length && ringPairs.every((pair) => pair !== null)) {
          const mappedMembers: {
            member: (typeof memberWays)[number];
            coordinates: LngLat[];
            closed: boolean;
          }[] = [];
          let mappingFailed = false;

          for (const member of memberWays) {
            const pair = ringPairs.find(
              (candidate) =>
                candidate?.raw.role === member.role &&
                orientMemberInRing(member.coordinates, candidate.raw.coordinates) !== null,
            );
            if (!pair) {
              mappingFailed = true;
              break;
            }
            const oriented = orientMemberInRing(member.coordinates, pair.raw.coordinates);
            if (!oriented) {
              mappingFailed = true;
              break;
            }
            const closed = sameCoordinate(
              member.coordinates[0],
              member.coordinates[member.coordinates.length - 1],
            );
            const effectiveAnchors = oriented.map(
              (point) =>
                movedByCoordinate.get(coordinateKey(roundToOsmGrid(point))) ??
                roundToOsmGrid(point),
            );
            const coordinates = editedMemberPath(pair.edited.coordinates, effectiveAnchors, closed);
            if (!coordinates) {
              mappingFailed = true;
              break;
            }
            // Return to the way's original XML direction after using the
            // assembled-ring direction to identify which edited arc it owns.
            const sameDirection = sameCoordinate(oriented[0], openRing(member.coordinates)[0]);
            mappedMembers.push({
              member,
              coordinates: sameDirection ? coordinates : [...coordinates].reverse(),
              closed,
            });
          }

          if (!mappingFailed) {
            const scope = groupOf(ref);
            const changedMemberRefs: string[] = [];
            const entry = entryFor(ref, { ref, action: "modify", target: "its nodes only" });
            entry.tagChanges = changes;
            let inserted = 0;

            for (const mapped of mappedMembers) {
              const resolved = mapped.closed
                ? resolveRing(mapped.coordinates, ref, scope)
                : resolvePath(mapped.coordinates, ref, scope);
              const unchanged =
                resolved.nodes.length === mapped.member.nodes.length &&
                resolved.nodes.every((node, index) => node === mapped.member.nodes[index]);
              if (unchanged) continue;

              const memberRef = `way/${mapped.member.id}`;
              ways.set(memberRef, {
                ref: memberRef,
                id: mapped.member.id,
                version: mapped.member.version,
                action: "modify",
                nodes: resolved.nodes,
                area: mapped.closed,
                tags: mapped.member.tags,
              });
              changedMemberRefs.push(memberRef);
              inserted += Math.max(0, resolved.nodes.length - mapped.member.nodes.length);
              entry.geometry = {
                reusedNodes: (entry.geometry?.reusedNodes ?? 0) + resolved.reused,
                newNodes: (entry.geometry?.newNodes ?? 0) + resolved.created,
                movedNodes: (entry.geometry?.movedNodes ?? 0) + resolved.moved,
                sharedWith: [
                  ...new Set([...(entry.geometry?.sharedWith ?? []), ...resolved.sharedWith]),
                ],
              };
            }

            if (changes.length > 0) {
              relations.set(ref, {
                ref,
                id: osmId,
                version,
                action: "modify",
                members: (members as { type: string; ref: number; role: string }[]).map(
                  (member) => ({
                    type: member.type as OsmElementType,
                    ref: member.ref,
                    role: member.role,
                  }),
                ),
                tags,
              });
            }
            entry.target =
              [...changedMemberRefs, ...(changes.length > 0 ? [ref] : [])].join(", ") ||
              "its nodes only";
            if (entry.geometry) entry.geometry.movedNodes = movedMemberNodeIds.size;
            else if (movedMemberNodeIds.size > 0) {
              entry.geometry = {
                reusedNodes: 0,
                newNodes: 0,
                movedNodes: movedMemberNodeIds.size,
                sharedWith: [],
              };
            }
            if (inserted > 0) {
              entry.notes.push(
                `${inserted} new outline node${inserted === 1 ? " was" : "s were"} assigned to ${changedMemberRefs.length === 1 ? "its member way" : "their member ways"} between surviving boundary nodes.`,
              );
            }
            if (movedMemberNodeIds.size > 0) {
              entry.notes.push(
                "Existing relation corners move through their nodes; the relation member list is unchanged.",
              );
            }
            if (
              changedMemberRefs.length === 0 &&
              changes.length === 0 &&
              movedMemberNodeIds.size === 0
            ) {
              entries.delete(ref);
              dropped.push(ref);
            }
            continue;
          }
        }
      }

      issues.push(
        issue(
          "error",
          "relation-geometry-unsupported",
          `${ref} is a multipolygon relation whose edited outline cannot be mapped safely to its member ways. Existing boundary nodes must remain in the same order; reload it if the member data is stale.`,
          [ref],
        ),
      );
      continue;
    }
    const base = tagsOf(properties);
    const tags = mergeTags(base, tagEdits[ref]?.changed);
    const entry = entryFor(ref, { ref, action: "modify", target: ref, version });
    entry.tagChanges = tagChanges(base, tags);
    entry.notes.push(
      override.kind === "hole"
        ? "The footprint was cut."
        : override.kind === "slice"
          ? "The footprint was sliced."
          : override.kind === "add-part"
            ? "The building outline was expanded for a new part."
            : override.kind === "add-node"
              ? "A new node was added to the footprint."
              : override.kind === "glue"
                ? "A new corner on one of its walls was added to this way, so the wall is shared rather than crossed."
                : "The footprint was reshaped.",
    );
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
        area: true,
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
  dropUnchangedWays({ ways, entries, rawById, dropped });

  return {
    nodes,
    ways: [...ways.values()],
    relations: [...relations.values()],
    entries: [...entries.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    reusedNodes,
    mergedNodes: mergedNodes + mergedExistingNodes.size,
    movedNodes: movedNodes.size,
    dropped,
    issues,
  };
}

/**
 * Leave out the ways an upload would rewrite exactly as they already are.
 *
 * Moving a node changes the node, not the ways listing it, so a drag that only
 * moved corners ends with every affected way holding the node list it already
 * had. Resending those would bump their versions for nothing and invite a
 * conflict over elements we are not changing — the same reason a tag edit that
 * already matches OSM is dropped. The review entry stays, because the building
 * really is being reshaped; it is reshaped through its nodes.
 */
function dropUnchangedWays(context: {
  ways: Map<string, ChangesetWay>;
  entries: Map<string, ChangesetEntry>;
  rawById: Map<string, Feature>;
  dropped: string[];
}) {
  const { ways, entries, rawById, dropped } = context;
  // Deleting the current entry mid-iteration is defined behaviour for a Map.
  for (const [ref, way] of ways) {
    if (way.action !== "modify") continue;
    const properties = rawById.get(ref)?.properties as BuildingProperties | undefined;
    const nodeIds = properties?.node_ids;
    if (!properties || !Array.isArray(nodeIds)) continue;
    if (nodeIds.length !== way.nodes.length) continue;
    if (nodeIds.some((id, index) => id !== way.nodes[index])) continue;
    const base = tagsOf(properties);
    const keys = new Set([...Object.keys(base), ...Object.keys(way.tags)]);
    if ([...keys].some((key) => base[key] !== way.tags[key])) continue;

    ways.delete(ref);
    dropped.push(ref);
    const entry = entries.get(ref);
    if (!entry) continue;
    // The way is not written, so it has no version to show and nothing to
    // conflict over. Say what the upload does touch instead.
    entry.target = "its nodes only";
    delete entry.version;
    entry.notes.push(
      "Its corners move with their nodes, so the way itself is unchanged and is not resent.",
    );
  }
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
      const memberWayRefs = relationMemberWays(properties.member_ways).map(
        (member) => `way/${member.id}`,
      );
      const touching = candidates.filter(
        (node) =>
          !memberWayRefs.some((memberRef) => ways.get(memberRef)?.nodes.includes(node.id)) &&
          rings.some((polygon) =>
            polygon.some((edge) =>
              edge.some(
                (point, i) =>
                  i > 0 &&
                  positionOnSegment(
                    node.coordinates,
                    [edge[i - 1][0], edge[i - 1][1]],
                    [point[0], point[1]],
                    NODE_REUSE_METERS,
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
        const at = positionOnSegment(
          node.coordinates,
          hostRing[i - 1],
          hostRing[i],
          NODE_REUSE_METERS,
        );
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
        area: true,
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
  return (
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // XML normalizes literal newlines in attributes to spaces. Character
      // references preserve the multiline changeset comment OSM receives.
      .replace(/\r\n?|\n/g, "&#10;")
  );
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

  const nodeXml = (node: ChangesetNode) => {
    const version = node.version === undefined ? "" : ` version="${node.version}"`;
    const position = ` lon="${formatCoordinate(node.coordinates[0])}" lat="${formatCoordinate(node.coordinates[1])}"`;
    const open = `    <node id="${node.id}"${version}${attribute}${position}`;
    const tags = node.tags && Object.keys(node.tags).length > 0 ? tagXml(node.tags, "      ") : "";
    // A modify replaces the node, so an existing node's own tags go back with it.
    return tags === "" ? `${open}/>` : [`${open}>`, tags, `    </node>`].join("\n");
  };

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
    const nodes = plan.nodes.filter((node) => node.action === action);
    if (nodes.length === 0 && ways.length === 0 && relations.length === 0) continue;
    lines.push(`  <${action}>`);
    // Referenced elements come first, so placeholder ids are always defined
    // before they are used, and a moved node is in place before the ways that
    // read it.
    lines.push(...nodes.map(nodeXml), ...ways.map(wayXml), ...relations.map(relationXml));
    lines.push(`  </${action}>`);
  }

  lines.push(`</osmChange>`);
  return lines.join("\n");
}
