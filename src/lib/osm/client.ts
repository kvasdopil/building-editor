"use client";

import type { Feature, FeatureCollection } from "geojson";
import type { Bounds } from "../geometry";
import { idbDelete, idbGet, idbPut, TILE_STORE } from "../idb";
import { OSM_TILE_SCHEMA, type TileId, tileKey, tilesInBounds } from "./tiles";

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

/** Parsed tile generations must not share an IndexedDB entry. */
const storedTileKey = (tile: TileId) => `${OSM_TILE_SCHEMA}/${tileKey(tile)}`;

/**
 * Tiles a single refresh may refetch. Higher than the per-viewport cap because a
 * refresh is asked for by element, not by viewport: dropping one of those tiles
 * would leave the map showing data the upload has already replaced.
 */
const MAX_REFRESH_TILES = 24;

interface StoredTile {
  fetchedAt: number;
  data: FeatureCollection;
}

export interface TileLoader {
  /** Queue the tiles covering `bounds`; already-known tiles are skipped. */
  load(bounds: Bounds): void;
  /**
   * Refetch the tiles covering `bounds`, past every cache. Used once an upload
   * lands: the cached tiles still describe the data it replaced.
   */
  refresh(bounds: Bounds): void;
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
  /** Queued work; `fresh` tiles bypass every cache on the way out. */
  const queue: { tile: TileId; fresh: boolean }[] = [];
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
      const { tile, fresh } = queue.shift() as { tile: TileId; fresh: boolean };
      active++;
      void fetchTile(tile, fresh).finally(() => {
        active--;
        // Emit after the count drops, or the last tile would leave the UI
        // reporting work that has already finished.
        emit();
        pump();
      });
    }
  };

  const fetchTile = async (tile: TileId, fresh = false) => {
    const key = storedTileKey(tile);
    try {
      const response = await fetch(
        `/api/osm/tile/${tile.z}/${tile.x}/${tile.y}?schema=${OSM_TILE_SCHEMA}${fresh ? "&fresh=1" : ""}`,
      );
      if (!response.ok) {
        failed++;
        // Allow a later viewport change to retry this tile.
        claimed.delete(key);
        return;
      }
      const data = (await response.json()) as FeatureCollection;
      absorb(data);
      loaded.add(key);
      await idbPut(TILE_STORE, key, { fetchedAt: Date.now(), data } satisfies StoredTile);
    } catch {
      failed++;
      claimed.delete(key);
    }
  };

  return {
    load(bounds) {
      if (stopped) return;
      for (const tile of tilesInBounds(bounds, MAX_TILES_PER_VIEW)) {
        const key = storedTileKey(tile);
        if (claimed.has(key)) continue;
        claimed.add(key);
        void idbGet<StoredTile>(TILE_STORE, key).then((stored) => {
          if (stopped) return;
          if (stored && Date.now() - stored.fetchedAt < TILE_TTL_MS) {
            absorb(stored.data);
            loaded.add(key);
            emit();
            return;
          }
          queue.push({ tile, fresh: false });
          pump();
        });
      }
    },
    refresh(bounds) {
      if (stopped) return;
      for (const tile of tilesInBounds(bounds, MAX_REFRESH_TILES)) {
        const key = storedTileKey(tile);
        if (queue.some((queued) => queued.fresh && storedTileKey(queued.tile) === key)) continue;
        // Drop every trace of the old tile: the browser copy, and the record that
        // says we already have it. The server copy is bypassed by `fresh`.
        claimed.add(key);
        loaded.delete(key);
        void idbDelete(TILE_STORE, key);
        queue.push({ tile, fresh: true });
      }
      pump();
    },

    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}
