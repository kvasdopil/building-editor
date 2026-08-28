"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FiAlertTriangle,
  FiCheckCircle,
  FiCopy,
  FiDownload,
  FiLogIn,
  FiLogOut,
  FiMapPin,
  FiUser,
  FiX,
  FiXCircle,
} from "react-icons/fi";
import {
  type ChangesetEntry,
  type ChangesetInput,
  type ChangesetPlan,
  changesetSize,
  changesetTags,
  toChangesetXml,
} from "@/lib/osm/changeset";
import type { Issue, IssueFix } from "@/lib/osm/issues";
import { sortIssues } from "@/lib/osm/issues";
import { COMMENT_MIN_LENGTH, commentIssues, isUsableComment } from "@/lib/osm/validate";
import { buildSubmissionReview } from "@/lib/osm/submission-review";
import { OsmBuildingLookup } from "@/lib/osm/building-lookup";
import type { UploadResult } from "@/lib/osm/upload";
import { type OsmAuth, useOsmAuth } from "@/lib/osm/use-osm-auth";
import { ConfirmDialog } from "./ConfirmDialog";
import { useEscapeKey } from "@/lib/use-escape-key";
import type { FeatureCollection } from "geojson";

/**
 * Review step between the pending changes and an upload: what would be written,
 * what the checks say about it, and the exact `osmChange` document.
 *
 * Sign-in is live (EP-001 FT-05), so the account a changeset would be attributed
 * to is shown here. Sending it is not (FT-06) and is meant to run against the OSM
 * development API first, so the Upload action stays inert on purpose.
 */

/**
 * The two datasets this editor derives heights from — the national laser point
 * cloud (ADR 0005) and Stockholm LOD1 (ADR 0003) — so `source` starts out saying
 * where the numbers came from. It stays editable, and typing over it sticks.
 */
const DEFAULT_SOURCE = "Lantmateriet Laserdata, skog; Stockholm LOD1";

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type AddressTags = Record<string, string>;

/** Street-address lines for the parent buildings touched by modify entries. */
function modifiedBuildingAddresses(plan: ChangesetPlan, displayed: FeatureCollection): string[] {
  const lookup = new OsmBuildingLookup(displayed);
  const buildings = new Map(
    plan.entries
      .filter((entry) => entry.action === "modify")
      .flatMap((entry) => {
        const selection = lookup.select(entry.ref.split("#")[0]);
        return selection ? [[selection.building.id, selection.building] as const] : [];
      }),
  );
  const byStreet = new Map<string, Set<string>>();
  for (const building of buildings.values()) {
    const properties = building.properties;
    const ownTags = (properties.tags ?? {}) as AddressTags;
    const nodeTags = (properties.node_tags ?? {}) as Record<string, AddressTags>;
    const memberNodeTags = (
      Array.isArray(properties.member_ways) ? properties.member_ways : []
    ).flatMap((member) => {
      if (!member || typeof member !== "object") return [];
      const tagged = (member as { node_tags?: Record<string, AddressTags> }).node_tags;
      return tagged ? Object.values(tagged) : [];
    });
    for (const tags of [ownTags, ...Object.values(nodeTags), ...memberNodeTags]) {
      const street = tags["addr:street"]?.trim();
      if (!street) continue;
      const numbers = byStreet.get(street) ?? new Set<string>();
      const houseNumber = tags["addr:housenumber"]?.trim();
      if (houseNumber) numbers.add(houseNumber);
      byStreet.set(street, numbers);
    }
  }
  return [...byStreet]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([street, numbers]) => {
      const ordered = [...numbers].sort((first, second) =>
        first.localeCompare(second, undefined, { numeric: true }),
      );
      return ordered.length > 0 ? `${street} ${ordered.join(", ")}` : street;
    });
}

/** A default multiline comment that says where and what changed. */
function suggestComment(plan: ChangesetPlan, displayed: FeatureCollection): string {
  const created = plan.entries.filter((entry) => entry.action === "create").length;
  const modified = plan.entries.filter((entry) => entry.action === "modify").length;
  const keys = [
    ...new Set(
      plan.entries
        .filter((entry) => entry.action === "modify")
        .flatMap((entry) => entry.tagChanges.map((change) => change.key)),
    ),
  ].sort();
  const parts: string[] = [];
  if (created > 0) parts.push(`Add ${pluralize(created, "building part")}`);
  if (modified > 0) {
    const tags = keys.slice(0, 3).join(", ");
    parts.push(
      keys.length > 0
        ? `Update ${tags} on ${pluralize(modified, "building")}`
        : `Update ${pluralize(modified, "building")}`,
    );
  }
  if (parts.length === 0) return "";
  return [...modifiedBuildingAddresses(plan, displayed), ...parts].join("\n");
}

function IssueRow({
  found,
  onNavigate,
  onLocate,
  onFix,
}: {
  found: Issue;
  onNavigate: (entity: string) => void;
  onLocate: (at: [number, number], entity?: string) => void;
  onFix: (fix: IssueFix) => void;
}) {
  const error = found.level === "error";
  const fix = found.fix;
  return (
    <li
      className={`flex gap-2 rounded-md border px-2.5 py-2 text-xs ${
        error ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      {error ? (
        <FiXCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden />
      ) : (
        <FiAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
      )}
      <div className="min-w-0">
        <p className={error ? "text-rose-900" : "text-amber-900"}>{found.message}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5">
          <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-[10px] text-slate-600">
            {found.check}
          </code>
          {found.entities.map((entity) => (
            <button
              key={entity}
              type="button"
              onClick={() => onNavigate(entity)}
              className="rounded bg-white/70 px-1 py-0.5 font-mono text-[10px] text-violet-700 underline-offset-2 hover:underline"
            >
              {entity}
            </button>
          ))}
          {found.at && (
            <button
              type="button"
              onClick={() => onLocate(found.at!, found.entities[0])}
              className="flex items-center gap-1 rounded bg-white/70 px-1 py-0.5 text-[10px] font-semibold text-rose-700 underline-offset-2 hover:underline"
            >
              <FiMapPin className="h-3 w-3" aria-hidden />
              Show
            </button>
          )}
          {fix && (
            <button
              type="button"
              onClick={() => onFix(fix)}
              className="rounded bg-amber-700 px-2 py-0.5 font-semibold text-white hover:bg-amber-800"
            >
              Fix
            </button>
          )}
        </p>
      </div>
    </li>
  );
}

function EntryRow({
  entry,
  onNavigate,
}: {
  entry: ChangesetEntry;
  onNavigate: (entity: string) => void;
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            entry.action === "create"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-sky-100 text-sky-800"
          }`}
        >
          {entry.action}
        </span>
        <button
          type="button"
          onClick={() => onNavigate(entry.ref)}
          className="truncate font-mono text-xs font-semibold text-violet-700 underline-offset-2 hover:underline"
        >
          {entry.ref}
        </button>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
          {entry.version === undefined ? entry.target : `v${entry.version}`}
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        {entry.tagChanges.length > 0 && (
          <ul className="space-y-0.5">
            {entry.tagChanges.map((change) => (
              <li key={change.key} className="flex items-baseline gap-1.5 text-xs">
                <span className="font-medium text-slate-900">{change.key}</span>
                <span className="text-slate-500">
                  {change.from === undefined ? "not set" : change.from}
                </span>
                <span className="text-slate-400">→</span>
                <span className="font-semibold text-violet-700">
                  {change.to === undefined ? "removed" : change.to}
                </span>
              </li>
            ))}
          </ul>
        )}
        {entry.geometry && (
          <p className="text-xs text-slate-600">
            Geometry: {pluralize(entry.geometry.newNodes, "new node")}, {entry.geometry.reusedNodes}{" "}
            existing reused
            {entry.geometry.movedNodes > 0 && `, ${entry.geometry.movedNodes} moved`}
            {entry.geometry.sharedWith.length > 0 && (
              <>
                {" "}
                · shares nodes with{" "}
                <span className="font-mono text-[10px]">
                  {entry.geometry.sharedWith.join(", ")}
                </span>
              </>
            )}
          </p>
        )}
        {entry.notes.map((note) => (
          <p key={note} className="text-xs text-slate-500 italic">
            {note}
          </p>
        ))}
      </div>
    </li>
  );
}

/** Who the changeset would be attributed to, and how to change that. */
function Account({ auth }: { auth: OsmAuth }) {
  const shell = "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs";

  if (auth.status === "unconfigured") {
    const origin = globalThis.location?.origin ?? "";
    // OSM only exempts the loopback IP from its https rule, never the name
    // `localhost`, and the redirect URI has to match the origin actually in use.
    const onLocalhost = globalThis.location?.hostname === "localhost";
    return (
      <div className={`${shell} border-slate-200 bg-slate-50 text-slate-600`}>
        <FiUser className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        <span>
          Sign-in is not configured. Register an OAuth 2 application on {auth.host} with the
          redirect URI <code className="font-mono">{`${origin}/oauth/callback`}</code> and set{" "}
          <code className="font-mono">OSM_CLIENT_ID</code>.
          {onLocalhost && (
            <>
              {" "}
              OSM refuses an http redirect URI unless its host is{" "}
              <code className="font-mono">127.0.0.1</code>, so open this app at{" "}
              <code className="font-mono">{origin.replace("localhost", "127.0.0.1")}</code> and
              register that instead.
            </>
          )}
        </span>
      </div>
    );
  }

  if (auth.status === "signed-in" && auth.user) {
    return (
      <div className={`${shell} border-emerald-200 bg-emerald-50 text-emerald-900`}>
        <FiUser className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
        <span>
          Signed in as <strong className="font-semibold">{auth.user.name}</strong> on {auth.host}
        </span>
        <button
          type="button"
          onClick={auth.signOut}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-2 py-1 font-semibold text-emerald-800 hover:bg-emerald-100"
        >
          <FiLogOut className="h-3.5 w-3.5" aria-hidden />
          Log out
        </button>
      </div>
    );
  }

  const busy = auth.status === "loading" || auth.status === "signing-in";
  return (
    <div className={`${shell} border-slate-200 bg-slate-50 text-slate-600`}>
      <FiUser className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      <span>
        {auth.error ??
          `Not signed in. A changeset is attributed to an OSM account on ${auth.host}${
            auth.production ? ", the public map" : ""
          }.`}
      </span>
      <button
        type="button"
        onClick={auth.signIn}
        disabled={busy}
        className={`ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold ${
          busy
            ? "cursor-wait bg-slate-200 text-slate-500"
            : "bg-violet-700 text-white hover:bg-violet-800"
        }`}
      >
        <FiLogIn className="h-3.5 w-3.5" aria-hidden />
        {auth.status === "signing-in" ? "Waiting for OSM…" : "Log in with OpenStreetMap"}
      </button>
    </div>
  );
}

export function SubmitDialog({
  open,
  input,
  displayed,
  onClose,
  onNavigate,
  onLocate,
  onFix,
  onUploaded,
}: {
  open: boolean;
  input: ChangesetInput;
  /** Features with the edits applied, for the geometry and tagging checks. */
  displayed: FeatureCollection;
  onClose: () => void;
  onNavigate: (entity: string) => void;
  /** Closes review and marks the exact map location of a geometry finding. */
  onLocate: (at: [number, number], entity?: string) => void;
  /** Applies a deterministic validator suggestion to the pending edits. */
  onFix: (fix: IssueFix) => void;
  /** Called once a changeset has landed, so the pending changes can be dropped. */
  onUploaded: (result: UploadResult) => void;
}) {
  const auth = useOsmAuth();
  const [comment, setComment] = useState("");
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [showXml, setShowXml] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const review = useMemo(
    () => (open ? buildSubmissionReview({ input, displayed }) : null),
    [displayed, input, open],
  );
  const plan = review?.plan ?? null;
  const validation = review?.validation ?? null;
  const xml = review?.xml ?? "";
  const issues = useMemo(
    () => sortIssues([...commentIssues(comment), ...(validation?.issues ?? [])]),
    [comment, validation],
  );
  // Stable, so the memoised element rows below are not rebuilt on every keystroke.
  const navigate = useCallback((entity: string) => onNavigate(entity.split("#")[0]), [onNavigate]);
  const suggestion = useMemo(
    () => (plan ? suggestComment(plan, displayed) : ""),
    [displayed, plan],
  );
  const entryRows = useMemo(
    () =>
      plan?.entries.map((entry) => (
        <EntryRow key={entry.ref} entry={entry} onNavigate={navigate} />
      )) ?? null,
    [navigate, plan],
  );

  // A previous result must not survive into the next review: the dialog stays
  // mounted after it is closed, so without this it would keep offering "Done" for
  // a changeset that is long gone and never let a new one be uploaded.
  useEffect(() => {
    if (!open) return;
    setUploaded(null);
    setUploadError(null);
  }, [open]);

  // Offer the generated comment as the starting point, without overwriting a
  // comment the user has already typed.
  useEffect(() => {
    if (open && suggestion) setComment((current) => current || suggestion);
  }, [open, suggestion]);

  // While the confirmation is up it owns Escape; otherwise one keypress would
  // dismiss the confirmation and the whole review behind it.
  useEscapeKey(open && !confirming, onClose);

  if (!open || !plan || !validation) return null;

  const commentOk = isUsableComment(comment);
  const changesetXml = toChangesetXml(changesetTags({ comment, source }));
  const errors = issues.filter((found) => found.level === "error");
  const warnings = issues.filter((found) => found.level === "warning");
  const createdWays = plan.ways.filter((way) => way.action === "create").length;
  const modifiedWays = plan.ways.filter((way) => way.action === "modify").length;
  const createdRelations = plan.relations.filter((r) => r.action === "create").length;
  const modifiedRelations = plan.relations.filter((r) => r.action === "modify").length;

  /** Why the upload cannot be attempted, or null when it can. */
  const blocked =
    errors.length > 0
      ? `${pluralize(errors.length, "error")} must be fixed first.`
      : auth.status === "loading"
        ? "Checking your OpenStreetMap session…"
        : auth.status !== "signed-in"
          ? "Sign in to OpenStreetMap to upload."
          : null;
  const readyMessage = auth.production
    ? `Uploads to ${auth.host} are public and attributed to ${auth.user?.name ?? "this account"}.`
    : `Uploading to ${auth.host}.`;

  const copyXml = () => {
    void navigator.clipboard?.writeText(xml).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const upload = async () => {
    setConfirming(false);
    setUploading(true);
    setUploadError(null);
    try {
      const response = await fetch("/api/osm/changeset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, comment, source }),
      });
      const body = (await response.json()) as UploadResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Upload failed");
      setUploaded(body);
      // A comment describes exactly one changeset. Leave the successful result
      // visible, but make the next review regenerate its own description from
      // the new plan instead of carrying this text across submissions.
      setComment("");
      onUploaded(body);
    } catch (failure) {
      setUploadError(failure instanceof Error ? failure.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const downloadOsc = () => {
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "building-editor.osc";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close submit review"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/45"
      />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="submit-title"
        className="relative m-0 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-0 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3">
          <div>
            <h2 id="submit-title" className="text-lg font-semibold text-slate-900">
              {uploaded ? "Uploaded to OpenStreetMap" : "Submit to OpenStreetMap"}
            </h2>
            <p className="text-xs text-slate-500">
              {uploaded ? (
                <>
                  Changeset {uploaded.changesetId} on {uploaded.host}
                </>
              ) : (
                <>
                  {pluralize(changesetSize(plan), "element")} ·{" "}
                  {pluralize(plan.nodes.length - plan.movedNodes, "new node")} · {plan.reusedNodes}{" "}
                  existing nodes reused
                  {plan.movedNodes > 0 && ` · ${pluralize(plan.movedNodes, "node")} moved`}
                  {plan.mergedNodes > 0 && ` · ${plan.mergedNodes} vertices merged`}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close submit review"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <FiX className="h-5 w-5" aria-hidden />
          </button>
        </header>

        {uploaded ? (
          /* The changeset has landed and the pending changes are gone, so there is
             nothing left to review: re-running the checks over an empty plan would
             only report that there is nothing to upload. */
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              <FiCheckCircle className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
              <span>
                <strong className="font-semibold">Uploaded.</strong>{" "}
                {pluralize(uploaded.diff.filter((entry) => entry.oldId < 0).length, "element")}{" "}
                created,{" "}
                {pluralize(uploaded.diff.filter((entry) => entry.oldId > 0).length, "element")}{" "}
                updated.
              </span>
            </p>
            <p className="text-sm text-slate-700">
              <a
                href={`https://${uploaded.host}/changeset/${uploaded.changesetId}`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-violet-700 underline"
              >
                Open changeset {uploaded.changesetId} on {uploaded.host}
              </a>
            </p>
            {uploaded.diff.some((entry) => entry.oldId < 0) && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  Ids assigned
                </h3>
                <ul className="font-mono text-[11px] text-slate-600">
                  {uploaded.diff
                    .filter((entry) => entry.oldId < 0)
                    .map((entry) => (
                      <li key={`${entry.type}-${entry.oldId}`}>
                        {entry.type}/{entry.oldId} → {entry.type}/{entry.newId}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-slate-500">
              The pending changes have been cleared and the map is reloading that area, so it shows
              what OSM now holds.
            </p>
          </div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {uploadError && (
              <p className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-900">
                <FiXCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                <span>
                  <strong className="font-semibold">Nothing was uploaded.</strong> {uploadError}
                </span>
              </p>
            )}

            <Account auth={auth} />

            <section className="space-y-2">
              <label
                htmlFor="changeset-comment"
                className="block text-xs font-semibold tracking-wide text-slate-500 uppercase"
              >
                Changeset comment <span className="text-rose-600">*</span>
              </label>
              <textarea
                id="changeset-comment"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={4}
                required
                aria-required="true"
                aria-invalid={!commentOk}
                aria-describedby="changeset-comment-hint"
                placeholder="What changed, and where the data came from"
                className={`w-full resize-y rounded-lg border px-3 py-2 text-sm text-slate-900 focus:outline-none ${
                  commentOk
                    ? "border-slate-300 focus:border-violet-500"
                    : "border-rose-400 bg-rose-50 focus:border-rose-500"
                }`}
              />
              <p
                id="changeset-comment-hint"
                className={`text-xs ${commentOk ? "text-slate-500" : "font-medium text-rose-700"}`}
              >
                {commentOk
                  ? "Every changeset carries this; other mappers read it to understand the edit."
                  : `Required — at least ${COMMENT_MIN_LENGTH} characters saying what changed.`}
              </p>
              <label
                htmlFor="changeset-source"
                className="block text-xs font-semibold tracking-wide text-slate-500 uppercase"
              >
                Source (optional)
              </label>
              <input
                id="changeset-source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="e.g. Stockholm LOD1; Esri World Imagery"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
              />
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                Checks
              </h3>
              {issues.length === 0 ? (
                <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-900">
                  <FiCheckCircle className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                  Every check passed.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {[...errors, ...warnings].map((found, position) => (
                    <IssueRow
                      key={`${found.check}-${found.entities.join()}-${position}`}
                      found={found}
                      onNavigate={navigate}
                      onLocate={onLocate}
                      onFix={onFix}
                    />
                  ))}
                </ul>
              )}
              {plan.dropped.length > 0 && (
                <p className="text-xs text-slate-500">
                  {pluralize(plan.dropped.length, "pending change")} already match OSM and were left
                  out, so no version is bumped for nothing.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                Elements
              </h3>
              {plan.entries.some((entry) => entry.action === "create") && (
                <p className="text-xs text-slate-500">
                  A negative id is a placeholder for something drawn here — OSM assigns the real one
                  on upload, and this dialog reports the mapping afterwards.
                </p>
              )}
              <p className="text-xs text-slate-600">
                {[
                  `${pluralize(plan.nodes.length, "node")} created`,
                  `${pluralize(createdWays, "way")} created`,
                  `${pluralize(modifiedWays, "way")} modified`,
                  createdRelations > 0 && `${pluralize(createdRelations, "relation")} created`,
                  modifiedRelations > 0 && `${pluralize(modifiedRelations, "relation")} modified`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <ul className="space-y-2">{entryRows}</ul>
            </section>

            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  osmChange
                </h3>
                <button
                  type="button"
                  onClick={() => setShowXml((shown) => !shown)}
                  className="text-xs font-semibold text-violet-700 hover:underline"
                >
                  {showXml ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  onClick={copyXml}
                  className="ml-auto flex items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <FiCopy className="h-3.5 w-3.5" aria-hidden />
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={downloadOsc}
                  title="Save as an .osc file, which JOSM can open and validate"
                  className="flex items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <FiDownload className="h-3.5 w-3.5" aria-hidden />
                  .osc
                </button>
              </div>
              {showXml && (
                <div className="space-y-2">
                  <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                    {xml}
                  </pre>
                  <details className="text-xs text-slate-600">
                    <summary className="cursor-pointer font-semibold">Changeset metadata</summary>
                    <pre className="mt-1.5 overflow-auto rounded-lg bg-slate-100 p-3 font-mono text-[11px] text-slate-800">
                      {changesetXml}
                    </pre>
                  </details>
                </div>
              )}
            </section>
          </div>
        )}

        {uploaded ? (
          <footer className="flex items-center gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-xs text-slate-600">Nothing is pending any more.</p>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-lg bg-violet-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-800"
            >
              Done
            </button>
          </footer>
        ) : (
          <footer className="flex items-center gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-xs text-slate-600">{blocked ?? readyMessage}</p>
            <div className="ml-auto flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => (auth.production ? setConfirming(true) : void upload())}
                disabled={blocked !== null || uploading}
                title={blocked ?? undefined}
                className={`rounded-lg px-3.5 py-2 text-sm font-semibold ${
                  blocked !== null || uploading
                    ? "cursor-not-allowed bg-slate-200 text-slate-500"
                    : "bg-violet-700 text-white hover:bg-violet-800"
                }`}
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </footer>
        )}
      </dialog>

      <ConfirmDialog
        open={confirming}
        tone="caution"
        title="Upload to the public map?"
        confirmLabel={`Upload to ${auth.host}`}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void upload()}
      >
        <p>
          {pluralize(changesetSize(plan), "element")} will be written to {auth.host} as{" "}
          <strong className="font-semibold">{auth.user?.name}</strong>, visible to everyone and
          permanent in the history. A mistake can be reverted, but not erased.
        </p>
        <p className="rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700 italic">
          “{comment}”
        </p>
      </ConfirmDialog>
    </div>
  );
}
