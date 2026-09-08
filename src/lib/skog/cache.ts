import { cachedPointTile } from "../point-tile-cache";

/**
 * Disk and memory cache for the Skog reads, under `.cache/skog`.
 *
 * The OSM cache next door stores parsed JSON tiles; this one stores bytes,
 * because what is expensive here is an assembled point tile — a couple of
 * megabytes of upstream range reads and a LAZ decode per z16 tile. It borrows
 * that module's freshness rules and single-flight so one tile is never
 * assembled twice at once.
 */

/**
 * Cached bytes for `key`, produced by `load` on a miss. A stale entry is served
 * when `load` fails, which is what makes an upstream outage invisible.
 */
export async function cachedBlob(
  key: string[],
  load: () => Promise<Uint8Array>,
): Promise<{ data: Uint8Array; cached: boolean }> {
  return cachedPointTile("skog", key, load);
}
