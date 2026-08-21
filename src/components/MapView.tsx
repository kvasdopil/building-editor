"use client";

import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import {
  addProtocol,
  AttributionControl,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type LayerSpecification,
  Map as MaplibreMap,
  type MapMouseEvent,
  MercatorCoordinate,
  NavigationControl,
  removeProtocol,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiMove } from "react-icons/fi";
import "maplibre-gl/dist/maplibre-gl.css";
import { BuildingPanel } from "./BuildingPanel";
import { ChangesSidebar } from "./ChangesSidebar";
import { SubmitDialog } from "./SubmitDialog";
import { installDevRafShim } from "@/lib/dev-raf-shim";
import {
  applyEditsToFeatureCollection,
  type EditMap,
  type PendingGeometry,
  useBuildingEdits,
  usePendingGeometry,
} from "@/lib/edits";
import type { BuildingElement, BuildingSelection, LngLat } from "@/lib/buildings";
import { pointInRing, elementBounds, openRing, padBounds, toFootprints } from "@/lib/geometry";
import { useSelectionHash } from "@/lib/use-selection-hash";
import {
  applyGeometryEdits,
  createPartFeature,
  cutHole,
  type CreatedPartMap,
  type EditableGeometry,
  geometryHasVertex,
  type GeometryEditMap,
  insertGeometryVertex,
  moveSharedGeometryVertex,
  type NodeMove,
  recordNodeMove,
} from "@/lib/geometry-edits";
import { createTileLoader, type LoaderStatus, type TileLoader } from "@/lib/osm/client";
import { drawnId, drawnRef, parseOsmRef } from "@/lib/osm/ref";
import { roundToOsmGrid } from "@/lib/osm/precision";
import { selectFromOsm } from "@/lib/osm/select";
import { OSM_TILE_ZOOM } from "@/lib/osm/tiles";
import { BUILDINGS_PMTILES_URL } from "@/lib/overture";
import { sliceBuilding } from "@/lib/slice";
import type { LidarCloud } from "@/lib/lidar";
import { LidarMapLayer } from "@/lib/lidar-map-layer";

const MIN_BUILDING_ZOOM = 10;
const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

interface PhotoOffset {
  x: number;
  y: number;
}

interface BasemapLayerState {
  id: string;
  visibility: "visible" | "none";
}

/**
 * At and above this zoom the map switches from the Overture overview snapshot
 * to live OSM data, which is the only source that shows recent edits and the
 * only one we can edit against (ADR 0001).
 */
const LIVE_ZOOM = OSM_TILE_ZOOM;

/**
 * Pending local edits render purple. Otherwise buildings and parts are colored
 * by the height data they carry: a measured `height`, a `num_floors` count we
 * multiply into a height, or nothing but a footprint. Each has a brighter
 * variant for use over satellite imagery.
 */
const BUILDING_COLORS = {
  modified: { map: "#7b2cbf", photo: "#b197fc" },
  height: { map: "#2f9e44", photo: "#51cf66" },
  floors: { map: "#1c7ed6", photo: "#4dabf7" },
  none: { map: "#e03131", photo: "#ff8787" },
} as const;

type ColorMode = "map" | "photo";

function buildingColor(mode: ColorMode): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "locally_modified"], true],
    BUILDING_COLORS.modified[mode],
    ["has", "height"],
    BUILDING_COLORS.height[mode],
    ["has", "num_floors"],
    BUILDING_COLORS.floors[mode],
    BUILDING_COLORS.none[mode],
  ];
}

const LEGEND: [keyof typeof BUILDING_COLORS, string][] = [
  ["modified", "Locally modified"],
  ["height", "Measured height"],
  ["floors", "Floor count"],
  ["none", "Footprint only"],
];

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

interface HoleDraft {
  targetId: string | null;
  nodes: LngLat[];
}

const EMPTY_HOLE_DRAFT: HoleDraft = { targetId: null, nodes: [] };

interface SliceDraft {
  targetId: string | null;
  mode: "open" | "loop" | null;
  nodes: LngLat[];
  snap: BoundarySnap | null;
}

const EMPTY_SLICE_DRAFT: SliceDraft = { targetId: null, mode: null, nodes: [], snap: null };

/** Raw RGBA square used by MapLibre's symbol layer for editable vertices. */
function squareImage(
  size: number,
  fill: readonly [number, number, number, number],
  border: readonly [number, number, number, number],
) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = x === 0 || y === 0 || x === size - 1 || y === size - 1 ? border : fill;
      data.set(color, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** Purple X with a white halo, used for a boundary-edge snap preview. */
function crossImage(size: number) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.min(Math.abs(x - y), Math.abs(x + y - (size - 1)));
      const color = distance <= 1 ? [124, 58, 237, 255] : [255, 255, 255, 255];
      if (distance <= 2) data.set(color, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** Hollow purple square with a white halo, used when reusing a footprint vertex. */
function hollowSquareImage(size: number) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edgeDistance = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edgeDistance > 2) continue;
      const color = edgeDistance === 1 ? [124, 58, 237, 255] : [255, 255, 255, 255];
      data.set(color, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

function draftFeatures(
  nodes: LngLat[],
  closePreview: boolean,
  snap: BoundarySnap | null = null,
): FeatureCollection {
  const features: Feature<Polygon | LineString | Point>[] = [];
  if (closePreview && nodes.length >= 3) {
    features.push({
      type: "Feature",
      properties: { role: "preview" },
      geometry: { type: "Polygon", coordinates: [[...nodes, nodes[0]]] },
    });
  }
  if (nodes.length >= 2) {
    features.push({
      type: "Feature",
      properties: { role: "edge" },
      geometry: { type: "LineString", coordinates: nodes },
    });
  }
  nodes.forEach((coordinates, index) => {
    features.push({
      type: "Feature",
      properties: { role: "node", first: index === 0 },
      geometry: { type: "Point", coordinates },
    });
  });
  if (snap) {
    features.push({
      type: "Feature",
      properties: { role: snap.kind === "node" ? "snap-node" : "snap-edge" },
      geometry: { type: "Point", coordinates: snap.coordinates },
    });
  }
  return { type: "FeatureCollection", features };
}

/** One point per footprint vertex, without GeoJSON's repeated closing coordinate. */
function selectionNodeFeatures(selection: BuildingSelection | null): FeatureCollection {
  if (!selection) return EMPTY;
  const features: Feature<Point>[] = selection.selected.polygons.flatMap(
    (footprint, polygonIndex) =>
      [footprint.outer, ...footprint.holes].flatMap((ring, ringIndex) =>
        openRing(ring).map((coordinates, vertexIndex) => ({
          type: "Feature",
          properties: { polygonIndex, ringIndex, vertexIndex },
          geometry: { type: "Point", coordinates },
        })),
      ),
  );
  return { type: "FeatureCollection", features };
}

interface SelectionNodeHandle {
  polygonIndex: number;
  ringIndex: number;
  vertexIndex: number;
  coordinates: LngLat;
}

/** Nearest selected node within the same nine-pixel area used to start a drag. */
function nearestSelectionNode(
  map: MaplibreMap,
  selection: BuildingSelection,
  click: { x: number; y: number },
  tolerance = 9,
): SelectionNodeHandle | null {
  const handles = map.queryRenderedFeatures(
    [
      [click.x - tolerance, click.y - tolerance],
      [click.x + tolerance, click.y + tolerance],
    ],
    { layers: ["selection-nodes"] },
  );
  const handle = handles
    .filter((feature) => feature.geometry.type === "Point")
    .map((feature) => {
      const point = map.project((feature.geometry as Point).coordinates as LngLat);
      return {
        feature,
        distance: Math.hypot(click.x - point.x, click.y - point.y),
      };
    })
    .filter(({ distance }) => distance <= tolerance)
    .sort((a, b) => a.distance - b.distance)[0]?.feature;
  if (!handle || handle.geometry.type !== "Point") return null;

  const polygonIndex = Number(handle.properties.polygonIndex);
  const ringIndex = Number(handle.properties.ringIndex);
  const vertexIndex = Number(handle.properties.vertexIndex);
  if (![polygonIndex, ringIndex, vertexIndex].every(Number.isInteger)) return null;
  const footprint = selection.selected.polygons[polygonIndex];
  const ring = footprint ? [footprint.outer, ...footprint.holes][ringIndex] : undefined;
  const coordinates = ring ? openRing(ring)[vertexIndex] : undefined;
  if (!coordinates) return null;
  return {
    polygonIndex,
    ringIndex,
    vertexIndex,
    // Rendered-feature coordinates can be projection-rounded. Resolve the
    // handle back to the exact source vertex used for shared-node identity.
    coordinates,
  };
}

function geometryOf(element: BuildingElement): EditableGeometry {
  return {
    type: "MultiPolygon",
    coordinates: element.polygons.map((footprint) => [footprint.outer, ...footprint.holes]),
  };
}

type GeometryByEntity = Record<string, EditableGeometry>;

function geometriesSharingVertex(
  collection: FeatureCollection,
  coordinates: LngLat,
): GeometryByEntity {
  const geometries: GeometryByEntity = {};
  for (const feature of collection.features) {
    const id = feature.properties?.id;
    if (
      typeof id !== "string" ||
      (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") ||
      !geometryHasVertex(feature.geometry, coordinates)
    )
      continue;
    geometries[id] = feature.geometry;
  }
  return geometries;
}

function selectionWithGeometries(
  selection: BuildingSelection,
  geometries: GeometryByEntity,
): BuildingSelection {
  const withGeometry = (element: BuildingElement): BuildingElement => {
    const geometry = geometries[element.id];
    return geometry ? { ...element, polygons: toFootprints(geometry) } : element;
  };
  const building = withGeometry(selection.building);
  const parts = selection.parts.map(withGeometry);
  const selected =
    selection.selected.id === building.id
      ? building
      : (parts.find((part) => part.id === selection.selected.id) ??
        withGeometry(selection.selected));
  return {
    ...selection,
    building,
    parts,
    selected,
    outline: {
      ...selection.outline,
      features: selection.outline.features.map((feature) => {
        const id = feature.properties?.id;
        return typeof id === "string" && geometries[id]
          ? { ...feature, geometry: geometries[id] }
          : feature;
      }),
    },
  };
}

interface NodeDrag {
  polygonIndex: number;
  ringIndex: number;
  vertexIndex: number;
  originalCoordinates: LngLat;
  /** Where the vertex sits right now; absent until the pointer has moved. */
  coordinates: LngLat | null;
  originalGeometries: GeometryByEntity;
  geometries: GeometryByEntity;
}

interface SelectionSegment {
  polygonIndex: number;
  ringIndex: number;
  segmentIndex: number;
  coordinates: LngLat;
}

/** Nearest empty segment of the selected footprint, measured in screen pixels. */
function nearestSelectionSegment(
  map: MaplibreMap,
  selection: BuildingSelection,
  click: { x: number; y: number },
  tolerance = 8,
): SelectionSegment | null {
  const nodeTolerance = 9;
  for (const footprint of selection.selected.polygons) {
    for (const ring of [footprint.outer, ...footprint.holes]) {
      for (const node of openRing(ring)) {
        const point = map.project(node);
        if (Math.hypot(click.x - point.x, click.y - point.y) <= nodeTolerance) return null;
      }
    }
  }

  let nearest: (SelectionSegment & { distance: number }) | null = null;
  for (const [polygonIndex, footprint] of selection.selected.polygons.entries()) {
    for (const [ringIndex, ring] of [footprint.outer, ...footprint.holes].entries()) {
      const nodes = openRing(ring);
      for (let segmentIndex = 0; segmentIndex < nodes.length; segmentIndex++) {
        const start = map.project(nodes[segmentIndex]);
        const end = map.project(nodes[(segmentIndex + 1) % nodes.length]);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared === 0) continue;
        const amount = Math.max(
          0,
          Math.min(1, ((click.x - start.x) * dx + (click.y - start.y) * dy) / lengthSquared),
        );
        const x = start.x + amount * dx;
        const y = start.y + amount * dy;
        const distance = Math.hypot(click.x - x, click.y - y);
        if (distance > tolerance || (nearest && distance >= nearest.distance)) continue;
        const coordinate = map.unproject([x, y]);
        nearest = {
          polygonIndex,
          ringIndex,
          segmentIndex,
          coordinates: roundToOsmGrid([coordinate.lng, coordinate.lat]),
          distance,
        };
      }
    }
  }
  if (!nearest) return null;
  const { distance: _distance, ...segment } = nearest;
  return segment;
}

interface BoundarySnap {
  targetId: string;
  coordinates: LngLat;
  distance: number;
  kind: "edge" | "node";
}

interface ProjectedBoundaryNode {
  coordinates: LngLat;
  x: number;
  y: number;
}

interface SliceBoundaryCache {
  targetId: string;
  selection: BuildingSelection;
  rings: LngLat[][];
  projected: ProjectedBoundaryNode[][] | null;
}

const boundaryRingIndexes = new WeakMap<FeatureCollection, Map<string, LngLat[][]>>();

/** Lightweight per-collection ring lookup: no part association or 3D neighbors. */
function boundaryRingIndex(collection: FeatureCollection): Map<string, LngLat[][]> {
  const cached = boundaryRingIndexes.get(collection);
  if (cached) return cached;
  const index = new Map<string, LngLat[][]>();
  for (const feature of collection.features) {
    const id = feature.properties?.id;
    if (typeof id !== "string") continue;
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.type === "MultiPolygon"
          ? feature.geometry.coordinates
          : [];
    index.set(
      id,
      polygons.flatMap((polygon) => polygon.map((ring) => ring as LngLat[])),
    );
  }
  boundaryRingIndexes.set(collection, index);
  return index;
}

function selectionBoundaryRings(selection: BuildingSelection): LngLat[][] {
  return [selection.building, ...selection.parts].flatMap((element) =>
    element.polygons.flatMap((footprint) => [footprint.outer, ...footprint.holes]),
  );
}

function projectBoundaryRings(map: MaplibreMap, rings: LngLat[][]): ProjectedBoundaryNode[][] {
  return rings.map((ring) =>
    openRing(ring).map((coordinates) => {
      const point = map.project(coordinates);
      return { coordinates, x: point.x, y: point.y };
    }),
  );
}

function nearestProjectedBoundary(
  projectedRings: ProjectedBoundaryNode[][],
  click: { x: number; y: number },
  targetId: string,
  tolerance: number,
): BoundarySnap | null {
  let nearestNode: BoundarySnap | null = null;
  let nearestEdge: BoundarySnap | null = null;
  const nodeTolerance = Math.min(tolerance, 9);
  for (const ring of projectedRings) {
    for (const node of ring) {
      const distance = Math.hypot(click.x - node.x, click.y - node.y);
      if (distance > nodeTolerance || (nearestNode && distance >= nearestNode.distance)) continue;
      nearestNode = { targetId, coordinates: node.coordinates, distance, kind: "node" };
    }
    for (let index = 0; index < ring.length; index++) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const amount =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((click.x - start.x) * dx + (click.y - start.y) * dy) / lengthSquared),
            );
      const x = start.x + amount * dx;
      const y = start.y + amount * dy;
      const distance = Math.hypot(click.x - x, click.y - y);
      if (distance > tolerance || (nearestEdge && distance >= nearestEdge.distance)) continue;
      nearestEdge = {
        targetId,
        coordinates: [
          start.coordinates[0] + amount * (end.coordinates[0] - start.coordinates[0]),
          start.coordinates[1] + amount * (end.coordinates[1] - start.coordinates[1]),
        ],
        distance,
        kind: "edge",
      };
    }
  }
  return nearestNode ?? nearestEdge;
}

function nearestBuildingBoundary(
  map: MaplibreMap,
  collection: FeatureCollection,
  click: { x: number; y: number },
  tolerance = 12,
  target?: SliceBoundaryCache | null,
): BoundarySnap | null {
  if (target) {
    target.projected ??= projectBoundaryRings(map, target.rings);
    return nearestProjectedBoundary(target.projected, click, target.targetId, tolerance);
  }

  const candidateIds = map
    .queryRenderedFeatures(
      [
        [click.x - tolerance, click.y - tolerance],
        [click.x + tolerance, click.y + tolerance],
      ],
      { layers: ["live-building-fill", "live-part-fill"] },
    )
    .map((feature) => feature.properties.id)
    .filter((id): id is string => typeof id === "string");
  const ringsById = boundaryRingIndex(collection);
  let nearestNode: BoundarySnap | null = null;
  let nearestEdge: BoundarySnap | null = null;
  for (const id of new Set(candidateIds)) {
    const rings = ringsById.get(id);
    if (!rings) continue;
    const nearest = nearestProjectedBoundary(
      projectBoundaryRings(map, rings),
      click,
      id,
      tolerance,
    );
    if (!nearest) continue;
    if (nearest.kind === "node") {
      if (!nearestNode || nearest.distance < nearestNode.distance) nearestNode = nearest;
    } else if (!nearestEdge || nearest.distance < nearestEdge.distance) nearestEdge = nearest;
  }
  return nearestNode ?? nearestEdge;
}

function applyLocalEdits(
  collection: FeatureCollection,
  tagEdits: EditMap,
  geometryEdits: GeometryEditMap,
  createdParts: CreatedPartMap,
): FeatureCollection {
  return applyEditsToFeatureCollection(
    applyGeometryEdits(collection, geometryEdits, createdParts),
    tagEdits,
  );
}

function pointInsideBuilding(point: LngLat, building: BuildingElement): boolean {
  return building.polygons.some(
    (polygon) =>
      pointInRing(point, polygon.outer) && !polygon.holes.some((hole) => pointInRing(point, hole)),
  );
}

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
      paint: { "fill-color": buildingColor("map"), "fill-opacity": part ? 0.25 : 0.35 },
    },
    {
      ...shared,
      id: `${id}-line`,
      type: "line",
      paint: {
        "line-color": buildingColor("map"),
        "line-width": part ? 0.8 : 1.2,
        ...(part ? { "line-dasharray": [2, 1] } : {}),
      },
    },
  ];
}

/** Sources and layers owned by the editor, installed above the remote vector basemap. */
function editorStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      overture: {
        type: "vector",
        url: `pmtiles://${BUILDINGS_PMTILES_URL}`,
        attribution: "Buildings © Overture Maps Foundation",
      },
      live: { type: "geojson", data: EMPTY, attribution: "© OpenStreetMap contributors" },
      selection: { type: "geojson", data: EMPTY },
      "selection-nodes": { type: "geojson", data: EMPTY },
      "selection-node-hover": { type: "geojson", data: EMPTY },
    },
    layers: [
      {
        id: "lidar-background",
        type: "background",
        layout: { visibility: "none" },
        paint: { "background-color": "#0b1020" },
      },
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
      {
        id: "selection-nodes",
        type: "circle",
        source: "selection-nodes",
        paint: { "circle-color": "#000000", "circle-radius": 3 },
      },
      {
        id: "selection-node-hover",
        type: "circle",
        source: "selection-node-hover",
        paint: {
          "circle-color": "#7c3aed",
          "circle-radius": 5,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      },
    ],
  };
}

function photoMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      photos: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri & contributors",
      },
    },
    layers: [{ id: "photos", type: "raster", source: "photos" }],
  };
}

function syncPhotoMap(main: MaplibreMap, photos: MaplibreMap, offset: PhotoOffset) {
  const mainCenter = MercatorCoordinate.fromLngLat(main.getCenter());
  const center = new MercatorCoordinate(
    mainCenter.x + offset.x,
    mainCenter.y + offset.y,
  ).toLngLat();
  photos.jumpTo({
    center,
    zoom: main.getZoom(),
    bearing: main.getBearing(),
    pitch: main.getPitch(),
  });
}

/** Main screen: MapLibre map with Overture buildings and the 3D side panel. */
export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const photoContainerRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<TileLoader | null>(null);
  const liveFeaturesRef = useRef<FeatureCollection>(EMPTY);
  /**
   * The same raw tile data as the ref, held as state so values derived from it
   * recompute when tiles arrive. The ref stays for the map callbacks, which read
   * it synchronously; both are written in one place.
   */
  const [liveFeatures, setLiveFeatures] = useState<FeatureCollection>(EMPTY);
  const displayedFeaturesRef = useRef<FeatureCollection>(EMPTY);
  // The instance lives in a ref, not state: cleanup nulls it synchronously, so
  // a sibling effect re-running after a remount can never touch a removed map
  // (MapLibre drops its style on remove(), and every paint call then throws).
  const mapRef = useRef<MaplibreMap | null>(null);
  const basemapLayersRef = useRef<BasemapLayerState[]>([]);
  const photoMapRef = useRef<MaplibreMap | null>(null);
  const lidarLayerRef = useRef<LidarMapLayer | null>(null);
  const photoOffsetRef = useRef<PhotoOffset>({ x: 0, y: 0 });
  const [mapReady, setMapReady] = useState(false);
  const [live, setLive] = useState(false);
  const [loaderStatus, setLoaderStatus] = useState<LoaderStatus>({
    tiles: 0,
    pending: 0,
    failed: 0,
  });
  const [photos, setPhotos] = useState(false);
  const [lidar, setLidar] = useState(false);
  const [photoAdjustActive, setPhotoAdjustActive] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [cutHoleActive, setCutHoleActive] = useState(false);
  const [sliceActive, setSliceActive] = useState(false);
  const [geometryEdits, setGeometryEdits] = useState<GeometryEditMap>({});
  const [createdParts, setCreatedParts] = useState<CreatedPartMap>({});
  const [zoomedIn, setZoomedIn] = useState(true);
  const [selection, setSelection] = useState<BuildingSelection | null>(null);
  const selectionBuildingId = selection?.building.id ?? null;
  const selectionRef = useRef<BuildingSelection | null>(selection);
  const [selectionBearing, setSelectionBearing] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  /** Pending-changes entity to select as soon as its tile is loaded. */
  const pendingSelectRef = useRef<string | null>(null);
  const cutHoleActiveRef = useRef(cutHoleActive);
  const sliceActiveRef = useRef(sliceActive);
  const photoAdjustActiveRef = useRef(photoAdjustActive);
  const suppressSelectionClickRef = useRef(false);
  const holeDraftRef = useRef<HoleDraft>(EMPTY_HOLE_DRAFT);
  const sliceDraftRef = useRef<SliceDraft>(EMPTY_SLICE_DRAFT);
  const sliceBoundaryCacheRef = useRef<SliceBoundaryCache | null>(null);
  const nextPartIdRef = useRef(1);
  const geometryEditsRef = useRef(geometryEdits);
  const createdPartsRef = useRef(createdParts);
  const edits = useBuildingEdits();
  const editsRef = useRef(edits.edits);
  cutHoleActiveRef.current = cutHoleActive;
  sliceActiveRef.current = sliceActive;
  photoAdjustActiveRef.current = photoAdjustActive;
  selectionRef.current = selection;
  geometryEditsRef.current = geometryEdits;
  createdPartsRef.current = createdParts;
  editsRef.current = edits.edits;
  const createdPartChangeCount = Object.values(createdParts).reduce(
    (count, feature) => count + 1 + Object.keys(feature.properties.tags ?? {}).length,
    0,
  );
  const distinctTagEditCount = Object.entries(edits.edits).reduce((count, [entity, edit]) => {
    const createdTags = createdParts[entity]?.properties.tags as Record<string, string> | undefined;
    return (
      count +
      Object.keys(edit.changed).filter((key) => !createdTags || !(key in createdTags)).length
    );
  }, 0);
  const changeCount =
    distinctTagEditCount + Object.keys(geometryEdits).length + createdPartChangeCount;
  /**
   * What a changeset would be built from. This has to follow the tiles, not only
   * the edits: reading raw data from the ref meant the changeset was assembled
   * against whatever had loaded when an edit last changed — after a reload, that
   * is nothing at all, and every restored edit reported that its element was not
   * in the loaded data.
   */
  const submitInput = useMemo(
    () => ({ features: liveFeatures, tagEdits: edits.edits, geometryEdits, createdParts }),
    [createdParts, edits.edits, geometryEdits, liveFeatures],
  );

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
      style: BASEMAP_STYLE_URL,
      center: [18.0686, 59.3293],
      zoom: 14,
      minZoom: 3,
      // Bearing is allowed (rotate by right-drag, the compass, or shift+arrows);
      // pitch stays locked, so buildings are still read from straight above.
      maxPitch: 0,
      pitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      // Placed bottom-left below, where the detail panel cannot cover it.
      attributionControl: false,
    });
    instance.addControl(
      new NavigationControl({ showCompass: true, visualizePitch: false }),
      "bottom-right",
    );
    instance.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: "Imagery © Esri & contributors",
      }),
      "bottom-left",
    );

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
      setLiveFeatures(features);
      const displayed = applyLocalEdits(
        features,
        editsRef.current,
        geometryEditsRef.current,
        createdPartsRef.current,
      );
      displayedFeaturesRef.current = displayed;
      const source = instance.getSource<GeoJSONSource>("live");
      void source?.setData(displayed);
      setLoaderStatus(status);

      // Sidebar navigation flies to the entity first; select it once its tile arrives.
      const wanted = pendingSelectRef.current;
      if (!wanted) return;
      const found = selectFromOsm(displayed, wanted);
      if (found) {
        pendingSelectRef.current = null;
        setSelectionBearing(instance.getBearing());
        setSelection(found);
      }
    });
    loaderRef.current = loader;
    instance.on("idle", () => {
      if (instance.getZoom() < LIVE_ZOOM) return;
      const bounds = instance.getBounds();
      loader.load([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
    });

    const setCursor = (cursor: string) => () => {
      if (!cutHoleActiveRef.current && !sliceActiveRef.current && !photoAdjustActiveRef.current)
        instance.getCanvas().style.cursor = cursor;
    };
    instance.on("click", (event: MapMouseEvent) => {
      if (suppressSelectionClickRef.current) {
        suppressSelectionClickRef.current = false;
        return;
      }
      if (cutHoleActiveRef.current || sliceActiveRef.current || photoAdjustActiveRef.current)
        return;
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
      // Parts render above their parent outlines and are the more specific
      // entity when both geometries cover the click point.
      const hit = hits.find((feature) => feature.properties.role === "part") ?? hits[0];
      const id = hit?.properties.id;
      const next = typeof id === "string" ? selectFromOsm(displayedFeaturesRef.current, id) : null;
      if (next) setSelectionBearing(instance.getBearing());
      setSelection(next);
    });

    instance.on("error", (e) => console.error("map error:", e.error?.message ?? e));
    mapRef.current = instance;
    instance.on("load", () => {
      // Liberty includes a low-zoom raster relief and a 3D building layer by
      // default. This editor deliberately keeps the basemap vector-only and
      // flat; its own color-coded building footprints are installed afterward.
      const providerStyle = instance.getStyle();
      for (const layer of providerStyle.layers) {
        if (layer.type === "raster" || layer.type === "fill-extrusion") {
          instance.removeLayer(layer.id);
        }
      }
      for (const [id, source] of Object.entries(providerStyle.sources)) {
        if (source.type === "raster") instance.removeSource(id);
      }

      // Keep the provider's remaining vector style together, then place all
      // editor-owned data above it. Remember its layers so Photos can reveal
      // the separate imagery map without hiding editing overlays.
      basemapLayersRef.current = instance.getStyle().layers.map((layer) => ({
        id: layer.id,
        visibility: layer.layout?.visibility === "none" ? "none" : "visible",
      }));
      const overlay = editorStyle();
      for (const [id, source] of Object.entries(overlay.sources)) instance.addSource(id, source);
      const lidarBackground = overlay.layers.find((layer) => layer.id === "lidar-background");
      if (lidarBackground) instance.addLayer(lidarBackground);
      const lidarLayer = new LidarMapLayer();
      lidarLayerRef.current = lidarLayer;
      instance.addLayer(lidarLayer);
      for (const layer of overlay.layers) {
        if (layer.id !== "lidar-background") instance.addLayer(layer);
      }

      for (const layer of ["building-fill", "live-building-fill", "live-part-fill"]) {
        instance.on("mouseenter", layer, setCursor("pointer"));
        instance.on("mouseleave", layer, setCursor(""));
      }

      instance.addImage("hole-node", squareImage(9, [124, 58, 237, 255], [255, 255, 255, 255]));
      instance.addImage(
        "hole-first-node",
        squareImage(11, [255, 255, 255, 255], [124, 58, 237, 255]),
      );
      instance.addImage("slice-snap-edge", crossImage(13));
      instance.addImage("slice-snap-node", hollowSquareImage(13));
      instance.addSource("hole-draft", { type: "geojson", data: EMPTY });
      instance.addLayer({
        id: "hole-draft-fill",
        type: "fill",
        source: "hole-draft",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#7c3aed", "fill-opacity": 0.18 },
      });
      instance.addLayer({
        id: "hole-draft-line",
        type: "line",
        source: "hole-draft",
        paint: { "line-color": "#7c3aed", "line-width": 2.5 },
      });
      instance.addLayer({
        id: "hole-draft-nodes",
        type: "symbol",
        source: "hole-draft",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "icon-image": [
            "match",
            ["get", "role"],
            "snap-edge",
            "slice-snap-edge",
            "snap-node",
            "slice-snap-node",
            ["case", ["==", ["get", "first"], true], "hole-first-node", "hole-node"],
          ],
          "icon-allow-overlap": true,
        },
      });
      setMapReady(true);
    });
    return () => {
      loader.stop();
      loaderRef.current = null;
      mapRef.current = null;
      lidarLayerRef.current = null;
      basemapLayersRef.current = [];
      setMapReady(false);
      instance.remove();
      removeProtocol("pmtiles");
    };
  }, []);

  // Imagery uses its own non-interactive map beneath the editing map. Keeping
  // the cameras synchronized makes a pixel offset possible without shifting
  // the building geometry or map camera.
  useEffect(() => {
    if (!photos || !mapReady) return;
    const main = mapRef.current;
    const container = photoContainerRef.current;
    if (!main || !container) return;

    const photoMap = new MaplibreMap({
      container,
      style: photoMapStyle(),
      center: main.getCenter(),
      zoom: main.getZoom(),
      bearing: main.getBearing(),
      pitch: main.getPitch(),
      maxPitch: 0,
      interactive: false,
      attributionControl: false,
    });
    photoMapRef.current = photoMap;
    const sync = () => syncPhotoMap(main, photoMap, photoOffsetRef.current);
    main.on("move", sync);
    main.on("resize", sync);
    photoMap.on("load", sync);
    sync();

    return () => {
      main.off("move", sync);
      main.off("resize", sync);
      if (photoMapRef.current === photoMap) photoMapRef.current = null;
      photoMap.remove();
    };
  }, [mapReady, photos]);

  // Alignment mode captures primary-button drags, locks normal map panning,
  // and applies the pointer delta to the imagery camera only.
  useEffect(() => {
    if (!photoAdjustActive || !photos || !mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    let drag:
      | {
          pointerId: number;
          x: number;
          y: number;
          photoCenterX: number;
          photoCenterY: number;
        }
      | undefined;

    map.dragPan.disable();
    canvas.style.cursor = "grab";

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const mainCenter = MercatorCoordinate.fromLngLat(map.getCenter());
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        photoCenterX: mainCenter.x + photoOffsetRef.current.x,
        photoCenterY: mainCenter.y + photoOffsetRef.current.y,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const startCenter = new MercatorCoordinate(drag.photoCenterX, drag.photoCenterY).toLngLat();
      const startPoint = map.project(startCenter);
      const shiftedCenter = map.unproject([
        startPoint.x - (event.clientX - drag.x),
        startPoint.y - (event.clientY - drag.y),
      ]);
      const shifted = MercatorCoordinate.fromLngLat(shiftedCenter);
      const mainCenter = MercatorCoordinate.fromLngLat(map.getCenter());
      photoOffsetRef.current = {
        x: shifted.x - mainCenter.x,
        y: shifted.y - mainCenter.y,
      };
      const photoMap = photoMapRef.current;
      if (photoMap) syncPhotoMap(map, photoMap, photoOffsetRef.current);
    };

    const finishDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      drag = undefined;
      canvas.style.cursor = "grab";
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", finishDrag);
    canvas.addEventListener("pointercancel", finishDrag);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", finishDrag);
      canvas.removeEventListener("pointercancel", finishDrag);
      map.dragPan.enable();
      canvas.style.cursor = "";
    };
  }, [mapReady, photoAdjustActive, photos]);

  /**
   * Look up an element by id, centre the map on it at edit zoom, and mark it for
   * selection once the tile loader has its data.
   */
  const searchById = useCallback(async (ref: { type: "way" | "relation"; id: string }) => {
    const map = mapRef.current;
    if (!map) return;
    const target = `${ref.type}/${ref.id}`;
    try {
      const response = await fetch(`/api/osm/element/${ref.type}/${ref.id}`);
      if (!response.ok) {
        setNotice(`Could not load ${target}`);
        return;
      }
      const collection = (await response.json()) as FeatureCollection;
      const feature = collection.features.find((f) => f.properties?.id === target);
      if (
        !feature ||
        (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon")
      ) {
        setNotice(`${target} is not a building or building part`);
        return;
      }
      const [west, south, east, north] = elementBounds({
        id: target,
        properties: {},
        polygons: toFootprints(feature.geometry),
      });
      const alreadyLoaded = selectFromOsm(displayedFeaturesRef.current, target);
      pendingSelectRef.current = alreadyLoaded ? null : target;
      if (alreadyLoaded) {
        setSelectionBearing(map.getBearing());
        setSelection(alreadyLoaded);
      }
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 120, maxZoom: 18, duration: 800 },
      );
      // fitBounds can land below edit zoom for a large building; the live layer
      // only exists from LIVE_ZOOM up, so nothing would be selectable.
      map.once("moveend", () => {
        if (map.getZoom() < LIVE_ZOOM) map.easeTo({ zoom: LIVE_ZOOM, duration: 300 });
      });
    } catch {
      setNotice(`Could not load ${target}`);
    }
  }, []);

  /** Close the changes drawer, then use the normal lookup flow to select its entity. */
  const navigateToEditedEntity = useCallback(
    (entity: string) => {
      setChangesOpen(false);
      // A drawn element has no upstream id to fetch, so it is only ever found in
      // what is already loaded.
      const ref = drawnId(entity) === null ? parseOsmRef(entity) : null;
      if (ref) {
        void searchById(ref);
        return;
      }
      const map = mapRef.current;
      const next = selectFromOsm(displayedFeaturesRef.current, entity);
      if (!map || !next) return;
      setSelectionBearing(map.getBearing());
      setSelection(next);
      const [west, south, east, north] = elementBounds(next.selected);
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 120, maxZoom: 19, duration: 600 },
      );
    },
    [searchById],
  );

  // The selected element lives in the URL hash, so a building can be linked to.
  useSelectionHash(selection?.selected.id ?? null, mapReady, searchById);

  /** Switch between an already loaded part and its parent without another request. */
  const selectLoadedEntity = useCallback((entityId: string) => {
    const map = mapRef.current;
    const next = selectFromOsm(displayedFeaturesRef.current, entityId);
    if (!map || !next) return;
    setSelectionBearing(map.getBearing());
    setSelection(next);
  }, []);

  const updateHoleDraft = useCallback((draft: HoleDraft) => {
    holeDraftRef.current = draft;
    const source = mapRef.current?.getSource<GeoJSONSource>("hole-draft");
    void source?.setData(draftFeatures(draft.nodes, true));
  }, []);

  const cancelHoleDrawing = useCallback(() => {
    updateHoleDraft(EMPTY_HOLE_DRAFT);
    setCutHoleActive(false);
  }, [updateHoleDraft]);

  const updateSliceDraft = useCallback((draft: SliceDraft) => {
    sliceDraftRef.current = draft;
    const source = mapRef.current?.getSource<GeoJSONSource>("hole-draft");
    void source?.setData(draftFeatures(draft.nodes, draft.mode === "loop", draft.snap));
  }, []);

  const prepareSliceBoundaryCache = useCallback((targetId: string): SliceBoundaryCache | null => {
    const current = sliceBoundaryCacheRef.current;
    if (
      current &&
      (current.targetId === targetId ||
        current.selection.parts.some((part) => part.id === targetId))
    )
      return current;
    const visibleSelection = selectionRef.current;
    const selection =
      visibleSelection &&
      (visibleSelection.building.id === targetId ||
        visibleSelection.parts.some((part) => part.id === targetId))
        ? visibleSelection
        : selectFromOsm(displayedFeaturesRef.current, targetId);
    if (!selection) return null;
    const cache: SliceBoundaryCache = {
      // A part edge may be the first hit, but every slice belongs to the
      // enclosing building and newly created parts must reference that outline.
      targetId: selection.building.id,
      selection,
      rings: selectionBoundaryRings(selection),
      projected: null,
    };
    sliceBoundaryCacheRef.current = cache;
    return cache;
  }, []);

  const cancelSliceDrawing = useCallback(() => {
    sliceBoundaryCacheRef.current = null;
    updateSliceDraft(EMPTY_SLICE_DRAFT);
    setSliceActive(false);
  }, [updateSliceDraft]);

  const refreshDisplayedFeatures = useCallback(
    (nextGeometryEdits: GeometryEditMap, nextCreatedParts = createdPartsRef.current) => {
      const displayed = applyLocalEdits(
        liveFeaturesRef.current,
        editsRef.current,
        nextGeometryEdits,
        nextCreatedParts,
      );
      displayedFeaturesRef.current = displayed;
      const source = mapRef.current?.getSource<GeoJSONSource>("live");
      void source?.setData(displayed);
      return displayed;
    },
    [],
  );

  /**
   * Bring back the drawn geometry stored by an earlier session. Placeholder ids
   * must continue past the lowest restored one: handing out `way/-1` twice would
   * let the old part's pending tag overrides land on the new one.
   */
  const restorePendingGeometry = useCallback(
    (stored: PendingGeometry) => {
      geometryEditsRef.current = stored.geometryEdits;
      createdPartsRef.current = stored.createdParts;
      setGeometryEdits(stored.geometryEdits);
      setCreatedParts(stored.createdParts);
      nextPartIdRef.current = Object.keys(stored.createdParts).reduce(
        (next, id) => Math.max(next, Math.abs(drawnId(id) ?? 0) + 1),
        1,
      );
      refreshDisplayedFeatures(stored.geometryEdits, stored.createdParts);
    },
    [refreshDisplayedFeatures],
  );

  const geometryReady = usePendingGeometry(geometryEdits, createdParts, restorePendingGeometry);

  /**
   * Drop tag overrides whose drawn element is gone. Storage can be unavailable,
   * and an older session may have left overrides behind; either way the override
   * describes nothing and would otherwise sit in the changes list forever.
   */
  const orphansCheckedRef = useRef(false);
  useEffect(() => {
    if (orphansCheckedRef.current || !edits.ready || !geometryReady) return;
    orphansCheckedRef.current = true;
    for (const ref of Object.keys(editsRef.current)) {
      if (drawnId(ref) !== null && !createdPartsRef.current[ref]) edits.revertBuilding(ref);
    }
  }, [edits, geometryReady]);

  /**
   * A changeset landed. The pending changes are now upstream, so they stop being
   * local: keeping them would re-propose an edit that has already been made, and
   * a drawn part would keep its placeholder id forever. The affected tiles are
   * refetched past every cache, since the cached ones still describe what the
   * upload replaced.
   */
  const onUploaded = useCallback(() => {
    // Which tiles to refetch is decided from the elements that were just written,
    // while they are still known. The viewport is the wrong question: it can be
    // zoomed out over hundreds of tiles, and the per-viewport cap would then keep
    // the ones nearest its centre rather than the ones that changed.
    const uploaded = new Set([
      ...Object.keys(editsRef.current),
      ...Object.keys(geometryEditsRef.current),
      ...Object.keys(createdPartsRef.current),
    ]);
    const areas = displayedFeaturesRef.current.features
      .filter((feature) => uploaded.has(String(feature.properties?.id)))
      .filter(
        (feature) =>
          feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon",
      )
      .map((feature) =>
        elementBounds({
          id: "",
          properties: {},
          polygons: toFootprints(feature.geometry as Polygon),
        }),
      );

    edits.revertAll();
    editsRef.current = {};
    geometryEditsRef.current = {};
    createdPartsRef.current = {};
    setGeometryEdits({});
    setCreatedParts({});
    refreshDisplayedFeatures({}, {});
    setSelection(null);

    // Per element rather than one enclosing box: two edits far apart would
    // otherwise ask for every tile between them.
    for (const area of areas) loaderRef.current?.refresh(padBounds(area, 30));
  }, [edits, refreshDisplayedFeatures]);

  const revertAllChanges = useCallback(() => {
    const selectedId = selection?.selected.id;
    edits.revertAll();
    editsRef.current = {};
    geometryEditsRef.current = {};
    createdPartsRef.current = {};
    setGeometryEdits({});
    setCreatedParts({});
    const displayed = refreshDisplayedFeatures({}, {});
    setSelection(selectedId ? selectFromOsm(displayed, selectedId) : null);
  }, [edits, refreshDisplayedFeatures, selection]);

  /**
   * Discard everything pending on one entity: its tag overrides, its footprint
   * override, and the part itself when it was drawn here. A part drawn in this
   * session exists only as a pending change, so dropping the change deletes it —
   * along with its tag overrides, which would otherwise describe nothing.
   */
  const revertEntity = useCallback(
    (entity: string) => {
      const selectedId = selection?.selected.id;
      edits.revertBuilding(entity);
      const nextCreatedParts: CreatedPartMap = Object.fromEntries(
        Object.entries(createdPartsRef.current).filter(([id]) => id !== entity),
      );
      const nextGeometryEdits: GeometryEditMap = Object.fromEntries(
        Object.entries(geometryEditsRef.current).filter(([id]) => id !== entity),
      );
      geometryEditsRef.current = nextGeometryEdits;
      createdPartsRef.current = nextCreatedParts;
      setGeometryEdits(nextGeometryEdits);
      setCreatedParts(nextCreatedParts);
      const displayed = refreshDisplayedFeatures(nextGeometryEdits, nextCreatedParts);
      setSelection(selectedId ? selectFromOsm(displayed, selectedId) : null);
    },
    [edits, refreshDisplayedFeatures, selection],
  );

  /**
   * Rewrite the tags of a part drawn in this session, and re-render from them.
   * Its tags live on the feature itself rather than in the override store,
   * because the element they would override does not exist upstream yet.
   */
  const updateDrawnPartTags = useCallback(
    (entity: string, tags: Record<string, string>) => {
      const part = createdPartsRef.current[entity];
      if (!part) return;
      const nextCreatedParts: CreatedPartMap = {
        ...createdPartsRef.current,
        [entity]: createPartFeature(entity, String(part.properties.parent_id), part.geometry, tags),
      };
      createdPartsRef.current = nextCreatedParts;
      setCreatedParts(nextCreatedParts);
      const displayed = refreshDisplayedFeatures(geometryEditsRef.current, nextCreatedParts);
      const selectedId = selection?.selected.id;
      if (selectedId) setSelection(selectFromOsm(displayed, selectedId));
    },
    [refreshDisplayedFeatures, selection],
  );

  /**
   * Drop one pending property. What that means depends on where the property came
   * from: an override goes back to what OSM has, a drawn part's tag is simply
   * unset, and a footprint override is discarded.
   */
  const removeProperty = useCallback(
    (entity: string, property: string) => {
      const drawn = createdPartsRef.current[entity];
      if (drawn && property !== "geometry") {
        const tags = { ...((drawn.properties.tags ?? {}) as Record<string, string>) };
        delete tags[property];
        // A manual override on the same key would otherwise put it straight back.
        edits.revertTag(entity, property);
        updateDrawnPartTags(entity, tags);
        return;
      }
      if (property === "geometry") {
        const nextGeometryEdits: GeometryEditMap = Object.fromEntries(
          Object.entries(geometryEditsRef.current).filter(([id]) => id !== entity),
        );
        geometryEditsRef.current = nextGeometryEdits;
        setGeometryEdits(nextGeometryEdits);
        const displayed = refreshDisplayedFeatures(nextGeometryEdits, createdPartsRef.current);
        const selectedId = selection?.selected.id;
        if (selectedId) setSelection(selectFromOsm(displayed, selectedId));
        return;
      }
      edits.revertTag(entity, property);
    },
    [edits, refreshDisplayedFeatures, selection, updateDrawnPartTags],
  );

  /** Change what one pending property will be written as. */
  const editProperty = useCallback(
    (entity: string, property: string, value: string) => {
      const drawn = createdPartsRef.current[entity];
      if (drawn) {
        updateDrawnPartTags(entity, {
          ...((drawn.properties.tags ?? {}) as Record<string, string>),
          [property]: value,
        });
        return;
      }
      // Keep the first-seen original, so reverting still restores what OSM has.
      edits.setTag(entity, property, value, edits.edits[entity]?.original[property]);
    },
    [edits, updateDrawnPartTags],
  );

  const finishHoleDrawing = useCallback(() => {
    const map = mapRef.current;
    const { targetId, nodes } = holeDraftRef.current;
    if (!map || !targetId) return;
    if (nodes.length < 3) {
      setNotice("A hole needs at least 3 nodes");
      return;
    }

    const feature = displayedFeaturesRef.current.features.find(
      (candidate) => candidate.properties?.id === targetId,
    );
    if (
      !feature ||
      (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon")
    ) {
      setNotice("Could not find the target building");
      return;
    }
    const geometry = cutHole(feature.geometry, nodes);
    if (!geometry) {
      setNotice("The hole must be a simple loop fully inside the building");
      return;
    }

    // A drawn part is not in the raw tile data, so an override keyed by its id
    // would apply to nothing: its own geometry is the thing to change, the same
    // way Slice does it.
    const drawn = createdPartsRef.current[targetId];
    const nextGeometryEdits: GeometryEditMap = drawn
      ? geometryEditsRef.current
      : { ...geometryEditsRef.current, [targetId]: { geometry, kind: "hole" } };
    const nextCreatedParts = drawn
      ? { ...createdPartsRef.current, [targetId]: { ...drawn, geometry } }
      : createdPartsRef.current;
    geometryEditsRef.current = nextGeometryEdits;
    createdPartsRef.current = nextCreatedParts;
    setGeometryEdits(nextGeometryEdits);
    setCreatedParts(nextCreatedParts);
    const displayed = refreshDisplayedFeatures(nextGeometryEdits, nextCreatedParts);
    const nextSelection = selectFromOsm(displayed, targetId);
    if (nextSelection) {
      setSelectionBearing(map.getBearing());
      setSelection(nextSelection);
    }
    updateHoleDraft(EMPTY_HOLE_DRAFT);
    setCutHoleActive(false);
    setNotice("Hole added");
  }, [refreshDisplayedFeatures, updateHoleDraft]);

  const finishSliceDrawing = useCallback(() => {
    const map = mapRef.current;
    const { targetId, mode, nodes } = sliceDraftRef.current;
    if (!map || !targetId || !mode) return;
    if (nodes.length < (mode === "loop" ? 3 : 2)) {
      setNotice(mode === "loop" ? "A loop needs at least 3 nodes" : "A slice needs two ends");
      return;
    }

    const target =
      sliceBoundaryCacheRef.current?.targetId === targetId
        ? sliceBoundaryCacheRef.current.selection
        : selectFromOsm(displayedFeaturesRef.current, targetId);
    if (!target) {
      setNotice("Could not find the target building");
      return;
    }
    const result = sliceBuilding(target.building, target.parts, nodes, mode === "loop");
    if (!result) {
      setNotice(
        mode === "loop"
          ? "The loop must be simple and fully inside the building"
          : "The polyline must stay inside, end on a boundary, and divide something",
      );
      return;
    }

    const nextGeometryEdits = { ...geometryEditsRef.current };
    const nextCreatedParts = { ...createdPartsRef.current };
    for (const [id, geometry] of Object.entries(result.replacements)) {
      const created = nextCreatedParts[id];
      if (created) nextCreatedParts[id] = { ...created, geometry };
      else nextGeometryEdits[id] = { geometry, kind: "slice" };
    }
    for (const addition of result.additions) {
      const id = drawnRef("way", nextPartIdRef.current++);
      nextCreatedParts[id] = createPartFeature(id, targetId, addition.geometry, addition.tags);
    }

    geometryEditsRef.current = nextGeometryEdits;
    createdPartsRef.current = nextCreatedParts;
    setGeometryEdits(nextGeometryEdits);
    setCreatedParts(nextCreatedParts);
    const displayed = refreshDisplayedFeatures(nextGeometryEdits, nextCreatedParts);
    const nextSelection = selectFromOsm(displayed, targetId);
    if (nextSelection) {
      setSelectionBearing(map.getBearing());
      setSelection(nextSelection);
    }
    sliceBoundaryCacheRef.current = null;
    updateSliceDraft(EMPTY_SLICE_DRAFT);
    setSliceActive(false);
    setNotice(
      `${result.additions.length} new ${result.additions.length === 1 ? "part" : "parts"} added`,
    );
  }, [refreshDisplayedFeatures, updateSliceDraft]);

  const toggleCutHole = useCallback(() => {
    if (cutHoleActiveRef.current) {
      cancelHoleDrawing();
      return;
    }
    cancelSliceDrawing();
    setPhotoAdjustActive(false);
    setChangesOpen(false);
    updateHoleDraft(EMPTY_HOLE_DRAFT);
    setCutHoleActive(true);
    setNotice("Click inside a building to place the first node");
  }, [cancelHoleDrawing, cancelSliceDrawing, updateHoleDraft]);

  const toggleSlice = useCallback(() => {
    if (sliceActiveRef.current) {
      cancelSliceDrawing();
      return;
    }
    cancelHoleDrawing();
    setPhotoAdjustActive(false);
    setChangesOpen(false);
    sliceBoundaryCacheRef.current = null;
    updateSliceDraft(EMPTY_SLICE_DRAFT);
    setSliceActive(true);
    setNotice("Start on an outline or part edge for an open slice, or inside for a loop");
  }, [cancelHoleDrawing, cancelSliceDrawing, updateSliceDraft]);

  useEffect(() => {
    if (!cutHoleActive || !mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";

    const onClick = (event: MapMouseEvent) => {
      const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const draft = holeDraftRef.current;

      if (draft.nodes.length > 0) {
        const first = map.project(draft.nodes[0]);
        if (Math.hypot(first.x - event.point.x, first.y - event.point.y) <= 12) {
          finishHoleDrawing();
          return;
        }
      }

      if (!draft.targetId) {
        const hit = map.queryRenderedFeatures(event.point, { layers: ["live-building-fill"] })[0];
        const id = hit?.properties.id;
        if (typeof id !== "string") {
          setNotice("Start the hole inside a live OSM building");
          return;
        }
        updateHoleDraft({ targetId: id, nodes: [point] });
        return;
      }

      const target = selectFromOsm(displayedFeaturesRef.current, draft.targetId)?.building;
      if (!target || !pointInsideBuilding(point, target)) {
        setNotice("Every node must stay inside the same building");
        return;
      }
      updateHoleDraft({ ...draft, nodes: [...draft.nodes, point] });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelHoleDrawing();
      } else if (event.key === "Enter") {
        event.preventDefault();
        finishHoleDrawing();
      }
    };

    map.on("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      map.off("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      canvas.style.cursor = "";
    };
  }, [cancelHoleDrawing, cutHoleActive, finishHoleDrawing, mapReady, updateHoleDraft]);

  useEffect(() => {
    if (cutHoleActive && !live) cancelHoleDrawing();
  }, [cancelHoleDrawing, cutHoleActive, live]);

  useEffect(() => {
    if (!sliceActive || !mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    let pendingPoint: { x: number; y: number } | null = null;
    let mouseMoveFrame = 0;

    const updateSnapAt = (point: { x: number; y: number }) => {
      const draft = sliceDraftRef.current;
      const boundaryCache =
        sliceBoundaryCacheRef.current?.targetId === draft.targetId
          ? sliceBoundaryCacheRef.current
          : null;
      const snap =
        draft.mode === "loop"
          ? null
          : draft.targetId && !boundaryCache
            ? null
            : nearestBuildingBoundary(map, displayedFeaturesRef.current, point, 12, boundaryCache);
      if (!draft.snap && !snap) return;
      if (
        draft.snap &&
        snap &&
        draft.snap.kind === snap.kind &&
        draft.snap.targetId === snap.targetId &&
        draft.snap.coordinates[0] === snap.coordinates[0] &&
        draft.snap.coordinates[1] === snap.coordinates[1]
      )
        return;
      updateSliceDraft({ ...draft, snap });
    };

    const onMouseMove = (event: MapMouseEvent) => {
      pendingPoint = { x: event.point.x, y: event.point.y };
      if (mouseMoveFrame) return;
      mouseMoveFrame = window.requestAnimationFrame(() => {
        mouseMoveFrame = 0;
        const point = pendingPoint;
        pendingPoint = null;
        if (point) updateSnapAt(point);
      });
    };

    const invalidateProjectedBoundaries = () => {
      if (sliceBoundaryCacheRef.current) sliceBoundaryCacheRef.current.projected = null;
    };

    const cancelPendingMouseMove = () => {
      pendingPoint = null;
      if (mouseMoveFrame) {
        window.cancelAnimationFrame(mouseMoveFrame);
        mouseMoveFrame = 0;
      }
    };

    const clearSnap = () => {
      cancelPendingMouseMove();
      const draft = sliceDraftRef.current;
      if (draft.snap) updateSliceDraft({ ...draft, snap: null });
    };

    const onClick = (event: MapMouseEvent) => {
      cancelPendingMouseMove();
      const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const draft = sliceDraftRef.current;

      if (!draft.targetId) {
        const snap = nearestBuildingBoundary(map, displayedFeaturesRef.current, event.point);
        if (snap) {
          const boundaryCache = prepareSliceBoundaryCache(snap.targetId);
          if (!boundaryCache) {
            setNotice("Could not find the target building");
            return;
          }
          updateSliceDraft({
            targetId: boundaryCache.targetId,
            mode: "open",
            nodes: [snap.coordinates],
            snap: null,
          });
          setNotice("Add bends, then click another outline, hole, or part edge");
          return;
        }
        const hit = map.queryRenderedFeatures(event.point, { layers: ["live-building-fill"] })[0];
        const id = hit?.properties.id;
        if (typeof id !== "string") {
          setNotice("Start on or inside a live OSM building");
          return;
        }
        if (!prepareSliceBoundaryCache(id)) {
          setNotice("Could not find the target building");
          return;
        }
        updateSliceDraft({ targetId: id, mode: "loop", nodes: [point], snap: null });
        setNotice("Draw a loop, then click its first node or press Enter");
        return;
      }

      const target = (
        sliceBoundaryCacheRef.current?.targetId === draft.targetId
          ? sliceBoundaryCacheRef.current.selection
          : prepareSliceBoundaryCache(draft.targetId)?.selection
      )?.building;
      if (!target) {
        setNotice("Could not find the target building");
        return;
      }

      if (draft.mode === "loop") {
        const first = map.project(draft.nodes[0]);
        if (
          draft.nodes.length >= 3 &&
          Math.hypot(first.x - event.point.x, first.y - event.point.y) <= 12
        ) {
          finishSliceDrawing();
          return;
        }
        if (!pointInsideBuilding(point, target)) {
          setNotice("Every loop node must stay inside the same building");
          return;
        }
        updateSliceDraft({ ...draft, nodes: [...draft.nodes, point], snap: null });
        return;
      }

      const boundaryCache =
        sliceBoundaryCacheRef.current?.targetId === draft.targetId
          ? sliceBoundaryCacheRef.current
          : null;
      if (!boundaryCache) {
        setNotice("Could not find the target building");
        return;
      }
      const snap = nearestBuildingBoundary(
        map,
        displayedFeaturesRef.current,
        event.point,
        12,
        boundaryCache,
      );
      if (snap) {
        updateSliceDraft({ ...draft, nodes: [...draft.nodes, snap.coordinates], snap: null });
        finishSliceDrawing();
        return;
      }
      if (!pointInsideBuilding(point, target)) {
        setNotice("Polyline nodes must stay inside the same building");
        return;
      }
      updateSliceDraft({ ...draft, nodes: [...draft.nodes, point], snap: null });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelSliceDrawing();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (sliceDraftRef.current.mode === "loop") finishSliceDrawing();
        else setNotice("Finish an open slice by clicking an outline, hole, or part edge");
      }
    };

    map.on("mousemove", onMouseMove);
    map.on("move", invalidateProjectedBoundaries);
    map.on("click", onClick);
    canvas.addEventListener("mouseleave", clearSnap);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("move", invalidateProjectedBoundaries);
      map.off("click", onClick);
      canvas.removeEventListener("mouseleave", clearSnap);
      window.removeEventListener("keydown", onKeyDown);
      if (mouseMoveFrame) window.cancelAnimationFrame(mouseMoveFrame);
      canvas.style.cursor = "";
    };
  }, [
    cancelSliceDrawing,
    finishSliceDrawing,
    mapReady,
    prepareSliceBoundaryCache,
    sliceActive,
    updateSliceDraft,
  ]);

  useEffect(() => {
    if (sliceActive && !live) cancelSliceDrawing();
  }, [cancelSliceDrawing, live, sliceActive]);

  // Selected footprint dots are direct handles. The draft follows the pointer;
  // releasing it records one persistent geometry override and refreshes 3D.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !selection) return;
    const canvas = map.getCanvas();
    let drag: NodeDrag | null = null;
    let nodeHovered = false;

    const setNodeHover = (handle: SelectionNodeHandle | null) => {
      nodeHovered = handle !== null;
      if (mapRef.current !== map) return;
      const source = map.getSource<GeoJSONSource>("selection-node-hover");
      void source?.setData(
        handle
          ? {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "Point", coordinates: handle.coordinates },
                },
              ],
            }
          : EMPTY,
      );
    };

    const preview = (geometries: GeometryByEntity) => {
      const draftSelection = selectionWithGeometries(selection, geometries);
      const outlineSource = map.getSource<GeoJSONSource>("selection");
      const nodeSource = map.getSource<GeoJSONSource>("selection-nodes");
      void outlineSource?.setData(draftSelection.outline);
      void nodeSource?.setData(selectionNodeFeatures(draftSelection));

      const displayed: FeatureCollection = {
        ...displayedFeaturesRef.current,
        features: displayedFeaturesRef.current.features.map((feature) => {
          const id = feature.properties?.id;
          return typeof id === "string" && geometries[id]
            ? { ...feature, geometry: geometries[id] }
            : feature;
        }),
      };
      const liveSource = map.getSource<GeoJSONSource>("live");
      void liveSource?.setData(displayed);
    };

    const currentGeometry = (): EditableGeometry => {
      const feature = displayedFeaturesRef.current.features.find(
        (candidate) => candidate.properties?.id === selection.selected.id,
      );
      return feature?.geometry.type === "Polygon" || feature?.geometry.type === "MultiPolygon"
        ? feature.geometry
        : geometryOf(selection.selected);
    };

    const commitGeometries = (
      geometries: GeometryByEntity,
      notice: string,
      /** The drag behind this commit, so the upload moves the node rather than
       * creating one beside it and orphaning the original. */
      move?: NodeMove,
    ) => {
      const targetId = selection.selected.id;
      const nextGeometryEdits: GeometryEditMap = { ...geometryEditsRef.current };
      const nextCreatedParts = { ...createdPartsRef.current };
      for (const [entity, geometry] of Object.entries(geometries)) {
        const drawn = nextCreatedParts[entity];
        // A drawn part has no upstream nodes, so nothing about it can be moved.
        if (drawn) nextCreatedParts[entity] = { ...drawn, geometry };
        else {
          const previous = nextGeometryEdits[entity];
          nextGeometryEdits[entity] = {
            geometry,
            kind: previous?.kind ?? "reshape",
            movedNodes: move
              ? recordNodeMove(previous?.movedNodes, move.from, move.to)
              : previous?.movedNodes,
          };
        }
      }

      geometryEditsRef.current = nextGeometryEdits;
      createdPartsRef.current = nextCreatedParts;
      setGeometryEdits(nextGeometryEdits);
      setCreatedParts(nextCreatedParts);
      const displayed = refreshDisplayedFeatures(nextGeometryEdits, nextCreatedParts);
      setSelection(selectFromOsm(displayed, targetId));
      setNotice(notice);
    };

    const onDragMove = (event: MapMouseEvent) => {
      if (!drag) return;
      const activeDrag = drag;
      const coordinates = roundToOsmGrid([event.lngLat.lng, event.lngLat.lat]);
      const geometries = Object.fromEntries(
        Object.entries(activeDrag.originalGeometries).map(([entity, geometry]) => [
          entity,
          moveSharedGeometryVertex(geometry, activeDrag.originalCoordinates, coordinates),
        ]),
      );
      drag = { ...activeDrag, geometries, coordinates };
      preview(geometries);
      setNodeHover({
        polygonIndex: activeDrag.polygonIndex,
        ringIndex: activeDrag.ringIndex,
        vertexIndex: activeDrag.vertexIndex,
        coordinates,
      });
    };

    const finishDrag = () => {
      if (!drag) return;
      const finished = drag;
      drag = null;
      map.off("mousemove", onDragMove);
      map.dragPan.enable();
      canvas.style.cursor = "pointer";
      const coordinates = finished.coordinates;
      if (!coordinates) return;

      // A drag generates a click after mouseup in some browsers. Let the node
      // edit land without that click selecting whatever is under its new point.
      suppressSelectionClickRef.current = true;
      setTimeout(() => {
        suppressSelectionClickRef.current = false;
      }, 0);

      const affected = Object.keys(finished.geometries).length;
      commitGeometries(
        finished.geometries,
        affected === 1 ? "Node moved" : `Shared node moved in ${affected} footprints`,
        { from: finished.originalCoordinates, to: coordinates },
      );
    };

    const onMouseDown = (event: MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;
      if (cutHoleActiveRef.current || sliceActiveRef.current || photoAdjustActiveRef.current)
        return;
      const handle = nearestSelectionNode(map, selection, event.point);
      if (!handle) return;

      event.preventDefault();
      const selectedGeometry = currentGeometry();
      const originalGeometries = geometriesSharingVertex(
        displayedFeaturesRef.current,
        handle.coordinates,
      );
      if (!originalGeometries[selection.selected.id]) {
        originalGeometries[selection.selected.id] = selectedGeometry;
      }
      drag = {
        polygonIndex: handle.polygonIndex,
        ringIndex: handle.ringIndex,
        vertexIndex: handle.vertexIndex,
        originalCoordinates: handle.coordinates,
        coordinates: null,
        originalGeometries,
        geometries: originalGeometries,
      };
      setNodeHover(handle);
      map.dragPan.disable();
      canvas.style.cursor = "grabbing";
      map.on("mousemove", onDragMove);
      window.addEventListener("mouseup", finishDrag, { once: true });
    };

    const onDoubleClick = (event: MapMouseEvent) => {
      if (cutHoleActiveRef.current || sliceActiveRef.current || photoAdjustActiveRef.current)
        return;
      const segment = nearestSelectionSegment(map, selection, event.point);
      if (!segment) return;
      const geometry = insertGeometryVertex(
        currentGeometry(),
        segment.polygonIndex,
        segment.ringIndex,
        segment.segmentIndex,
        segment.coordinates,
      );
      if (!geometry) return;
      event.preventDefault();
      commitGeometries({ [selection.selected.id]: geometry }, "Node added");
    };

    const onHover = (event: MapMouseEvent) => {
      if (
        drag ||
        cutHoleActiveRef.current ||
        sliceActiveRef.current ||
        photoAdjustActiveRef.current
      )
        return;
      const wasHovered = nodeHovered;
      const handle = nearestSelectionNode(map, selection, event.point);
      setNodeHover(handle);
      if (handle) canvas.style.cursor = "pointer";
      else if (wasHovered) canvas.style.cursor = "";
    };

    const clearNodeHover = () => {
      if (drag) return;
      setNodeHover(null);
      canvas.style.cursor = "";
    };

    map.on("mousedown", onMouseDown);
    map.on("dblclick", onDoubleClick);
    map.on("mousemove", onHover);
    canvas.addEventListener("mouseleave", clearNodeHover);
    return () => {
      map.off("mousedown", onMouseDown);
      map.off("dblclick", onDoubleClick);
      map.off("mousemove", onHover);
      map.off("mousemove", onDragMove);
      canvas.removeEventListener("mouseleave", clearNodeHover);
      window.removeEventListener("mouseup", finishDrag);
      setNodeHover(null);
      if (drag) {
        map.dragPan.enable();
        const liveSource = map.getSource<GeoJSONSource>("live");
        const outlineSource = map.getSource<GeoJSONSource>("selection");
        const nodeSource = map.getSource<GeoJSONSource>("selection-nodes");
        void liveSource?.setData(displayedFeaturesRef.current);
        void outlineSource?.setData(selection.outline);
        void nodeSource?.setData(selectionNodeFeatures(selection));
      }
      canvas.style.cursor = "";
    };
  }, [
    cutHoleActive,
    mapReady,
    photoAdjustActive,
    refreshDisplayedFeatures,
    selection,
    sliceActive,
  ]);

  // Clear the transient hint on its own, so it never sticks around.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const onLidarCloudChange = useCallback((buildingId: string, cloud: LidarCloud | null) => {
    if (selectionRef.current?.building.id !== buildingId) return;
    lidarLayerRef.current?.setCloud(cloud);
  }, []);

  // A cloud belongs to the building that requested it. Clear it immediately
  // on selection changes so an asynchronous 3D lookup cannot leave the
  // previous building's points under the new footprint.
  useEffect(() => {
    lidarLayerRef.current?.setCloud(null);
    if (!selectionBuildingId) setLidar(false);
  }, [selectionBuildingId]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = lidarLayerRef.current;
    if (!map || !layer || !mapReady) return;
    map.setLayoutProperty("lidar-background", "visibility", lidar ? "visible" : "none");
    layer.setVisible(lidar);
  }, [lidar, mapReady]);

  // Photo and LiDAR modes hide every vector-basemap layer and keep only editor
  // boundaries over their visual evidence. The provider style has many layers
  // rather than the single raster layer the photo map replaced.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const evidenceMode = photos || lidar;
    for (const layer of basemapLayersRef.current) {
      map.setLayoutProperty(layer.id, "visibility", evidenceMode ? "none" : layer.visibility);
    }
    const color = buildingColor(evidenceMode ? "photo" : "map");
    for (const prefix of ["", "live-"]) {
      map.setPaintProperty(`${prefix}building-fill`, "fill-opacity", evidenceMode ? 0 : 0.35);
      map.setPaintProperty(`${prefix}part-fill`, "fill-opacity", evidenceMode ? 0 : 0.25);
      map.setPaintProperty(`${prefix}building-line`, "line-color", color);
      map.setPaintProperty(`${prefix}part-line`, "line-color", color);
      map.setPaintProperty(`${prefix}building-line`, "line-width", evidenceMode ? 1.6 : 1.2);
      map.setPaintProperty(`${prefix}part-line`, "line-width", evidenceMode ? 1.1 : 0.8);
    }
  }, [lidar, mapReady, photos]);

  // Keep the selection highlight and footprint nodes in sync with the selected element.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const outlineSource = map.getSource<GeoJSONSource>("selection");
    const nodeSource = map.getSource<GeoJSONSource>("selection-nodes");
    void outlineSource?.setData(selection ? selection.outline : EMPTY);
    void nodeSource?.setData(selectionNodeFeatures(selection));
  }, [mapReady, selection]);

  // Pending tag and geometry overrides are projected over raw OSM together.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const displayed = applyLocalEdits(
      liveFeaturesRef.current,
      edits.edits,
      geometryEdits,
      createdParts,
    );
    displayedFeaturesRef.current = displayed;
    const source = map.getSource<GeoJSONSource>("live");
    void source?.setData(displayed);
  }, [createdParts, edits.edits, geometryEdits, mapReady]);

  return (
    <div
      className={`map-shell relative h-dvh w-full overflow-hidden ${
        selection ? "building-panel-open" : ""
      }`}
    >
      <div className="absolute inset-0">
        <div ref={photoContainerRef} className="h-full w-full" />
      </div>
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <div
        className={`absolute top-3 z-30 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-md ${
          selection ? "right-[29rem]" : "right-3"
        }`}
      >
        <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm font-medium text-slate-800 select-none">
          <input
            type="checkbox"
            checked={photos}
            onChange={(event) => {
              setPhotos(event.target.checked);
              if (event.target.checked) setLidar(false);
              if (!event.target.checked) setPhotoAdjustActive(false);
            }}
            className="h-4 w-4 accent-sky-600"
          />
          Photos
        </label>
        <label
          className={`flex items-center gap-2 px-2 py-1 text-sm font-medium select-none ${
            selection ? "cursor-pointer text-slate-800" : "cursor-not-allowed text-slate-400"
          }`}
        >
          <input
            type="checkbox"
            checked={lidar}
            disabled={!selection}
            onChange={(event) => {
              setLidar(event.target.checked);
              if (event.target.checked) {
                setPhotos(false);
                setPhotoAdjustActive(false);
              }
            }}
            className="h-4 w-4 accent-sky-600"
          />
          LiDAR
        </label>
        {photos && (
          <button
            type="button"
            onClick={() => {
              cancelHoleDrawing();
              cancelSliceDrawing();
              setPhotoAdjustActive((active) => !active);
            }}
            aria-label="Adjust photo position"
            aria-pressed={photoAdjustActive}
            title={photoAdjustActive ? "Stop adjusting photos" : "Adjust photo position"}
            className={`rounded-md p-1.5 transition-colors ${
              photoAdjustActive
                ? "bg-violet-700 text-white"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <FiMove className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {zoomedIn && (
        <div
          className={`absolute top-16 z-30 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow-md ${
            selection ? "right-[29rem]" : "right-3"
          }`}
        >
          <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
            Building colors
          </p>
          <ul className="flex flex-col gap-1">
            {LEGEND.map(([category, label]) => (
              <li key={label} className="flex items-center gap-2 text-xs text-slate-700">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: BUILDING_COLORS[category][photos || lidar ? "photo" : "map"],
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
        <div className="pointer-events-none absolute top-16 left-1/2 z-30 -translate-x-1/2 rounded-full bg-slate-900/75 px-4 py-1.5 text-sm text-white shadow">
          {zoomedIn ? notice : "Zoom in to see buildings"}
        </div>
      )}

      {!changesOpen && (
        <div className="absolute top-3 left-3 z-30 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              cancelHoleDrawing();
              cancelSliceDrawing();
              setChangesOpen(true);
            }}
            disabled={changeCount === 0}
            aria-controls="changes-sidebar"
            className={`rounded-lg px-3 py-2 text-sm font-semibold shadow-md transition-colors ${
              changeCount > 0
                ? "bg-violet-700 text-white hover:bg-violet-800"
                : "cursor-not-allowed bg-slate-200 text-slate-500"
            }`}
          >
            {changeCount} {changeCount === 1 ? "change" : "changes"}
          </button>
          <button
            type="button"
            onClick={toggleCutHole}
            disabled={!live && !cutHoleActive}
            aria-pressed={cutHoleActive}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold shadow-md transition-colors ${
              cutHoleActive
                ? "border-violet-700 bg-violet-700 text-white hover:bg-violet-800"
                : live
                  ? "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                  : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
            }`}
          >
            Cut hole
          </button>
          <button
            type="button"
            onClick={toggleSlice}
            disabled={!live && !sliceActive}
            aria-pressed={sliceActive}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold shadow-md transition-colors ${
              sliceActive
                ? "border-violet-700 bg-violet-700 text-white hover:bg-violet-800"
                : live
                  ? "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                  : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
            }`}
          >
            Slice
          </button>
        </div>
      )}

      {cutHoleActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Click to add nodes · first node or Enter closes · Esc cancels
        </div>
      )}

      {sliceActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Boundary → boundary polyline, or close an interior loop · Esc cancels
        </div>
      )}

      {photoAdjustActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Drag to align photos · map position stays fixed
        </div>
      )}

      <ChangesSidebar
        open={changesOpen}
        edits={edits.edits}
        geometryEdits={geometryEdits}
        createdParts={createdParts}
        onClose={() => setChangesOpen(false)}
        onNavigate={navigateToEditedEntity}
        onRevertEntity={revertEntity}
        onRemoveProperty={removeProperty}
        onEditProperty={editProperty}
        onRevertAll={revertAllChanges}
        onSubmit={() => setSubmitOpen(true)}
      />

      <SubmitDialog
        open={submitOpen}
        input={submitInput}
        displayed={displayedFeaturesRef.current}
        onClose={() => setSubmitOpen(false)}
        onNavigate={(entity) => {
          setSubmitOpen(false);
          navigateToEditedEntity(entity);
        }}
        onUploaded={onUploaded}
      />

      <BuildingPanel
        selection={selection}
        initialHeading={selectionBearing}
        edits={edits}
        onLidarCloudChange={onLidarCloudChange}
        onSelectEntity={selectLoadedEntity}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}
