import { type ChangesetPlan, toChangesetXml, toOsmChangeXml } from "./changeset";
import { CLIENT_ID, isProductionHost, OAUTH_BASE } from "./oauth";
import { USER_AGENT } from "./limiter";

/**
 * Sending a changeset: create, upload, close. Server side, because the access
 * token lives in an httpOnly cookie and ADR 0002 keeps upstream calls here.
 *
 * The document is rendered here from the reviewed plan rather than posted as text
 * by the browser, so what the review dialog described and what OSM receives come
 * from the same function — the only difference being the changeset id, which does
 * not exist until the first call returns.
 */

/**
 * Writing to the real OSM takes a deliberate setting, not merely pointing
 * `OSM_OAUTH_BASE` at it. A misconfigured host must fail closed: an accidental
 * upload to the public map cannot be taken back, only reverted in a second
 * changeset that stays in the history.
 */
function productionWritesAllowed(): boolean {
  return process.env.OSM_ALLOW_PRODUCTION_WRITES === "true";
}

export function uploadRefusal(): string | null {
  if (!CLIENT_ID) return "OSM sign-in is not configured.";
  const host = new URL(OAUTH_BASE).host;
  if (isProductionHost(host) && !productionWritesAllowed()) {
    return `Uploading to ${host} is the public map. Set OSM_ALLOW_PRODUCTION_WRITES=true to allow it, or point OSM_OAUTH_BASE at the development API.`;
  }
  return null;
}

interface DiffEntry {
  type: "node" | "way" | "relation";
  /** The id we sent: negative for something created here. */
  oldId: number;
  /** The id OSM assigned, absent when the element was deleted. */
  newId?: number;
  newVersion?: number;
}

export interface UploadResult {
  changesetId: number;
  diff: DiffEntry[];
  host: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "conflict" | "auth" | "refused" | "upstream",
  ) {
    super(message);
  }
}

async function call(
  path: string,
  accessToken: string,
  init: { method: string; body?: string } = { method: "GET" },
): Promise<Response> {
  return fetch(`${OAUTH_BASE}${path}`, {
    method: init.method,
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { "Content-Type": "text/xml" }),
    },
    body: init.body,
    cache: "no-store",
  });
}

/**
 * `diffResult` maps every id we sent to the id OSM stored. Read with a regular
 * expression rather than an XML parser: the document has one flat element shape,
 * fixed by the API, and adding a parser for it would be the larger risk.
 */
function parseDiffResult(xml: string): DiffEntry[] {
  const pattern =
    /<(node|way|relation)\s+old_id="(-?\d+)"(?:\s+new_id="(-?\d+)")?(?:\s+new_version="(\d+)")?/g;
  const entries: DiffEntry[] = [];
  for (const match of xml.matchAll(pattern)) {
    entries.push({
      type: match[1] as DiffEntry["type"],
      oldId: Number(match[2]),
      newId: match[3] === undefined ? undefined : Number(match[3]),
      newVersion: match[4] === undefined ? undefined : Number(match[4]),
    });
  }
  return entries;
}

async function errorFor(response: Response, fallback: string): Promise<UploadError> {
  // OSM explains conflicts in the body, e.g. "Version mismatch: Provided 3,
  // server had: 4 of Way 123". Nothing we could write is more useful.
  const detail = (await response.text().catch(() => ""))?.trim();
  const kind =
    response.status === 409 || response.status === 412
      ? "conflict"
      : response.status === 401 || response.status === 403
        ? "auth"
        : "upstream";
  return new UploadError(detail || fallback, response.status, kind);
}

/**
 * Create a changeset, upload the plan into it, and close it.
 *
 * A changeset left open would hold for an hour and could collect somebody else's
 * next edit, so it is closed whether the upload succeeded or not.
 */
export async function uploadChangeset(input: {
  accessToken: string;
  plan: ChangesetPlan;
  tags: Record<string, string>;
}): Promise<UploadResult> {
  const refusal = uploadRefusal();
  if (refusal) throw new UploadError(refusal, 403, "refused");

  const created = await call("/api/0.6/changeset/create", input.accessToken, {
    method: "PUT",
    body: toChangesetXml(input.tags),
  });
  if (!created.ok) throw await errorFor(created, "OSM would not open a changeset");
  const changesetId = Number((await created.text()).trim());
  if (!Number.isInteger(changesetId)) {
    throw new UploadError("OSM did not return a changeset id", 502, "upstream");
  }

  try {
    const uploaded = await call(`/api/0.6/changeset/${changesetId}/upload`, input.accessToken, {
      method: "POST",
      body: toOsmChangeXml(input.plan, changesetId),
    });
    if (!uploaded.ok) throw await errorFor(uploaded, "OSM rejected the changeset");
    const diff = parseDiffResult(await uploaded.text());
    return { changesetId, diff, host: new URL(OAUTH_BASE).host };
  } finally {
    // Best effort: an open changeset expires on its own, but leaving one behind
    // would let a later edit land inside it.
    await call(`/api/0.6/changeset/${changesetId}/close`, input.accessToken, {
      method: "PUT",
    }).catch(() => undefined);
  }
}
