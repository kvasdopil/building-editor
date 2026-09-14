import type { FeatureCollection } from "geojson";
import type { BuildingElement } from "./buildings";
import type { MaterializedEditState } from "./edit-history";
import {
  applyGeometryEdits,
  createPartFeature,
  type CreatedPartMap,
  type EditableGeometry,
  geometryHasVertex,
  geometryVertices,
  type GeometryEditMap,
  moveSharedGeometryVertices,
  type NodeMove,
  recordNodeMoves,
  weldNewVertices,
} from "./geometry-edits";
import { buildChangeset } from "./osm/changeset";
import { buildNodeIndex, nodeAt, NODE_REUSE_METERS } from "./osm/nodes";
import { coordinateKey, roundToOsmGrid } from "./osm/precision";
import { drawnRef } from "./osm/ref";
import type { sliceBuilding } from "./slice";

/** Materialize all Slice effects together, preserving existing node provenance. */
export function planSliceGeometry(
  before: Pick<MaterializedEditState, "geometryEdits" | "createdParts">,
  building: BuildingElement,
  parts: BuildingElement[],
  result: NonNullable<ReturnType<typeof sliceBuilding>>,
  nextPartId: number,
) {
  const geometryEdits = { ...before.geometryEdits };
  const createdParts = { ...before.createdParts };
  for (const [id, geometry] of Object.entries(result.replacements)) {
    const created = createdParts[id];
    if (created) createdParts[id] = { ...created, geometry };
    else geometryEdits[id] = { geometry, kind: "slice", movedNodes: geometryEdits[id]?.movedNodes };
  }
  for (const addition of result.additions) {
    const id = drawnRef("way", nextPartId++);
    createdParts[id] = createPartFeature(id, building.id, addition.geometry, addition.tags);
  }
  const geometryOf = (element: BuildingElement): EditableGeometry => ({
    type: "MultiPolygon",
    coordinates: element.polygons.map((polygon) => [polygon.outer, ...polygon.holes]),
  });
  const group = [building, ...parts];
  const candidates = Object.fromEntries(
    group
      .filter((element) => !(element.id in result.replacements))
      .map((element) => [element.id, geometryOf(element)]),
  );
  const welds = weldNewVertices({
    candidates,
    existing: group.flatMap((element) => geometryVertices(geometryOf(element))),
    produced: [
      ...Object.values(result.replacements),
      ...result.additions.map((addition) => addition.geometry),
    ],
    tolerance: NODE_REUSE_METERS,
  });
  for (const [id, geometry] of Object.entries(welds)) {
    const created = createdParts[id];
    if (created) createdParts[id] = { ...created, geometry };
    else
      geometryEdits[id] = {
        geometry,
        kind: geometryEdits[id]?.kind ?? "glue",
        movedNodes: geometryEdits[id]?.movedNodes,
      };
  }
  return { geometryEdits, createdParts, nextPartId };
}

/** Build a whole drag/insertion before publishing any of its effects. */
export function planGeometryGesture(input: {
  features: FeatureCollection;
  geometryEdits: GeometryEditMap;
  createdParts: CreatedPartMap;
  geometries: Record<string, EditableGeometry>;
  moves?: NodeMove[];
  gluedEntities?: Set<string>;
  kind?: "reshape" | "add-node";
}): Pick<MaterializedEditState, "geometryEdits" | "createdParts"> {
  const { features, geometries, moves = [], gluedEntities = new Set(), kind = "reshape" } = input;
  const geometryEdits = { ...input.geometryEdits };
  const createdParts = { ...input.createdParts };
  const displayed = applyGeometryEdits(features, input.geometryEdits, input.createdParts);
  const beforeById = new Map(
    displayed.features.map((feature) => [feature.properties?.id, feature]),
  );
  const index = buildNodeIndex(features);
  const identify = (move: NodeMove): NodeMove => ({
    ...move,
    nodeId: move.nodeId ?? nodeAt(index, roundToOsmGrid(move.from))?.id,
  });
  const priorMoves = Object.values(input.geometryEdits)
    .flatMap((override) => override.movedNodes ?? [])
    .map(identify);
  const targetAt = (point: NodeMove["to"]) => {
    const key = coordinateKey(point);
    if (moves.some((move) => coordinateKey(move.from) === key && coordinateKey(move.to) !== key))
      return undefined;
    const moved = priorMoves.find((move) => coordinateKey(move.to) === key);
    if (moved) return moved.targetNodeId ?? moved.nodeId;
    const raw = nodeAt(index, point);
    if (!raw || priorMoves.some((move) => move.nodeId === raw.id)) return undefined;
    return raw.id;
  };
  const updates = new Map<number, NodeMove>();
  const ambiguous = new Set<number>();
  for (const [entity, geometry] of Object.entries(geometries)) {
    const drawn = createdParts[entity];
    if (drawn) {
      createdParts[entity] = { ...drawn, geometry };
      continue;
    }
    const previous = geometryEdits[entity];
    const before = beforeById.get(entity)?.geometry;
    const entityMoves = moves.filter((move) =>
      before?.type === "Polygon" || before?.type === "MultiPolygon"
        ? geometryHasVertex(before, move.from)
        : geometryHasVertex(geometry, move.to),
    );
    // Resolve the source in the pre-gesture state, so a shared merge keeps both
    // upstream identities and moving the merged corner later updates both.
    const gestureMoves = entityMoves.map((move) => {
      const identified = identify(move);
      // A raw node that already left this coordinate is not the vertex under
      // the handle. Its current identity comes from the earlier move chain.
      if (
        priorMoves.some(
          (prior) =>
            prior.nodeId === identified.nodeId &&
            coordinateKey(prior.to) !== coordinateKey(move.from),
        )
      ) {
        return { ...move, nodeId: undefined };
      }
      return identified;
    });
    const recorded = recordNodeMoves(previous?.movedNodes?.map(identify), gestureMoves).map(
      identify,
    );
    for (const move of recorded) {
      if (!entityMoves.some((update) => coordinateKey(update.to) === coordinateKey(move.to)))
        continue;
      const target = targetAt(move.to);
      if (target !== undefined && target !== move.nodeId) move.targetNodeId = target;
    }
    geometryEdits[entity] = {
      geometry,
      kind: previous?.kind ?? (gluedEntities.has(entity) ? "glue" : kind),
      movedNodes: recorded,
    };
    for (const move of recorded) {
      if (
        move.nodeId !== undefined &&
        entityMoves.some((update) => coordinateKey(update.to) === coordinateKey(move.to))
      ) {
        const earlier = updates.get(move.nodeId);
        if (earlier && coordinateKey(earlier.to) !== coordinateKey(move.to))
          ambiguous.add(move.nodeId);
        updates.set(move.nodeId, move);
      }
    }
  }
  for (const id of ambiguous) updates.delete(id);

  // Legacy parent-only reverts may have left another owner at an old local
  // destination. An explicit new drag updates that node's claim and footprint
  // everywhere, using identity rather than requiring their coordinates to agree.
  for (const [entity, override] of Object.entries(geometryEdits)) {
    const replacements = new Map<string, NodeMove["to"]>();
    const movedNodes = override.movedNodes?.map((record) => {
      const move = identify(record);
      const update = move.nodeId === undefined ? undefined : updates.get(move.nodeId);
      if (!update) return move;
      if (coordinateKey(move.to) !== coordinateKey(update.to)) {
        replacements.set(coordinateKey(move.to), update.to);
      }
      return { ...move, to: update.to, targetNodeId: update.targetNodeId ?? move.targetNodeId };
    });
    if (replacements.size > 0) {
      geometryEdits[entity] = {
        ...override,
        geometry: moveSharedGeometryVertices(override.geometry, replacements),
        movedNodes,
      };
    }
  }
  // An owner whose override was deleted in a legacy snapshot still uses the
  // same upstream node. Materialize its move too, so map and upload agree.
  const missingOwners = new Map<string, NodeMove[]>();
  for (const [nodeId, update] of updates) {
    const node = index.byId.get(nodeId);
    if (!node) continue;
    for (const entity of node.ownerIds) {
      if (geometryEdits[entity]?.movedNodes?.some((move) => identify(move).nodeId === nodeId))
        continue;
      const geometry = geometryEdits[entity]?.geometry ?? beforeById.get(entity)?.geometry;
      if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") continue;
      if (!geometryHasVertex(geometry, node.coordinates)) continue;
      missingOwners.set(entity, [...(missingOwners.get(entity) ?? []), update]);
    }
  }
  for (const [entity, ownerMoves] of missingOwners) {
    const previous = geometryEdits[entity];
    const geometry = previous?.geometry ?? beforeById.get(entity)?.geometry;
    if (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") {
      geometryEdits[entity] = {
        kind: previous?.kind ?? "reshape",
        geometry: moveSharedGeometryVertices(
          geometry,
          new Map(ownerMoves.map((move) => [coordinateKey(move.from), move.to])),
        ),
        movedNodes: [...(previous?.movedNodes ?? []), ...ownerMoves],
      };
    }
  }
  return { geometryEdits, createdParts };
}

/** Reject new topology failures before a gesture can enter state or history. */
export function geometryTransactionIssue(
  features: FeatureCollection,
  before: MaterializedEditState,
  after: MaterializedEditState,
): string | null {
  const topologyChecks = new Set([
    "node-move-conflict",
    "node-version-unknown",
    "relation-geometry-unsupported",
    "element-not-loaded",
    "missing-version",
  ]);
  const plan = (state: MaterializedEditState) =>
    buildChangeset({
      features,
      tagEdits: state.edits,
      geometryEdits: state.geometryEdits,
      createdParts: state.createdParts,
    }).issues.filter((issue) => topologyChecks.has(issue.check));
  const next = plan(after);
  if (next.length === 0) return null;
  const changed = new Set(
    [...Object.keys(before.geometryEdits), ...Object.keys(after.geometryEdits)].filter(
      (id) => JSON.stringify(before.geometryEdits[id]) !== JSON.stringify(after.geometryEdits[id]),
    ),
  );
  const existing = new Set(plan(before).map((issue) => JSON.stringify(issue)));
  const failure = next.find(
    (issue) => issue.entities.some((id) => changed.has(id)) || !existing.has(JSON.stringify(issue)),
  );
  return failure ? `Edit not applied. ${failure.message}` : null;
}
