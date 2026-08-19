import { NextResponse } from "next/server";
import { parseTileParams, type TileId } from "./osm/tiles";

/**
 * Wraps a `[z]/[x]/[y]` route handler with grid validation. Refusing off-grid
 * requests is what keeps the cache key space bounded (ADR 0002), and both the
 * OSM and LOD1 tile routes need exactly the same check.
 */
export function tileRoute(handler: (tile: TileId) => Promise<Response> | Response) {
  return async (
    _request: Request,
    context: { params: Promise<{ z: string; x: string; y: string }> },
  ): Promise<Response> => {
    const tile = parseTileParams(await context.params);
    if (!tile) return NextResponse.json({ error: "Only z16 tiles are served" }, { status: 400 });
    return handler(tile);
  };
}
