"use client";

import { TilesRenderer } from "3d-tiles-renderer";
import { CesiumIonAuthPlugin } from "3d-tiles-renderer/plugins";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import type { CameraView } from "./Building3D";
import type { LngLat } from "@/lib/buildings";
import { placeEcefCamera } from "@/lib/ecef-camera";
import { mountCanvas } from "@/lib/three-canvas";

/**
 * Google's photorealistic mesh for the selected building, as a secondary visual
 * check next to our own extrusion. The camera follows the local orbit camera, so
 * both views show the same angle.
 *
 * The renderer is created once when the section is opened and only the camera
 * moves as the selection changes. That keeps the downloaded tiles warm and
 * avoids starting fresh provider sessions for every inspected building.
 */

const CESIUM_ION_ASSET_ID = "2275207";

const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_TOKEN;
const HAS_TILE_SOURCE = Boolean(CESIUM_TOKEN);

const OPEN_STORAGE_KEY = "building-explorer:google-3d-open";
/** Keeps remounts during selection changes from flashing the panel closed. */
let rememberedOpen: boolean | null = null;

const DEG = Math.PI / 180;

/**
 * The local view keeps the whole building inside a padded bounding sphere,
 * which puts its camera roughly 3x the building radius away. Photoreal context
 * needs no such margin, so the same range is pulled in to frame the building
 * rather than its neighbourhood.
 */
const RANGE_SCALE = 0.55;

/** Ray start for the ground probe: well above any terrain or building. */
const PROBE_ALTITUDE = 3000;

/** Re-probe no more often than this while tiles stream in. */
const PROBE_INTERVAL_MS = 1000;

/** Points sampled around the building when looking for ground level. */
const PROBE_RING_POINTS = 6;

const METERS_PER_DEG_LAT = 111320;

interface Viewpoint {
  center: LngLat;
  camera: CameraView | null;
  /** Footprint radius in meters, used to sample ground clear of the building. */
  radius?: number;
}

/**
 * Place `camera` so it looks at the building from the same heading, tilt and
 * range as the local 3D view. Tiles are in earth-centred coordinates, so the
 * offset is built in the local east/north/up frame at the building.
 */
function aimCamera(
  camera: THREE.PerspectiveCamera,
  tiles: TilesRenderer,
  { center: [lon, lat], camera: view }: Viewpoint,
  /** Ellipsoid height of the mesh surface under the building, meters. */
  surfaceHeight: number,
): void {
  const { position, target, up } = placeEcefCamera({
    ellipsoid: tiles.ellipsoid,
    lon,
    lat,
    surfaceHeight,
    heading: view?.heading ?? 0,
    tilt: view?.tilt ?? 55,
    range: Math.max((view?.range ?? 120) * RANGE_SCALE, 25),
  });
  camera.up.copy(up);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

/** Ellipsoid height of the mesh directly under one lon/lat, or null if unloaded. */
function probePoint(tiles: TilesRenderer, lon: number, lat: number): number | null {
  const { ellipsoid } = tiles;
  const start = ellipsoid.getCartographicToPosition(
    lat * DEG,
    lon * DEG,
    PROBE_ALTITUDE,
    new THREE.Vector3(),
  );
  const sea = ellipsoid.getCartographicToPosition(lat * DEG, lon * DEG, 0, new THREE.Vector3());
  const direction = sea.clone().sub(start).normalize();
  const raycaster = new THREE.Raycaster(start, direction, 0, PROBE_ALTITUDE * 2);
  const hit = raycaster.intersectObject(tiles.group, true)[0];
  if (!hit) return null;
  return ellipsoid.getPositionToCartographic(hit.point, {}).height;
}

/**
 * Ground level at the building, as an ellipsoid height. A ray down the middle
 * hits the roof, so a ring clear of the footprint is sampled too and the lowest
 * hit wins — buildings stand above the ground, so the minimum approximates it.
 * Null until tiles cover the area.
 */
function probeGroundHeight(
  tiles: TilesRenderer,
  [lon, lat]: LngLat,
  radius: number | undefined,
): number | null {
  const ring = Math.max((radius ?? 20) * 1.4, 12);
  const dLat = ring / METERS_PER_DEG_LAT;
  const dLon = dLat / Math.max(Math.cos(lat * DEG), 0.01);

  let lowest: number | null = null;
  for (let i = 0; i <= PROBE_RING_POINTS; i++) {
    const angle = (i / PROBE_RING_POINTS) * Math.PI * 2;
    // i === PROBE_RING_POINTS repeats the first point; use it for the centre.
    const atCentre = i === PROBE_RING_POINTS;
    const height = probePoint(
      tiles,
      lon + (atCentre ? 0 : Math.cos(angle) * dLon),
      lat + (atCentre ? 0 : Math.sin(angle) * dLat),
    );
    if (height !== null && (lowest === null || height < lowest)) lowest = height;
  }
  return lowest;
}

function MissingKey() {
  return (
    <div className="space-y-1 px-4 py-3 text-[11px] text-slate-500">
      <p>
        Set <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_CESIUM_TOKEN</code> in{" "}
        <code className="rounded bg-slate-100 px-1">.env.local</code> to show the photorealistic
        mesh here.
      </p>
      <p>The token needs access to Google Photorealistic 3D Tiles in Cesium ion (asset 2275207).</p>
    </div>
  );
}

export function Photoreal3D({ center, camera: view, radius }: Viewpoint) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => rememberedOpen ?? false);
  /**
   * Set on the first open and never cleared: collapsing hides the canvas but
   * keeps the renderer, its downloaded tiles and its session alive, so
   * re-opening costs neither a new session nor a re-download.
   */
  const [mounted, setMounted] = useState(() => rememberedOpen ?? false);
  const [attribution, setAttribution] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Latest viewpoint, read by the render loop rather than re-creating it. */
  const viewpointRef = useRef<Viewpoint>({ center, camera: view, radius });
  const aimRef = useRef<(() => void) | null>(null);
  /** Read inside the render loop so a collapsed section does no work. */
  const visibleRef = useRef(open);

  viewpointRef.current = { center, camera: view, radius };
  visibleRef.current = open;

  useEffect(() => {
    if (rememberedOpen !== null) return;
    let restored = false;
    try {
      restored = window.localStorage.getItem(OPEN_STORAGE_KEY) === "true";
    } catch {
      // Storage may be unavailable in a restricted browsing context. The
      // module-level value still preserves the preference while the app lives.
    }
    rememberedOpen = restored;
    setOpen(restored);
    if (restored) setMounted(true);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!mounted || !CESIUM_TOKEN || !container) return;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2));

    const camera = new THREE.PerspectiveCamera(50, 1, 1, 4e7);
    // Earth-centred coordinates are millions of meters from the origin, so a
    // logarithmic depth buffer is what keeps the mesh from z-fighting.
    const canvas = mountCanvas(container, camera, { logarithmicDepthBuffer: true });
    const { renderer } = canvas;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(
      new CesiumIonAuthPlugin({
        apiToken: CESIUM_TOKEN,
        assetId: CESIUM_ION_ASSET_ID,
        autoRefreshToken: true,
      }),
    );
    tiles.setCamera(camera);
    scene.add(tiles.group);

    let surfaceHeight = 0;
    const aim = () => aimCamera(camera, tiles, viewpointRef.current, surfaceHeight);
    aimRef.current = aim;
    aim();

    tiles.addEventListener("load-error", () => {
      setError("Cesium ion refused the tile request — check the token and asset access.");
    });

    let lastAttribution = 0;
    let lastProbe = 0;
    canvas.start(() => {
      // Paused while collapsed: keeps the cache warm without spending frames.
      if (!visibleRef.current) return;

      // Tiles stream coarse-to-fine, so the surface keeps improving; re-probe
      // until it settles rather than trusting the first hit.
      const now = performance.now();
      if (now - lastProbe > PROBE_INTERVAL_MS) {
        lastProbe = now;
        const probed = probeGroundHeight(
          tiles,
          viewpointRef.current.center,
          viewpointRef.current.radius,
        );
        if (probed !== null && Math.abs(probed - surfaceHeight) > 0.5) {
          surfaceHeight = probed;
          aim();
        }
      }
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
      renderer.render(scene, camera);

      // Attribution is required by the Map Tiles terms; it changes as tiles
      // stream in, so refresh it about once a second rather than per frame.
      if (now - lastAttribution > 1000) {
        lastAttribution = now;
        const tileCredits = tiles
          .getAttributions()
          .map((entry) => String(entry.value))
          .join(" · ");
        const providerCredits = "Google · Cesium ion";
        const credits = tileCredits ? `${providerCredits} · ${tileCredits}` : providerCredits;
        setAttribution((previous) => (previous === credits ? previous : credits));
      }
    });

    return () => {
      aimRef.current = null;
      tiles.dispose();
      canvas.dispose();
    };
  }, [mounted]);

  // Selection or orbit changes only move the camera, keeping one session alive.
  useEffect(() => {
    aimRef.current?.();
  }, [center, view, radius]);

  return (
    <section
      className={`border-t border-slate-200 ${
        open && HAS_TILE_SOURCE ? "flex min-h-48 flex-1 flex-col" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => {
          const next = !open;
          rememberedOpen = next;
          setOpen(next);
          setMounted(true);
          try {
            window.localStorage.setItem(OPEN_STORAGE_KEY, String(next));
          } catch {
            // Keep the in-memory preference when storage is unavailable.
          }
        }}
        aria-expanded={open}
        aria-label={open ? "Hide photorealistic view" : "Show photorealistic view"}
        title={open ? "Hide photorealistic view" : "Show photorealistic view"}
        className="flex w-full items-center gap-1 px-3 py-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase hover:text-slate-900"
      >
        {open ? (
          <FiChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <FiChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        <span className="ml-auto text-[10px] font-normal normal-case">
          {HAS_TILE_SOURCE ? "" : "no key"}
        </span>
      </button>

      {HAS_TILE_SOURCE ? (
        <>
          {mounted && (
            <div
              ref={containerRef}
              className={open ? "min-h-0 w-full flex-1 bg-slate-100" : "hidden"}
              aria-hidden={!open}
            />
          )}
          {open && <p className="px-4 py-1 text-[10px] text-slate-400">{error ?? attribution}</p>}
        </>
      ) : (
        open && <MissingKey />
      )}
    </section>
  );
}
