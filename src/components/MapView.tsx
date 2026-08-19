"use client";

import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import {
  addProtocol,
  AttributionControl,
  type ExpressionSpecification,
  type GeoJSONSource,
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
import { BUILDINGS_PMTILES_URL, type BuildingSelection, buildSelection } from "@/lib/overture";

const MIN_BUILDING_ZOOM = 10;

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
      selection: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "osm", type: "raster", source: "osm" },
      { id: "photos", type: "raster", source: "photos", layout: { visibility: "none" } },
      {
        id: "building-fill",
        type: "fill",
        source: "overture",
        "source-layer": "building",
        minzoom: MIN_BUILDING_ZOOM,
        paint: { "fill-color": heightDataColor("map"), "fill-opacity": 0.35 },
      },
      {
        id: "building-line",
        type: "line",
        source: "overture",
        "source-layer": "building",
        minzoom: MIN_BUILDING_ZOOM,
        paint: { "line-color": heightDataColor("map"), "line-width": 1.2 },
      },
      {
        id: "part-fill",
        type: "fill",
        source: "overture",
        "source-layer": "building_part",
        minzoom: MIN_BUILDING_ZOOM,
        paint: { "fill-color": heightDataColor("map"), "fill-opacity": 0.25 },
      },
      {
        id: "part-line",
        type: "line",
        source: "overture",
        "source-layer": "building_part",
        minzoom: MIN_BUILDING_ZOOM,
        paint: {
          "line-color": heightDataColor("map"),
          "line-width": 0.8,
          "line-dasharray": [2, 1],
        },
      },
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
  const [map, setMap] = useState<MaplibreMap | null>(null);
  const [photos, setPhotos] = useState(false);
  const [zoomedIn, setZoomedIn] = useState(true);
  const [selection, setSelection] = useState<BuildingSelection | null>(null);

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

    const onZoom = () => setZoomedIn(instance.getZoom() > MIN_BUILDING_ZOOM);
    instance.on("zoom", onZoom);
    onZoom();

    const setCursor = (cursor: string) => () => {
      instance.getCanvas().style.cursor = cursor;
    };
    instance.on("mouseenter", "building-fill", setCursor("pointer"));
    instance.on("mouseleave", "building-fill", setCursor(""));

    instance.on("click", (event: MapMouseEvent) => {
      if (instance.getZoom() <= MIN_BUILDING_ZOOM) return;
      const hits = instance.queryRenderedFeatures(event.point, {
        layers: ["building-fill", "part-fill"],
      });
      const hit = hits.find((f) => f.sourceLayer === "building") ?? hits[0];
      const buildingId =
        hit?.sourceLayer === "building" ? hit.properties.id : hit?.properties.building_id;
      if (typeof buildingId !== "string") {
        setSelection(null);
        return;
      }
      // buildSelection picks out the clicked building and its neighbors, so
      // hand it every loaded feature rather than filtering per id here.
      const fragments = (sourceLayer: string) =>
        instance.querySourceFeatures("overture", { sourceLayer }).map((f) => ({
          geometry: f.geometry as Polygon | MultiPolygon,
          properties: f.properties,
        }));
      setSelection(buildSelection(buildingId, fragments("building"), fragments("building_part")));
    });

    instance.on("error", (e) => console.error("map error:", e.error?.message ?? e));
    instance.on("load", () => setMap(instance));
    return () => {
      instance.remove();
      removeProtocol("pmtiles");
      setMap(null);
    };
  }, []);

  // Photo underlay: swap basemaps and keep only boundaries over imagery.
  useEffect(() => {
    if (!map) return;
    map.setLayoutProperty("photos", "visibility", photos ? "visible" : "none");
    map.setLayoutProperty("osm", "visibility", photos ? "none" : "visible");
    map.setPaintProperty("building-fill", "fill-opacity", photos ? 0 : 0.35);
    map.setPaintProperty("part-fill", "fill-opacity", photos ? 0 : 0.25);
    const color = heightDataColor(photos ? "photo" : "map");
    map.setPaintProperty("building-line", "line-color", color);
    map.setPaintProperty("part-line", "line-color", color);
    map.setPaintProperty("building-line", "line-width", photos ? 1.6 : 1.2);
    map.setPaintProperty("part-line", "line-width", photos ? 1.1 : 0.8);
  }, [map, photos]);

  // Keep the selection highlight in sync with the selected building.
  useEffect(() => {
    if (!map) return;
    const source = map.getSource<GeoJSONSource>("selection");
    void source?.setData(selection ? selection.outline : EMPTY);
  }, [map, selection]);

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
        </div>
      )}

      {!zoomedIn && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900/75 px-4 py-1.5 text-sm text-white shadow">
          Zoom in to see buildings
        </div>
      )}

      <BuildingPanel selection={selection} onClose={() => setSelection(null)} />
    </div>
  );
}
