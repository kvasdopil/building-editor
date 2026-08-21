import type { FeatureCollection } from "geojson";
import { NextResponse } from "next/server";
import {
  type CachedTile,
  isFresh,
  isUsableStale,
  readCachedTile,
  singleFlight,
  TILE_TTL_MS,
  writeCachedTile,
} from "@/lib/osm/cache";
import { fetchUpstream, UpstreamUnavailableError } from "@/lib/osm/limiter";
import { type OsmMapResponse, osmToBuildings } from "@/lib/osm/parse";
import { OSM_TILE_SCHEMA, type TileId, tileBounds } from "@/lib/osm/tiles";
import { tileRoute } from "@/lib/tile-route";

/**
 * Serves buildings for one z16 tile, read from OpenStreetMap through the
 * cache and limiter. This is the only path to an upstream OSM host: the browser
 * never calls one directly (ADR 0002).
 */

const OSM_API = process.env.OSM_API_BASE ?? "https://api.openstreetmap.org";

function upstreamUrl(tile: TileId): string {
  const [west, south, east, north] = tileBounds(tile);
  const bbox = [west, south, east, north].map((n) => n.toFixed(7)).join(",");
  return `${OSM_API}/api/0.6/map.json?bbox=${bbox}`;
}

async function loadTile(tile: TileId, key: string[]): Promise<CachedTile<FeatureCollection>> {
  const body = await fetchUpstream(upstreamUrl(tile));
  const parsed = JSON.parse(body) as OsmMapResponse;
  return writeCachedTile(key, osmToBuildings(parsed));
}

function tileResponse(
  entry: CachedTile<FeatureCollection>,
  status: "hit" | "miss" | "stale",
): NextResponse {
  const age = Math.floor((Date.now() - entry.fetchedAt) / 1000);
  return NextResponse.json(entry.data, {
    headers: {
      "x-cache": status,
      "x-fetched-at": new Date(entry.fetchedAt).toISOString(),
      "cache-control": `public, max-age=${Math.max(Math.floor(TILE_TTL_MS / 1000) - age, 60)}`,
    },
  });
}

export const GET = tileRoute(async (tile, { fresh }) => {
  const key = [OSM_TILE_SCHEMA, String(tile.z), String(tile.x), String(tile.y)];
  const cached = await readCachedTile<FeatureCollection>(key);
  if (!fresh && cached && isFresh(cached)) return tileResponse(cached, "hit");

  try {
    const entry = await singleFlight(key, () => loadTile(tile, key));
    return tileResponse(entry, "miss");
  } catch (error) {
    // Stale data beats hammering an upstream that is refusing us.
    if (cached && isUsableStale(cached)) return tileResponse(cached, "stale");
    const unavailable = error instanceof UpstreamUnavailableError;
    return NextResponse.json(
      { error: unavailable ? error.message : "Failed to read upstream OSM data" },
      { status: 503, headers: { "retry-after": "60" } },
    );
  }
});
