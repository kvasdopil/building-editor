"use client";

import { useEffect, useState } from "react";
import { CALLBACK_MESSAGE, PENDING_CODE_KEY } from "@/lib/osm/use-osm-auth";

/**
 * Where OSM sends the user back after consent. This page handles no token: it
 * passes the authorization code to the app that started the flow and gets out of
 * the way. The exchange happens on the server (ADR 0002).
 *
 * Normally this runs in a popup and reports back to its opener, so the app keeps
 * its map, selection and pending changes. Without an opener — a blocked popup, or
 * a link opened directly — the code is left in `sessionStorage` and the app picks
 * it up on load.
 */
export default function OAuthCallbackPage() {
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    // OSM reports a refusal here too, e.g. error=access_denied.
    const error =
      params.get("error_description") ??
      params.get("error") ??
      (code && state ? null : "No authorization code came back from OSM.");

    if (window.opener) {
      window.opener.postMessage(
        { source: CALLBACK_MESSAGE, code, state, error },
        window.location.origin,
      );
      setMessage(error ? "Sign-in was not completed." : "Signed in. This window can close.");
      window.close();
      return;
    }

    if (error) {
      setMessage(error);
      return;
    }
    sessionStorage.setItem(PENDING_CODE_KEY, JSON.stringify({ code, state }));
    window.location.replace("/");
  }, []);

  return (
    <main className="flex h-dvh items-center justify-center bg-slate-100 p-6">
      <p className="max-w-md rounded-lg border border-slate-200 bg-white px-4 py-3 text-center text-sm text-slate-700 shadow">
        {message}
      </p>
    </main>
  );
}
