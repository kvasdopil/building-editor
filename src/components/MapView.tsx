"use client";

import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import {
  AttributionControl,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type LayerSpecification,
  Map as MaplibreMap,
  type MapMouseEvent,
  MercatorCoordinate,
  NavigationControl,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiMove } from "react-icons/fi";
import { PiExcludeBold, PiKnifeBold, PiPlusCircleBold, PiSelectionPlusBold } from "react-icons/pi";
import "maplibre-gl/dist/maplibre-gl.css";
import { BuildingPanel } from "./BuildingPanel";
import { ChangesSidebar } from "./ChangesSidebar";
import { SubmitDialog } from "./SubmitDialog";
import { addPartToBuilding } from "@/lib/add-part";
import { installDevRafShim } from "@/lib/dev-raf-shim";
import {
  applyEditsToFeatureCollection,
  applyEditsToSelection,
  type EditMap,
  type PendingGeometry,
  useBuildingEdits,
  usePendingGeometry,
} from "@/lib/edits";
import type { BuildingElement, BuildingSelection, LngLat } from "@/lib/buildings";
import {
  boundsCenter,
  pointInRing,
  elementBounds,
  openRing,
  padBounds,
  toFootprints,
} from "@/lib/geometry";
import {
  buildHash,
  DEFAULT_VIEW,
  effectiveView,
  hashRef,
  type ViewHash,
  viewMode,
  viewState,
  writeHash,
} from "@/lib/map-hash";
import { useSelectionHash } from "@/lib/use-selection-hash";
import {
  applyGeometryEdits,
  createPartFeature,
  type CreatedPartMap,
  type EditableGeometry,
  geometryHasVertex,
  type GeometryEditMap,
  geometryVertices,
  insertGeometryVertex,
  edgeRunNodes,
  mergeSharedGeometryVertices,
  moveSharedGeometryVertex,
  moveSharedGeometryVertices,
  nearestRightAnglePoint,
  type NodeMove,
  recordNodeMove,
  removeGeometryRingNode,
  segmentNormal,
  subtractMaskFromGeometry,
  weldNewVertices,
  weldVerticesIntoGeometries,
} from "@/lib/geometry-edits";
import { createTileLoader, type LoaderStatus, type TileLoader } from "@/lib/osm/client";
import { drawnId, drawnRef, parseOsmRef } from "@/lib/osm/ref";
import { relationMemberWays } from "@/lib/osm/member-way";
import { NODE_REUSE_METERS } from "@/lib/osm/nodes";
import type { IssueFix } from "@/lib/osm/issues";
import { coordinateKey, METERS_PER_DEG_LAT, roundToOsmGrid } from "@/lib/osm/precision";
import { selectFromOsm } from "@/lib/osm/select";
import { PART_ROOF_KEYS } from "@/lib/part-tags";
import {
  edgeNormalRoofDirection,
  isCompassRoofDirection,
  minimumRoofFrame,
  parseRoofDirection,
  roofCenter,
  roofFrameElement,
  type Point2,
} from "@/lib/roofs";
import { sliceBuilding } from "@/lib/slice";
import type { LidarCloud } from "@/lib/lidar";
import { type LidarColourMode, LidarMapLayer } from "@/lib/lidar-map-layer";
import { type Lod1Match, lod1TilesFor, matchLod1 } from "@/lib/lod1";

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
 * At and above this zoom the map adds live editable OSM footprints over the
 * normal basemap (ADR 0001). Below it, only the basemap is shown.
 */
// Keep the fixed cache grid at z16, but reveal its live data half a zoom level
// earlier. At z15.5 a typical viewport still fits the loader's 12-tile cap.
const LIVE_ZOOM = 15.5;

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

/**
 * What sits under the editor overlays. Only one can be shown at a time — the
 * imagery and the point cloud are both "evidence" layers that replace the
 * basemap — so they are one switch rather than two toggles that cancel.
 */
type MapUnderlay = "map" | "photos" | "lidar";

const MAP_UNDERLAYS: {
  underlay: MapUnderlay;
  label: string;
  title: string;
  needsSelection?: boolean;
}[] = [
  { underlay: "map", label: "Map", title: "The ordinary basemap" },
  { underlay: "photos", label: "Photos", title: "Satellite imagery under the boundaries" },
  {
    underlay: "lidar",
    label: "LiDAR",
    title: "The selected building's laser point cloud, seen from straight above",
    needsSelection: true,
  },
];

/** What the LiDAR view can colour, in toolbar order. */
const LIDAR_COLOUR_MODES: { mode: LidarColourMode; label: string; title: string }[] = [
  {
    mode: "colour",
    label: "Color",
    title: "Colour each point from the survey's orthophoto sample",
  },
  {
    mode: "height",
    label: "Height",
    title: "Colour each point by height, violet lowest to red highest over the points in view",
  },
  {
    mode: "diff",
    label: "Diff",
    title:
      "Colour each point by its height against the roof modelled from OSM: " +
      "green agrees, red is above the model, violet below",
  },
  {
    mode: "surface",
    label: "Surface",
    title:
      "Split the outline into half-metre cells along its own axes and fill each with " +
      "the surface it holds: hue faces, saturation slopes, brightness rises",
  },
];

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
const LOD1_SNAP_TARGET = "lod1-reference";

/** Fetch the LOD1 blocks under the selected building and pick the best match. */
function useLod1(selection: BuildingSelection | null): Lod1Match | null {
  const selectedId =
    selection && selection.selected.properties.role !== "part" ? selection.selected.id : null;
  const [result, setResult] = useState<{ selectedId: string; match: Lod1Match | null } | null>(
    null,
  );

  useEffect(() => {
    if (!selection || !selectedId) return;
    let cancelled = false;
    void Promise.all(
      lod1TilesFor(selection.selected).map((tile) =>
        fetch(`/api/lod1/tile/${tile.z}/${tile.x}/${tile.y}`)
          .then((response) =>
            response.ok ? (response.json() as Promise<FeatureCollection>) : null,
          )
          .catch(() => null),
      ),
    ).then((collections) => {
      if (cancelled) return;
      const usable = collections.filter((collection): collection is FeatureCollection =>
        Boolean(collection),
      );
      setResult({ selectedId, match: matchLod1(selection.selected, usable) });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selection]);

  return result?.selectedId === selectedId ? result.match : null;
}

interface HoleDraft {
  targetId: string | null;
  nodes: LngLat[];
  snap: BoundarySnap | null;
}

const EMPTY_HOLE_DRAFT: HoleDraft = { targetId: null, nodes: [], snap: null };

interface SliceDraft {
  targetId: string | null;
  mode: "open" | "loop" | null;
  nodes: LngLat[];
  snap: BoundarySnap | null;
}

const EMPTY_SLICE_DRAFT: SliceDraft = { targetId: null, mode: null, nodes: [], snap: null };

interface AddPartDraft {
  targetId: string | null;
  nodes: LngLat[];
  snap: BoundarySnap | null;
}

const EMPTY_ADD_PART_DRAFT: AddPartDraft = { targetId: null, nodes: [], snap: null };

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

/**
 * Font Awesome's `fa-arrow-right`, the filled glyph `FaArrowRight` renders. It
 * is drawn in a 448 x 512 box where the mark itself spans x 0..441 and y
 * 45..467.
 */
const ARROW_RIGHT_PATH =
  "M190.5 66.9l22.2-22.2c9.4-9.4 24.6-9.4 33.9 0L441 239c9.4 9.4 9.4 24.6 0 33.9L246.6 467.3c-9.4 9.4-24.6 9.4-33.9 0l-22.2-22.2c-9.5-9.5-9.3-25 .4-34.3L311.4 296H24c-13.3 0-24-10.7-24-24v-32c0-13.3 10.7-24 24-24h287.4L190.9 101.2c-9.8-9.3-10-24.8-.4-34.3z";
const ARROW_RIGHT_WIDTH = 441;
const ARROW_RIGHT_TOP = 44.7;
const ARROW_RIGHT_HEIGHT = 422.6;

/**
 * The white arrow that sits inside an entrance dot. The glyph's bounding box is
 * fitted to the icon and centred, so how much of the entrance disc the arrow
 * fills is exactly `size` against the disc's diameter.
 */
function entranceArrowImage(size: number, pixelRatio: number): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = size * pixelRatio;
  canvas.height = size * pixelRatio;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const scale = (size * pixelRatio) / ARROW_RIGHT_WIDTH;
  context.scale(scale, scale);
  context.translate(0, (ARROW_RIGHT_WIDTH - ARROW_RIGHT_HEIGHT) / 2 - ARROW_RIGHT_TOP);
  context.fillStyle = "#ffffff";
  context.fill(new Path2D(ARROW_RIGHT_PATH));
  return context.getImageData(0, 0, canvas.width, canvas.height);
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

function distanceToSegment(
  x: number,
  y: number,
  start: readonly [number, number],
  end: readonly [number, number],
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const amount =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - start[0]) * dx + (y - start[1]) * dy) / lengthSquared));
  return Math.hypot(x - (start[0] + amount * dx), y - (start[1] + amount * dy));
}

/** White-cased chevron whose sharp corner points toward the roof slope. */
function roofDirectionImage(size: number) {
  const data = new Uint8Array(size * size * 4);
  const tip: [number, number] = [(size - 1) / 2, 2];
  const left: [number, number] = [3, size - 5];
  const right: [number, number] = [size - 4, size - 5];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.min(
        distanceToSegment(x, y, tip, left),
        distanceToSegment(x, y, tip, right),
      );
      if (distance <= 3.25) data.set([255, 255, 255, 245], (y * size + x) * 4);
      if (distance <= 1.6) data.set([124, 58, 237, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** Local east/south points keep map bearings aligned with the Three.js roof frame. */
function localRoofOutlines(element: BuildingElement, origin: LngLat): Point2[][] {
  const cosLat = Math.max(Math.cos((origin[1] * Math.PI) / 180), 0.01);
  return element.polygons.map((footprint) =>
    openRing(footprint.outer).map(
      ([lon, lat]): Point2 => [(lon - origin[0]) * cosLat, origin[1] - lat],
    ),
  );
}

/** Selected skillion centroid and its resolved downhill map bearing. */
function skillionDirectionFeatures(selection: BuildingSelection | null): FeatureCollection {
  if (!selection) return EMPTY;
  const element = selection.selected;
  const parent = selection.building;
  const shape = element.properties.roof_shape ?? parent.properties.roof_shape;
  if (shape !== "skillion") return EMPTY;

  const origin = boundsCenter(elementBounds(element));
  const center = roofCenter(localRoofOutlines(element, origin));
  const cosLat = Math.max(Math.cos((origin[1] * Math.PI) / 180), 0.01);
  const coordinates: LngLat = [origin[0] + center[0] / cosLat, origin[1] - center[1]];
  const rawDirection = element.properties.roof_direction ?? parent.properties.roof_direction;
  const requested = parseRoofDirection(rawDirection);
  const frameElement = roofFrameElement(element, parent);
  const frameOutlines = localRoofOutlines(frameElement, origin);

  let bearing = requested;
  if (bearing !== undefined && isCompassRoofDirection(rawDirection)) {
    bearing = edgeNormalRoofDirection(frameOutlines, roofCenter(frameOutlines), bearing);
  } else if (bearing === undefined) {
    const frame = minimumRoofFrame(frameOutlines);
    if (!frame) return EMPTY;
    bearing = (Math.atan2(frame.across[0], -frame.across[1]) * 180) / Math.PI;
    if (bearing < 0) bearing += 360;
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { bearing },
        geometry: { type: "Point", coordinates },
      },
    ],
  };
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

/**
 * How a footprint vertex is drawn. An entrance is the one node kind a mapper
 * reads as a place rather than a corner, so it gets its own mark; everything
 * else only says whether the node carries tags of its own.
 */
type SelectionNodeRole = "entrance" | "tagged" | "plain";

/** `entrance=*` marks a door; `building=entrance` is the deprecated spelling. */
function selectionNodeRole(tags: Record<string, string> | undefined): SelectionNodeRole {
  if (!tags || Object.keys(tags).length === 0) return "plain";
  return tags.entrance || tags.building === "entrance" ? "entrance" : "tagged";
}

/** One point per footprint vertex, without GeoJSON's repeated closing coordinate. */
function selectionNodeFeatures(selection: BuildingSelection | null): FeatureCollection {
  if (!selection) return EMPTY;
  const roles = new Map<string, SelectionNodeRole>();
  const noteRole = (coordinates: LngLat | undefined, tags: Record<string, string> | undefined) => {
    const role = selectionNodeRole(tags);
    if (!coordinates || role === "plain") return;
    const key = coordinateKey(roundToOsmGrid(coordinates));
    // A corner shared by several ways keeps the louder mark of the two.
    if (role === "entrance" || !roles.has(key)) roles.set(key, role);
  };
  const properties = selection.selected.properties;
  const nodeIds = Array.isArray(properties.node_ids) ? (properties.node_ids as number[]) : [];
  const nodeTags = (properties.node_tags ?? {}) as Record<string, Record<string, string>>;
  const outer = selection.selected.polygons[0]?.outer ?? [];
  nodeIds.forEach((id, index) => noteRole(outer[index], nodeTags[id]));
  for (const member of relationMemberWays(properties.member_ways)) {
    member.nodes.forEach((id, index) =>
      noteRole(member.coordinates[index], member.node_tags?.[id]),
    );
  }
  const features: Feature<Point>[] = selection.selected.polygons.flatMap(
    (footprint, polygonIndex) =>
      [footprint.outer, ...footprint.holes].flatMap((ring, ringIndex) =>
        openRing(ring).map((coordinates, vertexIndex) => ({
          type: "Feature",
          properties: {
            polygonIndex,
            ringIndex,
            vertexIndex,
            role: roles.get(coordinateKey(roundToOsmGrid(coordinates))) ?? "plain",
          },
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

/** Every corner in the matched generalized LOD1 footprint. */
function lod1Nodes(match: Lod1Match | null): LngLat[] {
  if (!match) return [];
  return match.outline.features.flatMap((feature) =>
    feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon"
      ? geometryVertices(feature.geometry)
      : [],
  );
}

/** Nearest LOD1 reference node within a screen-space snap tolerance. */
function nearestLod1Node(
  map: MaplibreMap,
  nodes: LngLat[],
  point: { x: number; y: number },
  tolerance = 9,
): BoundarySnap | null {
  let nearest: { coordinates: LngLat; distance: number } | null = null;
  for (const coordinates of nodes) {
    const projected = map.project(coordinates);
    const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
    if (distance > tolerance || (nearest && distance >= nearest.distance)) continue;
    nearest = { coordinates, distance };
  }
  return nearest
    ? {
        targetId: LOD1_SNAP_TARGET,
        coordinates: roundToOsmGrid(nearest.coordinates),
        distance: nearest.distance,
        kind: "node",
      }
    : null;
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

/** Every editable polygon in the currently loaded local model, keyed by entity. */
function polygonalGeometries(collection: FeatureCollection): GeometryByEntity {
  const geometries: GeometryByEntity = {};
  for (const feature of collection.features) {
    const id = feature.properties?.id;
    if (
      typeof id === "string" &&
      (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon")
    ) {
      geometries[id] = feature.geometry;
    }
  }
  return geometries;
}

function collectionWithGeometries(
  collection: FeatureCollection,
  geometries: GeometryByEntity,
): FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const id = feature.properties?.id;
      return typeof id === "string" && geometries[id]
        ? { ...feature, geometry: geometries[id] }
        : feature;
    }),
  };
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
  /** New vertices are insertions, never moves of an existing OSM node. */
  created: boolean;
  originalGeometries: GeometryByEntity;
  geometries: GeometryByEntity;
  snap: NodeDragSnap | null;
  rightAngleConstraints: RightAngleConstraint[];
  baseGluedEntities: Set<string>;
  gluedEntities: Set<string>;
}

/** A whole stretch of wall being dragged, with every footprint that shares it. */
interface EdgeDrag {
  /** The run's nodes as they stood when the drag began, in ring order. */
  originalCoordinates: LngLat[];
  /** Where they sit now; absent until the pointer has moved. */
  coordinates: LngLat[] | null;
  /** The line the wall slides on: its own unit normal, east/north metres. */
  normal: [number, number];
  /** Where the drag began, on the ground rather than on the screen. */
  origin: LngLat;
  /** How far it has slid along that normal, metres; signed. */
  offset: number;
  originalGeometries: GeometryByEntity;
  geometries: GeometryByEntity;
}

interface RightAngleConstraint {
  previous: LngLat;
  next: LngLat;
}

function rightAngleConstraints(
  geometries: GeometryByEntity,
  coordinates: LngLat,
): RightAngleConstraint[] {
  const constraints = new Map<string, RightAngleConstraint>();
  for (const geometry of Object.values(geometries)) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const nodes = openRing(ring as LngLat[]);
        for (const [index, node] of nodes.entries()) {
          if (node[0] !== coordinates[0] || node[1] !== coordinates[1]) continue;
          const previous = nodes[(index - 1 + nodes.length) % nodes.length];
          const next = nodes[(index + 1) % nodes.length];
          if (!previous || !next) continue;
          const keys = [
            coordinateKey(roundToOsmGrid(previous)),
            coordinateKey(roundToOsmGrid(next)),
          ].sort();
          constraints.set(keys.join("|"), { previous, next });
        }
      }
    }
  }
  return [...constraints.values()];
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

/**
 * How far a ring may turn at a node and still be the same wall. A hand-traced
 * facade collects slight kinks well under this; a real corner is far over it.
 */
const EDGE_RUN_MAX_TURN_DEG = 15;

/**
 * Screen reach of a wall's grab spot inside Add node mode, which keeps the
 * rest of the edge for inserting a node.
 */
const EDGE_HANDLE_PIXELS = 7;

function withinEdgeHandle(
  map: MaplibreMap,
  midpoint: LngLat,
  click: { x: number; y: number },
): boolean {
  const point = map.project(midpoint);
  return Math.hypot(click.x - point.x, click.y - point.y) <= EDGE_HANDLE_PIXELS;
}

/** The stretch of wall a midpoint handle belongs to, and the line it moves on. */
interface EdgeRun {
  /** The nodes that move with it, in ring order. */
  coordinates: LngLat[];
  /** Unit normal of the grabbed segment, in east/north metres. */
  normal: [number, number];
  /** The grabbed segment's midpoint, which is where Add node mode grabs it. */
  midpoint: LngLat;
}

function edgeRunFor(selection: BuildingSelection, segment: SelectionSegment): EdgeRun | null {
  const footprint = selection.selected.polygons[segment.polygonIndex];
  const ring = footprint && [footprint.outer, ...footprint.holes][segment.ringIndex];
  if (!ring) return null;
  const nodes = openRing(ring);
  const run = edgeRunNodes(nodes, segment.segmentIndex, EDGE_RUN_MAX_TURN_DEG);
  // The wall's own normal comes from the segment whose handle was grabbed: a
  // run with a slight kink in it has no single direction, and the piece the
  // mapper aimed at is the one they mean.
  const normal = segmentNormal(nodes, segment.segmentIndex);
  if (run.length < 2 || !normal) return null;
  const start = nodes[segment.segmentIndex];
  const end = nodes[(segment.segmentIndex + 1) % nodes.length];
  return {
    coordinates: run.map((index) => nodes[index]),
    normal,
    midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
  };
}

interface BoundarySnap {
  targetId: string;
  coordinates: LngLat;
  distance: number;
  kind: "edge" | "node";
}

const RIGHT_ANGLE_SNAP_TARGET = "right-angle";

interface RightAngleSnap {
  targetId: typeof RIGHT_ANGLE_SNAP_TARGET;
  coordinates: LngLat;
  distance: number;
  kind: "right-angle";
  constraint: RightAngleConstraint;
}

type NodeDragSnap = BoundarySnap | RightAngleSnap;

function nearestRightAngleSnap(
  map: MaplibreMap,
  constraints: RightAngleConstraint[],
  click: { x: number; y: number },
  tolerance = 10,
): RightAngleSnap | null {
  let nearest: RightAngleSnap | null = null;
  for (const constraint of constraints) {
    const previous = map.project(constraint.previous);
    const next = map.project(constraint.next);
    const candidate = nearestRightAnglePoint(previous, next, click, tolerance);
    if (!candidate || (nearest && candidate.distance >= nearest.distance)) continue;
    const lngLat = map.unproject([candidate.x, candidate.y]);
    nearest = {
      targetId: RIGHT_ANGLE_SNAP_TARGET,
      coordinates: roundToOsmGrid([lngLat.lng, lngLat.lat]),
      distance: candidate.distance,
      kind: "right-angle",
      constraint,
    };
  }
  return nearest;
}

function rightAngleGizmo(map: MaplibreMap, snap: RightAngleSnap): FeatureCollection {
  const vertex = map.project(snap.coordinates);
  const previous = map.project(snap.constraint.previous);
  const next = map.project(snap.constraint.next);
  const previousLength = Math.hypot(previous.x - vertex.x, previous.y - vertex.y);
  const nextLength = Math.hypot(next.x - vertex.x, next.y - vertex.y);
  const halfSize = Math.min(5, previousLength * 0.2, nextLength * 0.2);
  if (halfSize < 2) return EMPTY;
  const previousUnit = {
    x: (previous.x - vertex.x) / previousLength,
    y: (previous.y - vertex.y) / previousLength,
  };
  const nextUnit = {
    x: (next.x - vertex.x) / nextLength,
    y: (next.y - vertex.y) / nextLength,
  };
  const screenPoints = [
    {
      x: vertex.x + (previousUnit.x + nextUnit.x) * halfSize,
      y: vertex.y + (previousUnit.y + nextUnit.y) * halfSize,
    },
    {
      x: vertex.x + (previousUnit.x - nextUnit.x) * halfSize,
      y: vertex.y + (previousUnit.y - nextUnit.y) * halfSize,
    },
    {
      x: vertex.x + (-previousUnit.x - nextUnit.x) * halfSize,
      y: vertex.y + (-previousUnit.y - nextUnit.y) * halfSize,
    },
    {
      x: vertex.x + (-previousUnit.x + nextUnit.x) * halfSize,
      y: vertex.y + (-previousUnit.y + nextUnit.y) * halfSize,
    },
  ];
  screenPoints.push(screenPoints[0]);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: screenPoints.map((point) => {
            const lngLat = map.unproject([point.x, point.y]);
            return [lngLat.lng, lngLat.lat];
          }),
        },
      },
    ],
  };
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

function buildingOuterBoundaryRings(selection: BuildingSelection): LngLat[][] {
  return selection.building.polygons.map((footprint) => footprint.outer);
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
  excludedVertex?: LngLat,
): BoundarySnap | null {
  let nearestNode: BoundarySnap | null = null;
  let nearestEdge: BoundarySnap | null = null;
  const nodeTolerance = Math.min(tolerance, 9);
  const excludedKey = excludedVertex ? coordinateKey(roundToOsmGrid(excludedVertex)) : undefined;
  for (const ring of projectedRings) {
    for (const node of ring) {
      if (excludedKey === coordinateKey(roundToOsmGrid(node.coordinates))) continue;
      const distance = Math.hypot(click.x - node.x, click.y - node.y);
      if (distance > nodeTolerance || (nearestNode && distance >= nearestNode.distance)) continue;
      nearestNode = { targetId, coordinates: node.coordinates, distance, kind: "node" };
    }
    for (let index = 0; index < ring.length; index++) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      if (
        excludedKey &&
        (excludedKey === coordinateKey(roundToOsmGrid(start.coordinates)) ||
          excludedKey === coordinateKey(roundToOsmGrid(end.coordinates)))
      )
        continue;
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
  excludedVertex?: LngLat,
): BoundarySnap | null {
  if (target) {
    target.projected ??= projectBoundaryRings(map, target.rings);
    return nearestProjectedBoundary(
      target.projected,
      click,
      target.targetId,
      tolerance,
      excludedVertex,
    );
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
      excludedVertex,
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
  /** Draw building parts rather than outlines: fainter, dashed. */
  part?: boolean;
}

/** The fill + line pair for one class of live OSM footprint. */
function footprintLayers({
  id,
  source,
  part = false,
}: FootprintLayerOptions): LayerSpecification[] {
  const shared = {
    source,
    filter: [part ? "==" : "!=", ["get", "role"], "part"] as FilterSpecification,
    minzoom: LIVE_ZOOM,
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
      live: { type: "geojson", data: EMPTY, attribution: "© OpenStreetMap contributors" },
      lod1: { type: "geojson", data: EMPTY },
      selection: { type: "geojson", data: EMPTY },
      "selection-nodes": { type: "geojson", data: EMPTY },
      "selection-node-hover": { type: "geojson", data: EMPTY },
      "edge-hover": { type: "geojson", data: EMPTY },
      "right-angle-gizmo": { type: "geojson", data: EMPTY },
      "roof-direction": { type: "geojson", data: EMPTY },
      "validation-location": { type: "geojson", data: EMPTY },
    },
    layers: [
      {
        id: "lidar-background",
        type: "background",
        layout: { visibility: "none" },
        paint: { "background-color": "#0b1020" },
      },
      ...footprintLayers({ id: "live-building", source: "live" }),
      ...footprintLayers({ id: "live-part", source: "live", part: true }),
      {
        id: "lod1-outline",
        type: "line",
        source: "lod1",
        paint: { "line-color": "#d3d3d3", "line-width": 3, "line-opacity": 0.95 },
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
      {
        id: "edge-hover",
        type: "line",
        source: "edge-hover",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#7c3aed", "line-width": 5, "line-opacity": 0.85 },
      },
      {
        id: "selection-nodes",
        type: "circle",
        source: "selection-nodes",
        paint: {
          "circle-color": ["match", ["get", "role"], "tagged", "#ffffff", "#000000"],
          "circle-radius": ["match", ["get", "role"], "entrance", 7, "tagged", 4, 3],
          "circle-stroke-color": "#000000",
          "circle-stroke-width": ["match", ["get", "role"], "tagged", 1.5, 0],
        },
      },
      {
        // Rides on the entrance disc drawn just below, so the arrow must not be
        // dropped for collisions the way a label would be.
        id: "selection-node-entrances",
        type: "symbol",
        source: "selection-nodes",
        filter: ["==", ["get", "role"], "entrance"],
        layout: {
          "icon-image": "entrance-arrow",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
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
      {
        id: "right-angle-gizmo-casing",
        type: "line",
        source: "right-angle-gizmo",
        paint: {
          "line-color": "#ffffff",
          "line-width": 5,
          "line-opacity": 0.95,
        },
      },
      {
        id: "right-angle-gizmo",
        type: "line",
        source: "right-angle-gizmo",
        paint: {
          "line-color": "#7c3aed",
          "line-width": 2.5,
        },
      },
      {
        id: "roof-direction",
        type: "symbol",
        source: "roof-direction",
        layout: {
          "icon-image": "roof-direction-chevron",
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      {
        id: "validation-location-casing",
        type: "circle",
        source: "validation-location",
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": 11,
          "circle-opacity": 0.95,
        },
      },
      {
        id: "validation-location",
        type: "circle",
        source: "validation-location",
        paint: {
          "circle-color": "#e11d48",
          "circle-radius": 7,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
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

/** Main screen: MapLibre map with live OSM buildings and the 3D side panel. */
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
  const [lidarColourMode, setLidarColourMode] = useState<LidarColourMode>("colour");
  const [lidarLines, setLidarLines] = useState(false);

  const mapUnderlay: MapUnderlay = photos ? "photos" : lidar ? "lidar" : "map";
  const setMapUnderlay = useCallback((underlay: MapUnderlay) => {
    setPhotos(underlay === "photos");
    setLidar(underlay === "lidar");
    if (underlay !== "photos") setPhotoAdjustActive(false);
  }, []);
  const [lod1Visible, setLod1Visible] = useState(true);
  const [photoAdjustActive, setPhotoAdjustActive] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [cutHoleActive, setCutHoleActive] = useState(false);
  const [sliceActive, setSliceActive] = useState(false);
  const [addPartActive, setAddPartActive] = useState(false);
  const [addNodeActive, setAddNodeActive] = useState(false);
  const [geometryEdits, setGeometryEdits] = useState<GeometryEditMap>({});
  const [createdParts, setCreatedParts] = useState<CreatedPartMap>({});
  const [selection, setSelection] = useState<BuildingSelection | null>(null);
  const lod1Match = useLod1(selection);
  const selectionBuildingId = selection?.building.id ?? null;
  const selectionRef = useRef<BuildingSelection | null>(selection);
  const [selectionBearing, setSelectionBearing] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [validationLocation, setValidationLocation] = useState<LngLat | null>(null);
  /** Pending-changes entity to select as soon as its tile is loaded. */
  const pendingSelectRef = useRef<string | null>(null);
  const cutHoleActiveRef = useRef(cutHoleActive);
  const sliceActiveRef = useRef(sliceActive);
  const addPartActiveRef = useRef(addPartActive);
  const addNodeActiveRef = useRef(addNodeActive);
  const addNodeTargetRef = useRef<string | null>(null);
  const photoAdjustActiveRef = useRef(photoAdjustActive);
  const suppressSelectionClickRef = useRef(false);
  /** A node or wall drag is in flight, so Escape belongs to it rather than to a mode. */
  const dragActiveRef = useRef(false);
  const holeDraftRef = useRef<HoleDraft>(EMPTY_HOLE_DRAFT);
  const sliceDraftRef = useRef<SliceDraft>(EMPTY_SLICE_DRAFT);
  const addPartDraftRef = useRef<AddPartDraft>(EMPTY_ADD_PART_DRAFT);
  const sliceBoundaryCacheRef = useRef<SliceBoundaryCache | null>(null);
  const addPartBoundaryCacheRef = useRef<SliceBoundaryCache | null>(null);
  const nextPartIdRef = useRef(1);
  const geometryEditsRef = useRef(geometryEdits);
  const createdPartsRef = useRef(createdParts);
  const edits = useBuildingEdits();
  const editsRef = useRef(edits.edits);
  cutHoleActiveRef.current = cutHoleActive;
  sliceActiveRef.current = sliceActive;
  addPartActiveRef.current = addPartActive;
  addNodeActiveRef.current = addNodeActive;
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
  const displayedFeatures = useMemo(
    () => applyLocalEdits(liveFeatures, edits.edits, geometryEdits, createdParts),
    [createdParts, edits.edits, geometryEdits, liveFeatures],
  );
  const effectiveSelection = useMemo(
    () => (selection ? applyEditsToSelection(selection, edits.edits) : null),
    [edits.edits, selection],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    installDevRafShim();
    // Bundlers can mangle MapLibre's worker URL; serve it from /public instead.
    setWorkerUrl("/maplibre-gl-worker.mjs");
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
      const nextLive = zoom >= LIVE_ZOOM;
      setLive(nextLive);
      if (!nextLive) setSelection(null);
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
      if (
        !cutHoleActiveRef.current &&
        !sliceActiveRef.current &&
        !addPartActiveRef.current &&
        !photoAdjustActiveRef.current
      )
        instance.getCanvas().style.cursor = cursor;
    };
    instance.on("click", (event: MapMouseEvent) => {
      if (suppressSelectionClickRef.current) {
        suppressSelectionClickRef.current = false;
        return;
      }
      if (
        cutHoleActiveRef.current ||
        sliceActiveRef.current ||
        addPartActiveRef.current ||
        photoAdjustActiveRef.current
      )
        return;
      // Below live-OSM zoom the map is deliberately just the normal basemap.
      if (instance.getZoom() < LIVE_ZOOM) {
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
      if (addNodeActiveRef.current && !next) return;
      if (next) {
        setSelectionBearing(instance.getBearing());
        if (addNodeActiveRef.current) addNodeTargetRef.current = next.selected.id;
      }
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
      instance.addImage("roof-direction-chevron", roofDirectionImage(27));
      const entranceArrow = entranceArrowImage(9, 2);
      if (entranceArrow) instance.addImage("entrance-arrow", entranceArrow, { pixelRatio: 2 });
      const lidarBackground = overlay.layers.find((layer) => layer.id === "lidar-background");
      if (lidarBackground) instance.addLayer(lidarBackground);
      const lidarLayer = new LidarMapLayer();
      lidarLayerRef.current = lidarLayer;
      instance.addLayer(lidarLayer);
      for (const layer of overlay.layers) {
        if (layer.id !== "lidar-background") instance.addLayer(layer);
      }

      for (const layer of ["live-building-fill", "live-part-fill"]) {
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

  /**
   * The view the URL asked for, read once during render rather than inside the
   * effect that applies it. Two things make the timing matter: the effect that
   * writes the hash runs in the same commit as the one that applies it, so it
   * would see the state still at its server-rendered defaults and replace the
   * incoming view with them; and React's development double-mount would then
   * re-read a hash that had already been overwritten. A ref settled before any
   * effect runs is immune to both.
   */
  const initialView = useRef<ViewHash | null>(null);
  if (initialView.current === null) {
    initialView.current =
      typeof window === "undefined" ? DEFAULT_VIEW : effectiveView(window.location.hash);
  }

  // Applied after mount rather than as initial state, because the server never
  // sees the hash and rendering it directly would not match what it sent.
  useEffect(() => {
    const view = initialView.current ?? DEFAULT_VIEW;
    setLod1Visible(view.lod1);
    setLidarLines(view.lines);
    const wanted = viewState(view.mode);
    setPhotos(wanted.photos);
    setLidar(wanted.lidar);
    if (wanted.colour) setLidarColourMode(wanted.colour);
  }, []);

  const viewArmed = useRef(false);
  useEffect(() => {
    const current: ViewHash = {
      mode: viewMode(photos, lidar, lidarColourMode),
      lines: lidarLines,
      lod1: lod1Visible,
    };
    if (!viewArmed.current) {
      // Hold off until the restored view has actually reached the state. Until
      // then the state is still the defaults, and writing it would erase the
      // view the URL arrived with.
      const target = initialView.current ?? DEFAULT_VIEW;
      if (
        current.mode !== target.mode ||
        current.lines !== target.lines ||
        current.lod1 !== target.lod1
      ) {
        return;
      }
      viewArmed.current = true;
    }
    writeHash(buildHash(hashRef(window.location.hash), current));
  }, [lidar, lidarColourMode, lidarLines, lod1Visible, photos]);

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
    void source?.setData(draftFeatures(draft.nodes, true, draft.snap));
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

  const updateAddPartDraft = useCallback((draft: AddPartDraft) => {
    addPartDraftRef.current = draft;
    const source = mapRef.current?.getSource<GeoJSONSource>("hole-draft");
    void source?.setData(draftFeatures(draft.nodes, true, draft.snap));
  }, []);

  const cancelAddPartDrawing = useCallback(() => {
    addPartBoundaryCacheRef.current = null;
    updateAddPartDraft(EMPTY_ADD_PART_DRAFT);
    setAddPartActive(false);
  }, [updateAddPartDraft]);

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

  /** A part with an explicit roof shape owns it; the outline must stop supplying one. */
  const clearParentRoofShape = useCallback(
    (entity: string) => {
      const feature = displayedFeaturesRef.current.features.find(
        (candidate) => candidate.properties?.id === entity,
      );
      if (feature?.properties?.role !== "part") return;
      const parentId =
        typeof feature.properties.parent_id === "string"
          ? feature.properties.parent_id
          : selectFromOsm(displayedFeaturesRef.current, entity)?.building.id;
      if (!parentId || parentId === entity) return;
      const parent = displayedFeaturesRef.current.features.find(
        (candidate) => candidate.properties?.id === parentId,
      );
      const effectiveTags = (parent?.properties?.tags ?? {}) as Record<string, string>;
      if (!effectiveTags["roof:shape"]) return;
      const rawParent = liveFeaturesRef.current.features.find(
        (candidate) => candidate.properties?.id === parentId,
      );
      const rawTags = (rawParent?.properties?.tags ?? {}) as Record<string, string>;
      edits.setTag(parentId, "roof:shape", "", rawTags["roof:shape"]);
    },
    [edits],
  );

  /** Store one tag edit and enforce roof-shape ownership when the entity is a part. */
  const editEntityTag = useCallback(
    (entity: string, key: string, value: string, currentValue?: string) => {
      edits.setTag(entity, key, value, currentValue);
      if (key === "roof:shape") clearParentRoofShape(entity);
    },
    [clearParentRoofShape, edits],
  );

  /** Remove roof details from an outline after its first parts receive explicit copies. */
  const clearTransferredRoofTags = useCallback(
    (building: BuildingElement) => {
      const effectiveTags = (building.properties.tags ?? {}) as Record<string, string>;
      const raw = liveFeaturesRef.current.features.find(
        (candidate) => candidate.properties?.id === building.id,
      );
      const rawTags = (raw?.properties?.tags ?? {}) as Record<string, string>;
      for (const key of PART_ROOF_KEYS) {
        if (effectiveTags[key]) edits.setTag(building.id, key, "", rawTags[key]);
      }
    },
    [edits],
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
        if (property === "roof:shape") clearParentRoofShape(entity);
        return;
      }
      // Keep the first-seen original, so reverting still restores what OSM has.
      editEntityTag(entity, property, value, edits.edits[entity]?.original[property]);
    },
    [clearParentRoofShape, editEntityTag, edits.edits, updateDrawnPartTags],
  );

  /** Apply a validator's deterministic correction without leaving review. */
  const fixValidationIssue = useCallback(
    (fix: IssueFix) => {
      if (fix.kind === "set-tag") {
        const source = liveFeaturesRef.current.features.find(
          (feature) => feature.properties?.id === fix.entity,
        );
        const sourceTags = source?.properties?.tags as Record<string, string> | undefined;
        edits.setTag(fix.entity, fix.key, fix.value, sourceTags?.[fix.key]);
        setNotice(`Set ${fix.key}=${fix.value} on ${fix.entity}`);
        return;
      }

      const feature = displayedFeaturesRef.current.features.find(
        (candidate) => candidate.properties?.id === fix.entity,
      );
      if (
        !feature ||
        (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon")
      ) {
        setNotice(`Could not find ${fix.entity}'s current outline`);
        return;
      }
      const geometry = removeGeometryRingNode(
        feature.geometry,
        fix.polygonIndex,
        fix.ringIndex,
        fix.nodeIndex,
        fix.coordinate,
      );
      if (!geometry) {
        setNotice("The outline changed; review it again before applying this fix");
        return;
      }

      const drawn = createdPartsRef.current[fix.entity];
      let nextCreatedParts = createdPartsRef.current;
      let nextGeometryEdits = geometryEditsRef.current;
      if (drawn) {
        nextCreatedParts = {
          ...createdPartsRef.current,
          [fix.entity]: { ...drawn, geometry },
        };
      } else {
        const previous = geometryEditsRef.current[fix.entity];
        nextGeometryEdits = {
          ...geometryEditsRef.current,
          [fix.entity]: {
            geometry,
            kind: previous?.kind ?? "reshape",
            movedNodes: previous?.movedNodes,
          },
        };
      }
      geometryEditsRef.current = nextGeometryEdits;
      createdPartsRef.current = nextCreatedParts;
      setGeometryEdits(nextGeometryEdits);
      setCreatedParts(nextCreatedParts);
      const displayed = refreshDisplayedFeatures(nextGeometryEdits, nextCreatedParts);
      const selectedId = selectionRef.current?.selected.id;
      if (selectedId) setSelection(selectFromOsm(displayed, selectedId));
      setValidationLocation(null);
      setNotice(`Removed the backtracking corner from ${fix.entity}`);
    },
    [edits, refreshDisplayedFeatures],
  );

  /** Close review, select the affected element, and mark the exact failing point. */
  const locateValidationIssue = useCallback((at: LngLat, entity?: string) => {
    const map = mapRef.current;
    setSubmitOpen(false);
    setValidationLocation(at);
    if (entity) {
      const next = selectFromOsm(displayedFeaturesRef.current, entity);
      if (next && map) {
        setSelectionBearing(map.getBearing());
        setSelection(next);
      }
    }
    map?.easeTo({ center: at, zoom: Math.max(map.getZoom(), 20), duration: 600 });
  }, []);

  const finishHoleDrawing = useCallback(() => {
    const map = mapRef.current;
    const { targetId, nodes } = holeDraftRef.current;
    if (!map || !targetId) return;
    if (nodes.length < 3) {
      setNotice("A cutting mask needs at least 3 nodes");
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
    const targetSelection = selectFromOsm(displayedFeaturesRef.current, targetId);
    const buildingCut = subtractMaskFromGeometry(feature.geometry, nodes);
    if (!buildingCut) {
      setNotice("The cutting mask must be a simple, non-trivial loop");
      return;
    }
    if (!buildingCut.changed) {
      setNotice("The cutting mask must overlap the selected building");
      return;
    }
    if (!buildingCut.geometry) {
      setNotice("The cutting mask would remove the entire building");
      return;
    }
    const geometry = buildingCut.geometry;
    if (!targetSelection) {
      setNotice("Could not find the target building and its parts");
      return;
    }

    const partCuts = new Map<string, EditableGeometry>();
    for (const part of targetSelection.parts) {
      const cut = subtractMaskFromGeometry(geometryOf(part), nodes);
      if (!cut) {
        setNotice(`Could not apply the cutting mask to ${part.id}`);
        return;
      }
      if (!cut.changed) continue;
      if (!cut.geometry) {
        setNotice(`The cutting mask would remove all of ${part.id}`);
        return;
      }
      partCuts.set(part.id, cut.geometry);
    }

    // A drawn part is not in the raw tile data, so an override keyed by its id
    // would apply to nothing: its own geometry is the thing to change, the same
    // way Slice does it.
    const drawn = createdPartsRef.current[targetId];
    const previousTarget = geometryEditsRef.current[targetId];
    const nextGeometryEdits: GeometryEditMap = { ...geometryEditsRef.current };
    const nextCreatedParts = { ...createdPartsRef.current };
    if (drawn) nextCreatedParts[targetId] = { ...drawn, geometry };
    else {
      nextGeometryEdits[targetId] = {
        geometry,
        kind: "hole",
        movedNodes: previousTarget?.movedNodes,
      };
    }
    for (const [partId, partGeometry] of partCuts) {
      const drawnPart = nextCreatedParts[partId];
      if (drawnPart) {
        nextCreatedParts[partId] = { ...drawnPart, geometry: partGeometry };
        continue;
      }
      const previous = nextGeometryEdits[partId];
      nextGeometryEdits[partId] = {
        geometry: partGeometry,
        kind: "hole",
        movedNodes: previous?.movedNodes,
      };
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
    updateHoleDraft(EMPTY_HOLE_DRAFT);
    setCutHoleActive(false);
    setNotice(
      partCuts.size === 0
        ? "Building footprint cut"
        : `Building footprint and ${partCuts.size} underlying ${partCuts.size === 1 ? "part" : "parts"} cut`,
    );
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
    if (target.parts.length === 0) clearTransferredRoofTags(target.building);

    // A cut ends on a wall, and a wall is rarely one element's alone: the
    // outline and the part on the other side own it too. Give them the new
    // corner as well, or the pieces only look joined to their neighbours.
    const group = [target.building, ...target.parts];
    const untouched = Object.fromEntries(
      group
        .filter((element) => !(element.id in result.replacements))
        .map((element) => [element.id, geometryOf(element)] as const),
    );
    const welds = weldNewVertices({
      candidates: untouched,
      existing: group.flatMap((element) => geometryVertices(geometryOf(element))),
      produced: [
        ...Object.values(result.replacements),
        ...result.additions.map((addition) => addition.geometry),
      ],
      tolerance: NODE_REUSE_METERS,
    });
    for (const [id, geometry] of Object.entries(welds)) {
      const created = nextCreatedParts[id];
      if (created) nextCreatedParts[id] = { ...created, geometry };
      else {
        const previous = nextGeometryEdits[id];
        nextGeometryEdits[id] = {
          geometry,
          kind: previous?.kind ?? "glue",
          movedNodes: previous?.movedNodes,
        };
      }
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
  }, [clearTransferredRoofTags, refreshDisplayedFeatures, updateSliceDraft]);

  const finishAddPartDrawing = useCallback(
    (completedNodes?: LngLat[]) => {
      const map = mapRef.current;
      const { targetId, nodes: draftNodes } = addPartDraftRef.current;
      const nodes = completedNodes ?? draftNodes;
      if (!map || !targetId) return;
      if (nodes.length < 3) {
        setNotice("Add at least one exterior node before returning to the boundary");
        return;
      }

      const target =
        addPartBoundaryCacheRef.current?.targetId === targetId
          ? addPartBoundaryCacheRef.current.selection
          : selectFromOsm(displayedFeaturesRef.current, targetId);
      if (!target || target.selected.id !== target.building.id) {
        setNotice("Select a building outline before adding a part");
        return;
      }

      const result = addPartToBuilding(target.building, target.parts.length, nodes);
      if (!result) {
        setNotice(
          "The new part must stay outside and share a boundary segment with the building outline",
        );
        return;
      }

      const previousOverride = geometryEditsRef.current[targetId];
      const nextGeometryEdits: GeometryEditMap = {
        ...geometryEditsRef.current,
        [targetId]: {
          geometry: result.outline,
          kind: "add-part",
          movedNodes: previousOverride?.movedNodes,
        },
      };
      const nextCreatedParts = { ...createdPartsRef.current };
      const additions = result.base ? [result.base, result.addition] : [result.addition];
      const createdIds: string[] = [];
      for (const addition of additions) {
        const id = drawnRef("way", nextPartIdRef.current++);
        createdIds.push(id);
        nextCreatedParts[id] = createPartFeature(id, targetId, addition.geometry, addition.tags);
      }
      if (target.parts.length === 0) clearTransferredRoofTags(target.building);

      // The two attachment points belong to every part wall that follows the
      // same outline edge, not only to the expanded building and the new part.
      // Weld them locally now so an existing sibling (or the new base part)
      // references the same nodes in the upload rather than merely crossing
      // them at coincident coordinates.
      const candidates = Object.fromEntries([
        ...target.parts.map((part) => [part.id, geometryOf(part)] as const),
        ...createdIds.map(
          (id) => [id, nextCreatedParts[id].geometry] as [string, EditableGeometry],
        ),
      ]);
      const welds = weldVerticesIntoGeometries({
        candidates,
        // These are the exact snapped attachment points, including a point that
        // was already a node of another element but not yet of this part.
        points: [nodes[0], nodes[nodes.length - 1]],
        tolerance: NODE_REUSE_METERS,
      });
      for (const [id, geometry] of Object.entries(welds)) {
        const created = nextCreatedParts[id];
        if (created) nextCreatedParts[id] = { ...created, geometry };
        else {
          const previous = nextGeometryEdits[id];
          nextGeometryEdits[id] = {
            geometry,
            kind: previous?.kind ?? "glue",
            movedNodes: previous?.movedNodes,
          };
        }
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
      addPartBoundaryCacheRef.current = null;
      updateAddPartDraft(EMPTY_ADD_PART_DRAFT);
      setAddPartActive(false);
      setNotice(
        result.base ? "Part added with a new base part" : "Part added and outline expanded",
      );
    },
    [clearTransferredRoofTags, refreshDisplayedFeatures, updateAddPartDraft],
  );

  const cancelAddNode = useCallback(() => {
    addNodeActiveRef.current = false;
    addNodeTargetRef.current = null;
    setAddNodeActive(false);
  }, []);

  const toggleCutHole = useCallback(() => {
    if (cutHoleActiveRef.current) {
      cancelHoleDrawing();
      return;
    }
    cancelAddNode();
    cancelAddPartDrawing();
    cancelSliceDrawing();
    setPhotoAdjustActive(false);
    setChangesOpen(false);
    updateHoleDraft(EMPTY_HOLE_DRAFT);
    setCutHoleActive(true);
    setNotice(
      selectionRef.current
        ? "Draw a cutting mask for the selected building"
        : "Start inside a building, then draw its cutting mask",
    );
  }, [cancelAddNode, cancelAddPartDrawing, cancelHoleDrawing, cancelSliceDrawing, updateHoleDraft]);

  const toggleSlice = useCallback(() => {
    if (sliceActiveRef.current) {
      cancelSliceDrawing();
      return;
    }
    cancelAddNode();
    cancelAddPartDrawing();
    cancelHoleDrawing();
    setPhotoAdjustActive(false);
    setChangesOpen(false);
    sliceBoundaryCacheRef.current = null;
    updateSliceDraft(EMPTY_SLICE_DRAFT);
    setSliceActive(true);
    setNotice("Start on an outline or part edge for an open slice, or inside for a loop");
  }, [
    cancelAddNode,
    cancelAddPartDrawing,
    cancelHoleDrawing,
    cancelSliceDrawing,
    updateSliceDraft,
  ]);

  const toggleAddPart = useCallback(() => {
    if (addPartActiveRef.current) {
      cancelAddPartDrawing();
      return;
    }
    const selected = selectionRef.current;
    if (!selected || selected.selected.id !== selected.building.id) {
      setNotice("Select a building outline before adding a part");
      return;
    }
    cancelAddNode();
    cancelHoleDrawing();
    cancelSliceDrawing();
    setPhotoAdjustActive(false);
    setChangesOpen(false);
    addPartBoundaryCacheRef.current = {
      targetId: selected.building.id,
      selection: selected,
      rings: buildingOuterBoundaryRings(selected),
      projected: null,
    };
    updateAddPartDraft({ targetId: selected.building.id, nodes: [], snap: null });
    setAddPartActive(true);
    setNotice("Start on the selected building outline, draw outside, then return to the outline");
  }, [
    cancelAddNode,
    cancelAddPartDrawing,
    cancelHoleDrawing,
    cancelSliceDrawing,
    updateAddPartDraft,
  ]);

  const toggleAddNode = useCallback(() => {
    if (addNodeActiveRef.current) {
      cancelAddNode();
      return;
    }
    const selected = selectionRef.current;
    if (!selected) {
      setNotice("Select a building or part before adding nodes");
      return;
    }
    cancelAddPartDrawing();
    cancelHoleDrawing();
    cancelSliceDrawing();
    setPhotoAdjustActive(false);
    setChangesOpen(false);
    addNodeTargetRef.current = selected.selected.id;
    addNodeActiveRef.current = true;
    setAddNodeActive(true);
    setNotice("Drag an existing node, or press and drag an edge to add one");
  }, [cancelAddNode, cancelAddPartDrawing, cancelHoleDrawing, cancelSliceDrawing]);

  useEffect(() => {
    if (!cutHoleActive || !mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    let pendingPoint: { x: number; y: number } | null = null;
    let mouseMoveFrame = 0;

    const updateSnapAt = (point: { x: number; y: number }) => {
      const draft = holeDraftRef.current;
      const snap = nearestBuildingBoundary(map, displayedFeaturesRef.current, point);
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
      updateHoleDraft({ ...draft, snap });
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

    const cancelPendingMouseMove = () => {
      pendingPoint = null;
      if (mouseMoveFrame) {
        window.cancelAnimationFrame(mouseMoveFrame);
        mouseMoveFrame = 0;
      }
    };

    const onClick = (event: MapMouseEvent) => {
      cancelPendingMouseMove();
      const rawPoint: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const draft = holeDraftRef.current;

      if (draft.nodes.length > 0) {
        const first = map.project(draft.nodes[0]);
        if (Math.hypot(first.x - event.point.x, first.y - event.point.y) <= 12) {
          finishHoleDrawing();
          return;
        }
      }

      if (!draft.targetId) {
        const selectedId = selectionRef.current?.building.id;
        const snap = nearestBuildingBoundary(map, displayedFeaturesRef.current, event.point);
        const hit =
          selectedId || snap
            ? undefined
            : map.queryRenderedFeatures(event.point, { layers: ["live-building-fill"] })[0];
        const id = selectedId ?? snap?.targetId ?? hit?.properties.id;
        if (typeof id !== "string") {
          setNotice("Select a building first, or start the cut inside one");
          return;
        }
        const targetSelection =
          selectionRef.current?.building.id === id
            ? selectionRef.current
            : selectFromOsm(displayedFeaturesRef.current, id);
        if (!targetSelection) {
          setNotice("Could not find the target building");
          return;
        }
        updateHoleDraft({
          targetId: targetSelection.building.id,
          nodes: [snap?.coordinates ?? rawPoint],
          snap: null,
        });
        return;
      }

      const snap = nearestBuildingBoundary(map, displayedFeaturesRef.current, event.point);
      updateHoleDraft({
        ...draft,
        nodes: [...draft.nodes, snap?.coordinates ?? rawPoint],
        snap: null,
      });
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

    map.on("mousemove", onMouseMove);
    map.on("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelPendingMouseMove();
      map.off("mousemove", onMouseMove);
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
        // Shared walls can belong to several building outlines. Prefer the
        // building the mapper already selected, or the first boundary click on
        // relation/1794585 can lock onto its neighboring way/111680989 instead.
        const selectedTargetId = selectionRef.current?.building.id;
        const selectedCache = selectedTargetId ? prepareSliceBoundaryCache(selectedTargetId) : null;
        const selectedSnap = selectedCache
          ? nearestBuildingBoundary(
              map,
              displayedFeaturesRef.current,
              event.point,
              12,
              selectedCache,
            )
          : null;
        const snap =
          selectedSnap ?? nearestBuildingBoundary(map, displayedFeaturesRef.current, event.point);
        if (snap) {
          const boundaryCache =
            selectedSnap && selectedCache
              ? selectedCache
              : prepareSliceBoundaryCache(snap.targetId);
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
        const selectedBuilding = selectedCache?.selection.building;
        const insideSelected =
          selectedBuilding !== undefined && pointInsideBuilding(point, selectedBuilding);
        const hit = insideSelected
          ? null
          : map.queryRenderedFeatures(event.point, { layers: ["live-building-fill"] })[0];
        const id = insideSelected ? selectedBuilding.id : hit?.properties.id;
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

  useEffect(() => {
    if (!addPartActive || !mapReady) return;
    const map = mapRef.current;
    const boundaryCache = addPartBoundaryCacheRef.current;
    if (!map || !boundaryCache) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    const referenceNodes = lod1Visible ? lod1Nodes(lod1Match) : [];
    let pendingPoint: { x: number; y: number } | null = null;
    let mouseMoveFrame = 0;

    const updateSnapAt = (point: { x: number; y: number }) => {
      const draft = addPartDraftRef.current;
      const boundarySnap = nearestBuildingBoundary(
        map,
        displayedFeaturesRef.current,
        point,
        12,
        boundaryCache,
      );
      // The first and last nodes still have to belong to the OSM outline.
      // Once drawing has started, LOD1 corners guide exterior helper nodes.
      const referenceSnap =
        draft.nodes.length > 0 ? nearestLod1Node(map, referenceNodes, point) : null;
      const snap = boundarySnap ?? referenceSnap;
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
      updateAddPartDraft({ ...draft, snap });
    };

    const cancelPendingMouseMove = () => {
      pendingPoint = null;
      if (mouseMoveFrame) {
        window.cancelAnimationFrame(mouseMoveFrame);
        mouseMoveFrame = 0;
      }
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

    const clearSnap = () => {
      cancelPendingMouseMove();
      const draft = addPartDraftRef.current;
      if (draft.snap) updateAddPartDraft({ ...draft, snap: null });
    };

    const onClick = (event: MapMouseEvent) => {
      cancelPendingMouseMove();
      const draft = addPartDraftRef.current;
      const point = roundToOsmGrid([event.lngLat.lng, event.lngLat.lat]);
      const previewPoint = draft.snap ? map.project(draft.snap.coordinates) : null;
      const previewTolerance = draft.snap?.targetId === LOD1_SNAP_TARGET ? 9 : 12;
      const visibleSnap =
        draft.snap &&
        previewPoint &&
        Math.hypot(previewPoint.x - event.point.x, previewPoint.y - event.point.y) <=
          previewTolerance
          ? draft.snap
          : null;
      const boundarySnap = nearestBuildingBoundary(
        map,
        displayedFeaturesRef.current,
        event.point,
        12,
        boundaryCache,
      );
      const snap = boundarySnap ?? visibleSnap;
      const outlineSnap = snap?.targetId === boundaryCache.targetId ? snap : null;

      if (draft.nodes.length === 0) {
        if (!outlineSnap) {
          setNotice("The first node must snap to the selected building outline");
          return;
        }
        updateAddPartDraft({ ...draft, nodes: [outlineSnap.coordinates], snap: null });
        setNotice("Add exterior nodes, then return to a different point on the outline");
        return;
      }

      if (outlineSnap) {
        if (draft.nodes.length < 2) {
          setNotice("Add at least one exterior node before returning to the outline");
          return;
        }
        const first = draft.nodes[0];
        if (outlineSnap.coordinates[0] === first[0] && outlineSnap.coordinates[1] === first[1]) {
          setNotice("Return to a different point so the new part shares a wall");
          return;
        }
        finishAddPartDrawing([...draft.nodes, outlineSnap.coordinates]);
        return;
      }

      // Do not run a second, per-click inside/outside classification here. It
      // can disagree with the boolean geometry used to complete the addition,
      // especially on an edited outline or within a rounding step of its edge.
      // addPartToBuilding validates the entire finished ring: it rejects real
      // interior overlap and accepts only a connected outline expansion.
      const nextPoint = snap?.targetId === LOD1_SNAP_TARGET ? snap.coordinates : point;
      updateAddPartDraft({ ...draft, nodes: [...draft.nodes, nextPoint], snap: null });
    };

    const invalidateProjectedBoundaries = () => {
      boundaryCache.projected = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelAddPartDrawing();
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
      cancelPendingMouseMove();
      canvas.style.cursor = "";
    };
  }, [
    addPartActive,
    cancelAddPartDrawing,
    finishAddPartDrawing,
    lod1Match,
    lod1Visible,
    mapReady,
    updateAddPartDraft,
  ]);

  useEffect(() => {
    if (!addPartActive) return;
    const targetId = addPartDraftRef.current.targetId;
    if (
      !live ||
      !selection ||
      selection.building.id !== targetId ||
      selection.selected.id !== targetId
    )
      cancelAddPartDrawing();
  }, [addPartActive, cancelAddPartDrawing, live, selection]);

  useEffect(() => {
    if (!addNodeActive) return;
    if (!live || selection?.selected.id !== addNodeTargetRef.current) {
      cancelAddNode();
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // A drag in flight owns Escape: the first press abandons it, and only a
      // second one leaves the mode.
      if (event.key !== "Escape" || dragActiveRef.current) return;
      event.preventDefault();
      cancelAddNode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addNodeActive, cancelAddNode, live, selection]);

  // Selected footprint dots are direct handles. The draft follows the pointer;
  // releasing it records one persistent geometry override and refreshes 3D.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !selection) return;
    const canvas = map.getCanvas();
    const referenceNodes = lod1Visible ? lod1Nodes(lod1Match) : [];
    let drag: NodeDrag | null = null;
    let edgeDrag: EdgeDrag | null = null;

    /** Put the map back on the last committed geometry, discarding a preview. */
    const restorePreview = () => {
      const liveSource = map.getSource<GeoJSONSource>("live");
      const outlineSource = map.getSource<GeoJSONSource>("selection");
      const nodeSource = map.getSource<GeoJSONSource>("selection-nodes");
      void liveSource?.setData(displayedFeaturesRef.current);
      void outlineSource?.setData(selection.outline);
      void nodeSource?.setData(selectionNodeFeatures(selection));
    };

    const setEdgeHover = (run: LngLat[] | null) => {
      if (mapRef.current !== map) return;
      const source = map.getSource<GeoJSONSource>("edge-hover");
      void source?.setData(
        run
          ? {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates: run },
                },
              ],
            }
          : EMPTY,
      );
    };

    /** The handle under the pointer — a corner or a wall midpoint alike. */
    const setNodeHover = (coordinates: LngLat | null) => {
      if (mapRef.current !== map) return;
      const source = map.getSource<GeoJSONSource>("selection-node-hover");
      void source?.setData(
        coordinates
          ? {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: {}, geometry: { type: "Point", coordinates } },
              ],
            }
          : EMPTY,
      );
    };

    const setRightAngleGizmo = (snap: RightAngleSnap | null) => {
      if (mapRef.current !== map) return;
      const source = map.getSource<GeoJSONSource>("right-angle-gizmo");
      void source?.setData(snap ? rightAngleGizmo(map, snap) : EMPTY);
    };

    const preview = (geometries: GeometryByEntity) => {
      const draftSelection = selectionWithGeometries(selection, geometries);
      const outlineSource = map.getSource<GeoJSONSource>("selection");
      const nodeSource = map.getSource<GeoJSONSource>("selection-nodes");
      void outlineSource?.setData(draftSelection.outline);
      void nodeSource?.setData(selectionNodeFeatures(draftSelection));

      const displayed = collectionWithGeometries(displayedFeaturesRef.current, geometries);
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
      /** The drag behind this commit, so the upload moves those nodes rather
       * than creating new ones beside them and orphaning the originals. */
      moves?: NodeMove[],
      gluedEntities = new Set<string>(),
      defaultKind: "reshape" | "add-node" = "reshape",
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
          const displayed = displayedFeaturesRef.current.features.find(
            (feature) => feature.properties?.id === entity,
          );
          const before =
            displayed?.geometry.type === "Polygon" || displayed?.geometry.type === "MultiPolygon"
              ? displayed.geometry
              : null;
          // A wall run can touch several footprints at different nodes. Record
          // only the run nodes this footprint actually owned before the drag;
          // otherwise a later move of another run node leaves a false, stale
          // destination on this unrelated footprint.
          const entityMoves = moves?.filter((move) =>
            before ? geometryHasVertex(before, move.from) : geometryHasVertex(geometry, move.to),
          );
          nextGeometryEdits[entity] = {
            geometry,
            kind: previous?.kind ?? (gluedEntities.has(entity) ? "glue" : defaultKind),
            movedNodes: entityMoves?.length
              ? entityMoves.reduce(
                  (recorded, move) => recordNodeMove(recorded, move.from, move.to),
                  previous?.movedNodes,
                )
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
      const snapCollection = activeDrag.created
        ? collectionWithGeometries(displayedFeaturesRef.current, activeDrag.originalGeometries)
        : displayedFeaturesRef.current;
      const boundaryCandidate = nearestBuildingBoundary(
        map,
        snapCollection,
        event.point,
        12,
        undefined,
        activeDrag.originalCoordinates,
      );
      const perpendicularCandidate =
        boundaryCandidate?.kind === "node"
          ? null
          : nearestRightAngleSnap(map, activeDrag.rightAngleConstraints, event.point);
      const geometrySnap =
        perpendicularCandidate &&
        (!boundaryCandidate || perpendicularCandidate.distance < boundaryCandidate.distance)
          ? perpendicularCandidate
          : boundaryCandidate;
      const referenceNode = geometrySnap ? null : nearestLod1Node(map, referenceNodes, event.point);
      const snap = geometrySnap ?? referenceNode;
      const boundarySnap = snap?.kind === "node" || snap?.kind === "edge" ? snap : null;
      const perpendicularSnap = snap?.kind === "right-angle" ? snap : null;
      const coordinates = roundToOsmGrid(snap?.coordinates ?? [event.lngLat.lng, event.lngLat.lat]);
      let geometries = Object.fromEntries(
        Object.entries(activeDrag.originalGeometries).map(([entity, geometry]) => [
          entity,
          boundarySnap?.kind === "node"
            ? mergeSharedGeometryVertices(geometry, activeDrag.originalCoordinates, coordinates)
            : moveSharedGeometryVertex(geometry, activeDrag.originalCoordinates, coordinates),
        ]),
      );
      const gluedEntities = new Set(activeDrag.baseGluedEntities);
      if (boundarySnap?.kind === "edge") {
        const candidates = {
          ...polygonalGeometries(displayedFeaturesRef.current),
          ...geometries,
        };
        const welded = weldVerticesIntoGeometries({
          candidates,
          points: [coordinates],
          tolerance: NODE_REUSE_METERS,
        });
        for (const entity of Object.keys(welded)) {
          if (!(entity in activeDrag.originalGeometries)) gluedEntities.add(entity);
        }
        geometries = { ...geometries, ...welded };
      }
      drag = { ...activeDrag, geometries, coordinates, snap, gluedEntities };
      preview(geometries);
      setRightAngleGizmo(perpendicularSnap);
      setNodeHover(coordinates);
    };

    const onEdgeDragMove = (event: MapMouseEvent) => {
      if (!edgeDrag) return;
      const active = edgeDrag;
      // A wall slides on its own normal and nowhere else: dragging along it
      // would only shuffle nodes down a line they already sit on, and the
      // sideways component is the whole intent. The pointer's travel is
      // measured on the ground rather than on the screen, so a rotated or
      // tilted map does not change how far the wall goes.
      const cosLat = Math.cos((active.origin[1] * Math.PI) / 180);
      const [normalEast, normalNorth] = active.normal;
      const east = (event.lngLat.lng - active.origin[0]) * METERS_PER_DEG_LAT * cosLat;
      const north = (event.lngLat.lat - active.origin[1]) * METERS_PER_DEG_LAT;
      const offset = east * normalEast + north * normalNorth;
      const offsetLng = (offset * normalEast) / (METERS_PER_DEG_LAT * cosLat);
      const offsetLat = (offset * normalNorth) / METERS_PER_DEG_LAT;
      const coordinates = active.originalCoordinates.map(
        (node): LngLat => roundToOsmGrid([node[0] + offsetLng, node[1] + offsetLat]),
      );
      const moves = new Map(
        active.originalCoordinates.map((node, index) => [coordinateKey(node), coordinates[index]]),
      );
      const geometries = Object.fromEntries(
        Object.entries(active.originalGeometries).map(([entity, geometry]) => [
          entity,
          moveSharedGeometryVertices(geometry, moves),
        ]),
      );
      edgeDrag = { ...active, coordinates, geometries, offset };
      setEdgeHover(coordinates);
      preview(geometries);
    };

    const finishEdgeDrag = () => {
      if (!edgeDrag) return;
      const finished = edgeDrag;
      edgeDrag = null;
      dragActiveRef.current = false;
      map.off("mousemove", onEdgeDragMove);
      map.dragPan.enable();
      setEdgeHover(null);
      canvas.style.cursor = "";
      const moved = finished.coordinates;
      if (!moved) return;

      suppressSelectionClickRef.current = true;
      setTimeout(() => {
        suppressSelectionClickRef.current = false;
      }, 0);

      const moves = finished.originalCoordinates
        .map((from, index) => ({ from, to: moved[index] }))
        .filter((move) => coordinateKey(move.from) !== coordinateKey(move.to));
      if (moves.length === 0) {
        preview(finished.originalGeometries);
        return;
      }
      const affected = Object.keys(finished.geometries).length;
      const distance = `${Math.abs(finished.offset).toFixed(2)} m`;
      const nodes = `${moves.length} node${moves.length === 1 ? "" : "s"}`;
      commitGeometries(
        finished.geometries,
        affected === 1
          ? `Edge moved ${distance}, ${nodes}`
          : `Edge moved ${distance} across ${affected} footprints, ${nodes}`,
        moves,
      );
    };

    const startEdgeDrag = (event: MapMouseEvent): boolean => {
      const segment = nearestSelectionSegment(map, selection, event.point);
      const run = segment && edgeRunFor(selection, segment);
      if (!run) return false;
      if (addNodeActiveRef.current && !withinEdgeHandle(map, run.midpoint, event.point)) {
        return false;
      }
      const originalGeometries: GeometryByEntity = {};
      for (const node of run.coordinates) {
        Object.assign(
          originalGeometries,
          geometriesSharingVertex(displayedFeaturesRef.current, node),
        );
      }
      if (!originalGeometries[selection.selected.id]) {
        originalGeometries[selection.selected.id] = currentGeometry();
      }
      edgeDrag = {
        originalCoordinates: run.coordinates,
        coordinates: null,
        normal: run.normal,
        origin: [event.lngLat.lng, event.lngLat.lat],
        offset: 0,
        originalGeometries,
        geometries: originalGeometries,
      };
      dragActiveRef.current = true;
      setNodeHover(null);
      setEdgeHover(run.coordinates);
      map.dragPan.disable();
      canvas.style.cursor = "grabbing";
      map.on("mousemove", onEdgeDragMove);
      window.addEventListener("mouseup", finishEdgeDrag, { once: true });
      return true;
    };

    const finishDrag = () => {
      if (!drag) return;
      const finished = drag;
      drag = null;
      dragActiveRef.current = false;
      map.off("mousemove", onDragMove);
      map.dragPan.enable();
      setRightAngleGizmo(null);
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
      const action = finished.created
        ? "added"
        : finished.snap?.kind === "node" && finished.snap.targetId !== LOD1_SNAP_TARGET
          ? "merged"
          : "moved";
      commitGeometries(
        finished.geometries,
        affected === 1 ? `Node ${action}` : `Node ${action} across ${affected} footprints`,
        finished.created ? undefined : [{ from: finished.originalCoordinates, to: coordinates }],
        finished.gluedEntities,
        finished.created ? "add-node" : "reshape",
      );
    };

    /**
     * Escape abandons a drag in flight. Nothing is committed, so the preview
     * is thrown away and the map goes back to the geometry it had — including
     * a node that only exists because this gesture inserted it.
     */
    const cancelDrag = () => {
      if (!drag && !edgeDrag) return;
      drag = null;
      edgeDrag = null;
      dragActiveRef.current = false;
      map.off("mousemove", onDragMove);
      map.off("mousemove", onEdgeDragMove);
      window.removeEventListener("mouseup", finishDrag);
      window.removeEventListener("mouseup", finishEdgeDrag);
      map.dragPan.enable();
      setNodeHover(null);
      setEdgeHover(null);
      setRightAngleGizmo(null);
      canvas.style.cursor = "";
      restorePreview();
      setNotice("Drag cancelled");
      // The button is still down. Keep the click its release generates from
      // selecting whatever the pointer wandered over.
      window.addEventListener(
        "mouseup",
        () => {
          suppressSelectionClickRef.current = true;
          setTimeout(() => {
            suppressSelectionClickRef.current = false;
          }, 0);
        },
        { once: true },
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!drag && !edgeDrag)) return;
      event.preventDefault();
      cancelDrag();
    };

    const onMouseDown = (event: MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;
      if (
        cutHoleActiveRef.current ||
        sliceActiveRef.current ||
        addPartActiveRef.current ||
        photoAdjustActiveRef.current
      )
        return;
      const handle = nearestSelectionNode(map, selection, event.point);
      // A midpoint handle moves the whole wall it belongs to. Corner handles
      // still win, so a single node stays draggable where the two are close.
      if (!handle && startEdgeDrag(event)) {
        event.preventDefault();
        return;
      }
      let nextDrag: NodeDrag | null = null;
      let dragHandle = handle;
      if (handle) {
        const selectedGeometry = currentGeometry();
        const originalGeometries = geometriesSharingVertex(
          displayedFeaturesRef.current,
          handle.coordinates,
        );
        if (!originalGeometries[selection.selected.id]) {
          originalGeometries[selection.selected.id] = selectedGeometry;
        }
        nextDrag = {
          polygonIndex: handle.polygonIndex,
          ringIndex: handle.ringIndex,
          vertexIndex: handle.vertexIndex,
          originalCoordinates: handle.coordinates,
          coordinates: null,
          created: false,
          originalGeometries,
          geometries: originalGeometries,
          snap: null,
          rightAngleConstraints: rightAngleConstraints(originalGeometries, handle.coordinates),
          baseGluedEntities: new Set(),
          gluedEntities: new Set(),
        };
      } else if (addNodeActiveRef.current) {
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
        const candidates = {
          ...polygonalGeometries(displayedFeaturesRef.current),
          [selection.selected.id]: geometry,
        };
        const welded = weldVerticesIntoGeometries({
          candidates,
          points: [segment.coordinates],
          tolerance: NODE_REUSE_METERS,
        });
        const originalGeometries = { ...welded, [selection.selected.id]: geometry };
        const baseGluedEntities = new Set(
          Object.keys(welded).filter((entity) => entity !== selection.selected.id),
        );
        dragHandle = {
          polygonIndex: segment.polygonIndex,
          ringIndex: segment.ringIndex,
          vertexIndex: segment.segmentIndex + 1,
          coordinates: segment.coordinates,
        };
        nextDrag = {
          ...dragHandle,
          originalCoordinates: segment.coordinates,
          coordinates: segment.coordinates,
          created: true,
          originalGeometries,
          geometries: originalGeometries,
          snap: null,
          rightAngleConstraints: rightAngleConstraints(originalGeometries, segment.coordinates),
          baseGluedEntities,
          gluedEntities: baseGluedEntities,
        };
        preview(originalGeometries);
      }
      if (!nextDrag || !dragHandle) return;

      event.preventDefault();
      drag = nextDrag;
      dragActiveRef.current = true;
      setRightAngleGizmo(null);
      setNodeHover(dragHandle.coordinates);
      map.dragPan.disable();
      canvas.style.cursor = "grabbing";
      map.on("mousemove", onDragMove);
      window.addEventListener("mouseup", finishDrag, { once: true });
    };

    const onDoubleClick = (event: MapMouseEvent) => {
      if (
        cutHoleActiveRef.current ||
        sliceActiveRef.current ||
        addPartActiveRef.current ||
        addNodeActiveRef.current ||
        photoAdjustActiveRef.current
      )
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
      const candidates = {
        ...polygonalGeometries(displayedFeaturesRef.current),
        [selection.selected.id]: geometry,
      };
      const welded = weldVerticesIntoGeometries({
        candidates,
        points: [segment.coordinates],
        tolerance: NODE_REUSE_METERS,
      });
      const geometries = { ...welded, [selection.selected.id]: geometry };
      const gluedEntities = new Set(
        Object.keys(welded).filter((entity) => entity !== selection.selected.id),
      );
      event.preventDefault();
      commitGeometries(
        geometries,
        Object.keys(geometries).length === 1
          ? "Node added"
          : `Node added to ${Object.keys(geometries).length} shared footprints`,
        undefined,
        gluedEntities,
        "add-node",
      );
    };

    const onHover = (event: MapMouseEvent) => {
      if (
        drag ||
        edgeDrag ||
        cutHoleActiveRef.current ||
        sliceActiveRef.current ||
        addPartActiveRef.current ||
        photoAdjustActiveRef.current
      )
        return;
      const handle = nearestSelectionNode(map, selection, event.point);
      const segment = handle ? null : nearestSelectionSegment(map, selection, event.point);
      const run = segment && edgeRunFor(selection, segment);
      // Add node mode keeps the rest of the edge for inserting, so there the
      // wall is grabbed near its midpoint alone. With no tool active the whole
      // hovered edge grabs it, since nothing else wants that press.
      const grabbable =
        run && (!addNodeActiveRef.current || withinEdgeHandle(map, run.midpoint, event.point));
      const selectableFootprint =
        addNodeActiveRef.current &&
        map.queryRenderedFeatures(event.point, {
          layers: ["live-building-fill", "live-part-fill"],
        }).length > 0;
      setNodeHover(handle?.coordinates ?? null);
      // The highlight is the whole affordance: it shows up exactly where a
      // press would take the wall, and nowhere else.
      setEdgeHover(grabbable ? run.coordinates : null);
      if (handle) canvas.style.cursor = "pointer";
      else if (grabbable) canvas.style.cursor = "move";
      else if (segment && addNodeActiveRef.current) canvas.style.cursor = "crosshair";
      else if (selectableFootprint) canvas.style.cursor = "pointer";
      else canvas.style.cursor = "";
    };

    const clearNodeHover = () => {
      if (drag || edgeDrag) return;
      setNodeHover(null);
      setEdgeHover(null);
      canvas.style.cursor = "";
    };

    map.on("mousedown", onMouseDown);
    map.on("dblclick", onDoubleClick);
    map.on("mousemove", onHover);
    window.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("mouseleave", clearNodeHover);
    return () => {
      map.off("mousedown", onMouseDown);
      map.off("dblclick", onDoubleClick);
      map.off("mousemove", onHover);
      map.off("mousemove", onDragMove);
      map.off("mousemove", onEdgeDragMove);
      window.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("mouseleave", clearNodeHover);
      window.removeEventListener("mouseup", finishDrag);
      window.removeEventListener("mouseup", finishEdgeDrag);
      setNodeHover(null);
      setEdgeHover(null);
      setRightAngleGizmo(null);
      if (drag || edgeDrag) {
        dragActiveRef.current = false;
        map.dragPan.enable();
        restorePreview();
      }
      canvas.style.cursor = "";
    };
  }, [
    addNodeActive,
    addPartActive,
    cutHoleActive,
    lod1Match,
    lod1Visible,
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

  const onLidarDifferences = useCallback((buildingId: string, differences: Float32Array | null) => {
    if (selectionRef.current?.building.id !== buildingId) return;
    lidarLayerRef.current?.setDifferences(differences);
  }, []);

  const onLidarCloudChange = useCallback((buildingId: string, cloud: LidarCloud | null) => {
    if (selectionRef.current?.building.id !== buildingId) return;
    // The whole building's outline rides along for the grid mode's raster,
    // whichever part is selected.
    lidarLayerRef.current?.setCloud(cloud, selectionRef.current?.building.polygons ?? []);
  }, []);

  // A cloud belongs to the building that requested it. Clear it immediately
  // on selection changes so an asynchronous 3D lookup cannot leave the
  // previous building's points under the new footprint.
  const hadSelection = useRef(false);
  useEffect(() => {
    lidarLayerRef.current?.setCloud(null);
    // Only a selection that goes away closes LiDAR. On the first run there is
    // no previous selection to have gone, and the hash may have just asked for
    // a cloud whose building is still being fetched.
    if (!selectionBuildingId && hadSelection.current) setLidar(false);
    hadSelection.current = Boolean(selectionBuildingId);
  }, [selectionBuildingId]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = lidarLayerRef.current;
    if (!map || !layer || !mapReady) return;
    map.setLayoutProperty("lidar-background", "visibility", lidar ? "visible" : "none");
    layer.setVisible(lidar);
  }, [lidar, mapReady]);

  useEffect(() => {
    lidarLayerRef.current?.setColourMode(lidarColourMode);
  }, [lidarColourMode, mapReady]);

  useEffect(() => {
    lidarLayerRef.current?.setLinksVisible(lidarLines);
  }, [lidarLines, mapReady]);

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
    for (const prefix of ["live-"]) {
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

  // A selected skillion shows its downhill direction over the footprint centroid.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource<GeoJSONSource>("roof-direction");
    void source?.setData(skillionDirectionFeatures(effectiveSelection));
  }, [effectiveSelection, mapReady]);

  // The map and advice panel share the same best-overlap LOD1 match.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource<GeoJSONSource>("lod1");
    void source?.setData(lod1Visible && lod1Match ? lod1Match.outline : EMPTY);
  }, [lod1Match, lod1Visible, mapReady]);

  // A review finding can point to a millimetre-scale fold that is otherwise
  // invisible at ordinary map zoom. Keep a high-contrast marker after review closes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource<GeoJSONSource>("validation-location");
    void source?.setData(
      validationLocation
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { role: "validation-location" },
                geometry: { type: "Point", coordinates: validationLocation },
              },
            ],
          }
        : EMPTY,
    );
  }, [mapReady, validationLocation]);

  // Pending tag and geometry overrides are projected over raw OSM together.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    displayedFeaturesRef.current = displayedFeatures;
    const source = map.getSource<GeoJSONSource>("live");
    void source?.setData(displayedFeatures);
  }, [displayedFeatures, mapReady]);

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
        className={`absolute top-3 z-30 flex flex-col items-stretch gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-md ${
          selection ? "right-[29rem]" : "right-3"
        }`}
      >
        <div className="flex items-center gap-1">
          {/* One underlay at a time, so the three read as positions of a single
              switch rather than as toggles that silently cancel each other. */}
          <div className="flex items-center gap-0.5 rounded-md bg-slate-100 p-0.5">
            {MAP_UNDERLAYS.map(({ underlay, label, title, needsSelection }) => {
              const disabled = needsSelection && !selection;
              return (
                <button
                  key={underlay}
                  type="button"
                  disabled={disabled}
                  title={disabled ? "Select a building first" : title}
                  aria-pressed={mapUnderlay === underlay}
                  onClick={() => setMapUnderlay(underlay)}
                  className={`rounded px-2.5 py-0.5 text-sm font-medium transition-colors ${
                    disabled
                      ? "cursor-not-allowed text-slate-300"
                      : mapUnderlay === underlay
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setLod1Visible((visible) => !visible)}
            disabled={!lod1Match}
            aria-label={lod1Visible ? "Hide LOD1 outline" : "Show LOD1 outline"}
            aria-pressed={lod1Visible && Boolean(lod1Match)}
            title={lod1Match ? "Toggle the matched LOD1 outline" : "No matching LOD1 outline"}
            className={`rounded-md px-2 py-1 text-sm font-medium transition-colors ${
              !lod1Match
                ? "cursor-not-allowed text-slate-400"
                : lod1Visible
                  ? "bg-slate-200 text-slate-900"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            LOD1
          </button>
        </div>
        {/* Whatever the chosen underlay itself needs, kept off the first row so
            the switch stays in one place as its options come and go. */}
        {(photos || lidar) && (
          <div className="flex items-center gap-1 border-t border-slate-100 pt-1">
            {photos && (
              <button
                type="button"
                onClick={() => {
                  cancelAddNode();
                  cancelAddPartDrawing();
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
            {lidar && (
              <>
                <div className="flex items-center gap-0.5 rounded-md bg-slate-100 p-0.5">
                  {LIDAR_COLOUR_MODES.map(({ mode, label, title }) => (
                    <button
                      key={mode}
                      type="button"
                      title={title}
                      aria-pressed={lidarColourMode === mode}
                      onClick={() => setLidarColourMode(mode)}
                      className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                        lidarColourMode === mode
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label
                  title="Draw the links between points recorded one after the other"
                  className="flex cursor-pointer items-center gap-1.5 px-1 text-xs font-medium text-slate-800 select-none"
                >
                  <input
                    type="checkbox"
                    checked={lidarLines}
                    onChange={(event) => setLidarLines(event.target.checked)}
                    className="h-3.5 w-3.5 accent-sky-600"
                  />
                  Lines
                </label>
              </>
            )}
          </div>
        )}
      </div>

      {live && (
        <div
          className={`absolute z-30 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow-md ${
            photos || lidar ? "top-[5.75rem]" : "top-16"
          } ${selection ? "right-[29rem]" : "right-3"}`}
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
            Live OSM · {loaderStatus.tiles} tiles
            {loaderStatus.pending > 0 && " · loading…"}
            {loaderStatus.failed > 0 && ` · ${loaderStatus.failed} failed`}
          </p>
        </div>
      )}

      {notice && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-30 -translate-x-1/2 rounded-full bg-slate-900/75 px-4 py-1.5 text-sm text-white shadow">
          {notice}
        </div>
      )}

      {!changesOpen && (
        <div className="absolute top-3 left-3 z-30 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              cancelAddNode();
              cancelAddPartDrawing();
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
          <span className="group relative flex">
            <button
              type="button"
              onClick={toggleCutHole}
              disabled={!live && !cutHoleActive}
              aria-label="Cut hole"
              aria-describedby="cut-hole-tooltip"
              aria-pressed={cutHoleActive}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border shadow-md transition-colors ${
                cutHoleActive
                  ? "border-violet-700 bg-violet-700 text-white hover:bg-violet-800"
                  : live
                    ? "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                    : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
            >
              <PiExcludeBold className="h-5 w-5" aria-hidden />
            </button>
            <span
              id="cut-hole-tooltip"
              role="tooltip"
              className="pointer-events-none absolute top-full left-1/2 z-40 mt-2 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-md transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            >
              Cut hole
            </span>
          </span>
          <span className="group relative flex">
            <button
              type="button"
              onClick={toggleSlice}
              disabled={!live && !sliceActive}
              aria-label="Slice"
              aria-describedby="slice-tooltip"
              aria-pressed={sliceActive}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border shadow-md transition-colors ${
                sliceActive
                  ? "border-violet-700 bg-violet-700 text-white hover:bg-violet-800"
                  : live
                    ? "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                    : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
            >
              <PiKnifeBold className="h-5 w-5" aria-hidden />
            </button>
            <span
              id="slice-tooltip"
              role="tooltip"
              className="pointer-events-none absolute top-full left-1/2 z-40 mt-2 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-md transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            >
              Slice
            </span>
          </span>
          <span className="group relative flex">
            <button
              type="button"
              onClick={toggleAddPart}
              disabled={
                !addPartActive &&
                (!live || !selection || selection.selected.id !== selection.building.id)
              }
              aria-label="Add part"
              aria-describedby="add-part-tooltip"
              aria-pressed={addPartActive}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border shadow-md transition-colors ${
                addPartActive
                  ? "border-violet-700 bg-violet-700 text-white hover:bg-violet-800"
                  : live && selection?.selected.id === selection?.building.id
                    ? "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                    : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
            >
              <PiSelectionPlusBold className="h-5 w-5" aria-hidden />
            </button>
            <span
              id="add-part-tooltip"
              role="tooltip"
              className="pointer-events-none absolute top-full left-1/2 z-40 mt-2 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-md transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            >
              Add part
            </span>
          </span>
          <span className="group relative flex">
            <button
              type="button"
              onClick={toggleAddNode}
              disabled={!addNodeActive && (!live || !selection)}
              aria-label="Add node"
              aria-describedby="add-node-tooltip"
              aria-pressed={addNodeActive}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border shadow-md transition-colors ${
                addNodeActive
                  ? "border-violet-700 bg-violet-700 text-white hover:bg-violet-800"
                  : live && selection
                    ? "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                    : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
            >
              <PiPlusCircleBold className="h-5 w-5" aria-hidden />
            </button>
            <span
              id="add-node-tooltip"
              role="tooltip"
              className="pointer-events-none absolute top-full left-1/2 z-40 mt-2 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-md transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            >
              Add node
            </span>
          </span>
        </div>
      )}

      {cutHoleActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Draw a mask inside or across the selected footprint · first node or Enter closes · Esc
          cancels
        </div>
      )}

      {sliceActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Boundary → boundary polyline, or close an interior loop · Esc cancels
        </div>
      )}

      {addPartActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Outline → exterior nodes → outline · Esc cancels
        </div>
      )}

      {addNodeActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Drag a node or a wall handle, or press and drag an edge to add a node · Esc exits
        </div>
      )}

      {photoAdjustActive && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-violet-700 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
          Drag to align photos · map position stays fixed
        </div>
      )}

      <ChangesSidebar
        open={changesOpen}
        selectedId={selection?.selected.id ?? null}
        edits={edits.edits}
        geometryEdits={geometryEdits}
        createdParts={createdParts}
        onClose={() => setChangesOpen(false)}
        onNavigate={navigateToEditedEntity}
        onRevertEntity={revertEntity}
        onRemoveProperty={removeProperty}
        onEditProperty={editProperty}
        onRevertAll={revertAllChanges}
        onSubmit={() => {
          setValidationLocation(null);
          setSubmitOpen(true);
        }}
      />

      <SubmitDialog
        open={submitOpen}
        input={submitInput}
        displayed={displayedFeatures}
        onClose={() => setSubmitOpen(false)}
        onNavigate={(entity) => {
          setSubmitOpen(false);
          navigateToEditedEntity(entity);
        }}
        onLocate={locateValidationIssue}
        onFix={fixValidationIssue}
        onUploaded={onUploaded}
      />

      <BuildingPanel
        selection={selection}
        lod1Match={lod1Match}
        initialHeading={selectionBearing}
        edits={edits}
        onEditTag={editEntityTag}
        onLidarCloudChange={onLidarCloudChange}
        onLidarDifferences={onLidarDifferences}
        wantLidarDifferences={lidar && lidarColourMode === "diff"}
        onSelectEntity={selectLoadedEntity}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}
