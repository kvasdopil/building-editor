import { Copc, type Getter } from "copc";
import type { Bounds } from "../geometry";
import { type PointArrays, packColour, withSingleReturn } from "../lidar-format";
import { SWEREF99_TM, project, unproject } from "../sweref99";
import { fetchJson, fetchRange } from "./upstream";

/**
 * Reads Lantmäteriet's "Laserdata Skog" point cloud on demand.
 *
 * The tiles are 10 x 5 km COPC files of 0.5-1.4 GB, but COPC is an octree with
 * a range-readable hierarchy, so one building costs a couple of megabytes: find
 * the file through the STAC catalogue, walk the hierarchy, read only the nodes
 * over the footprint. Coordinates are SWEREF 99 TM with RH2000 heights.
 */

const STAC_SEARCH = "https://api.lantmateriet.se/stac-hojd/v1/search";
const COLLECTION = "dsm-skoglig-copc";

/** LAS classes this survey never labels usefully: vendor-flagged noise. */
const NOISE_CLASSES = new Set([7, 18]);

/**
 * Nodes and bytes one tile may read. The caps exist so a pathological request
 * cannot pull a whole 1 GB file, and hitting one is reported rather than
 * silently truncating the cloud.
 */
const MAX_NODES = 64;
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Points per square metre worth reading. A COPC octree is a level-of-detail
 * pyramid, so each deeper level roughly triples the cost for detail this view
 * does not use: over Hammarby, depths 0-5 give 2.5 points/m² for 2.5 MB and the
 * next level spends 2.9 MB more to reach 7.4. Dots read as a surface and a roof
 * percentile is stable well below that, so descent stops once the target is met.
 *
 * Whole levels are taken or skipped, never part of one: nodes at the same depth
 * cover different ground, so a partial level would leave holes in the cloud.
 */
const TARGET_DENSITY = 3;

/**
 * The octree in these files is keyed to the LAS header bounding box rather than
 * to the cube in the COPC info VLR, which the specification says node keys index.
 * Node "6-2-47-18" in the Stockholm tile decodes to points 1.2 km away from where
 * the cube says it should be, and to the byte the header box predicts. Stepping
 * the header box per axis is therefore what selects the right nodes here; the
 * query box is padded by one deepest-level cell so a file that follows the spec
 * over-reads slightly instead of missing points.
 */
const KEY_PADDING_M = 25;

interface StacAsset {
  href: string;
}
interface StacItem {
  id: string;
  assets: Record<string, StacAsset>;
}

/** COPC files overlapping `bounds`, from the public STAC catalogue. */
async function itemsForBounds([west, south, east, north]: Bounds): Promise<StacItem[]> {
  const query = new URLSearchParams({
    collections: COLLECTION,
    bbox: [west, south, east, north].join(","),
    limit: "8",
  });
  const result = await fetchJson<{ features?: StacItem[] }>(`${STAC_SEARCH}?${query}`);
  return (result.features ?? []).filter((item) => item.assets?.data?.href);
}

function getterFor(url: string): Getter {
  return (begin: number, end: number) => fetchRange(url, begin, end);
}

/**
 * Colour for a point. This survey classifies ground, water and bridges and
 * leaves everything else — roofs and vegetation together — unclassified, so the
 * one distinction available for free is the return count: a roof reflects once,
 * a canopy several times. It is a hint, not a classification, and it is what
 * makes a roof legible among the trees in the 3D view.
 */
function colourFor(classification: number, numberOfReturns: number): number {
  if (classification === 2) return packColour(170, 144, 112); // ground
  if (classification === 9) return packColour(90, 130, 170); // water
  if (classification === 17) return packColour(150, 150, 155); // bridge
  return numberOfReturns === 1
    ? packColour(198, 202, 208) // single return: hard surface, most often a roof
    : packColour(112, 150, 104); // several returns: vegetation
}

interface SkogPoints extends PointArrays {
  /** Files, nodes and bytes the read touched, for the route's headers. */
  files: number;
  nodes: number;
  bytes: number;
  /** True when a cap stopped the read before every node was included. */
  capped: boolean;
}

/** Every Skog point inside `bounds`, read straight from upstream. */
export async function skogPointsForBounds(bounds: Bounds): Promise<SkogPoints> {
  const [west, south, east, north] = bounds;
  // The files are projected, so the query box has to be too. Both diagonals are
  // projected because a lon/lat box is not a rectangle in a projected metre grid.
  const corners = [
    project(SWEREF99_TM, west, south),
    project(SWEREF99_TM, east, south),
    project(SWEREF99_TM, west, north),
    project(SWEREF99_TM, east, north),
  ];
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const area = (maxX - minX) * (maxY - minY);

  const lon: number[] = [];
  const lat: number[] = [];
  const z: number[] = [];
  const colour: number[] = [];
  const classification: number[] = [];
  let nodesRead = 0;
  let bytesRead = 0;
  let capped = false;

  const items = await itemsForBounds(bounds);
  for (const item of items) {
    const getter = getterFor(item.assets.data.href);
    const copc = await Copc.create(getter);
    const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);

    const [headerMinX, headerMinY] = copc.header.min;
    const [headerMaxX, headerMaxY] = copc.header.max;
    /**
     * Points a node is expected to put inside the query box: its own count
     * scaled by how much of it the box covers. A node at the top of the octree
     * spans the whole 5-10 km file, so counting its full total against the
     * box's area would satisfy any density target without contributing
     * anything to the tile being built.
     */
    const expectedInBox = (key: string, pointCount: number): number => {
      const [depth, keyX, keyY] = key.split("-").map(Number);
      const stepX = (headerMaxX - headerMinX) / 2 ** depth;
      const stepY = (headerMaxY - headerMinY) / 2 ** depth;
      const x0 = headerMinX + keyX * stepX;
      const y0 = headerMinY + keyY * stepY;
      const overlapX = Math.min(x0 + stepX, maxX) - Math.max(x0, minX);
      const overlapY = Math.min(y0 + stepY, maxY) - Math.max(y0, minY);
      if (overlapX <= 0 || overlapY <= 0) return 0;
      return pointCount * ((overlapX * overlapY) / (stepX * stepY));
    };

    const overlapping = Object.entries(nodes).filter(([key, node]) => {
      if (!node) return false;
      const [depth, keyX, keyY] = key.split("-").map(Number);
      const stepX = (headerMaxX - headerMinX) / 2 ** depth;
      const stepY = (headerMaxY - headerMinY) / 2 ** depth;
      const x0 = headerMinX + keyX * stepX;
      const y0 = headerMinY + keyY * stepY;
      return (
        x0 < maxX + KEY_PADDING_M &&
        x0 + stepX > minX - KEY_PADDING_M &&
        y0 < maxY + KEY_PADDING_M &&
        y0 + stepY > minY - KEY_PADDING_M
      );
    });

    // Shallowest levels first, so the density target decides how deep to go.
    const byDepth = new Map<number, typeof overlapping>();
    for (const entry of overlapping) {
      const depth = Number(entry[0].split("-")[0]);
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), entry]);
    }
    const wanted: typeof overlapping = [];
    let plannedPoints = 0;
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      if (plannedPoints / area >= TARGET_DENSITY) break;
      for (const entry of byDepth.get(depth) ?? []) {
        wanted.push(entry);
        plannedPoints += expectedInBox(entry[0], entry[1]?.pointCount ?? 0);
      }
    }

    for (const [, node] of wanted) {
      if (!node) continue;
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
      for (let i = 0; i < view.pointCount; i++) {
        const x = getX(i);
        const y = getY(i);
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        const pointClass = getClass(i);
        if (NOISE_CLASSES.has(pointClass)) continue;
        const [pointLon, pointLat] = unproject(SWEREF99_TM, x, y);
        const returns = getReturns(i);
        lon.push(pointLon);
        lat.push(pointLat);
        z.push(getZ(i));
        colour.push(colourFor(pointClass, returns));
        classification.push(returns === 1 ? withSingleReturn(pointClass) : pointClass);
      }
    }
    if (capped) break;
  }

  return {
    lon,
    lat,
    z,
    colour,
    classification,
    files: items.length,
    nodes: nodesRead,
    bytes: bytesRead,
    capped,
  };
}
