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

/** Google Earth exposes target, distance, heading, tilt and roll in its URL. */
function google3dUrl([lon, lat]: LngLat, camera: CameraView): string {
  const view = [
    lat.toFixed(6),
    lon.toFixed(6),
    "0a",
    `${Math.max(camera.range, 10)}d`,
    "35y",
    `${camera.heading}h`,
    `${camera.tilt}t`,
    "0r",
  ].join(",");
  return `https://earth.google.com/web/@${view}`;
}

function LinkOut({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Continue from this camera angle in ${children}`}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
    >
      {children}
      <FiExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

/**
 * External photorealistic 3D views synchronized to the local orbit camera. Sits
 * in the panel header, so it renders only the links and leaves layout to it.
 */
export function External3DLinks({ center, camera }: { center: LngLat; camera: CameraView | null }) {
  if (!camera) return null;
  return (
    <>
      <LinkOut href={bing3dUrl(center, camera)}>Bing</LinkOut>
      <LinkOut href={google3dUrl(center, camera)}>Google</LinkOut>
    </>
  );
}
