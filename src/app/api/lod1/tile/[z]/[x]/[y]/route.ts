import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { LOD1_ENABLED } from "@/lib/features";
import { localTilePath } from "@/lib/local-data";
import { tileRoute } from "@/lib/tile-route";

/**
 * Serves imported Stockholm LOD1 tiles from disk. This is local static data
 * produced by scripts/import-lod1.mjs, so it needs no limiter or cache layer —
 * unlike the live OSM path.
 */

const EMPTY = { type: "FeatureCollection", features: [] } as const;

const serveTile = tileRoute(async (tile) => {
  const file = localTilePath("lod1", tile, ".json");
  try {
    const body = await readFile(file, "utf8");
    return new NextResponse(body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=86400",
        "x-lod1": "hit",
      },
    });
  } catch {
    // Outside Stockholm, or a tile with no buildings.
    return NextResponse.json(EMPTY, { headers: { "x-lod1": "empty" } });
  }
});

export async function GET(
  request: Request,
  context: { params: Promise<{ z: string; x: string; y: string }> },
): Promise<Response> {
  if (!LOD1_ENABLED) return new NextResponse(null, { status: 404 });
  return serveTile(request, context);
}
