import { NextResponse } from "next/server";
import { cacheStats } from "@/lib/osm/cache";
import { limiterStats } from "@/lib/osm/limiter";

/** Upstream and cache counters. Keeping these visible is part of ADR 0002. */
export function GET() {
  return NextResponse.json(
    { upstream: limiterStats(), cache: cacheStats() },
    { headers: { "cache-control": "no-store" } },
  );
}
