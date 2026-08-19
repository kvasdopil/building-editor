"use client";

import { useCallback, useEffect, useState } from "react";
import type { BuildingSelection } from "./buildings";
import { EDIT_STORE, idbDelete, idbEntries, idbPut } from "./idb";
import { normalizeOsmTags } from "./osm/parse";

/**
 * Pending tag edits, held per OSM element and persisted in IndexedDB so a
 * reload does not lose them. Nothing here is uploaded: this is the local
 * changeset the user builds up before review (EP-001 FT-04).
 */

/** Edited tag values, plus what OSM had, so an edit can be reverted exactly. */
interface BuildingEdit {
  /** Tag key -> new value. */
  changed: Record<string, string>;
  /** Tag key -> value in OSM when the edit was made; absent means unset. */
  original: Record<string, string | undefined>;
  updatedAt: number;
}

type EditMap = Record<string, BuildingEdit>;

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export interface EditsApi {
  edits: EditMap;
  /** True once the stored edits have been read back. */
  ready: boolean;
  setTag(buildingId: string, key: string, value: string, currentValue?: string): void;
  revertTag(buildingId: string, key: string): void;
  revertBuilding(buildingId: string): void;
  editCount: number;
}

export function useBuildingEdits(): EditsApi {
  const [edits, setEdits] = useState<EditMap>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void idbEntries<BuildingEdit>(EDIT_STORE).then((entries) => {
      if (cancelled) return;
      setEdits(Object.fromEntries(entries.filter(([, edit]) => edit?.changed)));
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((buildingId: string, edit: BuildingEdit | null) => {
    if (edit) void idbPut(EDIT_STORE, buildingId, edit);
    else void idbDelete(EDIT_STORE, buildingId);
  }, []);

  /**
   * Replace one building's edit, dropping it entirely when nothing is changed,
   * and persist whatever the result is.
   */
  const update = useCallback(
    (buildingId: string, next: (edit: BuildingEdit | undefined) => BuildingEdit | null) => {
      setEdits((previous) => {
        const edit = next(previous[buildingId]);
        const empty = !edit || Object.keys(edit.changed).length === 0;
        persist(buildingId, empty ? null : edit);
        if (empty) return buildingId in previous ? withoutKey(previous, buildingId) : previous;
        return { ...previous, [buildingId]: edit };
      });
    },
    [persist],
  );

  const setTag = useCallback(
    (buildingId: string, key: string, value: string, currentValue?: string) => {
      update(buildingId, (existing) => ({
        changed: { ...existing?.changed, [key]: value },
        original: {
          ...existing?.original,
          // Keep the first-seen original, so revert always restores OSM.
          [key]: key in (existing?.original ?? {}) ? existing?.original[key] : currentValue,
        },
        updatedAt: Date.now(),
      }));
    },
    [update],
  );

  const revertTag = useCallback(
    (buildingId: string, key: string) => {
      update(buildingId, (existing) =>
        existing
          ? {
              changed: withoutKey(existing.changed, key),
              original: withoutKey(existing.original, key),
              updatedAt: Date.now(),
            }
          : null,
      );
    },
    [update],
  );

  const revertBuilding = useCallback(
    (buildingId: string) => update(buildingId, () => null),
    [update],
  );

  return {
    edits,
    ready,
    setTag,
    revertTag,
    revertBuilding,
    editCount: Object.values(edits).reduce((n, e) => n + Object.keys(e.changed).length, 0),
  };
}

/**
 * Apply pending edits to a selection so the inspector and the 3D view show the
 * edited building. Tags are merged and then re-normalized, because heights and
 * colors read the normalized fields rather than raw tags.
 */
export function applyEdit(
  selection: BuildingSelection,
  edit: BuildingEdit | undefined,
): BuildingSelection {
  if (!edit || Object.keys(edit.changed).length === 0) return selection;

  const properties = selection.building.properties;
  const rawTags = (properties.tags ?? {}) as Record<string, string>;
  const tags = { ...rawTags, ...edit.changed };
  const role = properties.role === "part" ? "part" : "building";

  return {
    ...selection,
    building: {
      ...selection.building,
      properties: {
        ...properties,
        ...normalizeOsmTags(tags, role),
        // Identity is not editable, so keep what the source gave us.
        id: properties.id,
        osm_type: properties.osm_type,
        osm_id: properties.osm_id,
        version: properties.version,
        tags,
      },
    },
  };
}
