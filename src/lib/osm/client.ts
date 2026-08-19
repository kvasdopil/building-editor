"use client";

import type { Feature, FeatureCollection } from "geojson";
import type { Bounds } from "../geometry";
import { type TileId, tileKey, tilesInBounds } from "./tiles";

/**
 * Browser-side half of the OSM read path. Tiles are cached in IndexedDB so
 * panning back and reloading cost nothing, and only a couple of fetches are
 * ever in flight. Combined with the server cache and limiter this is what keeps
 * upstream traffic near zero (ADR 0002).
 */

/** Matches the server TTL; a tile older than this is refetched. */
const TILE_TTL_MS = 6 * 60 * 60 * 1000;

/** Tiles fetched per viewport, nearest the center first. */
const MAX_TILES_PER_VIEW = 12;

const MAX_CONCURRENT_FETCHES = 2;

const DB_NAME = "building-editor";
const STORE = "osm-tiles";

interface StoredTile {
  fetchedAt: number;
  data: FeatureCollection;
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // Private browsing and blocked storage are fine; we just skip the cache.
    request.onerror = () => resolve(null);
  });
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

async function readStored(key: string): Promise<StoredTile | null> {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as StoredTile | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function writeStored(key: string, entry: StoredTile): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(entry, key);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

export interface TileLoader {
  /** Queue the tiles covering `bounds`; already-known tiles are skipped. */
  load(bounds: Bounds): void;
  stop(): void;
}

export interface LoaderStatus {
  tiles: number;
  pending: number;
  failed: number;
}

/**
 * Create a loader that fetches tiles for a viewport and reports the merged
 * feature collection. Features are keyed by OSM id, so a way appearing in two
 * tiles is stored once.
 */
export function createTileLoader(
  onChange: (features: FeatureCollection, status: LoaderStatus) => void,
): TileLoader {
  const features = new Map<string, Feature>();
  /** Tiles we have data for. */
  const loaded = new Set<string>();
  /** Tiles already claimed, so a viewport change does not queue them twice. */
  const claimed = new Set<string>();
  const queue: TileId[] = [];
  let active = 0;
  let failed = 0;
  let stopped = false;

  const emit = () => {
    onChange(
      { type: "FeatureCollection", features: [...features.values()] },
      { tiles: loaded.size, pending: queue.length + active, failed },
    );
  };

  const absorb = (collection: FeatureCollection) => {
    for (const feature of collection.features) {
      const id = feature.properties?.id;
      if (typeof id === "string") features.set(id, feature);
    }
  };

  const pump = () => {
    while (!stopped && active < MAX_CONCURRENT_FETCHES && queue.length > 0) {
      const tile = queue.shift() as TileId;
      active++;
      void fetchTile(tile).finally(() => {
        active--;
        // Emit after the count drops, or the last tile would leave the UI
        // reporting work that has already finished.
        emit();
        pump();
      });
    }
  };

  const fetchTile = async (tile: TileId) => {
    const key = tileKey(tile);
    try {
      const response = await fetch(`/api/osm/tile/${tile.z}/${tile.x}/${tile.y}`);
      if (!response.ok) {
        failed++;
        // Allow a later viewport change to retry this tile.
        claimed.delete(key);
        return;
      }
      const data = (await response.json()) as FeatureCollection;
      absorb(data);
      loaded.add(key);
      await writeStored(key, { fetchedAt: Date.now(), data });
    } catch {
      failed++;
      claimed.delete(key);
    }
  };

  return {
    load(bounds) {
      if (stopped) return;
      for (const tile of tilesInBounds(bounds, MAX_TILES_PER_VIEW)) {
        const key = tileKey(tile);
        if (claimed.has(key)) continue;
        claimed.add(key);
        void readStored(key).then((stored) => {
          if (stopped) return;
          if (stored && Date.now() - stored.fetchedAt < TILE_TTL_MS) {
            absorb(stored.data);
            loaded.add(key);
            emit();
            return;
          }
          queue.push(tile);
          pump();
        });
      }
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}
