/** Server-side gate for IGN's public WFS and COPC download services. */

const MAX_CONCURRENT = 4;
const MAX_ATTEMPTS = 3;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

interface Gate {
  active: number;
  waiting: (() => void)[];
}

const globalScope = globalThis as typeof globalThis & { __ignLidarGate?: Gate };

function gate(): Gate {
  globalScope.__ignLidarGate ??= { active: 0, waiting: [] };
  return globalScope.__ignLidarGate;
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

export class IgnLidarUnavailableError extends Error {}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function request(
  url: string,
  headers: HeadersInit,
): Promise<{ bytes: Uint8Array; status: number }> {
  const release = await acquire();
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { headers });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw new IgnLidarUnavailableError(String(error));
        await sleep(attempt * 500);
        continue;
      }
      if (response.ok) {
        return { bytes: new Uint8Array(await response.arrayBuffer()), status: response.status };
      }
      if (!RETRY_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new IgnLidarUnavailableError(`${response.status} for ${url}`);
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 500,
      );
    }
    throw new IgnLidarUnavailableError(`exhausted attempts for ${url}`);
  } finally {
    release();
  }
}

/** Read `[begin, end)` of a public COPC asset. */
export async function fetchIgnRange(url: string, begin: number, end: number): Promise<Uint8Array> {
  const { bytes, status } = await request(url, { Range: `bytes=${begin}-${end - 1}` });
  if (status !== 206 && (begin !== 0 || bytes.byteLength !== end)) {
    throw new IgnLidarUnavailableError(`range request was not honoured for ${url}`);
  }
  return bytes;
}

/** Fetch a small public JSON document, such as the WFS tile-index response. */
export async function fetchIgnJson<T>(url: string): Promise<T> {
  const { bytes } = await request(url, { accept: "application/json" });
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
