"use client";

import type { FeatureCollection } from "geojson";
import { useEffect, useMemo, useState } from "react";
import { Building3D } from "./Building3D";
import { ExternalViews } from "./ExternalViews";
import { type TagRow, TagRows } from "./TagRows";
import type { BuildingProperties, BuildingSelection } from "@/lib/buildings";
import { applyEdit, type EditsApi } from "@/lib/edits";
import { boundsCenter, elementBounds } from "@/lib/geometry";
import { verticalExtent } from "@/lib/heights";
import { type Lod1Match, lod1TilesFor, matchLod1, suggestionsFor } from "@/lib/lod1";

function buildingTitle(selection: BuildingSelection): string {
  const props = selection.building.properties;
  if (props["@name"]) return props["@name"];
  const type = props.class ?? props.subtype ?? "building";
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
  if (raw && typeof raw === "object") return raw as Record<string, string>;
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => [key, tagValue(value)]),
  );
}

/** Fetch the LOD1 blocks under this building and pick the best match. */
function useLod1(selection: BuildingSelection | null): Lod1Match | null {
  const [match, setMatch] = useState<Lod1Match | null>(null);

  useEffect(() => {
    setMatch(null);
    if (!selection) return;
    let cancelled = false;
    void Promise.all(
      lod1TilesFor(selection.building).map((tile) =>
        fetch(`/api/lod1/tile/${tile.z}/${tile.x}/${tile.y}`)
          .then((response) =>
            response.ok ? (response.json() as Promise<FeatureCollection>) : null,
          )
          .catch(() => null),
      ),
    ).then((collections) => {
      if (cancelled) return;
      const usable = collections.filter((c): c is FeatureCollection => c !== null);
      setMatch(matchLod1(selection.building, usable));
    });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  return match;
}

/** Side panel: 3D view, LOD1 advice, and the element's tags. */
export function BuildingPanel({
  selection,
  edits,
  onClose,
}: {
  selection: BuildingSelection | null;
  edits: EditsApi;
  onClose: () => void;
}) {
  const match = useLod1(selection);
  const buildingId = selection?.building.id ?? "";
  const edit = edits.edits[buildingId];

  // The edited building is what gets inspected and extruded, so applying a
  // suggestion shows up in the 3D view on the same render.
  const edited = useMemo(() => (selection ? applyEdit(selection, edit) : null), [selection, edit]);

  // Tags as OSM has them, independent of pending edits: what revert restores
  // and what an edit records as its original value.
  const osmTags = useMemo(
    () => (selection ? sourceTags(selection.building.properties) : {}),
    [selection],
  );

  const rows = useMemo<TagRow[]>(() => {
    if (!edited) return [];
    // Compared against the effective tags, so advice disappears once applied.
    const tags = sourceTags(edited.building.properties);
    const suggestions = match ? suggestionsFor(edited.building, match, tags) : [];
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

    // Advice for a tag OSM does not have yet needs a row of its own.
    const extra = suggestions
      .filter((s) => !(s.key in tags))
      .map((s): TagRow => ({ key: s.key, value: "", edited: false, suggestion: s }));

    return [...extra, ...known].sort((a, b) => a.key.localeCompare(b.key));
  }, [edited, match, edit, osmTags]);

  if (!selection || !edited) return null;

  const props = edited.building.properties;
  const version = typeof props.version === "number" ? `v${props.version}` : null;
  const summary = [
    typeof props.osm_type === "string" ? `${props.id} · ${version ?? ""}`.trim() : null,
    `≈${verticalExtent(props).top.toFixed(1)} m`,
    selection.parts.length > 0 ? `${selection.parts.length} parts` : null,
    edit ? `${Object.keys(edit.changed).length} edited` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-900 capitalize">
            {buildingTitle(edited)}
          </h2>
          <p className="truncate text-xs text-slate-500">{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {edit && (
            <button
              type="button"
              onClick={() => edits.revertBuilding(buildingId)}
              className="rounded-md px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
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
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="relative min-h-48 flex-1">
        <Building3D selection={edited} />
      </div>

      <ExternalViews
        center={boundsCenter(elementBounds(edited.building))}
        height={verticalExtent(props).top}
      />

      <p className="border-y border-slate-200 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-500">
        {match ? (
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
      </p>

      <div className="max-h-[32%] min-h-24 overflow-y-auto">
        <TagRows
          rows={rows}
          onApply={(suggestion) =>
            edits.setTag(buildingId, suggestion.key, suggestion.value, osmTags[suggestion.key])
          }
          onRevert={(key) => edits.revertTag(buildingId, key)}
        />
      </div>
    </aside>
  );
}
