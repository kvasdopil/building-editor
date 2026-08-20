"use client";

import type { ReactNode } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { useEscapeKey } from "@/lib/use-escape-key";

/**
 * A modal for the two actions in this app that cannot be undone by pressing the
 * button again: discarding every pending change, and writing a changeset to a map
 * other people read. Both deserve the same pause, so they share one.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  tone,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** `danger` for losing local work, `caution` for publishing it. */
  tone: "danger" | "caution";
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  useEscapeKey(open, onCancel);
  if (!open) return null;

  const palette =
    tone === "danger"
      ? { badge: "bg-rose-100 text-rose-700", action: "bg-rose-700 hover:bg-rose-800" }
      : { badge: "bg-amber-100 text-amber-700", action: "bg-amber-600 hover:bg-amber-700" };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={`Cancel: ${title}`}
        onClick={onCancel}
        className="absolute inset-0 bg-slate-950/55"
      />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        className="relative m-0 w-full max-w-md rounded-xl border border-slate-200 bg-white p-0 shadow-2xl"
      >
        <div className="flex gap-3 p-5">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${palette.badge}`}
          >
            <FiAlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 id="confirm-title" className="text-lg font-semibold text-slate-900">
              {title}
            </h3>
            <div id="confirm-description" className="mt-1 space-y-2 text-sm text-slate-600">
              {children}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white ${palette.action}`}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </div>
  );
}
