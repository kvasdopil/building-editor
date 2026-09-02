import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { localTilePath } from "@/lib/local-data";
import { LIDAR_SOURCE_ID, emptyTile } from "@/lib/lidar-format";
import { tileRoute } from "@/lib/tile-route";

/**
 * Serves imported laser point cloud tiles from disk, produced by
 * scripts/import-lidar.mjs. Tiles may be Stockholm's municipal scan or ICGC
 * LiDAR Territorial; their LDR1 header tells the client which. Same shape as
 * the LOD1 route — local static data, so no limiter or cache layer — except the
 * body is binary because a tile holds hundreds of thousands of points.
 */

export const GET = tileRoute(async (tile) => {
  const file = localTilePath("lidar", tile, ".bin");
  try {
    const body = await readFile(file);
    const sourceId = body.byteLength >= 16 ? body.readUInt32LE(12) : 0;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "public, max-age=86400",
        "x-lidar": "hit",
        "x-lidar-source":
          sourceId === LIDAR_SOURCE_ID.ICGC_TERRITORIAL ? "icgc-territorial" : "stockholm-2023",
      },
    });
  } catch {
    // Outside the imported area, which is nearly everywhere: the city publishes
    // one test area for direct download. Answer an empty tile rather than 404,
    // like the LOD1 route, so a normal selection logs no failed request.
    return new NextResponse(emptyTile().buffer as ArrayBuffer, {
      headers: { "content-type": "application/octet-stream", "x-lidar": "empty" },
    });
  }
});
