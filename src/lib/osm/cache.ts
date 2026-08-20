import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Two-layer server cache for parsed tiles: an in-memory LRU in front of a disk
 * store that survives restarts. Empty tiles are cached like any other, so blank
 * areas are not re-queried forever. See ADR 0002.
 */

/** How long a tile is served without revalidating. */
export const TILE_TTL_MS = 6 * 60 * 60 * 1000;

/** Beyond the TTL a tile is still served while a refresh is attempted. */
const TILE_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const MEMORY_LIMIT = 256;

const CACHE_DIR = path.join(process.cwd(), ".cache", "osm");

export interface CachedTile<T> {
  fetchedAt: number;
  data: T;
}

interface CacheStats {
  memoryHits: number;
  diskHits: number;
  misses: number;
  writes: number;
  coalesced: number;
  memoryEntries: number;
}

interface CacheState {
  memory: Map<string, CachedTile<unknown>>;
  inFlight: Map<string, Promise<unknown>>;
  stats: CacheStats;
}

const globalScope = globalThis as typeof globalThis & { __osmCache?: CacheState };

function cache(): CacheState {
  globalScope.__osmCache ??= {
    memory: new Map(),
    inFlight: new Map(),
    stats: { memoryHits: 0, diskHits: 0, misses: 0, writes: 0, coalesced: 0, memoryEntries: 0 },
  };
  return globalScope.__osmCache;
}

export function cacheStats(): CacheStats {
  const state = cache();
  return { ...state.stats, memoryEntries: state.memory.size };
}

/** Cache key: path segments, e.g. ["16", "36062", "19281"] or ["way", "123"]. */
type CacheKey = string[];

function diskPath(key: CacheKey): string {
  return path.join(CACHE_DIR, ...key.slice(0, -1), `${key[key.length - 1]}.json`);
}

/**
 * Move `key` to the front of an LRU map and evict from the back. Exported
 * because the Skog cache next door keeps bytes rather than parsed tiles but
 * wants exactly this eviction rule.
 */
export function touchLru<T>(memory: Map<string, T>, key: string, entry: T, limit: number): void {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > limit) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function touchMemory<T>(key: string, entry: CachedTile<T>): void {
  touchLru(cache().memory, key, entry, MEMORY_LIMIT);
}

export async function readCachedTile<T>(cacheKey: CacheKey): Promise<CachedTile<T> | null> {
  const state = cache();
  const key = cacheKey.join("/");

  const hot = state.memory.get(key) as CachedTile<T> | undefined;
  if (hot) {
    state.stats.memoryHits++;
    touchMemory(key, hot);
    return hot;
  }
  try {
    const raw = await readFile(diskPath(cacheKey), "utf8");
    const entry = JSON.parse(raw) as CachedTile<T>;
    state.stats.diskHits++;
    touchMemory(key, entry);
    return entry;
  } catch {
    state.stats.misses++;
    return null;
  }
}

export async function writeCachedTile<T>(cacheKey: CacheKey, data: T): Promise<CachedTile<T>> {
  const state = cache();
  const entry: CachedTile<T> = { fetchedAt: Date.now(), data };
  touchMemory(cacheKey.join("/"), entry);

  const target = diskPath(cacheKey);
  await mkdir(path.dirname(target), { recursive: true });
  // Write then rename, so a crash mid-write cannot leave a torn cache file.
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(entry), "utf8");
  await rename(temporary, target);
  state.stats.writes++;
  return entry;
}

/**
 * Run `load` for this tile, collapsing concurrent callers onto one execution so
 * a burst of viewport requests makes a single upstream call.
 */
export async function singleFlight<T>(cacheKey: CacheKey, load: () => Promise<T>): Promise<T> {
  const state = cache();
  const key = cacheKey.join("/");
  const running = state.inFlight.get(key) as Promise<T> | undefined;
  if (running) {
    state.stats.coalesced++;
    return running;
  }
  const promise = load().finally(() => state.inFlight.delete(key));
  state.inFlight.set(key, promise);
  return promise;
}

export function isFresh(entry: CachedTile<unknown>): boolean {
  return Date.now() - entry.fetchedAt < TILE_TTL_MS;
}

export function isUsableStale(entry: CachedTile<unknown>): boolean {
  return Date.now() - entry.fetchedAt < TILE_MAX_STALE_MS;
}
