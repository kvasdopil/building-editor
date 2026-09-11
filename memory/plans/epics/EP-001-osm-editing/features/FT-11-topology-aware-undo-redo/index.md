# FT-11 - Topology-aware undo and redo

Status: Active (2026-09-11)

Replace the mutable collection of final tag and geometry overrides with a persistent command journal. Each completed user edit becomes one atomic, reversible command whose semantic anchors retain enough OSM node and member-way identity to replay safely and assemble relation changes without guessing.

Related documents:

- [EP-001 - Edit buildings and submit to OSM](../../index.md): Parent editing epic. Read this for the current feature sequence and upload lifecycle.
- [Building Explorer domain spec](../../../../../spec/domain/building-explorer.md): Normative map-editing behavior. Update this when undo/redo interaction and edit grouping are finalized.
- [OSM submission spec](../../../../../spec/domain/osm-submission.md): Normative node identity, relation-member mapping, and upload safety rules. Read this before defining topology commands.
- [Testing scenarios](../../../../../spec/testing/scenarios/index.md): Home for the end-to-end undo/redo and relation replay scenarios required by this plan.

## User value

A mapper can undo and redo any completed local edit, including compound geometry operations, without losing work after a reload. Multipolygon edits retain the member-way ownership known when the gesture was made, so submission does not have to reconstruct topology from a flattened polygon.

The first delivered relation regression was caused by harmless inner-ring reordering, not missing
provenance: submission now pairs rings by role and surviving cyclic node anchors, so existing edits
affected only by that ordering bug are repaired automatically. The later topology-command slices
still prevent genuinely ambiguous edits from reaching a late `relation-geometry-unsupported`
failure. Existing geometry overrides whose boundary ownership truly is missing cannot be repaired
automatically.

## Implementation progress

Delivered in the compatibility foundation:

- one versioned IndexedDB history document with atomic before/after materialized states, a cursor,
  redo-tail truncation, legacy-state migration, and exact generated-part restoration;
- combined tag, geometry, and created-part undo/redo through toolbar controls and standard keyboard
  shortcuts, with persistent cursor state after reload;
- one history entry for each completed map edit, plus explicit coalescing for continuous height and
  roof-direction drags;
- undoable property removal, entity discard, and Revert all, while successful upload remains a
  terminal history clear;
- anchor-based relation ring matching and a `relation/1658671`-shaped regression test covering
  reordered inner rings.

Interactive verification on the user-run development server covered a tag edit, undo, redo, reload,
redo-tail truncation, and a multi-update height drag. It found and closed two browser-only ordering
edges: restored selection must be rebuilt from raw tags plus pending geometry, and pointer gesture
groups must remain open through the render frame containing pointer-up so the final drag value cannot
escape into a second history entry. The same pass loaded `relation/1658671`, started Add Part with the
relation outline selected, and cancelled the draft without creating history.

Still planned in slices 3-5 below: semantic topology operations, complete-member preflight,
deterministic replay against refreshed upstream versions, conflict recovery, multi-tab revision
protection, and removal of the compatibility projection stores. Until those land, the durable
entries are materialized snapshots and the current conservative submission mapper remains the
topology safety boundary.

## Scope

Included:

- undo and redo for tag edits, validator fixes, node and wall changes, Cut hole, Slice, Add part, Add node, per-property removal, entity discard, and Revert all;
- one undo step per completed user intent, including every coupled change to parents, siblings, shared nodes, generated parts, and transferred roof tags;
- persistence of the journal, its cursor, generated ids, and replay status in IndexedDB;
- topology-aware commands anchored to OSM node ids, member-way ids, and adjacent node ids;
- deterministic replay after reload and conservative rebase onto refreshed OSM data;
- relation-safe changeset assembly from recorded topology effects;
- toolbar controls and standard desktop keyboard shortcuts.

Excluded from the first delivery:

- undoing selection, camera, imagery alignment, panel sizing, or an in-progress drawing draft;
- collaborative merging between browser tabs or devices;
- guessing through a missing anchor or silently rewriting arbitrary relation membership;
- undo after a successful OSM upload;
- automatic conversion of legacy flattened relation overrides into topology commands.

## Required architectural decision

Record an ADR before implementation with these decisions:

1. The command journal is the source of truth for pending local edits.
2. `EditMap`, `GeometryEditMap`, and `CreatedPartMap` become derived projections and are never independently mutated or persisted by UI handlers.
3. Commands store semantic intent and topology anchors. Geometry snapshots may be retained as replay caches or diagnostics, but cannot be the only durable representation.
4. A command is accepted only when it can produce both valid displayed geometry and a safe topology effect for every existing OSM relation it changes.
5. Upload clears the journal as a terminal checkpoint; ordinary discard actions are journaled and remain undoable.

## Command model

Use one versioned document in a new IndexedDB store:

```ts
interface EditJournal {
  schemaVersion: 1;
  revision: number;
  commands: EditCommand[];
  cursor: number; // commands [0, cursor) are applied; the remainder is redoable
  nextGeneratedId: number;
  checkpoint?: MaterializedEditState;
}

interface EditCommand {
  id: string;
  createdAt: number;
  label: string;
  affectedEntities: string[];
  baselines: EntityBaseline[];
  operations: EditOperation[];
}
```

`EntityBaseline` binds a command to the OSM element version plus a stable topology fingerprint: relation member list, member-way versions, and ordered node ids for geometry hosts. It is not a copy of the whole tile.

`EditOperation` should cover these semantic primitives:

- set or delete an OSM tag, retaining the first upstream value;
- create, update, or delete a session-local part with its allocated negative id;
- move an existing OSM node by node id;
- insert a node on a way edge anchored by `wayId`, `beforeNodeId`, and `afterNodeId`;
- delete an existing node from a known member way when the editing operation explicitly intends deletion and the remaining path is valid;
- replace a boundary span on a known way between surviving node anchors;
- create a new outer or inner way and add it to a known relation role;
- apply a geometry intent such as Cut hole, Slice, or Add part, retaining its snapped input path and the topology plan produced when it was accepted.

A single command may contain many operations. For example, the first Add part can expand the parent relation member way, create two parts, insert attachment nodes into siblings, and clear four roof tags; undo must reverse that entire command atomically.

## Reducer and replay contract

Create a UI-independent edit engine, separate from `MapView`, with three pure operations:

```ts
applyCommand(rawFeatures, priorState, command) -> Result<MaterializedEditState, EditConflict>
replayJournal(rawFeatures, journal) -> ReplayResult
planCommand(rawFeatures, currentState, intent) -> Result<EditCommand, EditConflict>
```

The materialized state contains the current tag overrides, geometry overrides, created parts, node moves, and relation member-way patches expected by changeset assembly. Rendering continues to consume projections equivalent to the current maps, which keeps the map and 3D layers isolated from journal internals.

Replay rules:

- apply commands strictly in journal order;
- undo decrements the cursor and replays; redo increments it and replays;
- a new command after undo truncates the redo tail before it is persisted;
- generated ids are stored in the command and never reallocated during replay;
- failure is atomic: no partial command effects reach rendering or persistence;
- a draft or drag is preview-only and creates no command until its existing commit point;
- selection is restored to the affected entity when it still exists, but selection itself is not journaled.

Keep replay fast by storing a validated materialized checkpoint every fixed number of commands. The checkpoint is an optimization only: deleting it and replaying from the start must produce byte-equivalent pending state.

## Relation topology strategy

Move relation safety from submission time to command creation.

1. Load the complete relation member list and every affected member way before accepting the command. A partial tile assembly is sufficient for display but not for topology planning.
2. Build an edge-provenance index from each assembled ring segment to its source member way and ordered node pair.
3. Carry provenance through geometry operations:
   - moved vertices retain their node ids;
   - a vertex inserted on an existing edge inherits that edge's member way and adjacent-node anchors;
   - a replacement span records both surviving endpoint anchors and its owning member way;
   - a new closed ring becomes a new member way with an explicit `outer` or `inner` role.
4. Reject the gesture at completion if one replacement span crosses member-way ownership in a way the first version cannot express safely. Do not defer this to Review & submit.
5. Make changeset assembly consume the materialized member-way patches directly. Retain the current coordinate-based mapper temporarily as a compatibility path for legacy overrides only.

For a refresh or OSM version change, replay may rebase a command only when all anchors still exist in the same member roles and local cyclic order. Coordinate changes to anchored nodes are acceptable; missing, reordered, or re-owned anchors produce an explicit conflict naming the first command that cannot be replayed.

## Persistence and migration

Add a new IndexedDB object store and bump the database schema version without clearing OSM tile cache or pending edits.

Migration behavior:

- import existing tag and geometry stores as one `legacy-snapshot` command/checkpoint so no pending work is lost;
- allow the imported batch to be undone and redone as a whole;
- keep its current upload compatibility behavior and relation safety error—do not claim topology provenance that was never recorded;
- after the first successful journal write, stop writing the legacy stores;
- remove the legacy read path only after one release has exercised migration.

Persist the full journal and cursor with one IndexedDB write after every committed command, undo, or redo. Include a monotonically increasing revision and a per-tab writer id. If another tab advances the stored revision, stop local writes and ask the mapper to reload rather than silently overwriting either history.

## UI behavior

- Add Undo and Redo buttons to the desktop editing toolbar, disabled when their action is unavailable.
- Tooltips name the next command, for example `Undo: Move wall` and `Redo: Add part`.
- Support `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, and `Ctrl+Y`.
- Do not intercept shortcuts while an input, textarea, select, contenteditable element, or value dialog owns text editing.
- Escape continues to cancel in-progress drafts and drags; cancelled previews never enter history.
- Revert property, discard entity, and Revert all become undoable commands. Confirmation copy must no longer say they cannot be undone.
- Review & submit reads only the materialized state at the current cursor.
- A replay conflict shows the failed command, affected OSM entity, and safe actions: locate, discard that command and its dependents, or discard all pending changes.

## Delivery slices

### 1. Characterization and ADR

- Capture `relation/1658671` plus all of its member ways and node ids as a deterministic fixture.
- Record a minimal gesture or pending geometry that reproduces `relation-geometry-unsupported`.
- Add the command-journal ADR and the normative undo/redo rules to the domain specs.
- Characterize every current mutation entry point in `MapView`, `BuildingPanel`, Changes, and validation fixes.

Exit: the failure is reproducible without a browser or live OSM, and every current edit action has an assigned command boundary.

### 2. Journal foundation and tag edits

- Implement the pure journal reducer, cursor, persistence, migration, and derived projections.
- Route tag edits, tag reverts, validator tag fixes, entity discard, and Revert all through commands.
- Add Undo/Redo controls and keyboard shortcuts.
- Keep geometry writes on the compatibility adapter during this slice.

Exit: tag history survives reload; undo/redo/revert behavior is covered end to end; no UI handler writes tag storage directly.

### 3. Direct geometry commands

- Convert node drag, wall drag, Add node, shared-node welds, and redundant-node validator fixes.
- Resolve node ids and member-way edge anchors when the command is created.
- Treat every multi-entity drag or weld as one atomic command.

Exit: direct geometry edits replay identically on ways and relations and produce explicit member-way patches.

### 4. Constructive geometry commands

- Convert Cut hole, Slice, and Add part to intent-based commands.
- Add edge provenance through boolean results and deterministic generated-id allocation.
- Support new relation member ways for holes and additional rings.
- Reject unsupported cross-member rewrites at gesture completion with a precise message.

Exit: the `relation/1658671` reproduction either submits through explicit member-way patches or is rejected at the exact unsupported gesture—not later during upload review.

### 5. Rebase, conflict recovery, and cleanup

- Replay onto refreshed entity versions using topology fingerprints and anchors.
- Add conflict UI and multi-tab revision protection.
- Make changeset assembly prefer journal topology patches and retain legacy mapping only for migrated snapshots.
- Remove direct `setGeometryEdits`, `setCreatedParts`, and legacy edit-store writes from feature handlers.
- Update README, specs, scenarios, and the epic status after interactive verification.

Exit: fresh journals never depend on coordinate-only relation inference, and all pending edits have one durable source of truth.

## Acceptance scenarios

### Atomic compound undo

Setup: select an unpartitioned building with roof tags.

Action: Add part, undo once, then redo once.

Assert: undo removes both generated parts, restores the original outline and roof tags, removes sibling welds, and restores the prior changes list; redo restores the exact same negative ids, coordinates, tags, and changeset plan.

### Persistent cursor

Setup: apply three tag or geometry commands and undo the last two.

Action: reload the page and redo once.

Assert: the cursor and redo tail survive, the same command is reapplied, and a subsequent new edit drops only the remaining redo tail.

### Shared-node geometry

Setup: select two loaded footprints sharing an OSM node.

Action: drag the shared node, undo, and redo.

Assert: both footprints move and revert atomically; upload always modifies the original node id rather than creating coincident nodes.

### Multipolygon replay

Setup: load the `relation/1658671` fixture with complete member topology.

Action: perform the reproducing edit, reload, undo, redo, and build the changeset.

Assert: replay preserves member-way ownership and original node identity; the changeset modifies the intended member ways and has no `relation-geometry-unsupported` issue.

### Rebase conflict

Setup: record an insertion between two member-way nodes, then refresh against a fixture where one anchor was removed upstream.

Action: replay the journal.

Assert: replay stops before that command, renders no partial effect from it, names the missing anchor and command, and does not permit upload until the conflict is resolved.

### Text-editing shortcuts

Setup: open a tag value dialog with several editor commands available to undo.

Action: press the platform undo shortcut while editing text, close the dialog, then press it again.

Assert: the first shortcut changes only the field's text history; the second undoes the last editor command.

## Automated verification

- reducer algebra: replay, undo, redo, redo-tail truncation, checkpoint equivalence, and atomic failure;
- serialization round-trip and migration from the current edit and geometry stores;
- deterministic generated ids across undo, redo, and reload;
- one test per edit command type, including compound side effects;
- member-edge provenance for closed ways, open-way assembled rings, reversed members, holes, and shared junction nodes;
- `relation/1658671` regression fixture and expected `osmChange` member-way output;
- stale-version rebase success and missing/reordered-anchor conflict cases;
- keyboard shortcut focus guards and toolbar disabled/label states;
- existing drawing, geometry, changeset, and validation suites remain green;
- required repository checks: `yarn test`, `yarn lint`, `yarn format`, and `yarn tsc --noEmit`.

## Risks and controls

- **Silent topology corruption:** commands are rejected unless topology planning succeeds before commit; upload never guesses ownership.
- **Two competing sources of truth:** all mutations move behind the journal API before legacy stores are removed; development assertions compare projections during migration.
- **Replay drift:** command planners and reducers are pure and versioned; fixtures assert byte-equivalent state after reload.
- **Large histories:** periodic checkpoints bound replay cost while the complete command list remains available until upload.
- **Boolean-operation nondeterminism:** persist snapped intent and planned topology effects, pin test fixtures, and fail migration across incompatible command schema versions rather than changing old results silently.
- **Legacy relation edits:** preserve them unchanged and label their limitation; only newly recorded commands gain safe provenance.

## Definition of done

- Every completed edit action is represented by exactly one journal command.
- Undo and redo cover all included edit types, survive reload, and preserve atomic coupled changes.
- No UI component directly mutates or persists the derived edit maps.
- New relation edits either have explicit safe member-way patches or are rejected when the gesture completes.
- `relation/1658671` has a deterministic regression fixture and no late upload-only mapping failure for the supported reproduction.
- Upload clears the journal only after a successful changeset.
- Specs, ADR, acceptance scenarios, README, and epic index match the delivered behavior.
- All automated checks pass, followed by user-run interactive verification in the development server.
