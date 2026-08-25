"use client";

import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { FiAlertCircle, FiEdit2, FiPlusCircle, FiXCircle } from "react-icons/fi";
import { TbArrowsHorizontal, TbCompass } from "react-icons/tb";
import type { Suggestion } from "@/lib/lod1";
import { parseMeters } from "@/lib/osm/parse";
import { ValueEditDialog } from "./ValueEditDialog";

export const EDITABLE_DIMENSION_KEYS = [
  "building:levels",
  "height",
  "building:min_level",
  "min_height",
  "roof:levels",
  "roof:height",
] as const;

export const OPTIONAL_ROOF_KEYS = ["roof:shape", "roof:orientation", "roof:direction"] as const;

const EDITABLE_LABELS: Record<(typeof EDITABLE_DIMENSION_KEYS)[number], string> = {
  "building:levels": "levels",
  height: "height",
  "building:min_level": "min_levels",
  min_height: "min_height",
  "roof:levels": "roof_levels",
  "roof:height": "roof_height",
};

function editableLabel(key: string): string | null {
  return EDITABLE_DIMENSION_KEYS.includes(key as (typeof EDITABLE_DIMENSION_KEYS)[number])
    ? EDITABLE_LABELS[key as (typeof EDITABLE_DIMENSION_KEYS)[number]]
    : null;
}

/**
 * The tag table: OSM tags, pending edits, and LOD1 advice in one list. A row
 * can be advised (apply the LOD1 value), edited (highlighted, revertable), or
 * plain.
 */

export interface TagRow {
  key: string;
  /** Value shown now, i.e. the edited value when there is one. */
  value: string;
  /** Set when this row differs from OSM because of a pending edit. */
  originalValue?: string;
  edited: boolean;
  suggestion?: Suggestion;
}

function SuggestionButton({
  suggestion,
  onApply,
}: {
  suggestion: Suggestion;
  onApply: () => void;
}) {
  const missing = suggestion.kind === "missing";
  const Icon = missing ? FiPlusCircle : FiAlertCircle;
  const tone = !suggestion.confident
    ? "border border-dashed border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
    : missing
      ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
      : "bg-amber-50 text-amber-800 hover:bg-amber-100";
  return (
    <button
      type="button"
      onClick={onApply}
      title={`${missing ? "Missing in OSM" : `OSM has ${suggestion.current}`} — apply LOD1 value ${suggestion.value} (${suggestion.note})`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium transition-colors ${tone}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {suggestion.value}
    </button>
  );
}

interface EditDraft {
  key: string;
  value: string;
  original: string;
}

function parseNumber(value: string): number | undefined {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

const HEIGHT_DRAG_STEP_M = 0.5;
const HEIGHT_DRAG_STEP_PX = 8;

function formatDraggedHeight(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function snapDraggedHeight(value: number): number {
  return Math.round(value / HEIGHT_DRAG_STEP_M) * HEIGHT_DRAG_STEP_M;
}

function HeightDragButton({
  tagKey,
  value,
  edited,
  minHeight,
  onChange,
  onReset,
}: {
  tagKey: "height" | "roof:height";
  value: string;
  edited: boolean;
  minHeight?: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
    startRaw: string;
    wasEdited: boolean;
    steps: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const applySteps = (steps: number) => {
    const current = drag.current;
    if (!current || steps === current.steps) return;
    current.steps = steps;
    if (steps === 0) {
      if (current.wasEdited) onChange(current.startRaw);
      else onReset();
      return;
    }
    const next = current.startValue + steps * HEIGHT_DRAG_STEP_M;
    if (next <= Math.max(0, parseMeters(minHeight) ?? 0)) return;
    onChange(formatDraggedHeight(next));
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: snapDraggedHeight(parseMeters(value) ?? 0),
      startRaw: value,
      wasEdited: edited,
      steps: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    applySteps(Math.trunc((event.clientX - current.startX) / HEIGHT_DRAG_STEP_PX));
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = snapDraggedHeight(parseMeters(value) ?? 0) + direction * HEIGHT_DRAG_STEP_M;
    if (next <= Math.max(0, parseMeters(minHeight) ?? 0)) return;
    onChange(formatDraggedHeight(next));
  };

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      aria-label={`Drag horizontally to change ${tagKey}`}
      title={`Drag left or right to change ${tagKey} by 0.5 m`}
      className={`shrink-0 touch-none rounded p-0.5 transition-colors select-none ${
        dragging
          ? "cursor-ew-resize bg-violet-100 text-violet-700"
          : "cursor-ew-resize text-slate-400 hover:bg-violet-50 hover:text-violet-700"
      }`}
    >
      <TbArrowsHorizontal className="h-4 w-4" aria-hidden />
    </button>
  );
}

function RoofShapeSelect({
  value,
  edited,
  onChange,
}: {
  value: string;
  edited: boolean;
  onChange: (value: string) => void;
}) {
  const standardValues = new Set([
    "",
    "pyramidal",
    "hipped",
    "gabled",
    "gambrel",
    "round",
    "skillion",
    "dome",
    "onion",
  ]);
  const currentIsCustom = value !== "" && !standardValues.has(value);
  return (
    <select
      aria-label="Roof type"
      title="Set roof:shape"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`max-w-full rounded border px-1.5 py-0.5 text-xs outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100 ${
        edited
          ? "border-amber-300 bg-amber-100 font-semibold text-amber-900"
          : "border-slate-300 bg-white text-slate-900"
      }`}
    >
      <option value="">none</option>
      <option value="pyramidal">pyramid</option>
      <option value="hipped">hipped</option>
      <option value="gabled">gabled</option>
      <option value="gambrel">gambrel</option>
      <option value="round">round</option>
      <option value="skillion">skillion</option>
      <option value="dome">dome</option>
      <option value="onion">onion</option>
      {currentIsCustom && <option value={value}>{value} (current value)</option>}
    </select>
  );
}

function RoofOrientationSelect({
  value,
  edited,
  onChange,
}: {
  value: string;
  edited: boolean;
  onChange: (value: string) => void;
}) {
  const standardValues = new Set(["", "along", "across"]);
  const currentIsCustom = value !== "" && !standardValues.has(value);
  return (
    <select
      aria-label="Roof orientation"
      title="Set roof:orientation"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`max-w-full rounded border px-1.5 py-0.5 text-xs outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100 ${
        edited
          ? "border-amber-300 bg-amber-100 font-semibold text-amber-900"
          : "border-slate-300 bg-white text-slate-900"
      }`}
    >
      <option value="">default (along)</option>
      <option value="along">along</option>
      <option value="across">across</option>
      {currentIsCustom && <option value={value}>{value} (current value)</option>}
    </select>
  );
}

const ROOF_DIRECTION_DRAG_DEAD_ZONE_PX = 6;

function RoofDirectionDragButton({
  resolveLook,
  onChange,
}: {
  resolveLook: (bearing: number) => string;
  onChange: (value: string) => void;
}) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastValue: string | null;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastValue: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const east = event.clientX - current.startX;
    const south = event.clientY - current.startY;
    if (Math.hypot(east, south) < ROOF_DIRECTION_DRAG_DEAD_ZONE_PX) return;
    event.preventDefault();
    const lookBearing = (Math.atan2(east, -south) * 180) / Math.PI;
    const value = resolveLook((lookBearing + 360) % 360);
    if (value === current.lastValue) return;
    current.lastValue = value;
    onChange(value);
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    setDragging(false);
  };

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      aria-label="Drag to change roof slope direction"
      title="Drag toward a footprint edge to set its perpendicular roof slope"
      className={`shrink-0 touch-none rounded p-0.5 transition-colors select-none ${
        dragging
          ? "cursor-crosshair bg-violet-100 text-violet-700"
          : "cursor-crosshair text-slate-400 hover:bg-violet-50 hover:text-violet-700"
      }`}
    >
      <TbCompass className="h-4 w-4" aria-hidden />
    </button>
  );
}

function roofDirectionLabel(value: string): string {
  if (value === "") return "automatic";
  return parseNumber(value) === undefined ? value : `${value}°`;
}

function editError(draft: EditDraft, rows: TagRow[]): string | null {
  const label = editableLabel(draft.key) ?? draft.key;
  if (draft.key === "roof:direction" && draft.value.trim() === "") return null;
  const value = parseNumber(draft.value);
  if (value === undefined) return `${label} must be a number`;
  if (draft.key === "roof:direction") {
    return value < 0 || value > 360 ? "roof:direction must be between 0 and 360 degrees" : null;
  }
  // A flat roof is `roof:levels=0`, and a part can start at ground level.
  const minimumCanBeZero = ["building:min_level", "min_height", "roof:levels"].includes(draft.key);
  if (minimumCanBeZero ? value < 0 : value <= 0)
    return `${label} must be ${minimumCanBeZero ? "at least" : "greater than"} 0`;

  const valueFor = (key: string) =>
    parseNumber(
      draft.key === key ? draft.value : (rows.find((row) => row.key === key)?.value ?? ""),
    );
  const levels = valueFor("building:levels");
  const minLevels = valueFor("building:min_level");
  if (levels !== undefined && minLevels !== undefined && levels <= minLevels)
    return "levels must be greater than min_levels";
  const height = valueFor("height");
  const minHeight = valueFor("min_height");
  if (height !== undefined && minHeight !== undefined && height <= minHeight)
    return "height must be greater than min_height";
  const roofHeight = valueFor("roof:height");
  if (roofHeight !== undefined && height !== undefined && roofHeight > height)
    return "roof_height must not be greater than height";
  return null;
}

export function TagRows({
  rows,
  onApply,
  onEdit,
  onRevert,
  roofDirectionForLook,
  parentId,
  onSelectParent,
}: {
  rows: TagRow[];
  onApply: (suggestion: Suggestion) => void;
  onEdit: (key: string, value: string) => void;
  onRevert: (key: string) => void;
  roofDirectionForLook: (bearing: number) => string;
  parentId?: string | null;
  onSelectParent?: () => void;
}) {
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const error = editing ? editError(editing, rows) : null;

  const saveEditing = () => {
    if (!editing || error || editing.value.trim() === editing.original.trim()) return;
    if (editing.key === "roof:direction" && editing.value.trim() === "") {
      onEdit(editing.key, "");
      setEditing(null);
      return;
    }
    const value = parseNumber(editing.value);
    if (value === undefined) return;
    onEdit(editing.key, String(editing.key === "roof:direction" && value === 360 ? 0 : value));
    setEditing(null);
  };

  return (
    <>
      <table className="w-full table-fixed text-xs">
        <tbody>
          {rows.map((row) => {
            const label = editableLabel(row.key);
            return (
              <tr key={row.key} className="group border-b border-slate-100 align-top last:border-0">
                <th
                  scope="row"
                  className="w-2/5 px-4 py-1.5 text-left font-medium break-words text-slate-500"
                >
                  <span className="flex items-center gap-1">
                    {(row.key === "height" || row.key === "roof:height") && (
                      <HeightDragButton
                        tagKey={row.key}
                        value={row.value}
                        edited={row.edited}
                        minHeight={
                          row.key === "height"
                            ? rows.find((candidate) => candidate.key === "min_height")?.value
                            : undefined
                        }
                        onChange={(value) => onEdit(row.key, value)}
                        onReset={() => onRevert(row.key)}
                      />
                    )}
                    <span>{row.key}</span>
                  </span>
                </th>
                <td className="px-4 py-1.5 break-words text-slate-900">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {row.key === "roof:shape" ? (
                      <RoofShapeSelect
                        value={row.value}
                        edited={row.edited}
                        onChange={(value) => {
                          if (value !== row.value) onEdit(row.key, value);
                        }}
                      />
                    ) : row.key === "roof:orientation" ? (
                      <RoofOrientationSelect
                        value={row.value}
                        edited={row.edited}
                        onChange={(value) => {
                          if (value !== row.value) onEdit(row.key, value);
                        }}
                      />
                    ) : row.key === "roof:direction" ? (
                      <>
                        <RoofDirectionDragButton
                          resolveLook={roofDirectionForLook}
                          onChange={(value) => {
                            if (value !== row.value) onEdit(row.key, value);
                          }}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({ key: row.key, value: row.value, original: row.value })
                          }
                          aria-label="Set roof slope direction in degrees"
                          title="Set roof:direction in degrees"
                          className={`max-w-full rounded border px-1.5 py-0.5 text-xs outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100 ${
                            row.edited
                              ? "border-amber-300 bg-amber-100 font-semibold text-amber-900"
                              : "border-slate-300 bg-white text-slate-900"
                          }`}
                        >
                          {roofDirectionLabel(row.value)}
                        </button>
                      </>
                    ) : row.value === "" ? (
                      <span className="text-slate-400 italic">not set</span>
                    ) : (
                      <span
                        className={
                          row.edited ? "rounded bg-amber-100 px-1 font-semibold text-amber-900" : ""
                        }
                        title={
                          row.edited
                            ? `Edited — OSM has ${row.originalValue ?? "no value"}`
                            : undefined
                        }
                      >
                        {row.value}
                      </span>
                    )}
                    {row.key === "building:part" && parentId && onSelectParent && (
                      <button
                        type="button"
                        onClick={onSelectParent}
                        title={`Select parent ${parentId}`}
                        className="font-medium text-violet-700 underline decoration-violet-300 underline-offset-2 hover:text-violet-900"
                      >
                        parent
                      </button>
                    )}
                    {label && (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({ key: row.key, value: row.value, original: row.value })
                        }
                        aria-label={`Edit ${label}`}
                        title={`Edit ${label}`}
                        className="text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-violet-700 focus:opacity-100"
                      >
                        <FiEdit2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                    {row.edited && (
                      <button
                        type="button"
                        onClick={() => onRevert(row.key)}
                        aria-label={`Revert ${row.key}`}
                        title={`Revert to ${row.originalValue ?? "no value"}`}
                        className="text-slate-400 transition-colors hover:text-rose-600"
                      >
                        <FiXCircle className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                    {row.suggestion && (
                      <SuggestionButton
                        suggestion={row.suggestion}
                        onApply={() => onApply(row.suggestion as Suggestion)}
                      />
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing && (
        <ValueEditDialog
          title={`Edit ${editableLabel(editing.key) ?? editing.key}`}
          subtitle={editing.key}
          value={editing.value}
          onChange={(value) => setEditing((current) => (current ? { ...current, value } : current))}
          error={error}
          unchanged={editing.value.trim() === editing.original.trim()}
          numeric
          onCancel={() => setEditing(null)}
          onApply={saveEditing}
        />
      )}
    </>
  );
}
