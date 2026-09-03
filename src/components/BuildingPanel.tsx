"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Building3D, type CameraView, type CloudStatus, type TerrainStatus } from "./Building3D";
import { ExternalMapLinks } from "./External3DLinks";
import { Photoreal3D } from "./Photoreal3D";
import { EDITABLE_DIMENSION_KEYS, OPTIONAL_ROOF_KEYS, type TagRow, TagRows } from "./TagRows";
import type { BuildingProperties, BuildingSelection } from "@/lib/buildings";
import { applyEditsToSelection, type EditsApi } from "@/lib/edits";
import { LOD1_ENABLED } from "@/lib/features";
import { boundsCenter, boundsRadiusMeters, elementBounds } from "@/lib/geometry";
import { type Lod1Match, type Suggestion, suggestionsFor } from "@/lib/lod1";
import type { LidarCloud } from "@/lib/lidar";
import { trackProductEvent } from "@/lib/product-analytics";
import { roofAdviceFor } from "@/lib/roof-advice";
import { roofDirectionFromLook } from "@/lib/roofs";
import { buildSurfaceGrid } from "@/lib/surface-grid";

/** Stable empty list, so a reading-less panel does not remake its rows. */
const EMPTY_ADVICE: Suggestion[] = [];

const VIEWER_HEIGHT_STORAGE_KEY = "building-explorer:sidebar-viewer-height-percent";
const DEFAULT_VIEWER_HEIGHT_PERCENT = 66;
const MIN_VIEWER_HEIGHT_PERCENT = 25;
const MAX_VIEWER_HEIGHT_PERCENT = 80;

function clampViewerHeight(percent: number): number {
  return Math.min(MAX_VIEWER_HEIGHT_PERCENT, Math.max(MIN_VIEWER_HEIGHT_PERCENT, percent));
}

function storedViewerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_VIEWER_HEIGHT_PERCENT;
  try {
    const raw = window.localStorage.getItem(VIEWER_HEIGHT_STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEWER_HEIGHT_PERCENT;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clampViewerHeight(stored) : DEFAULT_VIEWER_HEIGHT_PERCENT;
  } catch {
    return DEFAULT_VIEWER_HEIGHT_PERCENT;
  }
}

function pointCountBucket(points = 0): string {
  if (points === 0) return "0";
  if (points < 10_000) return "1-9k";
  if (points < 100_000) return "10-99k";
  if (points < 500_000) return "100-499k";
  return "500k+";
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
  widthPercent,
  minWidthPercent,
  maxWidthPercent,
  onWidthPercentChange,
  lod1Match,
  initialHeading,
  edits,
  onEditTag,
  onLidarCloudChange,
  onLidarDifferences,
  wantLidarDifferences,
  onSelectEntity,
}: {
  selection: BuildingSelection | null;
  widthPercent: number;
  minWidthPercent: number;
  maxWidthPercent: number;
  onWidthPercentChange: (percent: number) => void;
  lod1Match: Lod1Match | null;
  initialHeading: number;
  edits: EditsApi;
  onEditTag: (entity: string, key: string, value: string, currentValue?: string) => void;
  onLidarCloudChange?: (buildingId: string, cloud: LidarCloud | null) => void;
  onLidarDifferences?: (buildingId: string, differences: Float32Array | null) => void;
  wantLidarDifferences?: boolean;
  onSelectEntity: (entityId: string) => void;
}) {
  const match = lod1Match;
  const [camera, setCamera] = useState<CameraView | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  const [cloud, setCloud] = useState<LidarCloud | null>(null);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus | null>(null);
  const [viewerHeight, setViewerHeight] = useState(storedViewerHeight);
  const [resizing, setResizing] = useState(false);
  const [resizingWidth, setResizingWidth] = useState(false);
  const reportedCloudsRef = useRef(new Set<string>());
  const splitRef = useRef<HTMLDivElement>(null);
  const resizePointer = useRef<number | null>(null);
  const widthResizePointer = useRef<number | null>(null);
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

  useEffect(() => {
    if (!cloudStatus || cloudStatus.state === "loading") return;
    if (reportedCloudsRef.current.has(cloudStatus.buildingId)) return;
    reportedCloudsRef.current.add(cloudStatus.buildingId);
    trackProductEvent("LiDAR Query Completed", {
      result: cloudStatus.state,
      source: cloudStatus.source ?? "none",
      points: pointCountBucket(cloudStatus.points),
    });
  }, [cloudStatus]);

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

  // The laser cloud reaches the map as well, for its Surface mode; the panel
  // keeps it to measure the roof from.
  const handleCloud = useCallback(
    (buildingId: string, loaded: LidarCloud | null) => {
      setCloud(loaded);
      onLidarCloudChange?.(buildingId, loaded);
    },
    [onLidarCloudChange],
  );

  // Rastered from the whole building whichever part is selected, so a part is
  // measured in the same frame as its neighbours — and from the OSM geometry
  // rather than the edited one, so applying a tag does not rebuild the raster.
  const grid = useMemo(
    () => (cloud && selection ? buildSurfaceGrid(cloud, selection.building.polygons) : null),
    [cloud, selection],
  );

  const laserReading = useMemo(
    () =>
      grid && selection ? roofAdviceFor(grid, selection.selected.polygons, effectiveTags) : null,
    [grid, selection, effectiveTags],
  );
  const laserAdvice = laserReading?.advice ?? EMPTY_ADVICE;

  // The three tags describe one roof, and are worth applying as one: a height
  // without the roof height it was measured with builds a different roof than
  // the one the laser matched.
  // The advice already holds exactly the keys that would change, so a tag the
  // laser agrees with is left alone rather than recorded as a no-op edit.
  const applyLaserRoof = useCallback(() => {
    for (const advice of laserAdvice) {
      onEditTag(selectedId, advice.key, advice.value, osmTags[advice.key]);
    }
  }, [laserAdvice, onEditTag, selectedId, osmTags]);

  const setAndStoreViewerHeight = useCallback((percent: number) => {
    const next = clampViewerHeight(percent);
    setViewerHeight(next);
    try {
      window.localStorage.setItem(VIEWER_HEIGHT_STORAGE_KEY, String(next));
    } catch {
      // Keep the in-memory position when storage is unavailable.
    }
  }, []);

  const resizeFromPointer = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (resizePointer.current !== event.pointerId) return;
      const split = splitRef.current;
      if (!split) return;
      event.preventDefault();
      const bounds = split.getBoundingClientRect();
      setAndStoreViewerHeight(((event.clientY - bounds.top) / bounds.height) * 100);
    },
    [setAndStoreViewerHeight],
  );

  const finishResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (resizePointer.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizePointer.current = null;
    setResizing(false);
  }, []);

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      let next = viewerHeight;
      if (event.key === "ArrowUp") next -= 1;
      else if (event.key === "ArrowDown") next += 1;
      else if (event.key === "Home") next = MIN_VIEWER_HEIGHT_PERCENT;
      else if (event.key === "End") next = MAX_VIEWER_HEIGHT_PERCENT;
      else return;
      event.preventDefault();
      setAndStoreViewerHeight(next);
    },
    [setAndStoreViewerHeight, viewerHeight],
  );

  const resizeWidthFromPointer = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (widthResizePointer.current !== event.pointerId) return;
      event.preventDefault();
      onWidthPercentChange(((window.innerWidth - event.clientX) / window.innerWidth) * 100);
    },
    [onWidthPercentChange],
  );

  const finishWidthResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (widthResizePointer.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    widthResizePointer.current = null;
    setResizingWidth(false);
  }, []);

  const resizeWidthWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      let next = widthPercent;
      if (event.key === "ArrowLeft") next += 1;
      else if (event.key === "ArrowRight") next -= 1;
      else if (event.key === "Home") next = minWidthPercent;
      else if (event.key === "End") next = maxWidthPercent;
      else return;
      event.preventDefault();
      onWidthPercentChange(next);
    },
    [maxWidthPercent, minWidthPercent, onWidthPercentChange, widthPercent],
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

    // LOD1 is a per-building municipal measurement, so where it has a
    // confident opinion it keeps the row. The laser fills in the rest: roof
    // shapes, which LOD1 does not model at all, every building:part, which it
    // does not cover, and anywhere its block spans more than this building.
    // Asked against empty tags it reports every key it has a value for, not
    // just the ones OSM already disagrees with — which is what precedence
    // needs, or the laser would argue with a tag LOD1 quietly agrees with.
    const lod1Keys = new Set(
      match
        ? suggestionsFor(edited.selected, match, {})
            .filter((suggestion) => suggestion.confident)
            .map((suggestion) => suggestion.key)
        : [],
    );
    for (const advice of laserAdvice) {
      if (!lod1Keys.has(advice.key)) byKey.set(advice.key, advice);
    }
    const advised: Suggestion[] = [...byKey.values()];

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
      ...advised.filter((s) => !(s.key in tags)).map((s) => s.key),
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

    // The dimensions being edited all day live above the alphabet.
    const pinned = ["height", "min_height", "roof:height", "roof:shape", "building:levels"];
    const rank = (row: TagRow) => {
      const index = pinned.indexOf(row.key);
      return index === -1 ? pinned.length : index;
    };
    return [...extra, ...known].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  }, [edited, effectiveTags, match, edit, osmTags, laserAdvice]);

  if (!selection || !edited) return null;

  const props = edited.selected.properties;
  const selectedIsPart = props.role === "part";
  const parentId = edited.selected.id !== edited.building.id ? edited.building.id : null;

  return (
    <aside
      className={`absolute inset-y-0 right-0 z-20 flex min-w-0 flex-col bg-white shadow-2xl ${resizingWidth ? "cursor-col-resize select-none" : ""}`}
      style={{ width: `${widthPercent}%` }}
    >
      <div className="absolute inset-y-0 left-0 z-30 w-px">
        <button
          type="button"
          aria-label="Resize map and sidebar"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            widthResizePointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizingWidth(true);
          }}
          onPointerMove={resizeWidthFromPointer}
          onPointerUp={finishWidthResize}
          onPointerCancel={finishWidthResize}
          onKeyDown={resizeWidthWithKeyboard}
          className="peer absolute -inset-x-1.5 inset-y-0 m-0 w-4 cursor-col-resize touch-none border-0 bg-transparent outline-none"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-px bg-slate-200 peer-hover:bg-violet-400 peer-focus-visible:bg-violet-500"
        />
      </div>
      <div
        ref={splitRef}
        className={`flex min-h-0 flex-1 flex-col ${resizing ? "cursor-row-resize select-none" : ""}`}
      >
        <div
          className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          style={{ height: `${viewerHeight}%` }}
        >
          <div className="relative min-h-0 flex-1">
            <Building3D
              selection={edited}
              initialHeading={initialHeading}
              onCameraChange={setCamera}
              onCloudStatus={setCloudStatus}
              onCloudChange={handleCloud}
              onCloudDifferences={onLidarDifferences}
              wantDifferences={wantLidarDifferences}
              onTerrainStatus={setTerrainStatus}
            />
          </div>

          <Photoreal3D
            center={boundsCenter(elementBounds(edited.selected))}
            camera={camera}
            radius={boundsRadiusMeters(elementBounds(edited.selected))}
          />
        </div>

        <div className="relative z-10 h-px shrink-0">
          <button
            type="button"
            aria-label="Resize 3D view and properties"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              resizePointer.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={resizeFromPointer}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onKeyDown={resizeWithKeyboard}
            className="peer absolute inset-x-0 -inset-y-1.5 m-0 h-4 cursor-row-resize touch-none border-0 bg-transparent outline-none"
          />
          <hr className="pointer-events-none absolute inset-x-0 top-0 m-0 h-px border-0 bg-slate-200 peer-hover:bg-violet-400 peer-focus-visible:bg-violet-500" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <dl className="border-b border-slate-100 text-xs">
            <div className="flex items-start">
              <dt className="w-2/5 px-4 py-1.5 font-medium text-slate-500">feature</dt>
              <dd className="w-3/5 px-4 py-1.5 font-mono break-words text-slate-900">
                {selectedId}
              </dd>
            </div>
          </dl>
          {(LOD1_ENABLED || laserStatus || selectedTerrainStatus) && (
            <p className="border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-500">
              {LOD1_ENABLED &&
                (selectedIsPart ? (
                  "LOD1 covers building outlines only — this part is measured from the laser"
                ) : match ? (
                  <>
                    LOD1 covers {Math.round(match.coverage * 100)}% of this footprint
                    {match.properties.category ? ` · ${match.properties.category}` : ""}
                    {!match.confident && (
                      <span className="text-amber-700">
                        {" "}
                        · block is {(1 / Math.max(match.blockShare, 0.01)).toFixed(1)}× larger, so
                        its heights cover several buildings — advice is unreliable
                      </span>
                    )}
                  </>
                ) : (
                  "No LOD1 building matches this footprint"
                ))}
              {laserStatus && (
                <span className="text-slate-400">
                  {LOD1_ENABLED ? " · " : ""}
                  {laserStatus}
                </span>
              )}
              {selectedTerrainStatus && (
                <span className="text-slate-400">
                  {LOD1_ENABLED || laserStatus ? " · terrain: " : "terrain: "}
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
          )}

          <TagRows
            rows={rows}
            onApply={(suggestion) =>
              onEditTag(selectedId, suggestion.key, suggestion.value, osmTags[suggestion.key])
            }
            onEdit={(key, value) => onEditTag(selectedId, key, value, osmTags[key])}
            onRevert={(key) => edits.revertTag(selectedId, key)}
            roofDirectionForLook={roofDirectionForLook}
            laser={laserReading}
            onApplyLaserRoof={laserAdvice.length > 0 ? applyLaserRoof : undefined}
            parentId={parentId}
            onSelectParent={parentId ? () => onSelectEntity(parentId) : undefined}
          />
          <ExternalMapLinks
            center={boundsCenter(elementBounds(edited.selected))}
            camera={camera}
            entityId={selectedId}
          />
        </div>
      </div>
    </aside>
  );
}
