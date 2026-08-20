import { NextResponse } from "next/server";
import { parseTileParams, type TileId } from "./osm/tiles";

/**
 * Wraps a `[z]/[x]/[y]` route handler with grid validation. Refusing off-grid
 * requests is what keeps the cache key space bounded (ADR 0002), and both the
 * OSM and LOD1 tile routes need exactly the same check.
 */
export function tileRoute(
  handler: (tile: TileId, options: { fresh: boolean }) => Promise<Response> | Response,
) {
  return async (
    request: Request,
    context: { params: Promise<{ z: string; x: string; y: string }> },
  ): Promise<Response> => {
    const tile = parseTileParams(await context.params);
    if (!tile) return NextResponse.json({ error: "Only z16 tiles are served" }, { status: 400 });
    // `?fresh=1` skips the read caches for one tile. Used after an upload, where
    // a cached tile would keep showing the data the edit just replaced.
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    return handler(tile, { fresh });
  };
}
