"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import type {
  BuildingElement,
  BuildingProperties,
  BuildingSelection,
  BuildingWithParts,
} from "./buildings";
import type { CreatedPartMap, GeometryEditMap } from "./geometry-edits";
import { EDIT_STORE, GEOMETRY_STORE, idbClear, idbDelete, idbEntries, idbGet, idbPut } from "./idb";
import { drawnId, parseOsmRef } from "./osm/ref";
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

export type EditMap = Record<string, BuildingEdit>;

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
  revertAll(): void;
  editCount: number;
}

/** Merge one pending edit into normalized OSM properties for display. */
function applyEditToProperties(
  properties: BuildingProperties,
  edit: BuildingEdit | undefined,
): BuildingProperties {
  if (!edit || Object.keys(edit.changed).length === 0) return properties;

  const rawTags = (properties.tags ?? {}) as Record<string, string>;
  const tags = { ...rawTags, ...edit.changed };
  const role = properties.role === "part" ? "part" : "building";

  return {
    ...properties,
    // A pending empty value deletes a tag. Clear every normalized field first
    // so deleting one changes the effective geometry immediately instead of
    // leaving its old derived value behind until the next tile load.
    height: undefined,
    num_floors: undefined,
    min_height: undefined,
    min_floor: undefined,
    roof_shape: undefined,
    roof_height: undefined,
    roof_orientation: undefined,
    roof_direction: undefined,
    ...normalizeOsmTags(tags, role),
    // Identity is not editable, so keep what the source gave us.
    id: properties.id,
    osm_type: properties.osm_type,
    osm_id: properties.osm_id,
    version: properties.version,
    tags,
    locally_modified: true,
  };
}

/** Apply one pending edit to a building or part without changing its geometry. */
function applyEditToElement(
  element: BuildingElement,
  edit: BuildingEdit | undefined,
): BuildingElement {
  if (!edit || Object.keys(edit.changed).length === 0) return element;
  return { ...element, properties: applyEditToProperties(element.properties, edit) };
}

/** Apply pending edits to an outline and all of its parts. */
function applyEditsToBuilding(
  subject: BuildingWithParts,
  edits: EditsApi["edits"],
): BuildingWithParts {
  return {
    building: applyEditToElement(subject.building, edits[subject.building.id]),
    parts: subject.parts.map((part) => applyEditToElement(part, edits[part.id])),
  };
}

/**
 * Apply all pending edits to the live map collection. The tile cache remains
 * raw OSM data, while MapLibre sees the effective properties and can update
 * data-driven styling immediately.
 */
export function applyEditsToFeatureCollection(
  collection: FeatureCollection,
  edits: EditsApi["edits"],
): FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const properties = (feature.properties ?? {}) as BuildingProperties;
      const id = properties.id;
      const edit = typeof id === "string" ? edits[id] : undefined;
      if (!edit) return feature;
      return { ...feature, properties: applyEditToProperties(properties, edit) };
    }),
  };
}

export function useBuildingEdits(): EditsApi {
  const [edits, setEdits] = useState<EditMap>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void idbEntries<BuildingEdit>(EDIT_STORE).then((entries) => {
      if (cancelled) return;
      const usable = entries.filter(
        ([id, edit]) => edit?.changed && (parseOsmRef(id) !== null || drawnId(id) !== null),
      );
      // Anything else is keyed by an id this app no longer issues — drawn parts
      // were once `new/part-1`, before they took the negative placeholder id the
      // upload uses. Such an override describes an element nothing can resolve,
      // so drop it rather than carry it into the changes list forever.
      const kept = new Set(usable.map(([id]) => id));
      for (const [id] of entries) if (!kept.has(id)) void idbDelete(EDIT_STORE, id);
      setEdits(Object.fromEntries(usable));
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

  const revertAll = useCallback(() => {
    setEdits({});
    void idbClear(EDIT_STORE);
  }, []);

  return {
    edits,
    ready,
    setTag,
    revertTag,
    revertBuilding,
    revertAll,
    editCount: Object.values(edits).reduce((n, e) => n + Object.keys(e.changed).length, 0),
  };
}

/** The drawn half of the pending change set, as stored. */
export interface PendingGeometry {
  geometryEdits: GeometryEditMap;
  createdParts: CreatedPartMap;
}

const GEOMETRY_KEY = "overrides";
const PARTS_KEY = "created-parts";

/**
 * Persist footprint overrides and drawn parts, and restore them once on mount.
 *
 * Tag overrides are stored per OSM element, and were the only half of the pending
 * change set that survived a reload. That left tag overrides on a drawn part
 * outliving the part itself — a pending change pointing at nothing, which the
 * submit checks could only report as missing. Both halves now persist together.
 *
 * State stays with the caller: the drawing tools update it through refs on every
 * click, so ownership here would mean rewriting all of them.
 */
export function usePendingGeometry(
  geometryEdits: GeometryEditMap,
  createdParts: CreatedPartMap,
  onRestore: (stored: PendingGeometry) => void,
): boolean {
  const [ready, setReady] = useState(false);
  const restored = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      idbGet<GeometryEditMap>(GEOMETRY_STORE, GEOMETRY_KEY),
      idbGet<CreatedPartMap>(GEOMETRY_STORE, PARTS_KEY),
    ]).then(([overrides, parts]) => {
      if (cancelled) return;
      restored.current = true;
      setReady(true);
      if (overrides || parts) {
        onRestore({ geometryEdits: overrides ?? {}, createdParts: parts ?? {} });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onRestore]);

  // Writing before the read comes back would erase what is stored.
  useEffect(() => {
    if (restored.current) void idbPut(GEOMETRY_STORE, GEOMETRY_KEY, geometryEdits);
  }, [geometryEdits]);

  useEffect(() => {
    if (restored.current) void idbPut(GEOMETRY_STORE, PARTS_KEY, createdParts);
  }, [createdParts]);

  return ready;
}

/**
 * Project every pending edit into a 3D selection. The selected building, its
 * parts, and all context buildings use effective normalized properties while
 * the underlying selection remains raw OSM data.
 */
export function applyEditsToSelection(
  selection: BuildingSelection,
  edits: EditsApi["edits"],
): BuildingSelection {
  const selected = applyEditsToBuilding(selection, edits);

  return {
    ...selection,
    ...selected,
    selected: applyEditToElement(selection.selected, edits[selection.selected.id]),
    neighbors: selection.neighbors.map((neighbor) => applyEditsToBuilding(neighbor, edits)),
  };
}
