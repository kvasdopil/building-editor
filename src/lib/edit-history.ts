"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditMap } from "./edits";
import type { CreatedPartMap, GeometryEditMap } from "./geometry-edits";
import { EDIT_HISTORY_STORE, idbDelete, idbGet, idbPut } from "./idb";

export interface MaterializedEditState {
  edits: EditMap;
  geometryEdits: GeometryEditMap;
  createdParts: CreatedPartMap;
}

export interface EditHistoryEntry {
  id: string;
  label: string;
  createdAt: number;
  before: MaterializedEditState;
  after: MaterializedEditState;
}

export interface EditHistoryDocument {
  schemaVersion: 1;
  entries: EditHistoryEntry[];
  cursor: number;
}

const HISTORY_KEY = "pending";

function serialized(state: MaterializedEditState): string {
  return JSON.stringify(state);
}

function emptyState(): MaterializedEditState {
  return { edits: {}, geometryEdits: {}, createdParts: {} };
}

function isEmpty(state: MaterializedEditState): boolean {
  return (
    Object.keys(state.edits).length === 0 &&
    Object.keys(state.geometryEdits).length === 0 &&
    Object.keys(state.createdParts).length === 0
  );
}

export function historyStateAt(
  document: EditHistoryDocument,
  cursor: number,
): MaterializedEditState {
  if (cursor === 0) return document.entries[0]?.before ?? emptyState();
  return document.entries[cursor - 1]?.after ?? emptyState();
}

export function appendHistory(
  document: EditHistoryDocument,
  after: MaterializedEditState,
  id = crypto.randomUUID(),
  createdAt = Date.now(),
): EditHistoryDocument {
  const before = historyStateAt(document, document.cursor);
  if (serialized(before) === serialized(after)) return document;
  const entry: EditHistoryEntry = {
    id,
    label: describeEdit(before, after),
    createdAt,
    before,
    after,
  };
  return {
    schemaVersion: 1,
    entries: [...document.entries.slice(0, document.cursor), entry],
    cursor: document.cursor + 1,
  };
}

export function moveHistoryCursor(
  document: EditHistoryDocument,
  cursor: number,
): EditHistoryDocument {
  if (cursor < 0 || cursor > document.entries.length) return document;
  return { ...document, cursor };
}

function changedKeys<T>(before: Record<string, T>, after: Record<string, T>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/** Human-readable history labels derived from the atomic state transition. */
export function describeEdit(before: MaterializedEditState, after: MaterializedEditState): string {
  const created = changedKeys(before.createdParts, after.createdParts);
  const geometry = changedKeys(before.geometryEdits, after.geometryEdits);
  const tags = changedKeys(before.edits, after.edits);
  const removed =
    Object.keys(before.createdParts).length > Object.keys(after.createdParts).length ||
    Object.keys(before.geometryEdits).length > Object.keys(after.geometryEdits).length ||
    Object.keys(before.edits).length > Object.keys(after.edits).length;

  const kinds = geometry
    .map((id) => after.geometryEdits[id]?.kind)
    .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined);
  if (kinds.includes("add-part")) return "Add part";
  if (kinds.includes("slice")) return "Slice building";
  if (kinds.includes("hole")) return "Cut hole";
  if (kinds.includes("add-node")) return "Add node";
  if (kinds.includes("reshape")) return "Reshape footprint";
  if (created.length > 0 && !removed) return "Create building part";
  if (geometry.length > 0) return removed ? "Revert geometry" : "Edit geometry";
  if (tags.length > 0) return removed ? "Revert tags" : "Edit tags";
  return removed ? "Revert changes" : "Edit building";
}

function usableDocument(value: EditHistoryDocument | null): value is EditHistoryDocument {
  return (
    value?.schemaVersion === 1 &&
    Array.isArray(value.entries) &&
    Number.isInteger(value.cursor) &&
    value.cursor >= 0 &&
    value.cursor <= value.entries.length
  );
}

export function useEditHistory({
  current,
  ready,
  apply,
}: {
  current: MaterializedEditState;
  ready: boolean;
  apply: (state: MaterializedEditState) => void;
}) {
  const [document, setDocument] = useState<EditHistoryDocument | null>(null);
  const currentRef = useRef(current);
  const documentRef = useRef(document);
  const applyingRef = useRef<string | null>(null);
  const groupRef = useRef<{
    label: string;
    before: MaterializedEditState;
    base: EditHistoryDocument;
    id: string;
    createdAt: number;
    ending: boolean;
  } | null>(null);
  const [grouping, setGrouping] = useState(false);
  currentRef.current = current;
  documentRef.current = document;

  const persist = useCallback((next: EditHistoryDocument) => {
    documentRef.current = next;
    setDocument(next);
    void idbPut(EDIT_HISTORY_STORE, HISTORY_KEY, next);
  }, []);

  useEffect(() => {
    if (!ready || documentRef.current) return;
    let cancelled = false;
    void idbGet<EditHistoryDocument>(EDIT_HISTORY_STORE, HISTORY_KEY).then((stored) => {
      if (cancelled || documentRef.current) return;
      if (usableDocument(stored)) {
        const restored = historyStateAt(stored, stored.cursor);
        applyingRef.current = serialized(restored);
        apply(restored);
        documentRef.current = stored;
        setDocument(stored);
        return;
      }

      const legacy = currentRef.current;
      const initial: EditHistoryDocument = isEmpty(legacy)
        ? { schemaVersion: 1, entries: [], cursor: 0 }
        : {
            schemaVersion: 1,
            entries: [
              {
                id: crypto.randomUUID(),
                label: "Restore pending changes",
                createdAt: Date.now(),
                before: emptyState(),
                after: legacy,
              },
            ],
            cursor: 1,
          };
      persist(initial);
    });
    return () => {
      cancelled = true;
    };
  }, [apply, persist, ready]);

  useEffect(() => {
    const active = documentRef.current;
    if (!ready || !active) return;
    const encoded = serialized(current);
    if (applyingRef.current === encoded) {
      applyingRef.current = null;
      return;
    }
    const previous = historyStateAt(active, active.cursor);
    if (serialized(previous) === encoded) return;

    const group = groupRef.current;
    if (group) {
      if (serialized(group.before) === encoded) {
        persist(group.base);
        return;
      }
      persist({
        schemaVersion: 1,
        entries: [
          ...group.base.entries.slice(0, group.base.cursor),
          {
            id: group.id,
            label: group.label,
            createdAt: group.createdAt,
            before: group.before,
            after: current,
          },
        ],
        cursor: group.base.cursor + 1,
      });
      return;
    }

    persist(appendHistory(active, current));
  }, [current, persist, ready]);

  const moveTo = useCallback(
    (cursor: number) => {
      const active = documentRef.current;
      if (!active || cursor < 0 || cursor > active.entries.length) return;
      if (groupRef.current) return;
      const restored = historyStateAt(active, cursor);
      const next = moveHistoryCursor(active, cursor);
      applyingRef.current = serialized(restored);
      persist(next);
      apply(restored);
    },
    [apply, persist],
  );

  const clear = useCallback(() => {
    const next: EditHistoryDocument = { schemaVersion: 1, entries: [], cursor: 0 };
    applyingRef.current = serialized(emptyState());
    documentRef.current = next;
    groupRef.current = null;
    setGrouping(false);
    setDocument(next);
    void idbDelete(EDIT_HISTORY_STORE, HISTORY_KEY);
  }, []);

  const beginGroup = useCallback((label: string) => {
    const active = documentRef.current;
    if (!active || groupRef.current) return;
    groupRef.current = {
      label,
      before: currentRef.current,
      base: active,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ending: false,
    };
    setGrouping(true);
  }, []);

  const endGroup = useCallback(() => {
    const group = groupRef.current;
    if (!group || group.ending) return;
    // Pointer-up can be batched with the drag's final state update. Keep the
    // group alive through this frame so the observing effect folds that final
    // value into the same entry instead of appending a stray undo step.
    group.ending = true;
    requestAnimationFrame(() => {
      if (groupRef.current !== group) return;
      groupRef.current = null;
      setGrouping(false);
    });
  }, []);

  return useMemo(
    () => ({
      ready: document !== null,
      grouping,
      canUndo: Boolean(document && document.cursor > 0),
      canRedo: Boolean(document && document.cursor < document.entries.length),
      undoLabel: document?.cursor ? document.entries[document.cursor - 1]?.label : undefined,
      redoLabel:
        document && document.cursor < document.entries.length
          ? document.entries[document.cursor]?.label
          : undefined,
      undo: () => moveTo((documentRef.current?.cursor ?? 0) - 1),
      redo: () => moveTo((documentRef.current?.cursor ?? 0) + 1),
      beginGroup,
      endGroup,
      clear,
    }),
    [beginGroup, clear, document, endGroup, grouping, moveTo],
  );
}
