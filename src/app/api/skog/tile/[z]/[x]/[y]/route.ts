import { NextResponse } from "next/server";
import { emptyTile, encodeTile } from "@/lib/lidar-format";
import { tileBounds } from "@/lib/osm/tiles";
import { cachedBlob } from "@/lib/skog/cache";
import { skogPointsForBounds } from "@/lib/skog/copc";
import { SkogUnavailableError, skogCredential } from "@/lib/skog/upstream";
import { tileRoute } from "@/lib/tile-route";

/**
 * Serves Lantmäteriet's "Laserdata Skog" as point tiles, read on demand.
 *
 * Unlike the local `/api/lidar` route there is nothing on disk to serve: the
 * upstream COPC files cover the country and are far too large to import, so a
 * tile is assembled from range reads the first time it is asked for and cached
 * as bytes afterwards. The Geotorget credential lives on this side only.
 *
 * Every failure answers an empty tile rather than an error status: the 3D view
 * treats "no points here" as normal, so a missing credential, a missing product
 * permission and an upstream outage all degrade to a view without dots.
 */

const CACHE_SECONDS = 24 * 60 * 60;

function tileResponse(bytes: Uint8Array, headers: Record<string, string>): NextResponse {
  return new NextResponse(bytes.buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      ...headers,
    },
  });
}

export const GET = tileRoute(async (tile) => {
  if (!skogCredential()) {
    return tileResponse(emptyTile(), { "x-skog": "no-credential", "cache-control": "no-store" });
  }

  const key = ["16", String(tile.x), String(tile.y)];
  try {
    let stats = "";
    const { data, cached } = await cachedBlob(key, async () => {
      const bounds = tileBounds(tile);
      const points = await skogPointsForBounds(bounds);
      stats = `${points.files} files, ${points.nodes} nodes, ${Math.round(points.bytes / 1024)} KB${
        points.capped ? ", capped" : ""
      }`;
      return encodeTile(points, bounds);
    });
    return tileResponse(data, {
      "x-skog": cached ? "cache" : "upstream",
      ...(stats ? { "x-skog-read": stats } : {}),
    });
  } catch (error) {
    // Wrong credential, missing product permission, or upstream trouble. The
    // reason is reported in a header because a tile that quietly has no points
    // is indistinguishable from one that failed, and only one of those is a bug.
    const reason =
      error instanceof SkogUnavailableError ? error.message : String(error).slice(0, 200);
    return tileResponse(emptyTile(), { "x-skog": "unavailable", "x-skog-error": reason });
  }
});
