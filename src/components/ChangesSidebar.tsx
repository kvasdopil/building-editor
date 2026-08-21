"use client";

import { useCallback, useMemo, useState } from "react";
import { FiArrowRight, FiEdit2, FiTrash2, FiX, FiXCircle } from "react-icons/fi";
import type { EditMap } from "@/lib/edits";
import type { CreatedPartMap, GeometryEditMap } from "@/lib/geometry-edits";
import { useEscapeKey } from "@/lib/use-escape-key";
import { ConfirmDialog } from "./ConfirmDialog";
import { ValueEditDialog } from "./ValueEditDialog";

interface ChangeEntry {
  entity: string;
  property: string;
  original?: string;
  pending: string;
  /** False for the geometry rows, whose value is not a tag anyone can type. */
  editable: boolean;
  /** Why this row cannot be removed on its own, or null when it can. */
  locked: string | null;
}

interface ChangeGroup {
  entity: string;
  changes: Omit<ChangeEntry, "entity">[];
}

function changeEntries(
  edits: EditMap,
  geometryEdits: GeometryEditMap,
  createdParts: CreatedPartMap,
): ChangeEntry[] {
  const tags = Object.entries(edits).flatMap(([entity, edit]) =>
    Object.entries(edit.changed).map(([property, pending]) => ({
      entity,
      property,
      original: edit.original[property],
      pending,
      editable: true,
      locked: null,
    })),
  );
  const geometries = Object.entries(geometryEdits).map(([entity, override]) => {
    const labels =
      override.kind === "hole"
        ? { original: "building outline", pending: "hole cut" }
        : override.kind === "slice"
          ? { original: "part outline", pending: "part sliced" }
          : { original: "footprint", pending: "footprint reshaped" };
    return {
      entity,
      property: "geometry",
      ...labels,
      editable: false,
      locked: null,
    };
  });
  const creations = Object.entries(createdParts).flatMap(([entity, feature]) => [
    {
      entity,
      property: "geometry",
      original: undefined,
      pending: "new building part",
      editable: false,
      // The drawn part *is* this row, so removing it removes the part, which is
      // what the entity action does — with its confirmation.
      locked: "the whole part" as string | null,
    },
    ...Object.entries((feature.properties.tags ?? {}) as Record<string, string>).map(
      ([property, pending]) => ({
        entity,
        property,
        original: undefined,
        pending,
        editable: true,
        // Without it the way is not a building part at all.
        locked: property === "building:part" ? ("what makes this a part" as string | null) : null,
      }),
    ),
  ]);
  const merged = new Map<string, ChangeEntry>();
  // A manual override on a new part replaces that part's generated tag row;
  // it must not appear as a second change for the same property.
  for (const entry of [...creations, ...geometries, ...tags]) {
    const key = `${entry.entity}\u0000${entry.property}`;
    const previous = merged.get(key);
    merged.set(key, { ...entry, original: previous ? previous.original : entry.original });
  }
  return [...merged.values()].sort(
    (a, b) => a.entity.localeCompare(b.entity) || a.property.localeCompare(b.property),
  );
}

function groupChanges(entries: ChangeEntry[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup["changes"]>();
  for (const { entity, ...change } of entries) {
    const changes = groups.get(entity) ?? [];
    changes.push(change);
    groups.set(entity, changes);
  }
  return [...groups].map(([entity, changes]) => ({ entity, changes }));
}

function Value({ value, muted }: { value?: string; muted?: boolean }) {
  return value === undefined ? (
    <span className="text-slate-400 italic">not set</span>
  ) : (
    <span className={muted ? "text-slate-500" : undefined} title={value}>
      {value}
    </span>
  );
}

/** One property being retyped in the panel. */
interface PropertyDraft {
  entity: string;
  property: string;
  value: string;
  original: string;
}

/** What the confirm dialog is about: every pending change, or one entity's. */
type ConfirmTarget = { all: true } | { entity: string };

/**
 * What discarding an entity's changes does. A part drawn in this session exists
 * only as a pending change, so discarding it deletes the part; an upstream entity
 * keeps existing and only loses its overrides.
 */
function entityAction(entity: string, createdParts: CreatedPartMap): string {
  return entity in createdParts ? "Delete new part" : "Revert every change on";
}

/** Left drawer for reviewing and navigating to pending tag overrides. */
export function ChangesSidebar({
  open,
  edits,
  geometryEdits,
  createdParts,
  onClose,
  onNavigate,
  onRevertEntity,
  onRemoveProperty,
  onEditProperty,
  onRevertAll,
  onSubmit,
}: {
  open: boolean;
  edits: EditMap;
  geometryEdits: GeometryEditMap;
  createdParts: CreatedPartMap;
  onClose: () => void;
  onNavigate: (entity: string) => void;
  /** Discard everything pending on one entity, the drawn part itself included. */
  onRevertEntity: (entity: string) => void;
  /** Drop one pending property: revert an override, or unset a drawn part's tag. */
  onRemoveProperty: (entity: string, property: string) => void;
  /** Change what one pending property will be written as. */
  onEditProperty: (entity: string, property: string, value: string) => void;
  onRevertAll: () => void;
  onSubmit: () => void;
}) {
  // The confirm dialog covers either every change or one entity's changes.
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [editing, setEditing] = useState<PropertyDraft | null>(null);
  const entries = useMemo(
    () => changeEntries(edits, geometryEdits, createdParts),
    [createdParts, edits, geometryEdits],
  );
  const groups = useMemo(() => groupChanges(entries), [entries]);
  const entityCount = groups.length;
  const confirmEntity = confirmTarget && "entity" in confirmTarget ? confirmTarget.entity : null;
  const confirmCount = entries.filter((entry) => entry.entity === confirmEntity).length;

  useEscapeKey(
    open && editing === null,
    useCallback(() => {
      if (confirmTarget !== null) setConfirmTarget(null);
      else onClose();
    }, [confirmTarget, onClose]),
  );

  if (!open) return null;

  return (
    <aside
      id="changes-sidebar"
      aria-labelledby="changes-title"
      className="absolute inset-y-0 left-0 z-40 flex w-full max-w-sm flex-col border-r border-slate-200 bg-white shadow-2xl"
    >
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 id="changes-title" className="text-lg font-semibold text-slate-900">
            Pending changes
          </h2>
          <p className="text-xs text-slate-500">
            {entries.length} {entries.length === 1 ? "property" : "properties"} across {entityCount}{" "}
            OSM {entityCount === 1 ? "entity" : "entities"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setConfirmTarget({ all: true })}
            className="rounded-md px-2.5 py-1.5 text-sm font-semibold text-rose-700 hover:bg-rose-50"
          >
            Revert all
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close changes sidebar"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <FiX className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-3">
          {groups.map((group) => (
            <li
              key={group.entity}
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
            >
              <div className="flex items-stretch border-b border-slate-200 bg-slate-50">
                <a
                  href={`#${group.entity}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(group.entity);
                  }}
                  className="group flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 transition-colors hover:bg-violet-50"
                >
                  <span className="truncate font-mono text-xs font-semibold text-violet-700">
                    {group.entity}
                  </span>
                  <FiArrowRight
                    className="ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-violet-700"
                    aria-hidden
                  />
                </a>
                <button
                  type="button"
                  onClick={() => setConfirmTarget({ entity: group.entity })}
                  aria-label={`${entityAction(group.entity, createdParts)} ${group.entity}`}
                  title={`${entityAction(group.entity, createdParts)} ${group.entity}`}
                  className="border-l border-slate-200 px-3 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-700"
                >
                  <FiTrash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <table className="w-full table-fixed text-xs">
                <tbody>
                  {group.changes.map((change) => (
                    <tr
                      key={change.property}
                      className="group border-b border-slate-100 align-top last:border-0"
                    >
                      <th
                        scope="row"
                        className="w-2/5 px-3 py-1.5 text-left font-medium break-words text-slate-500"
                        title={change.property}
                      >
                        {change.property}
                      </th>
                      <td className="px-3 py-1.5 break-words text-slate-900">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Value value={change.original} muted />
                          <span className="text-slate-400" aria-hidden>
                            →
                          </span>
                          <span
                            className="rounded bg-amber-100 px-1 font-semibold text-amber-900"
                            title={`Pending — OSM has ${change.original ?? "no value"}`}
                          >
                            {change.pending === "" ? (
                              <span className="italic">not set</span>
                            ) : (
                              change.pending
                            )}
                          </span>
                          {change.editable && (
                            <button
                              type="button"
                              onClick={() =>
                                setEditing({
                                  entity: group.entity,
                                  property: change.property,
                                  value: change.pending,
                                  original: change.pending,
                                })
                              }
                              aria-label={`Edit ${change.property}`}
                              title={`Edit ${change.property}`}
                              className="text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-violet-700 focus:opacity-100"
                            >
                              <FiEdit2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={change.locked !== null}
                            onClick={() => onRemoveProperty(group.entity, change.property)}
                            aria-label={`Remove ${change.property} from the changeset`}
                            title={
                              change.locked
                                ? `Cannot be removed on its own — it is ${change.locked}. Use the entity action instead.`
                                : change.original === undefined
                                  ? `Drop ${change.property} from the changeset`
                                  : `Revert to ${change.original}`
                            }
                            className={
                              change.locked !== null
                                ? "cursor-not-allowed text-slate-200"
                                : "text-slate-400 transition-colors hover:text-rose-600"
                            }
                          >
                            <FiXCircle className="h-4 w-4" aria-hidden />
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      </div>

      <footer className="border-t border-slate-200 bg-slate-50 px-4 py-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={entries.length === 0}
          className={`w-full rounded-lg px-3.5 py-2 text-sm font-semibold ${
            entries.length > 0
              ? "bg-violet-700 text-white hover:bg-violet-800"
              : "cursor-not-allowed bg-slate-200 text-slate-500"
          }`}
        >
          Review &amp; submit to OSM
        </button>
        <p className="mt-1.5 text-center text-[11px] text-slate-500">
          Runs the pre-upload checks and shows the changeset before anything is sent.
        </p>
      </footer>

      {editing && (
        <ValueEditDialog
          title={`Edit ${editing.property}`}
          subtitle={editing.entity}
          value={editing.value}
          onChange={(value) => setEditing((current) => (current ? { ...current, value } : current))}
          error={editing.value.trim() === "" ? "A value is needed; remove the row instead." : null}
          unchanged={editing.value.trim() === editing.original.trim()}
          onCancel={() => setEditing(null)}
          onApply={() => {
            onEditProperty(editing.entity, editing.property, editing.value.trim());
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        tone="danger"
        title={
          confirmEntity === null
            ? "Revert all pending changes?"
            : `${entityAction(confirmEntity, createdParts)} ${confirmEntity}?`
        }
        confirmLabel={confirmEntity === null ? "Revert all" : "Discard"}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (confirmEntity === null) {
            onRevertAll();
            onClose();
          } else {
            onRevertEntity(confirmEntity);
          }
          setConfirmTarget(null);
        }}
      >
        {confirmEntity === null ? (
          <p>
            This will discard {entries.length} pending {entries.length === 1 ? "change" : "changes"}{" "}
            across {entityCount} OSM {entityCount === 1 ? "entity" : "entities"}. This cannot be
            undone.
          </p>
        ) : (
          <p>
            This will discard {confirmCount} pending {confirmCount === 1 ? "change" : "changes"} on{" "}
            <span className="font-mono">{confirmEntity}</span>
            {confirmEntity in createdParts ? ", removing the drawn part itself" : ""}. This cannot
            be undone.
          </p>
        )}
      </ConfirmDialog>
    </aside>
  );
}
