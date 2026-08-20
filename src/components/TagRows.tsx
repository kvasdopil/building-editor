"use client";

import { useEffect, useState } from "react";
import { FiAlertCircle, FiEdit2, FiPlusCircle, FiXCircle } from "react-icons/fi";
import type { Suggestion } from "@/lib/lod1";

export const EDITABLE_DIMENSION_KEYS = [
  "building:levels",
  "height",
  "building:min_level",
  "min_height",
] as const;

const EDITABLE_LABELS: Record<(typeof EDITABLE_DIMENSION_KEYS)[number], string> = {
  "building:levels": "levels",
  height: "height",
  "building:min_level": "min_levels",
  min_height: "min_height",
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

function editError(draft: EditDraft, rows: TagRow[]): string | null {
  const label = editableLabel(draft.key) ?? draft.key;
  const value = parseNumber(draft.value);
  if (value === undefined) return `${label} must be a number`;
  const minimumCanBeZero = draft.key === "building:min_level" || draft.key === "min_height";
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
  return null;
}

export function TagRows({
  rows,
  onApply,
  onEdit,
  onRevert,
  parentId,
  onSelectParent,
}: {
  rows: TagRow[];
  onApply: (suggestion: Suggestion) => void;
  onEdit: (key: string, value: string) => void;
  onRevert: (key: string) => void;
  parentId?: string | null;
  onSelectParent?: () => void;
}) {
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const error = editing ? editError(editing, rows) : null;

  const saveEditing = () => {
    if (!editing || error || editing.value.trim() === editing.original.trim()) return;
    const value = parseNumber(editing.value);
    if (value === undefined) return;
    onEdit(editing.key, String(value));
    setEditing(null);
  };

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setEditing(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

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
                  {row.key}
                </th>
                <td className="px-4 py-1.5 break-words text-slate-900">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {row.value === "" ? (
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cancel editing value"
            onClick={() => setEditing(null)}
            className="absolute inset-0 bg-slate-950/45"
          />
          <dialog
            open
            aria-modal="true"
            aria-labelledby="edit-tag-title"
            className="relative m-0 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-0 shadow-2xl"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveEditing();
              }}
            >
              <div className="p-5">
                <h3 id="edit-tag-title" className="text-lg font-semibold text-slate-900">
                  Edit {editableLabel(editing.key)}
                </h3>
                <p className="mt-0.5 font-mono text-xs text-slate-500">{editing.key}</p>
                <input
                  autoFocus
                  type="text"
                  inputMode="decimal"
                  value={editing.value}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) =>
                    setEditing((current) =>
                      current ? { ...current, value: event.target.value } : current,
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    saveEditing();
                  }}
                  aria-invalid={Boolean(error)}
                  className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
                />
                {error && <p className="mt-1.5 text-xs text-rose-700">{error}</p>}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={Boolean(error) || editing.value.trim() === editing.original.trim()}
                  className="rounded-lg bg-violet-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                >
                  Apply
                </button>
              </div>
            </form>
          </dialog>
        </div>
      )}
    </>
  );
}
