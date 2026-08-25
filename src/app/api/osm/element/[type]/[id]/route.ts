import type { FeatureCollection } from "geojson";
import { NextResponse } from "next/server";
import {
  isFresh,
  isUsableStale,
  readCachedTile,
  singleFlight,
  writeCachedTile,
} from "@/lib/osm/cache";
import { fetchUpstream, UpstreamUnavailableError } from "@/lib/osm/limiter";
import { type OsmMapResponse, osmToBuildings } from "@/lib/osm/parse";
import { OSM_TILE_SCHEMA } from "@/lib/osm/tiles";

/**
 * Looks up one OSM element by id, for the "#way/123" search. Goes through the
 * same limiter and cache as tiles (ADR 0002); `/full` is used so a way arrives
 * with its nodes and a relation with its members.
 */

const OSM_API = process.env.OSM_API_BASE ?? "https://api.openstreetmap.org";

const TYPES = new Set(["way", "relation"]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await context.params;
  // Nodes are never buildings, so only ways and relations are worth fetching.
  if (!TYPES.has(type) || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: "Expected way/<id> or relation/<id>" }, { status: 400 });
  }

  const key = [OSM_TILE_SCHEMA, "element", type, id];
  const cached = await readCachedTile<FeatureCollection>(key);
  if (cached && isFresh(cached)) {
    return NextResponse.json(cached.data, { headers: { "x-cache": "hit" } });
  }

  try {
    const entry = await singleFlight(key, async () => {
      const body = await fetchUpstream(`${OSM_API}/api/0.6/${type}/${id}/full.json`);
      const parsed = JSON.parse(body) as OsmMapResponse;
      return writeCachedTile(key, osmToBuildings(parsed));
    });
    return NextResponse.json(entry.data, { headers: { "x-cache": "miss" } });
  } catch (error) {
    if (cached && isUsableStale(cached)) {
      return NextResponse.json(cached.data, { headers: { "x-cache": "stale" } });
    }
    const unavailable = error instanceof UpstreamUnavailableError;
    return NextResponse.json(
      { error: unavailable ? error.message : `Could not load ${type}/${id}` },
      { status: 503, headers: { "retry-after": "60" } },
    );
  }
}
