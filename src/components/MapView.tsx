"use client";

import type { FeatureCollection } from "geojson";
import {
  addProtocol,
  AttributionControl,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type LayerSpecification,
  Map as MaplibreMap,
  type MapMouseEvent,
  NavigationControl,
  removeProtocol,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { BuildingPanel } from "./BuildingPanel";
import { installDevRafShim } from "@/lib/dev-raf-shim";
import type { BuildingSelection } from "@/lib/buildings";
import { createTileLoader, type LoaderStatus, type TileLoader } from "@/lib/osm/client";
import { selectFromOsm } from "@/lib/osm/select";
import { OSM_TILE_ZOOM } from "@/lib/osm/tiles";
import { BUILDINGS_PMTILES_URL } from "@/lib/overture";

const MIN_BUILDING_ZOOM = 10;

/**
 * At and above this zoom the map switches from the Overture overview snapshot
 * to live OSM data, which is the only source that shows recent edits and the
 * only one we can edit against (ADR 0001).
 */
const LIVE_ZOOM = OSM_TILE_ZOOM;

/**
 * Buildings and parts are colored by the height data they carry: a measured
 * `height`, a `num_floors` count we multiply into a height, or nothing but a
 * footprint. Each has a brighter variant for use over satellite imagery.
 */
const HEIGHT_DATA_COLORS = {
  height: { map: "#2f9e44", photo: "#51cf66" },
  floors: { map: "#1c7ed6", photo: "#4dabf7" },
  none: { map: "#e03131", photo: "#ff8787" },
} as const;

type ColorMode = "map" | "photo";

function heightDataColor(mode: ColorMode): ExpressionSpecification {
  return [
    "case",
    ["has", "height"],
    HEIGHT_DATA_COLORS.height[mode],
    ["has", "num_floors"],
    HEIGHT_DATA_COLORS.floors[mode],
    HEIGHT_DATA_COLORS.none[mode],
  ];
}

const LEGEND: [keyof typeof HEIGHT_DATA_COLORS, string][] = [
  ["height", "Measured height"],
  ["floors", "Floor count"],
  ["none", "Footprint only"],
];

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

interface FootprintLayerOptions {
  /** Layer id prefix; `-fill` and `-line` are appended. */
  id: string;
  source: string;
  sourceLayer?: string;
  /** Draw building parts rather than outlines: fainter, dashed. */
  part?: boolean;
  /** Live layers take over from the Overture overview at LIVE_ZOOM. */
  live?: boolean;
}

/**
 * The fill + line pair for one class of footprint. Overture separates buildings
 * from parts by source layer; the live source is one collection, so it filters
 * on the normalized `role` instead.
 */
function footprintLayers({
  id,
  source,
  sourceLayer,
  part = false,
  live = false,
}: FootprintLayerOptions): LayerSpecification[] {
  const zoom = live ? { minzoom: LIVE_ZOOM } : { minzoom: MIN_BUILDING_ZOOM, maxzoom: LIVE_ZOOM };
  const shared = {
    source,
    ...(sourceLayer ? { "source-layer": sourceLayer } : {}),
    ...(live
      ? { filter: [part ? "==" : "!=", ["get", "role"], "part"] as FilterSpecification }
      : {}),
    ...zoom,
  };
  return [
    {
      ...shared,
      id: `${id}-fill`,
      type: "fill",
      paint: { "fill-color": heightDataColor("map"), "fill-opacity": part ? 0.25 : 0.35 },
    },
    {
      ...shared,
      id: `${id}-line`,
      type: "line",
      paint: {
        "line-color": heightDataColor("map"),
        "line-width": part ? 0.8 : 1.2,
        ...(part ? { "line-dasharray": [2, 1] } : {}),
      },
    },
  ];
}

function mapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors",
      },
      photos: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri & contributors",
      },
      overture: {
        type: "vector",
        url: `pmtiles://${BUILDINGS_PMTILES_URL}`,
        attribution: "Buildings © Overture Maps Foundation",
      },
      live: { type: "geojson", data: EMPTY, attribution: "© OpenStreetMap contributors" },
      selection: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "osm", type: "raster", source: "osm" },
      { id: "photos", type: "raster", source: "photos", layout: { visibility: "none" } },
      ...footprintLayers({ id: "building", source: "overture", sourceLayer: "building" }),
      ...footprintLayers({
        id: "part",
        source: "overture",
        sourceLayer: "building_part",
        part: true,
      }),
      ...footprintLayers({ id: "live-building", source: "live", live: true }),
      ...footprintLayers({ id: "live-part", source: "live", live: true, part: true }),
      {
        id: "selection-casing",
        type: "line",
        source: "selection",
        paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.9 },
      },
      {
        id: "selection-line",
        type: "line",
        source: "selection",
        paint: { "line-color": "#101828", "line-width": 2 },
      },
    ],
  };
}

/** Main screen: MapLibre map with Overture buildings and the 3D side panel. */
export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<TileLoader | null>(null);
  const liveFeaturesRef = useRef<FeatureCollection>(EMPTY);
  // The instance lives in a ref, not state: cleanup nulls it synchronously, so
  // a sibling effect re-running after a remount can never touch a removed map
  // (MapLibre drops its style on remove(), and every paint call then throws).
  const mapRef = useRef<MaplibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [live, setLive] = useState(false);
  const [loaderStatus, setLoaderStatus] = useState<LoaderStatus>({
    tiles: 0,
    pending: 0,
    failed: 0,
  });
  const [photos, setPhotos] = useState(false);
  const [zoomedIn, setZoomedIn] = useState(true);
  const [selection, setSelection] = useState<BuildingSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    installDevRafShim();
    // Bundlers can mangle MapLibre's worker URL; serve it from /public instead.
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const protocol = new Protocol();
    addProtocol("pmtiles", protocol.tile);

    const instance = new MaplibreMap({
      container,
      style: mapStyle(),
      center: [18.0686, 59.3293],
      zoom: 14,
      minZoom: 3,
      maxPitch: 0,
      pitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      // Placed bottom-left below, where the detail panel cannot cover it.
      attributionControl: false,
    });
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();
    instance.addControl(new NavigationControl({ showCompass: false }), "top-left");
    instance.addControl(new AttributionControl({ compact: true }), "bottom-left");

    const onZoom = () => {
      const zoom = instance.getZoom();
      setZoomedIn(zoom > MIN_BUILDING_ZOOM);
      setLive(zoom >= LIVE_ZOOM);
    };
    instance.on("zoom", onZoom);
    onZoom();

    // Live tiles are requested only once the map settles, and only at edit
    // zoom, so panning never turns into a burst of upstream reads (ADR 0002).
    const loader = createTileLoader((features, status) => {
      liveFeaturesRef.current = features;
      const source = instance.getSource<GeoJSONSource>("live");
      void source?.setData(features);
      setLoaderStatus(status);
    });
    loaderRef.current = loader;
    instance.on("idle", () => {
      if (instance.getZoom() < LIVE_ZOOM) return;
      const bounds = instance.getBounds();
      loader.load([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
    });

    const setCursor = (cursor: string) => () => {
      instance.getCanvas().style.cursor = cursor;
    };
    for (const layer of ["building-fill", "live-building-fill"]) {
      instance.on("mouseenter", layer, setCursor("pointer"));
      instance.on("mouseleave", layer, setCursor(""));
    }

    instance.on("click", (event: MapMouseEvent) => {
      // Selection is live-OSM only: the Overture overview is a snapshot we
      // cannot edit, and its fields are not OSM tags (ADR 0001).
      if (instance.getZoom() < LIVE_ZOOM) {
        const overview = instance.queryRenderedFeatures(event.point, { layers: ["building-fill"] });
        if (overview.length > 0) setNotice("Zoom in for OSM data");
        setSelection(null);
        return;
      }
      const hits = instance.queryRenderedFeatures(event.point, {
        layers: ["live-building-fill", "live-part-fill"],
      });
      const hit = hits.find((f) => f.properties.role !== "part") ?? hits[0];
      const id = hit?.properties.id;
      setSelection(typeof id === "string" ? selectFromOsm(liveFeaturesRef.current, id) : null);
    });

    instance.on("error", (e) => console.error("map error:", e.error?.message ?? e));
    mapRef.current = instance;
    instance.on("load", () => setMapReady(true));
    return () => {
      loader.stop();
      loaderRef.current = null;
      mapRef.current = null;
      setMapReady(false);
      instance.remove();
      removeProtocol("pmtiles");
    };
  }, []);

  // Clear the transient hint on its own, so it never sticks around.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  // Photo underlay: swap basemaps and keep only boundaries over imagery.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setLayoutProperty("photos", "visibility", photos ? "visible" : "none");
    map.setLayoutProperty("osm", "visibility", photos ? "none" : "visible");
    const color = heightDataColor(photos ? "photo" : "map");
    for (const prefix of ["", "live-"]) {
      map.setPaintProperty(`${prefix}building-fill`, "fill-opacity", photos ? 0 : 0.35);
      map.setPaintProperty(`${prefix}part-fill`, "fill-opacity", photos ? 0 : 0.25);
      map.setPaintProperty(`${prefix}building-line`, "line-color", color);
      map.setPaintProperty(`${prefix}part-line`, "line-color", color);
      map.setPaintProperty(`${prefix}building-line`, "line-width", photos ? 1.6 : 1.2);
      map.setPaintProperty(`${prefix}part-line`, "line-width", photos ? 1.1 : 0.8);
    }
  }, [mapReady, photos]);

  // Keep the selection highlight in sync with the selected building.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource<GeoJSONSource>("selection");
    void source?.setData(selection ? selection.outline : EMPTY);
  }, [mapReady, selection]);

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />

      <label
        className={`absolute top-3 z-30 flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-md select-none ${
          selection ? "right-[29rem]" : "right-3"
        }`}
      >
        <input
          type="checkbox"
          checked={photos}
          onChange={(e) => setPhotos(e.target.checked)}
          className="h-4 w-4 accent-sky-600"
        />
        Photos
      </label>

      {zoomedIn && (
        <div
          className={`absolute top-16 z-30 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow-md ${
            selection ? "right-[29rem]" : "right-3"
          }`}
        >
          <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
            Height data
          </p>
          <ul className="flex flex-col gap-1">
            {LEGEND.map(([category, label]) => (
              <li key={label} className="flex items-center gap-2 text-xs text-slate-700">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: HEIGHT_DATA_COLORS[category][photos ? "photo" : "map"],
                  }}
                />
                {label}
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">
            {live ? (
              <>
                Live OSM · {loaderStatus.tiles} tiles
                {loaderStatus.pending > 0 && " · loading…"}
                {loaderStatus.failed > 0 && ` · ${loaderStatus.failed} failed`}
              </>
            ) : (
              "Overture overview · zoom in to inspect OSM"
            )}
          </p>
        </div>
      )}

      {(!zoomedIn || notice) && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900/75 px-4 py-1.5 text-sm text-white shadow">
          {zoomedIn ? notice : "Zoom in to see buildings"}
        </div>
      )}

      <BuildingPanel selection={selection} onClose={() => setSelection(null)} />
    </div>
  );
}
