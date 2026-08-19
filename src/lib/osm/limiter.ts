/**
 * Server-side gate in front of every upstream OSM request. Nothing else in the
 * app is allowed to call an upstream host, so this is the single place that
 * enforces spacing, queue depth, backoff and the circuit breaker required by
 * ADR 0002. Getting the project's IP banned stops all work, so the limits are
 * deliberately conservative.
 */

/** Minimum gap between two upstream requests. */
const MIN_SPACING_MS = 1100;

/** Requests waiting beyond this are rejected rather than queued forever. */
const MAX_QUEUE = 32;

/** Consecutive failures before the breaker opens. */
const FAILURE_THRESHOLD = 3;

const BREAKER_COOLDOWN_MS = 60_000;

const USER_AGENT =
  process.env.OSM_USER_AGENT ??
  "building-editor/0.1 (+https://github.com/kvasdopil/nextjs; dev build)";

interface LimiterStats {
  upstreamRequests: number;
  upstreamFailures: number;
  rejectedQueueFull: number;
  breakerTrips: number;
  queueDepth: number;
  consecutiveFailures: number;
  breakerOpenUntil: number | null;
  lastError: string | null;
  lastRequestAt: number | null;
}

interface Limiter {
  stats: LimiterStats;
  queue: number;
  chain: Promise<unknown>;
  lastStart: number;
}

/** Survives Next's dev-time module reloading, so limits are actually global. */
const globalScope = globalThis as typeof globalThis & { __osmLimiter?: Limiter };

function limiter(): Limiter {
  globalScope.__osmLimiter ??= {
    stats: {
      upstreamRequests: 0,
      upstreamFailures: 0,
      rejectedQueueFull: 0,
      breakerTrips: 0,
      queueDepth: 0,
      consecutiveFailures: 0,
      breakerOpenUntil: null,
      lastError: null,
      lastRequestAt: null,
    },
    queue: 0,
    chain: Promise.resolve(),
    lastStart: 0,
  };
  return globalScope.__osmLimiter;
}

export function limiterStats(): LimiterStats {
  const state = limiter();
  return { ...state.stats, queueDepth: state.queue };
}

export class UpstreamUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "breaker-open" | "queue-full" | "request-failed",
  ) {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(response: Response, attempt: number): number {
  const header = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(header) && header > 0) return Math.min(header, 60) * 1000;
  return Math.min(2 ** attempt * 1500, 30_000);
}

/**
 * Fetch `url` upstream: one request in flight at a time, spaced by
 * MIN_SPACING_MS, retrying 429/5xx with backoff that honors `Retry-After`.
 */
export async function fetchUpstream(url: string, attempts = 3): Promise<string> {
  const state = limiter();

  if (state.stats.breakerOpenUntil && Date.now() < state.stats.breakerOpenUntil) {
    throw new UpstreamUnavailableError("Upstream circuit breaker is open", "breaker-open");
  }
  if (state.queue >= MAX_QUEUE) {
    state.stats.rejectedQueueFull++;
    throw new UpstreamUnavailableError("Too many queued upstream requests", "queue-full");
  }

  state.queue++;
  const run = state.chain.then(async () => {
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const wait = state.lastStart + MIN_SPACING_MS - Date.now();
        if (wait > 0) await sleep(wait);
        state.lastStart = Date.now();
        state.stats.upstreamRequests++;
        state.stats.lastRequestAt = state.lastStart;

        const response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (response.ok) {
          state.stats.consecutiveFailures = 0;
          state.stats.breakerOpenUntil = null;
          return await response.text();
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === attempts - 1) {
          throw new Error(`upstream responded ${response.status}`);
        }
        await sleep(retryDelay(response, attempt));
      }
      throw new Error("upstream retries exhausted");
    } catch (error) {
      state.stats.upstreamFailures++;
      state.stats.consecutiveFailures++;
      state.stats.lastError = error instanceof Error ? error.message : String(error);
      if (state.stats.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.stats.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
        state.stats.breakerTrips++;
      }
      throw new UpstreamUnavailableError(state.stats.lastError, "request-failed");
    } finally {
      state.queue--;
    }
  });

  // Keep the chain alive regardless of this request's outcome.
  state.chain = run.catch(() => undefined);
  return run;
}
