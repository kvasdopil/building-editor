"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

/** The URL hash contains the selected OSM feature id, which analytics does not need. */
function redactEditorSelection(event: BeforeSendEvent): BeforeSendEvent {
  const hashStart = event.url.indexOf("#");
  return hashStart === -1 ? event : { ...event, url: event.url.slice(0, hashStart) };
}

/** Vercel's page-view collector with the editor's identifying URL state removed. */
export function ProductAnalytics() {
  return <Analytics beforeSend={redactEditorSelection} />;
}
