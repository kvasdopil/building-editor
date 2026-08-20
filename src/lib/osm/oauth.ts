import { cookies } from "next/headers";
import { USER_AGENT } from "./limiter";

/**
 * Server side of OSM sign-in. The access token never reaches the browser: the
 * code exchange happens here and the token goes into an httpOnly cookie, so a
 * script on the page cannot read it and cannot call an upstream host with it
 * either — which is what ADR 0002 requires anyway.
 *
 * These requests deliberately skip the tile limiter. Its token bucket exists to
 * ration shared map data; a sign-in queued behind thirty pending tiles would be
 * a bug, and one authorization per user is not the traffic the policy is about.
 * They still identify the client, as the policy requires.
 */

/**
 * Writes and sign-in run against the OSM development API until FT-07 flips
 * production deliberately. Reads keep their own base, which defaults to
 * production, because reading real data is what the map is for.
 *
 * Both of these are read here and nowhere else. They are deliberately not
 * `NEXT_PUBLIC_`: those are inlined at build time, so the client id could only be
 * changed by rebuilding, and one build could not serve both dev and production.
 * The browser is told what it needs through `/api/osm/session` instead. A public
 * PKCE client id is not a secret — it travels in the consent URL — so this is
 * about configuration, not concealment.
 */
export const OAUTH_BASE = process.env.OSM_OAUTH_BASE ?? "https://api06.dev.openstreetmap.org";

export const CLIENT_ID = process.env.OSM_CLIENT_ID ?? "";

/**
 * Set when the OSM application is registered as confidential. The exchange runs
 * here, on the server, so a secret can be held properly — and a confidential
 * client is the stronger setup. PKCE is still sent either way: it also proves the
 * browser that finished the flow is the one that started it, which a secret does
 * not. A public application simply leaves this empty.
 */
const CLIENT_SECRET = process.env.OSM_CLIENT_SECRET ?? "";

/**
 * What sign-in asks for. `write_api` ("Modify the map") is the only write this
 * app ever needs: it covers creating and modifying nodes, ways and relations
 * through a changeset. `read_prefs` is what identifies the account.
 *
 * Requested now, while nothing writes yet, so uploading later does not send
 * everyone through a second consent screen. Nothing else belongs here — in
 * particular `write_redactions` ("Redact map data") is a moderator scope for
 * editing element history, which this app must never ask for.
 */
export const SCOPE = "read_prefs write_api";

/**
 * Whether a host is the real OpenStreetMap rather than a test instance. Anything
 * not recognisable as a development server counts as production: guessing wrong
 * that way only shows a warning nobody needed, while the opposite hides one that
 * mattered.
 */
export function isProductionHost(host: string): boolean {
  return !/(^|\.)dev\.openstreetmap\.org$|^localhost(:|$)|^127\.0\.0\.1(:|$)/.test(host);
}

const COOKIE = "osm-session";

/** A cookie that outlives this is not worth keeping; the user can sign in again. */
const MAX_COOKIE_AGE_S = 30 * 24 * 60 * 60;

interface OsmUser {
  id: number;
  name: string;
}

interface Session {
  accessToken: string;
  /** Absolute ms; absent when the token does not expire, as OSM's currently do not. */
  expiresAt?: number;
  refreshToken?: string;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
}

async function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  return fetch(`${OAUTH_BASE}${path}`, { ...init, headers, cache: "no-store" });
}

/** What OSM said went wrong, for a message worth showing someone. */
async function describeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; error_description?: string };
    const detail = [body.error, body.error_description].filter(Boolean).join(" - ");
    return detail || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Exchange an authorization code for a token, with PKCE and, if set, a secret. */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const response = await upstream("/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    // OSM's own reason is the difference between a misconfigured application and
    // a stale code, so pass it on rather than reporting only a status.
    throw new Error(`OSM refused the authorization code: ${await describeError(response)}`);
  }
  return (await response.json()) as TokenResponse;
}

/** Who the token belongs to. Also how we check a stored token is still good. */
export async function fetchUser(accessToken: string): Promise<OsmUser | null> {
  const response = await upstream("/api/0.6/user/details.json", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { user?: { id?: number; display_name?: string } };
  const id = body.user?.id;
  const name = body.user?.display_name;
  return typeof id === "number" && typeof name === "string" ? { id, name } : null;
}

/** Best effort: a sign-out that leaves a live token upstream is not a sign-out. */
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    const body = new URLSearchParams({ token: accessToken, client_id: CLIENT_ID });
    // A confidential application must authenticate to revoke, too.
    if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);
    await upstream("/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    // The cookie is cleared either way; nothing here is worth failing sign-out.
  }
}

export async function readSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (typeof session.accessToken !== "string") return null;
    if (session.expiresAt !== undefined && session.expiresAt < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

/**
 * `secure` follows the request, not the build. Keying it to production would drop
 * the cookie on a locally started production build served over http, and sign-in
 * would fail with nothing to see.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function writeSession(token: TokenResponse, secure: boolean): Promise<void> {
  const session: Session = {
    accessToken: token.access_token,
    scope: token.scope,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    refreshToken: token.refresh_token,
  };
  (await cookies()).set(COOKIE, JSON.stringify(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: token.expires_in ?? MAX_COOKIE_AGE_S,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
