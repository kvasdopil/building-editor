"use client";

/**
 * Small IndexedDB wrapper shared by the tile cache and the pending-edit store.
 * Both live in one database so the schema version stays in one place; opening
 * the same database at two versions from two modules would deadlock.
 */

const DB_NAME = "building-editor";
const DB_VERSION = 3;

export const TILE_STORE = "osm-tiles";
export const EDIT_STORE = "edits";
/**
 * Footprint overrides and drawn parts. Kept apart from EDIT_STORE because those
 * are keyed by OSM element and these include elements that do not exist upstream
 * yet — but both must survive a reload, or a tag override outlives the geometry
 * it describes.
 */
export const GEOMETRY_STORE = "geometry-edits";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of [TILE_STORE, EDIT_STORE, GEOMETRY_STORE]) {
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => {
      // A later tab raising DB_VERSION must not be blocked by this connection:
      // close it and degrade, or both tabs wait on each other forever.
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
    // Private browsing and blocked storage are fine; callers degrade to no cache.
    request.onerror = () => resolve(null);
    // An older connection is holding the previous version open. Without this the
    // promise never settles and every read and write hangs silently.
    request.onblocked = () => resolve(null);
  });
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  databasePromise ??= open();
  return databasePromise;
}

function request<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest,
) {
  return async (): Promise<T | null> => {
    const db = await database();
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const req = run(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  };
}

export function idbGet<T>(store: string, key: string): Promise<T | null> {
  return request<T>(store, "readonly", (s) => s.get(key))();
}

export function idbPut(store: string, key: string, value: unknown): Promise<unknown> {
  return request(store, "readwrite", (s) => s.put(value, key))();
}

export function idbDelete(store: string, key: string): Promise<unknown> {
  return request(store, "readwrite", (s) => s.delete(key))();
}

export function idbClear(store: string): Promise<unknown> {
  return request(store, "readwrite", (s) => s.clear())();
}

/** All entries as [key, value] pairs, for restoring state on load. */
export async function idbEntries<T>(store: string): Promise<[string, T][]> {
  const db = await database();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(store, "readonly").objectStore(store);
      const keys = transaction.getAllKeys() as IDBRequest<string[]>;
      const values = transaction.getAll();
      let pending = 2;
      const done = () => {
        if (--pending > 0) return;
        const ids = keys.result ?? [];
        const data = (values.result ?? []) as T[];
        resolve(ids.map((id, index) => [id, data[index]] as [string, T]));
      };
      keys.onsuccess = done;
      values.onsuccess = done;
      keys.onerror = () => resolve([]);
      values.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
