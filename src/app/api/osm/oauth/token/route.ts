import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/json-request";
import { CLIENT_ID, exchangeCode, fetchUser, isSecureRequest, writeSession } from "@/lib/osm/oauth";

/**
 * Completes sign-in: swaps the authorization code for a token and keeps the
 * token here, in an httpOnly cookie. The browser only ever learns who it is
 * signed in as (ADR 0002: no browser talks to an upstream API).
 */
export async function POST(request: Request) {
  if (!CLIENT_ID) {
    return NextResponse.json({ error: "OSM sign-in is not configured" }, { status: 501 });
  }

  const body = await readJsonBody<{
    code?: unknown;
    codeVerifier?: unknown;
    redirectUri?: unknown;
  }>(request);
  if (!body) return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  const { code, codeVerifier, redirectUri } = body;
  if (
    typeof code !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof redirectUri !== "string"
  ) {
    return NextResponse.json(
      { error: "Expected code, codeVerifier and redirectUri" },
      { status: 400 },
    );
  }

  try {
    const token = await exchangeCode({ code, codeVerifier, redirectUri });
    const user = await fetchUser(token.access_token);
    if (!user) {
      return NextResponse.json({ error: "OSM did not identify the account" }, { status: 502 });
    }
    await writeSession(token, isSecureRequest(request));
    return NextResponse.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sign-in failed" },
      { status: 502 },
    );
  }
}
