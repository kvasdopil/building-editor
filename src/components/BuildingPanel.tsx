"use client";

import { useMemo, useState } from "react";
import { Building3D, type CameraView, type CloudStatus, type TerrainStatus } from "./Building3D";
import { External3DLinks } from "./External3DLinks";
import { Photoreal3D } from "./Photoreal3D";
import { EDITABLE_DIMENSION_KEYS, OPTIONAL_ROOF_KEYS, type TagRow, TagRows } from "./TagRows";
import type { BuildingProperties, BuildingSelection } from "@/lib/buildings";
import { applyEditsToSelection, type EditsApi } from "@/lib/edits";
import { boundsCenter, boundsRadiusMeters, elementBounds } from "@/lib/geometry";
import { type Lod1Match, suggestionsFor } from "@/lib/lod1";
import type { LidarCloud } from "@/lib/lidar";
import { roofDirectionFromLook } from "@/lib/roofs";

function buildingTitle(selection: BuildingSelection): string {
  const props = selection.selected.properties;
  if (props["@name"]) return props["@name"];
  const type =
    props.class ?? props.subtype ?? (props.role === "part" ? "building part" : "building");
  return type.replace(/_/g, " ");
}

function tagValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/** Raw source tags for the element: OSM features carry them under `tags`. */
function sourceTags(properties: BuildingProperties): Record<string, string> {
  const raw = properties.tags;
  if (raw && typeof raw === "object") {
    return Object.fromEntries(
      Object.entries(raw as Record<string, string>).filter(([, value]) => value !== ""),
    );
  }
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => [key, tagValue(value)]),
  );
}

/** Side panel: 3D view, LOD1 advice, and the element's tags. */
export function BuildingPanel({
  selection,
  lod1Match,
  initialHeading,
  edits,
  onEditTag,
  onLidarCloudChange,
  onSelectEntity,
  onClose,
}: {
  selection: BuildingSelection | null;
  lod1Match: Lod1Match | null;
  initialHeading: number;
  edits: EditsApi;
  onEditTag: (entity: string, key: string, value: string, currentValue?: string) => void;
  onLidarCloudChange?: (buildingId: string, cloud: LidarCloud | null) => void;
  onSelectEntity: (entityId: string) => void;
  onClose: () => void;
}) {
  const match = lod1Match;
  const [camera, setCamera] = useState<CameraView | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus | null>(null);
  const selectedId = selection?.selected.id ?? "";
  // Laser dots arrive after the 3D view, and a national tile is assembled on
  // demand, so say which of "reading", "measured" and "nothing here" it is.
  const laserStatus =
    cloudStatus === null || cloudStatus.buildingId !== selection?.building.id
      ? null
      : cloudStatus.state === "loading"
        ? "laser: reading…"
        : cloudStatus.state === "empty"
          ? "laser: no points"
          : `laser: ${cloudStatus.points?.toLocaleString()} pts · ${cloudStatus.source}`;
  const selectedTerrainStatus =
    terrainStatus?.buildingId === selection?.building.id ? terrainStatus : null;
  const edit = edits.edits[selectedId];

  // Project every pending override into the scene so both the selected subject
  // and gray context buildings render from their effective properties.
  const edited = useMemo(
    () => (selection ? applyEditsToSelection(selection, edits.edits) : null),
    [selection, edits.edits],
  );

  // Tags as OSM has them, independent of pending edits: what revert restores
  // and what an edit records as its original value.
  const osmTags = useMemo(
    () => (selection ? sourceTags(selection.selected.properties) : {}),
    [selection],
  );

  const effectiveTags = useMemo(
    () => (edited ? sourceTags(edited.selected.properties) : {}),
    [edited],
  );
  const roofDirectionForLook = useMemo(
    () => (lookBearing: number) => {
      if (!edited) return "0";
      const rounded = Math.round(roofDirectionFromLook(edited.selected, lookBearing)) % 360;
      return String((rounded + 360) % 360);
    },
    [edited],
  );

  const rows = useMemo<TagRow[]>(() => {
    if (!edited) return [];
    // Compared against the effective tags, so advice disappears once applied.
    const tags = effectiveTags;
    const roofShape =
      edited.selected.properties.roof_shape ?? edited.building.properties.roof_shape;
    const suggestions = match ? suggestionsFor(edited.selected, match, tags) : [];
    const byKey = new Map(suggestions.map((s) => [s.key, s]));

    const known = Object.entries(tags)
      .filter(([, value]) => value !== "")
      .map(
        ([key, value]): TagRow => ({
          key,
          value,
          edited: edit ? key in edit.changed : false,
          originalValue: osmTags[key],
          suggestion: byKey.get(key),
        }),
      );

    // Advice and manually editable dimensions need rows even when OSM does not
    // have those tags yet.
    const extraKeys = new Set([
      ...suggestions.filter((s) => !(s.key in tags)).map((s) => s.key),
      ...EDITABLE_DIMENSION_KEYS.filter((key) => !(key in tags)),
      ...OPTIONAL_ROOF_KEYS.filter(
        (key) =>
          !(key in tags) &&
          ((key !== "roof:orientation" && key !== "roof:direction") ||
            (key === "roof:orientation" &&
              ["gabled", "gambrel", "round"].includes(roofShape ?? "")) ||
            (key === "roof:direction" && roofShape === "skillion")),
      ),
    ]);
    const extra = [...extraKeys].map(
      (key): TagRow => ({
        key,
        value: "",
        edited: edit ? key in edit.changed : false,
        originalValue: osmTags[key],
        suggestion: byKey.get(key),
      }),
    );

    return [...extra, ...known].sort((a, b) => a.key.localeCompare(b.key));
  }, [edited, effectiveTags, match, edit, osmTags]);

  if (!selection || !edited) return null;

  const props = edited.selected.properties;
  const selectedIsPart = props.role === "part";
  const parentId = edited.selected.id !== edited.building.id ? edited.building.id : null;
  const editedCount = edit ? Object.keys(edit.changed).length : 0;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900 capitalize">
            {buildingTitle(edited)}
          </h2>
          <p className="truncate text-[11px] text-slate-500">
            <span className="font-mono">{selectedId}</span>
            {selectedIsPart ? (
              <>
                <span aria-hidden> · </span>
                {parentId ? (
                  <>
                    part of{" "}
                    <a
                      href={`#${parentId}`}
                      onClick={(event) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        onSelectEntity(parentId);
                      }}
                      className="font-mono font-medium text-violet-700 underline decoration-violet-300 underline-offset-2 hover:text-violet-900"
                    >
                      {parentId}
                    </a>
                  </>
                ) : (
                  "standalone part"
                )}
              </>
            ) : selection.parts.length > 0 ? (
              <>
                <span aria-hidden> · </span>
                {selection.parts.length} parts
              </>
            ) : null}
            {editedCount > 0 && (
              <>
                <span aria-hidden> · </span>
                {editedCount} edited
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <External3DLinks center={boundsCenter(elementBounds(edited.selected))} camera={camera} />
          {edit && (
            <button
              type="button"
              onClick={() => edits.revertBuilding(selectedId)}
              className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-50"
            >
              Revert all
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="relative min-h-48 flex-1">
        <Building3D
          selection={edited}
          initialHeading={initialHeading}
          onCameraChange={setCamera}
          onCloudStatus={setCloudStatus}
          onCloudChange={onLidarCloudChange}
          onTerrainStatus={setTerrainStatus}
        />
      </div>

      <Photoreal3D
        center={boundsCenter(elementBounds(edited.selected))}
        camera={camera}
        radius={boundsRadiusMeters(elementBounds(edited.selected))}
      />

      <p className="border-y border-slate-200 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-500">
        {selectedIsPart ? (
          "LOD1 advice is only available for building outlines"
        ) : match ? (
          <>
            LOD1 covers {Math.round(match.coverage * 100)}% of this footprint
            {match.properties.category ? ` · ${match.properties.category}` : ""}
            {!match.confident && (
              <span className="text-amber-700">
                {" "}
                · block is {(1 / Math.max(match.blockShare, 0.01)).toFixed(1)}× larger, so its
                heights cover several buildings — advice is unreliable
              </span>
            )}
          </>
        ) : (
          "No LOD1 building matches this footprint"
        )}
        {laserStatus && <span className="text-slate-400"> · {laserStatus}</span>}
        {selectedTerrainStatus && (
          <span className="text-slate-400">
            {" "}
            · terrain:{" "}
            {selectedTerrainStatus.state === "loading"
              ? "reading…"
              : selectedTerrainStatus.state === "empty"
                ? "unavailable"
                : `${selectedTerrainStatus.groundZ?.toFixed(1)} m ground · `}
            {selectedTerrainStatus.state === "loaded" && (
              <a
                href="https://mapterhorn.com/attribution/"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-slate-600"
              >
                Mapterhorn z13
              </a>
            )}
          </span>
        )}
      </p>

      <div className="max-h-[32%] min-h-24 overflow-y-auto">
        <TagRows
          rows={rows}
          onApply={(suggestion) =>
            onEditTag(selectedId, suggestion.key, suggestion.value, osmTags[suggestion.key])
          }
          onEdit={(key, value) => onEditTag(selectedId, key, value, osmTags[key])}
          onRevert={(key) => edits.revertTag(selectedId, key)}
          roofDirectionForLook={roofDirectionForLook}
          parentId={parentId}
          onSelectParent={parentId ? () => onSelectEntity(parentId) : undefined}
        />
      </div>
    </aside>
  );
}
