"use client";

import { useCallback, useMemo, useState } from "react";
import { FiArrowRight, FiX } from "react-icons/fi";
import type { EditMap } from "@/lib/edits";
import type { CreatedPartMap, GeometryEditMap } from "@/lib/geometry-edits";
import { useEscapeKey } from "@/lib/use-escape-key";
import { ConfirmDialog } from "./ConfirmDialog";

interface ChangeEntry {
  entity: string;
  property: string;
  original?: string;
  pending: string;
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
    })),
  );
  const geometries = Object.entries(geometryEdits).map(([entity, override]) => ({
    entity,
    property: "geometry",
    original: override.kind === "hole" ? "building outline" : "part outline",
    pending: override.kind === "hole" ? "hole cut" : "part sliced",
  }));
  const creations = Object.entries(createdParts).flatMap(([entity, feature]) => [
    {
      entity,
      property: "geometry",
      original: undefined,
      pending: "new building part",
    },
    ...Object.entries((feature.properties.tags ?? {}) as Record<string, string>).map(
      ([property, pending]) => ({ entity, property, original: undefined, pending }),
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

function Value({ value }: { value?: string }) {
  return value === undefined ? (
    <span className="block truncate text-slate-400 italic">not set</span>
  ) : (
    <span className="block truncate" title={value}>
      {value}
    </span>
  );
}

/** Left drawer for reviewing and navigating to pending tag overrides. */
export function ChangesSidebar({
  open,
  edits,
  geometryEdits,
  createdParts,
  onClose,
  onNavigate,
  onRevertAll,
  onSubmit,
}: {
  open: boolean;
  edits: EditMap;
  geometryEdits: GeometryEditMap;
  createdParts: CreatedPartMap;
  onClose: () => void;
  onNavigate: (entity: string) => void;
  onRevertAll: () => void;
  onSubmit: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const entries = useMemo(
    () => changeEntries(edits, geometryEdits, createdParts),
    [createdParts, edits, geometryEdits],
  );
  const groups = useMemo(() => groupChanges(entries), [entries]);
  const entityCount = groups.length;

  useEscapeKey(
    open,
    useCallback(() => {
      if (confirmOpen) setConfirmOpen(false);
      else onClose();
    }, [confirmOpen, onClose]),
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
            onClick={() => setConfirmOpen(true)}
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
              <a
                href={`#${group.entity}`}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(group.entity);
                }}
                className="group flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5 transition-colors hover:bg-violet-50"
              >
                <span className="truncate font-mono text-xs font-semibold text-violet-700">
                  {group.entity}
                </span>
                <FiArrowRight
                  className="ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-violet-700"
                  aria-hidden
                />
              </a>
              <ul className="divide-y divide-slate-100">
                {group.changes.map((change) => (
                  <li
                    key={change.property}
                    className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_auto_minmax(0,0.8fr)] items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap"
                  >
                    <span className="truncate font-medium text-slate-900" title={change.property}>
                      {change.property}
                    </span>
                    <span className="min-w-0 text-slate-600">
                      <Value value={change.original} />
                    </span>
                    <span className="text-slate-400">→</span>
                    <span className="min-w-0 font-semibold text-violet-700">
                      <Value value={change.pending} />
                    </span>
                  </li>
                ))}
              </ul>
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

      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title="Revert all pending changes?"
        confirmLabel="Revert all"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          onRevertAll();
          setConfirmOpen(false);
          onClose();
        }}
      >
        <p>
          This will discard {entries.length} pending {entries.length === 1 ? "change" : "changes"}{" "}
          across {entityCount} OSM {entityCount === 1 ? "entity" : "entities"}. This cannot be
          undone.
        </p>
      </ConfirmDialog>
    </aside>
  );
}
