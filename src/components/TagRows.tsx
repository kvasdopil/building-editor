"use client";

import { FiAlertCircle, FiPlusCircle, FiXCircle } from "react-icons/fi";
import type { Suggestion } from "@/lib/lod1";

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

export function TagRows({
  rows,
  onApply,
  onRevert,
}: {
  rows: TagRow[];
  onApply: (suggestion: Suggestion) => void;
  onRevert: (key: string) => void;
}) {
  return (
    <table className="w-full table-fixed text-xs">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-slate-100 align-top last:border-0">
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
                      row.edited ? `Edited — OSM has ${row.originalValue ?? "no value"}` : undefined
                    }
                  >
                    {row.value}
                  </span>
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
        ))}
      </tbody>
    </table>
  );
}
