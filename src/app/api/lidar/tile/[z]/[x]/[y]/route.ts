import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { tileRoute } from "@/lib/tile-route";

/**
 * Serves imported laser point cloud tiles from disk, produced by
 * scripts/import-lidar.mjs. Same shape as the LOD1 route — local static data,
 * so no limiter or cache layer — except the body is the importer's binary
 * rather than GeoJSON, because a tile holds hundreds of thousands of points.
 */

/** A tile header with no points, for everywhere the importer has not run. */
function emptyTile(): ArrayBuffer {
  const empty = new ArrayBuffer(16);
  new Uint8Array(empty).set([0x4c, 0x44, 0x52, 0x31]); // "LDR1"
  return empty;
}

export const GET = tileRoute(async (tile) => {
  const file = path.join(
    process.cwd(),
    "data",
    "lidar",
    String(tile.z),
    String(tile.x),
    `${tile.y}.bin`,
  );
  try {
    const body = await readFile(file);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "public, max-age=86400",
        "x-lidar": "hit",
      },
    });
  } catch {
    // Outside the imported area, which is nearly everywhere: the city publishes
    // one test area for direct download. Answer an empty tile rather than 404,
    // like the LOD1 route, so a normal selection logs no failed request.
    return new NextResponse(emptyTile(), {
      headers: { "content-type": "application/octet-stream", "x-lidar": "empty" },
    });
  }
});
