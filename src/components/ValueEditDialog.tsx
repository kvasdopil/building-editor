"use client";

import { useEscapeKey } from "@/lib/use-escape-key";

/**
 * The modal for typing one tag value. Shared by the inspector and the pending
 * changes panel so editing a property feels the same wherever it is reached from:
 * same title, same key subtitle, Enter applies, Escape cancels, and Apply stays
 * disabled while the value is invalid or unchanged.
 *
 * Validation belongs to the caller. The inspector's dimension rows are numeric and
 * check each other; an arbitrary tag is just text.
 */
export function ValueEditDialog({
  title,
  subtitle,
  value,
  onChange,
  error,
  unchanged,
  numeric,
  onCancel,
  onApply,
}: {
  title: string;
  /** The raw tag key, shown under the title. */
  subtitle: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  /** True when the value still equals what it was, so there is nothing to apply. */
  unchanged: boolean;
  numeric?: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  useEscapeKey(true, onCancel);
  const blocked = Boolean(error) || unchanged;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancel editing value"
        onClick={onCancel}
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
            if (!blocked) onApply();
          }}
        >
          <div className="p-5">
            <h3 id="edit-tag-title" className="text-lg font-semibold text-slate-900">
              {title}
            </h3>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{subtitle}</p>
            <input
              autoFocus
              type="text"
              inputMode={numeric ? "decimal" : "text"}
              value={value}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (!blocked) onApply();
              }}
              aria-invalid={Boolean(error)}
              className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
            />
            {error && <p className="mt-1.5 text-xs text-rose-700">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={blocked}
              className="rounded-lg bg-violet-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              Apply
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
