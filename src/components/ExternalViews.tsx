"use client";

import { useState } from "react";
import { FiChevronDown, FiChevronRight, FiExternalLink } from "react-icons/fi";
import type { LngLat } from "@/lib/buildings";

/**
 * Third-party imagery for the selected building.
 *
 * Neither provider allows their 3D view to be framed: `bing.com/maps?style=3d`
 * answers `X-Frame-Options: DENY`, and `google.com/maps` (including the old
 * `output=embed` trick) answers SAMEORIGIN. Bing's `/maps/embed` endpoint does
 * allow framing, but only in road and aerial styles — Birdseye and 3D are not
 * available there. So the panel frames Bing aerial and links out to the real 3D
 * views, which open in a new tab.
 */

type Style = "a" | "r";

const STYLES: { id: Style; label: string }[] = [
  { id: "a", label: "Aerial" },
  { id: "r", label: "Road" },
];

function bingEmbedUrl([lon, lat]: LngLat, style: Style): string {
  const params = new URLSearchParams({
    h: "400",
    w: "600",
    cp: `${lat.toFixed(6)}~${lon.toFixed(6)}`,
    lvl: "19",
    typ: "d",
    sty: style,
  });
  return `https://www.bing.com/maps/embed?${params.toString()}`;
}

/** Bing's own 3D app: photogrammetric mesh, but only outside an iframe. */
function bing3dUrl([lon, lat]: LngLat, height: number | undefined): string {
  const params = new URLSearchParams({
    cp: `${lat.toFixed(6)}~${lon.toFixed(6)}`,
    lvl: "19.2",
    style: "3d",
    // Camera elevation; the building's own height keeps it in frame.
    eh: String(Math.round(Math.max(height ?? 50, 30))),
  });
  return `https://www.bing.com/maps/?${params.toString()}`;
}

/** Google tilted satellite: `a` is altitude, `t` the tilt in degrees. */
function google3dUrl([lon, lat]: LngLat): string {
  return `https://www.google.com/maps/@${lat.toFixed(6)},${lon.toFixed(6)},120a,35y,60t/data=!3m1!1e3`;
}

/** Street View is what mappers actually count floors from. */
function streetViewUrl([lon, lat]: LngLat): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function LinkOut({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
    >
      {children}
      <FiExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

export function ExternalViews({ center, height }: { center: LngLat; height?: number }) {
  const [open, setOpen] = useState(true);
  const [style, setStyle] = useState<Style>("a");

  return (
    <section className="border-t border-slate-200">
      <div className="flex items-center gap-2 px-4 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase hover:text-slate-900"
          aria-expanded={open}
        >
          {open ? (
            <FiChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <FiChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
          Imagery
        </button>
        <span className="ml-auto flex items-center gap-1">
          {open &&
            STYLES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setStyle(option.id)}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  style === option.id
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:bg-slate-100"
                }`}
              >
                {option.label}
              </button>
            ))}
        </span>
      </div>

      {open && (
        <>
          <iframe
            // Re-frame when the building changes rather than reusing the view.
            key={`${center[0]},${center[1]},${style}`}
            src={bingEmbedUrl(center, style)}
            title="Bing Maps imagery of the selected building"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className="h-48 w-full border-0 bg-slate-100"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
            <span className="text-[11px] text-slate-500">3D cannot be embedded — open:</span>
            <LinkOut href={bing3dUrl(center, height)}>Bing 3D</LinkOut>
            <LinkOut href={google3dUrl(center)}>Google 3D</LinkOut>
            <LinkOut href={streetViewUrl(center)}>Street View</LinkOut>
          </div>
        </>
      )}
    </section>
  );
}
