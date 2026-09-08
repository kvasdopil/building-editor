import { NextResponse } from "next/server";
import { ignLidarPointsForBounds } from "@/lib/ign/copc";
import { IgnLidarUnavailableError } from "@/lib/ign/upstream";
import { encodeTile, emptyTile, LIDAR_SOURCE_ID } from "@/lib/lidar-format";
import { tileBounds } from "@/lib/osm/tiles";
import { cachedPointTile } from "@/lib/point-tile-cache";
import { tileRoute } from "@/lib/tile-route";

/** Serve France's classified IGN LiDAR HD by range-reading public COPC files. */

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
  const key = [String(tile.z), String(tile.x), String(tile.y)];
  try {
    let stats = "";
    const { data, cached } = await cachedPointTile("ign", key, async () => {
      const bounds = tileBounds(tile);
      const points = await ignLidarPointsForBounds(bounds);
      stats = `${points.files} files, ${points.pages} pages, ${points.nodes} nodes, ${Math.round(
        points.bytes / 1024,
      )} KB${points.thinned ? ", thinned" : ""}${points.capped ? ", capped" : ""}`;
      return encodeTile(points, bounds, LIDAR_SOURCE_ID.IGN_LIDAR_HD);
    });
    return tileResponse(data, {
      "x-ign-lidar": cached ? "cache" : "upstream",
      ...(stats ? { "x-ign-lidar-read": stats } : {}),
    });
  } catch (error) {
    const reason =
      error instanceof IgnLidarUnavailableError ? error.message : String(error).slice(0, 200);
    return tileResponse(emptyTile(), {
      "x-ign-lidar": "unavailable",
      "x-ign-lidar-error": reason,
    });
  }
});
