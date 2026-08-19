"use client";

import { Building3D } from "./Building3D";
import { verticalExtent } from "@/lib/heights";
import type { BuildingSelection } from "@/lib/overture";

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

/** Every tag on the feature, alphabetically, empty values dropped. */
function tagRows(properties: Record<string, unknown>): [string, string][] {
  return Object.entries(properties)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]): [string, string] => [key, tagValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Side panel with the 3D view and the raw tags of the selected building. */
export function BuildingPanel({
  selection,
  onClose,
}: {
  selection: BuildingSelection | null;
  onClose: () => void;
}) {
  if (!selection) return null;

  const props = selection.building.properties;
  const tags = tagRows(props);
  const summary = [
    `≈${verticalExtent(props).top.toFixed(1)} m`,
    selection.parts.length > 0 ? `${selection.parts.length} parts` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-900 capitalize">
            {buildingTitle(selection)}
          </h2>
          <p className="truncate text-xs text-slate-500">{summary}</p>
        </div>
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
      </header>

      <div className="relative min-h-56 flex-1">
        <Building3D selection={selection} />
      </div>

      <div className="max-h-[45%] overflow-y-auto border-t border-slate-200">
        <table className="w-full table-fixed text-xs">
          <tbody>
            {tags.map(([key, value]) => (
              <tr key={key} className="border-b border-slate-100 align-top last:border-0">
                <th
                  scope="row"
                  className="w-2/5 px-4 py-1.5 text-left font-medium break-words text-slate-500"
                >
                  {key}
                </th>
                <td className="px-4 py-1.5 break-words text-slate-900">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
