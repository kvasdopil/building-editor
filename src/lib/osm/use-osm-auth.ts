"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser side of OSM sign-in: OAuth 2.0 with PKCE, so the app needs no secret.
 *
 * The browser's part is deliberately small. It sends the user to OSM, receives an
 * authorization code back, and hands that code to our own route — which does the
 * exchange and keeps the token in an httpOnly cookie. Nothing here ever holds an
 * access token, so nothing here can leak one or call OSM directly (ADR 0002).
 *
 * The authorization step itself is the one upstream navigation the app cannot
 * proxy: consent has to happen on openstreetmap.org, in the user's own session.
 */

interface OsmUser {
  id: number;
  name: string;
}

type AuthStatus =
  /** Asking our own server who is signed in. */
  | "loading"
  /** No client id configured, so sign-in cannot be offered at all. */
  | "unconfigured"
  | "signed-out"
  /** Waiting for the user to finish on OSM, or for the code exchange. */
  | "signing-in"
  | "signed-in";

export interface OsmAuth {
  status: AuthStatus;
  user: OsmUser | null;
  /** The OSM host this account belongs to, e.g. `api06.dev.openstreetmap.org`. */
  host: string;
  /** True when that host is the real OSM, so the UI can say so plainly. */
  production: boolean;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}

/**
 * Where to send the user, and as whom. Served by `/api/osm/session` rather than
 * built into the bundle, so it stays runtime configuration (see
 * src/lib/osm/oauth.ts) and the scope this app asks for is decided in one place.
 */
interface AuthConfig {
  clientId: string;
  configured: boolean;
  authorizeUrl: string;
  scope: string;
  host: string;
  /** True when this is the real OSM rather than a test server. */
  production: boolean;
}

const PKCE_KEY = "osm-oauth-pkce";
/** Where the callback leaves a code when it had no opener to talk to. */
export const PENDING_CODE_KEY = "osm-oauth-code";
const CALLBACK_PATH = "/oauth/callback";
/** Marks the messages our own callback page sends, so others are ignored. */
export const CALLBACK_MESSAGE = "osm-oauth-callback";

interface PkceState {
  verifier: string;
  state: string;
  redirectUri: string;
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function readPkce(): PkceState | null {
  const raw = sessionStorage.getItem(PKCE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PkceState;
  } catch {
    return null;
  }
}

export function useOsmAuth(): OsmAuth {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<OsmUser | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  // Read inside the click handler, where state may still be a render behind.
  const configRef = useRef<AuthConfig | null>(null);
  configRef.current = config;

  // Who are we, according to our own server? It re-checks the token upstream, so
  // a token revoked on the account page reads as signed out here.

  /**
   * Ask our own server who is signed in and what a sign-in needs. It re-checks the
   * token upstream, so a token revoked on the account page reads as signed out
   * here — and it is the only writer of `config`, so the configuration and the
   * status can never describe different moments.
   */
  const loadSession = useCallback(async () => {
    const response = await fetch("/api/osm/session", { cache: "no-store" });
    const { user: signedIn, ...rest } = (await response.json()) as AuthConfig & {
      user: OsmUser | null;
    };
    setConfig(rest);
    configRef.current = rest;
    setUser(signedIn);
    setStatus(!rest.configured ? "unconfigured" : signedIn ? "signed-in" : "signed-out");
  }, []);

  /** Hand a code to our own server, which owns the token from there on. */
  const exchange = useCallback(
    async (code: string, state: string) => {
      const pkce = readPkce();
      sessionStorage.removeItem(PKCE_KEY);
      if (!pkce || pkce.state !== state) {
        // Either the flow did not start here or the state does not match, which is
        // exactly what the state parameter is for.
        setStatus("signed-out");
        setError("The sign-in response did not match this session. Try again.");
        return;
      }
      setStatus("signing-in");
      try {
        const response = await fetch("/api/osm/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            codeVerifier: pkce.verifier,
            redirectUri: pkce.redirectUri,
          }),
        });
        const body = (await response.json()) as { user?: OsmUser; error?: string };
        if (!response.ok || !body.user) throw new Error(body.error ?? "Sign-in failed");
        await loadSession();
        setError(null);
      } catch (failure) {
        setStatus("signed-out");
        setError(failure instanceof Error ? failure.message : "Sign-in failed");
      }
    },
    [loadSession],
  );

  useEffect(() => {
    let cancelled = false;
    void loadSession().catch(() => {
      if (!cancelled) setStatus("signed-out");
    });
    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  // A code left behind by the redirect fallback, when no popup was available.
  useEffect(() => {
    const raw = sessionStorage.getItem(PENDING_CODE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_CODE_KEY);
    try {
      const pending = JSON.parse(raw) as { code: string; state: string };
      void exchange(pending.code, pending.state);
    } catch {
      // Nothing usable; the user can start again.
    }
  }, [exchange]);

  // The popup reports back here rather than reloading the app, so the pending
  // changes and the open dialog survive signing in.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; code?: string; state?: string; error?: string };
      if (data?.source !== CALLBACK_MESSAGE) return;
      popupRef.current?.close();
      popupRef.current = null;
      if (data.error) {
        setStatus("signed-out");
        setError(data.error);
        return;
      }
      if (data.code && data.state) void exchange(data.code, data.state);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [exchange]);

  const signIn = useCallback(() => {
    const active = configRef.current;
    if (!active?.configured) return;
    setError(null);
    const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;
    const state = randomToken();
    const verifier = randomToken();
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirectUri }));

    // The popup has to be opened in the click itself or the browser blocks it,
    // so it is opened before the challenge is hashed and pointed at the URL after.
    const popup = window.open("about:blank", "osm-oauth", "width=620,height=760");
    popupRef.current = popup;
    setStatus("signing-in");

    void challengeFor(verifier).then((challenge) => {
      const url = `${active.authorizeUrl}?${new URLSearchParams({
        response_type: "code",
        client_id: active.clientId,
        redirect_uri: redirectUri,
        scope: active.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`;
      // Blocked popup: go there in this tab instead. Pending changes are stored,
      // so leaving the page and coming back loses nothing.
      if (popup) popup.location.replace(url);
      else window.location.assign(url);
    });
  }, []);

  const signOut = useCallback(() => {
    setUser(null);
    setStatus("signed-out");
    setError(null);
    void fetch("/api/osm/oauth/logout", { method: "POST" });
  }, []);

  return {
    status,
    user,
    host: config?.host ?? "openstreetmap.org",
    production: config?.production ?? true,
    error,
    signIn,
    signOut,
  };
}
