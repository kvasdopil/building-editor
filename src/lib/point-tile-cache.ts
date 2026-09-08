import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CachedTile, isFresh, isUsableStale, singleFlight, touchLru } from "./osm/cache";

/** Shared byte cache for on-demand point-cloud producers under `.cache/<source>`. */

type CachedBlob = CachedTile<Uint8Array>;

const MEMORY_LIMIT = 96;

interface CacheState {
  memory: Map<string, CachedBlob>;
}

const globalScope = globalThis as typeof globalThis & { __pointTileCache?: CacheState };

function cache(): CacheState {
  globalScope.__pointTileCache ??= { memory: new Map() };
  return globalScope.__pointTileCache;
}

function diskPath(namespace: string, key: string[]): string {
  return path.join(process.cwd(), ".cache", namespace, ...key.slice(0, -1), `${key.at(-1)}.bin`);
}

function memoryKey(namespace: string, key: string[]): string {
  return `${namespace}/${key.join("/")}`;
}

function remember(key: string, entry: CachedBlob): void {
  touchLru(cache().memory, key, entry, MEMORY_LIMIT);
}

async function read(namespace: string, key: string[]): Promise<CachedBlob | null> {
  const hotKey = memoryKey(namespace, key);
  const hot = cache().memory.get(hotKey);
  if (hot) {
    remember(hotKey, hot);
    return hot;
  }
  const file = diskPath(namespace, key);
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
    const entry: CachedBlob = { fetchedAt: info.mtimeMs, data: new Uint8Array(bytes) };
    remember(hotKey, entry);
    return entry;
  } catch {
    return null;
  }
}

async function write(namespace: string, key: string[], data: Uint8Array): Promise<CachedBlob> {
  const file = diskPath(namespace, key);
  const entry: CachedBlob = { fetchedAt: Date.now(), data };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, file);
  } catch {
    // A cache that cannot write is still a working cache.
  }
  remember(memoryKey(namespace, key), entry);
  return entry;
}

/** Cached bytes for one source tile, with stale-on-upstream-error behavior. */
export async function cachedPointTile(
  namespace: string,
  key: string[],
  load: () => Promise<Uint8Array>,
): Promise<{ data: Uint8Array; cached: boolean }> {
  const existing = await read(namespace, key);
  if (existing && isFresh(existing)) return { data: existing.data, cached: true };

  return singleFlight([namespace, ...key], async () => {
    try {
      const produced = await load();
      const entry = await write(namespace, key, produced);
      return { data: entry.data, cached: false };
    } catch (error) {
      if (existing && isUsableStale(existing)) return { data: existing.data, cached: true };
      throw error;
    }
  });
}
