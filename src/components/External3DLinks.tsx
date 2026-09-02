"use client";

import { FiExternalLink } from "react-icons/fi";
import type { CameraView } from "./Building3D";
import type { LngLat } from "@/lib/buildings";

/** Match Bing's discrete map zoom to the Three.js camera range. */
function bingZoom(range: number): number {
  return Math.max(16, Math.min(20, 20 - Math.log2(Math.max(range, 1) / 50)));
}

/** Bing 3D accepts heading (`dir`), pitch (`pi`) and eye height (`eh`). */
function bing3dUrl([lon, lat]: LngLat, camera: CameraView): string {
  const params = new URLSearchParams({
    cp: `${lat.toFixed(6)}~${lon.toFixed(6)}`,
    lvl: bingZoom(camera.range).toFixed(1),
    style: "3d",
    eh: String(Math.max(camera.eyeHeight, 10)),
    dir: String(camera.heading),
    pi: String(camera.tilt),
  });
  return `https://www.bing.com/maps/?${params.toString()}`;
}

/** Official cross-platform Google Maps URL: centered satellite map, no API key. */
function googleMapsUrl([lon, lat]: LngLat, camera: CameraView | null): string {
  const params = new URLSearchParams({
    api: "1",
    map_action: "map",
    center: `${lat.toFixed(6)},${lon.toFixed(6)}`,
    zoom: String(Math.round(camera ? bingZoom(camera.range) : 19)),
    basemap: "satellite",
  });
  return `https://www.google.com/maps/@?${params.toString()}`;
}

function osmUrl([lon, lat]: LngLat, entityId: string): string {
  const osmEntity = /^(node|way|relation)\/(\d+)$/.exec(entityId);
  if (osmEntity) return `https://www.openstreetmap.org/${osmEntity[1]}/${osmEntity[2]}`;
  return `https://www.openstreetmap.org/#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

function LinkOut({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Open in ${children}`}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
    >
      {children}
      <FiExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

/**
 * External map links shown together at the bottom of the properties list.
 * Bing follows the full local orbit; Google Maps and OSM use the same target.
 */
export function ExternalMapLinks({
  center,
  camera,
  entityId,
}: {
  center: LngLat;
  camera: CameraView | null;
  entityId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-slate-200 px-3 py-2">
      <span className="mr-1 text-[11px] text-slate-400">Open in</span>
      {camera && <LinkOut href={bing3dUrl(center, camera)}>Bing</LinkOut>}
      <LinkOut href={googleMapsUrl(center, camera)}>Google Maps</LinkOut>
      <LinkOut href={osmUrl(center, entityId)}>OpenStreetMap</LinkOut>
    </div>
  );
}
