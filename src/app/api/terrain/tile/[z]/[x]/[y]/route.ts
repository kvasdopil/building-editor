import { NextResponse } from "next/server";
import { MAPTERHORN_ZOOM } from "@/lib/terrain-config";

const MAPTERHORN_TILES = "https://tiles.mapterhorn.com";

function tileParams(params: { z: string; x: string; y: string }) {
  const z = Number.parseInt(params.z, 10);
  const x = Number.parseInt(params.x, 10);
  const y = Number.parseInt(params.y, 10);
  const limit = 2 ** z;
  if (
    z !== MAPTERHORN_ZOOM ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= limit ||
    y >= limit
  ) {
    return null;
  }
  return { z, x, y };
}

/**
 * Same-origin, fixed-grid access to Mapterhorn's public z13 Terrarium tiles.
 * Keeping the browser on this route makes WebP decoding independent of the
 * upstream's CORS policy and gives the immutable elevation bytes a long cache.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ z: string; x: string; y: string }> },
): Promise<Response> {
  const tile = tileParams(await context.params);
  if (!tile) {
    return NextResponse.json(
      { error: `Only valid z${MAPTERHORN_ZOOM} terrain tiles are served` },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(`${MAPTERHORN_TILES}/${tile.z}/${tile.x}/${tile.y}.webp`, {
      next: { revalidate: 604800 },
    });
    if (!upstream.ok) {
      return new Response(null, { status: upstream.status });
    }
    return new Response(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "image/webp",
        "cache-control": "public, max-age=604800, stale-while-revalidate=2592000",
        "x-terrain": "mapterhorn-z13",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
