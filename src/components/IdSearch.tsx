"use client";

import { useState } from "react";
import { FiSearch } from "react-icons/fi";

/**
 * Find an OSM element by id. Accepts what people actually have to hand: a
 * "#way/123" reference, a bare "way/123", "w123", or a pasted openstreetmap.org
 * URL.
 */
function parseOsmRef(input: string): { type: "way" | "relation"; id: string } | null {
  const text = input.trim().toLowerCase();
  // Longest alternatives first, and allow the "#" people actually type.
  const match = text.match(/(?:^|[#/])(way|relation|w|r)[/ ]?(\d+)\s*$/);
  if (!match) return null;
  return { type: match[1].startsWith("r") ? "relation" : "way", id: match[2] };
}

export function IdSearch({
  onSearch,
  status,
}: {
  onSearch: (ref: { type: "way" | "relation"; id: string }) => void;
  status: string | null;
}) {
  const [value, setValue] = useState("");
  const parsed = parseOsmRef(value);
  const invalid = value.trim().length > 0 && !parsed;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed) onSearch(parsed);
      }}
      className="absolute top-3 left-1/2 z-30 -translate-x-1/2"
    >
      <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-md">
        <FiSearch className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="#way/1794585"
          aria-label="Find an OSM element by id"
          spellCheck={false}
          className={`w-40 bg-transparent text-sm outline-none placeholder:text-slate-400 ${
            invalid ? "text-rose-600" : "text-slate-900"
          }`}
        />
        <button
          type="submit"
          disabled={!parsed}
          className="rounded-md bg-slate-900 px-2 py-0.5 text-xs font-medium text-white disabled:bg-slate-200 disabled:text-slate-400"
        >
          Go
        </button>
      </div>
      {status && (
        <p className="mt-1 rounded-md bg-slate-900/75 px-2 py-1 text-center text-xs text-white">
          {status}
        </p>
      )}
    </form>
  );
}
