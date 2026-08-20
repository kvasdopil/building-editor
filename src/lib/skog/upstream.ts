/**
 * Server-side gate in front of Lantmäteriet's height data host.
 *
 * The credential is a Geotorget account, so it must never reach the browser:
 * everything here runs on the server and the tile route is the only way in.
 * Unlike the OSM proxy (ADR 0002) this host is a bulk download service reached
 * by HTTP range request, so a few requests in parallel are expected and serial
 * spacing would make one building take ten seconds. The cap is on concurrency
 * instead, with backoff on the codes that mean "slow down".
 */

/** Requests in flight at once, across every tile being assembled. */
const MAX_CONCURRENT = 6;

/** Attempts per range, including the first. */
const MAX_ATTEMPTS = 3;

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

interface Gate {
  active: number;
  waiting: (() => void)[];
  stats: { requests: number; bytes: number; retries: number; failures: number };
}

/** Survives Next's dev-time module reloading, so the cap is actually global. */
const globalScope = globalThis as typeof globalThis & { __skogGate?: Gate };

function gate(): Gate {
  globalScope.__skogGate ??= {
    active: 0,
    waiting: [],
    stats: { requests: 0, bytes: 0, retries: 0, failures: 0 },
  };
  return globalScope.__skogGate;
}

async function acquire(): Promise<() => void> {
  const state = gate();
  if (state.active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.active++;
  return () => {
    state.active--;
    state.waiting.shift()?.();
  };
}

/**
 * The Basic credential, or null when the account is not configured. A missing
 * credential is a normal state — the app works without Skog data — so callers
 * degrade instead of throwing.
 */
export function skogCredential(): string | null {
  const login = process.env.GEOTORGET_LOGIN;
  const password = process.env.GEOTORGET_PASSWORD;
  if (!login || !password) return null;
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

export class SkogUnavailableError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read `[begin, end)` of an upstream asset. `end` is exclusive, matching the
 * getter contract copc.js expects.
 */
export async function fetchRange(url: string, begin: number, end: number): Promise<Uint8Array> {
  const credential = skogCredential();
  if (!credential) throw new SkogUnavailableError("GEOTORGET_LOGIN / GEOTORGET_PASSWORD not set");
  const state = gate();
  const release = await acquire();
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      state.stats.requests++;
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: credential, Range: `bytes=${begin}-${end - 1}` },
        });
      } catch (error) {
        state.stats.failures++;
        if (attempt === MAX_ATTEMPTS) throw new SkogUnavailableError(String(error));
        state.stats.retries++;
        await sleep(attempt * 500);
        continue;
      }
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        state.stats.bytes += bytes.byteLength;
        return bytes;
      }
      state.stats.failures++;
      // 401 means the credential is wrong and 403 that the account lacks the
      // product permission. Neither improves by asking again.
      if (!RETRY_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new SkogUnavailableError(`${response.status} for ${url}`);
      }
      state.stats.retries++;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 500,
      );
    }
    throw new SkogUnavailableError(`exhausted attempts for ${url}`);
  } finally {
    release();
  }
}

/** A whole small asset, for the STAC search responses. */
export async function fetchJson<T>(url: string): Promise<T> {
  const release = await acquire();
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new SkogUnavailableError(`${response.status} for ${url}`);
    return (await response.json()) as T;
  } finally {
    release();
  }
}
