import { Copc, type Getter, type Hierarchy } from "copc";
import type { Bounds } from "../geometry";
import { projectLambert93, unprojectLambert93 } from "../lambert93";
import { type PointArrays, packColour, withSingleReturn } from "../lidar-format";
import { fetchIgnJson, fetchIgnRange } from "./upstream";

/** IGN's public kilometre-tile index for classified LiDAR HD COPC files. */
const TILE_INDEX = "https://data.geopf.fr/wfs/ows";
const TILE_LAYER = "IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle";

const TARGET_DENSITY = 4;
const MAX_NODES = 96;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_HIERARCHY_PAGES = 32;
const MAX_OUTPUT_POINTS = 500000;
const NOISE_CLASSES = new Set([7, 18]);

interface TileFeature {
  properties?: {
    url?: string;
    format?: string;
    projection?: string;
  };
}

interface TileIndexResponse {
  features?: TileFeature[];
}

interface ProjectedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function publicIgnDownload(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "data.geopf.fr" &&
      url.pathname.startsWith("/telechargement/download/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function projectedBounds([west, south, east, north]: Bounds): ProjectedBounds {
  const corners = [
    projectLambert93(west, south),
    projectLambert93(west, north),
    projectLambert93(east, south),
    projectLambert93(east, north),
  ];
  return {
    minX: Math.min(...corners.map(([x]) => x)),
    minY: Math.min(...corners.map(([, y]) => y)),
    maxX: Math.max(...corners.map(([x]) => x)),
    maxY: Math.max(...corners.map(([, y]) => y)),
  };
}

/** WFS request used to resolve the public COPC files intersecting a lon/lat box. */
export function ignTileIndexUrl(bounds: Bounds): string {
  const { minX, minY, maxX, maxY } = projectedBounds(bounds);
  const query = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    TYPENAMES: TILE_LAYER,
    OUTPUTFORMAT: "application/json",
    SRSNAME: "EPSG:2154",
    BBOX: `${minX},${minY},${maxX},${maxY},EPSG:2154`,
    COUNT: "8",
  });
  return `${TILE_INDEX}?${query}`;
}

async function filesForBounds(bounds: Bounds): Promise<string[]> {
  const response = await fetchIgnJson<TileIndexResponse>(ignTileIndexUrl(bounds));
  return [
    ...new Set(
      (response.features ?? [])
        .map(({ properties }) => properties)
        .filter(
          (properties) => properties?.format === "copc" && properties.projection === "EPSG:2154",
        )
        .map((properties) => publicIgnDownload(properties?.url))
        .filter((url): url is string => url !== null),
    ),
  ];
}

function getterFor(url: string): Getter {
  return (begin: number, end: number) => fetchIgnRange(url, begin, end);
}

function keyBounds(key: string, cube: number[]): ProjectedBounds {
  const [depth, keyX, keyY] = key.split("-").map(Number);
  const step = (cube[3] - cube[0]) / 2 ** depth;
  return {
    minX: cube[0] + keyX * step,
    minY: cube[1] + keyY * step,
    maxX: cube[0] + (keyX + 1) * step,
    maxY: cube[1] + (keyY + 1) * step,
  };
}

function overlaps(a: ProjectedBounds, b: ProjectedBounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function expectedInBounds(
  key: string,
  pointCount: number,
  cube: number[],
  query: ProjectedBounds,
): number {
  const node = keyBounds(key, cube);
  const overlapX = Math.min(node.maxX, query.maxX) - Math.max(node.minX, query.minX);
  const overlapY = Math.min(node.maxY, query.maxY) - Math.max(node.minY, query.minY);
  if (overlapX <= 0 || overlapY <= 0) return 0;
  return pointCount * ((overlapX * overlapY) / ((node.maxX - node.minX) * (node.maxY - node.minY)));
}

function wantedNodes(
  nodes: Hierarchy.Node.Map,
  cube: number[],
  query: ProjectedBounds,
  area: number,
): [string, Hierarchy.Node][] {
  const byDepth = new Map<number, [string, Hierarchy.Node][]>();
  for (const [key, node] of Object.entries(nodes)) {
    if (!node || !overlaps(keyBounds(key, cube), query)) continue;
    const depth = Number(key.split("-")[0]);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), [key, node]]);
  }

  const wanted: [string, Hierarchy.Node][] = [];
  let plannedPoints = 0;
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    if (plannedPoints / area >= TARGET_DENSITY) break;
    for (const entry of byDepth.get(depth) ?? []) {
      wanted.push(entry);
      plannedPoints += expectedInBounds(entry[0], entry[1].pointCount, cube, query);
    }
  }
  return wanted;
}

async function hierarchyNodes(
  getter: Getter,
  copc: Awaited<ReturnType<typeof Copc.create>>,
  query: ProjectedBounds,
  area: number,
): Promise<{ nodes: Hierarchy.Node.Map; pages: number; capped: boolean }> {
  const nodes: Hierarchy.Node.Map = {};
  let pending: [string, Hierarchy.Page][] = [["0-0-0-0", copc.info.rootHierarchyPage]];
  let pagesRead = 0;

  while (pending.length > 0 && pagesRead < MAX_HIERARCHY_PAGES) {
    const wave = pending;
    pending = [];
    for (const [index, [, page]] of wave.entries()) {
      if (pagesRead >= MAX_HIERARCHY_PAGES) {
        pending.push(...wave.slice(index));
        break;
      }
      const subtree = await Copc.loadHierarchyPage(getter, page);
      pagesRead++;
      Object.assign(nodes, subtree.nodes);
      for (const [key, child] of Object.entries(subtree.pages)) {
        if (child && overlaps(keyBounds(key, copc.info.cube), query)) pending.push([key, child]);
      }
    }
    const plannedDensity =
      wantedNodes(nodes, copc.info.cube, query, area).reduce(
        (count, [key, node]) =>
          count + expectedInBounds(key, node.pointCount, copc.info.cube, query),
        0,
      ) / area;
    if (plannedDensity >= TARGET_DENSITY) {
      return { nodes, pages: pagesRead, capped: false };
    }
  }

  return { nodes, pages: pagesRead, capped: pending.length > 0 };
}

function colourFor(classification: number, returns: number): number {
  if (classification === 2) return packColour(170, 144, 112); // ground
  if (classification === 3) return packColour(154, 184, 112); // low vegetation
  if (classification === 4) return packColour(112, 164, 96); // medium vegetation
  if (classification === 5) return packColour(70, 132, 78); // high vegetation
  if (classification === 6) return packColour(205, 207, 212); // building
  if (classification === 9) return packColour(90, 130, 170); // water
  if (classification === 17) return packColour(150, 150, 155); // bridge deck
  return returns === 1 ? packColour(190, 194, 200) : packColour(105, 148, 100);
}

export interface IgnLidarPoints extends PointArrays {
  files: number;
  pages: number;
  nodes: number;
  bytes: number;
  capped: boolean;
  thinned: boolean;
}

function uniformlyThin<T>(values: T[], count: number): T[] {
  if (values.length <= count) return values;
  return Array.from(
    { length: count },
    (_, index) => values[Math.floor((index * values.length) / count)],
  );
}

/** Classified IGN LiDAR HD points inside a WGS84 box, streamed from COPC. */
export async function ignLidarPointsForBounds(bounds: Bounds): Promise<IgnLidarPoints> {
  const query = projectedBounds(bounds);
  const area = (query.maxX - query.minX) * (query.maxY - query.minY);
  const lon: number[] = [];
  const lat: number[] = [];
  const z: number[] = [];
  const colour: number[] = [];
  const classification: number[] = [];
  let pagesRead = 0;
  let nodesRead = 0;
  let bytesRead = 0;
  let capped = false;

  const files = await filesForBounds(bounds);
  for (const file of files) {
    const getter = getterFor(file);
    const copc = await Copc.create(getter);
    const hierarchy = await hierarchyNodes(getter, copc, query, area);
    pagesRead += hierarchy.pages;
    capped ||= hierarchy.capped;

    for (const [, node] of wantedNodes(hierarchy.nodes, copc.info.cube, query, area)) {
      if (nodesRead >= MAX_NODES || bytesRead + node.pointDataLength > MAX_BYTES) {
        capped = true;
        break;
      }
      const view = await Copc.loadPointDataView(getter, copc, node);
      nodesRead++;
      bytesRead += node.pointDataLength;
      const getX = view.getter("X");
      const getY = view.getter("Y");
      const getZ = view.getter("Z");
      const getClass = view.getter("Classification");
      const getReturns = view.getter("NumberOfReturns");
      for (let index = 0; index < view.pointCount; index++) {
        const x = getX(index);
        const y = getY(index);
        if (x < query.minX || x > query.maxX || y < query.minY || y > query.maxY) continue;
        const pointClass = getClass(index);
        if (NOISE_CLASSES.has(pointClass)) continue;
        const returns = getReturns(index);
        const [pointLon, pointLat] = unprojectLambert93(x, y);
        lon.push(pointLon);
        lat.push(pointLat);
        z.push(getZ(index));
        colour.push(colourFor(pointClass, returns));
        classification.push(returns === 1 ? withSingleReturn(pointClass) : pointClass);
      }
    }
    if (capped) break;
  }

  const thinned = z.length > MAX_OUTPUT_POINTS;
  return {
    lon: uniformlyThin(lon, MAX_OUTPUT_POINTS),
    lat: uniformlyThin(lat, MAX_OUTPUT_POINTS),
    z: uniformlyThin(z, MAX_OUTPUT_POINTS),
    colour: uniformlyThin(colour, MAX_OUTPUT_POINTS),
    classification: uniformlyThin(classification, MAX_OUTPUT_POINTS),
    files: files.length,
    pages: pagesRead,
    nodes: nodesRead,
    bytes: bytesRead,
    capped,
    thinned,
  };
}
