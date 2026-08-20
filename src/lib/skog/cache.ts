import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CachedTile, isFresh, isUsableStale, singleFlight, touchLru } from "../osm/cache";

/**
 * Disk and memory cache for the Skog reads, under `.cache/skog`.
 *
 * The OSM cache next door stores parsed JSON tiles; this one stores bytes,
 * because what is expensive here is an assembled point tile — a couple of
 * megabytes of upstream range reads and a LAZ decode per z16 tile. It borrows
 * that module's freshness rules and single-flight so one tile is never
 * assembled twice at once.
 */

const CACHE_DIR = path.join(process.cwd(), ".cache", "skog");

/** Bytes plus the time they were produced, so the TTL rules apply unchanged. */
type CachedBlob = CachedTile<Uint8Array>;

const MEMORY_LIMIT = 64;

interface CacheState {
  memory: Map<string, CachedBlob>;
  stats: { memoryHits: number; diskHits: number; misses: number; writes: number };
}

const globalScope = globalThis as typeof globalThis & { __skogCache?: CacheState };

function cache(): CacheState {
  globalScope.__skogCache ??= {
    memory: new Map(),
    stats: { memoryHits: 0, diskHits: 0, misses: 0, writes: 0 },
  };
  return globalScope.__skogCache;
}

function diskPath(key: string[]): string {
  return path.join(CACHE_DIR, ...key.slice(0, -1), `${key[key.length - 1]}.bin`);
}

function remember(key: string, entry: CachedBlob): void {
  touchLru(cache().memory, key, entry, MEMORY_LIMIT);
}

async function read(key: string[]): Promise<CachedBlob | null> {
  const state = cache();
  const memoryKey = key.join("/");
  const hot = state.memory.get(memoryKey);
  if (hot) {
    state.stats.memoryHits++;
    remember(memoryKey, hot);
    return hot;
  }
  const file = diskPath(key);
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
    const entry: CachedBlob = { fetchedAt: info.mtimeMs, data: new Uint8Array(bytes) };
    state.stats.diskHits++;
    remember(memoryKey, entry);
    return entry;
  } catch {
    state.stats.misses++;
    return null;
  }
}

async function write(key: string[], data: Uint8Array): Promise<CachedBlob> {
  const state = cache();
  const file = diskPath(key);
  const entry: CachedBlob = { fetchedAt: Date.now(), data };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // Write beside the target and move it in, so a crash cannot leave a
    // half-written tile that would later decode as garbage.
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, file);
    state.stats.writes++;
  } catch {
    // A cache that cannot write is still a working cache.
  }
  remember(key.join("/"), entry);
  return entry;
}

/**
 * Cached bytes for `key`, produced by `load` on a miss. A stale entry is served
 * when `load` fails, which is what makes an upstream outage invisible.
 */
export async function cachedBlob(
  key: string[],
  load: () => Promise<Uint8Array>,
): Promise<{ data: Uint8Array; cached: boolean }> {
  const existing = await read(key);
  if (existing && isFresh(existing)) return { data: existing.data, cached: true };

  return singleFlight(key, async () => {
    try {
      const produced = await load();
      const entry = await write(key, produced);
      return { data: entry.data, cached: false };
    } catch (error) {
      if (existing && isUsableStale(existing)) return { data: existing.data, cached: true };
      throw error;
    }
  });
}
