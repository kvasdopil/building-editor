import { NextResponse } from "next/server";
import { clearSession, readSession, revokeToken } from "@/lib/osm/oauth";

/** Sign out: revoke the token upstream, then drop the cookie either way. */
export async function POST() {
  const session = await readSession();
  if (session) await revokeToken(session.accessToken);
  await clearSession();
  return NextResponse.json({ user: null }, { headers: { "cache-control": "no-store" } });
}
