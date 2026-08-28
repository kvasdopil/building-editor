import { NextResponse } from "next/server";
import {
  CLIENT_ID,
  clearSession,
  fetchUser,
  isProductionHost,
  OAUTH_BASE,
  readSession,
  SCOPE,
} from "@/lib/osm/oauth";

/**
 * Who is signed in, and what the browser needs to start a sign-in.
 *
 * The account is checked against OSM rather than trusted from the cookie: a token
 * the user revoked on their account page has to read as signed out here.
 *
 * The client id and the authorize endpoint are served from here rather than baked
 * into the bundle, so they stay runtime configuration (see src/lib/osm/oauth.ts).
 * The host is reported so the UI can name which OSM an account belongs to.
 */
export async function GET() {
  const session = await readSession();
  const host = new URL(OAUTH_BASE).host;
  const config = {
    clientId: CLIENT_ID,
    configured: CLIENT_ID.length > 0,
    authorizeUrl: `${OAUTH_BASE}/oauth2/authorize`,
    scope: SCOPE,
    host,
    // The UI has to be able to say so: an account on the real map is not the same
    // thing as one on a test server, and an upload from here is a public edit.
    production: isProductionHost(host),
  };
  if (!session) {
    return NextResponse.json(
      { ...config, user: null },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const user = await fetchUser(session.accessToken);
  if (!user) await clearSession();
  return NextResponse.json({ ...config, user }, { headers: { "cache-control": "no-store" } });
}
