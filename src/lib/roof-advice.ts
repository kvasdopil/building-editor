import type { Footprint } from "./buildings";
import type { Suggestion } from "./lod1";
import {
  type RoofFootprint,
  type RoofOrientation,
  type RoofPlan,
  type RoofShape,
  type RoofSurface,
  hippedRoofGeometryReady,
  roofSurface,
} from "./roofs";
import { type GridFrame, type SurfaceGrid, lonLatToGrid } from "./surface-grid";

/**
 * Laser-measured advice for the dimension tags of one element — the selected
 * building or a single building:part — read from its cells of the surface
 * grid. The three tags are read together rather than separately: the roof the
 * 3D view would extrude from them is built, raised until it sits as close to
 * the laser points as it can, and the combination whose surface misses by the
 * least is what gets offered — with that miss, in metres, reported alongside.
 *
 * Which shape is tried first still comes from what the roof does where it
 * meets each of its walls, because the residual alone cannot tell the shapes
 * apart (see `classifyShape`). The fitting decides the heights and measures
 * the result; the walls decide the shape unless another fits distinctly
 * better.
 *
 * The shape is a best effort offered for confirmation, not a measurement: it
 * agrees with two thirds of well-tagged roofs, and most of the rest are the
 * genuine hip/gable ambiguity, since a block with hipped ends is routinely
 * tagged `gabled` by whoever looked at it.
 *
 * LOD1 advice exists only where the municipal blocks do and knows nothing
 * about roof shapes or parts; this covers the rest from the laser alone.
 * Free of map and DOM dependencies, like the grid it reads.
 */

/**
 * Advice needs at least this many fitted cells (~10 m²) under the element.
 * A small outbuilding barely clears it: the 0.4 m edge margin erodes a 6 x 4 m
 * footprint to about sixty cells, and a slightly smaller one to fewer. The
 * error reported beside every suggestion is the better guard against a thin
 * reading than a high floor is, because it says how thin.
 */
const MIN_CELLS = 40;

/**
 * Raw maxima are only a better ridge than the fitted heights when there are
 * enough of them for a high percentile to mean something. Below this the
 * smoothed heights are steadier, even though they erode the ridge a little.
 */
const MIN_PEAK_CELLS = 60;

/** Cells steeper than this carry the shape vote. */
const SLOPED_CELL_RAD = (8 * Math.PI) / 180;

/**
 * How far a raw return may stand above the surface fitted around it before it
 * stops being roof. A chimney, an antenna or an overhanging branch rises
 * metres above the plane its own cell fits, while a ridge peak clears it by a
 * few centimetres — the smithy at Kastellet reads 12.5 m at the chimney and
 * 6.4 m at the ridge it actually has. Rejecting on that gap rather than on a
 * percentile is what makes small roofs work: a building of seventy cells has
 * no ninety-ninth percentile to hide an outlier in.
 */
const MAX_PEAK_ABOVE_FIT_M = 1.5;

/** The smallest rise a roof is searched at, and the smallest one suggested. */
const MIN_ROOF_RISE_M = 0.5;

/** The largest, as a share of the building's height and as a flat ceiling. */
const MAX_ROOF_RISE_SHARE = 0.6;
const MAX_ROOF_RISE_M = 8;

/** The step the rise is searched in — the half-metres a tag is written in. */
const RISE_STEP_M = 0.5;

/** Bucket edge for the point index a modelled surface is dropped on, metres. */
const BUCKET_M = 2;

/**
 * Where the roof starts, as a share of the building's height above ground.
 * Everything below is a courtyard, a lower wing, or ground seen through a gap
 * in the outline, and reading eaves from those puts the join at ankle height.
 * A share rather than a fixed clearance, or a garden shed has no roof left.
 */
const ROOF_FLOOR_SHARE = 0.5;

/** The roof has to be this much of the element before its eaves are believed. */
const MIN_ROOF_CELL_SHARE = 0.25;

/** A fitted candidate must reach this share of the element's points to count. */
const MIN_MODEL_COVERAGE = 0.6;

/** Share of the closest-fitting cells the reported miss is measured over. */
const TRIMMED_SHARE = 0.9;

/** How far in from a wall the roof still counts as meeting that wall. */
const WALL_BAND_M = 2.5;

/** A stretch of wall with fewer sloped cells than this is not read. */
const MIN_WALL_CELLS = 5;

/** Share of the perimeter that must climb away before a roof is one pitch. */
const MIN_HIGH_WALL_SHARE = 0.12;

/** Share of the perimeter that must run along the roof before it is a gable. */
const MIN_GABLE_SHARE = 0.1;

/** Top slice of the roof's height range that counts as its ridge. */
const RIDGE_BAND_SHARE = 0.08;

/** A ridge closer than this to a wall has run out to it, so that end is a gable. */
const RIDGE_REACH_M = 0.6;

/** A hip's ridge shorter than this share of the footprint is a pyramid's apex. */
const PYRAMID_RIDGE_SHARE = 0.25;

function formatHeight(value: number): string {
  return String(Math.round(value * 2) / 2);
}

function percentile(sorted: number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function compare(
  key: string,
  value: string,
  tags: Record<string, string>,
  note: string,
  confident: boolean,
  error?: number,
): Suggestion | null {
  const current = tags[key];
  if (current === undefined || current === "")
    return { key, value, kind: "missing", source: "laser", note, confident, error };
  if (current.trim() === value) return null;
  return { key, value, current, kind: "differs", source: "laser", note, confident, error };
}

interface ElementCells {
  heights: number[];
  /** Raw per-cell maxima, chimneys excluded — what ridge and eaves read from. */
  peaks: number[];
  slopes: number[];
  /** Downslope direction per cell, in the grid frame. */
  aspects: number[];
  /** Cell centres in the grid frame, parallel to the readings above. */
  us: number[];
  vs: number[];
  /** Where each cell sits in the raster, so a modelled roof can be sampled. */
  columns: number[];
  rows: number[];
  /** The grid frame's rotation, for turning a grid aspect into a bearing. */
  theta: number;
  /** The element's outline in the grid frame, as the walls the roof meets. */
  edges: Edge[];
  /** Fitted cells over cells inside the element, as a coverage measure. */
  coverage: number;
}

/** One outline segment with the direction pointing out of the building. */
interface Edge {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  length: number;
  /** Outward unit normal in the grid frame. */
  normalU: number;
  normalV: number;
}

/** Even-odd test over every ring, so holes count themselves back out. */
function insideRings(rings: [number, number][][], u: number, v: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ui, vi] = ring[i];
      const [uj, vj] = ring[j];
      if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
    }
  }
  return inside;
}

/**
 * The outline's segments, each with the normal that points away from the
 * building. Ring winding cannot be assumed — holes run the other way round —
 * so the outward side is decided by stepping off the segment and asking the
 * polygon which side that landed on.
 */
function outlineEdges(rings: [number, number][][]): Edge[] {
  const edges: Edge[] = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [u0, v0] = ring[j];
      const [u1, v1] = ring[i];
      const length = Math.hypot(u1 - u0, v1 - v0);
      if (length < 1e-6) continue;
      let normalU = (v1 - v0) / length;
      let normalV = -(u1 - u0) / length;
      if (insideRings(rings, (u0 + u1) / 2 + normalU * 0.5, (v0 + v1) / 2 + normalV * 0.5)) {
        normalU = -normalU;
        normalV = -normalV;
      }
      edges.push({ u0, v0, u1, v1, length, normalU, normalV });
    }
  }
  return edges;
}

/** Distance from a point to one outline segment. */
function distanceToEdge(edge: Edge, u: number, v: number): number {
  const du = edge.u1 - edge.u0;
  const dv = edge.v1 - edge.v0;
  const t = Math.max(
    0,
    Math.min(1, ((u - edge.u0) * du + (v - edge.v0) * dv) / (du * du + dv * dv)),
  );
  return Math.hypot(u - edge.u0 - t * du, v - edge.v0 - t * dv);
}

/** One element's rings in the grid frame, the outline everything is cut to. */
function gridRings(frame: GridFrame, polygons: Footprint[]): [number, number][][] {
  return polygons
    .flatMap((polygon) => [polygon.outer, ...polygon.holes])
    .map((ring) => ring.map(([lon, lat]) => lonLatToGrid(frame, lon, lat)));
}

/** The grid's surface returns that stand inside this element. */
interface ElementPoints {
  count: number;
  us: Float32Array;
  vs: Float32Array;
  /** Absolute height, metres RH2000. */
  zs: Float32Array;
}

function elementPoints(grid: SurfaceGrid, rings: [number, number][][]): ElementPoints {
  const kept: number[] = [];
  for (let i = 0; i < grid.points.count; i++) {
    if (insideRings(rings, grid.points.us[i], grid.points.vs[i])) kept.push(i);
  }
  return {
    count: kept.length,
    us: Float32Array.from(kept, (i) => grid.points.us[i]),
    vs: Float32Array.from(kept, (i) => grid.points.vs[i]),
    zs: Float32Array.from(kept, (i) => grid.points.zs[i]),
  };
}

function elementCells(grid: SurfaceGrid, rings: [number, number][][]): ElementCells {
  const cells: ElementCells = {
    heights: [],
    peaks: [],
    slopes: [],
    aspects: [],
    us: [],
    vs: [],
    columns: [],
    rows: [],
    theta: grid.frame.theta,
    edges: outlineEdges(rings),
    coverage: 0,
  };
  let insideCount = 0;
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const at = row * grid.columns + column;
      if (!grid.inside[at]) continue;
      const u = grid.frame.uMin + (column + 0.5) * grid.cell;
      const v = grid.frame.vMin + (row + 0.5) * grid.cell;
      if (!insideRings(rings, u, v)) continue;
      insideCount += 1;
      if (Number.isNaN(grid.height[at])) continue;
      if (grid.heightMax[at] - grid.height[at] <= MAX_PEAK_ABOVE_FIT_M) {
        cells.peaks.push(grid.heightMax[at]);
      }
      cells.heights.push(grid.height[at]);
      cells.slopes.push(grid.slope[at]);
      // Back into the grid frame, where the outline and its normals live.
      cells.aspects.push(grid.aspect[at] - grid.frame.theta);
      cells.us.push(u);
      cells.vs.push(v);
      cells.columns.push(column);
      cells.rows.push(row);
    }
  }
  cells.coverage = insideCount > 0 ? cells.heights.length / insideCount : 0;
  return cells;
}

/** How each wall reads from the roof that meets it. */
type WallKind = "eaves" | "gable" | "high";

/** The outline segment nearest each cell, and how far away it is. */
interface NearestWall {
  edge: number;
  distance: number;
}

function nearestWalls(cells: ElementCells): NearestWall[] {
  return cells.us.map((u, i) => {
    let edge = -1;
    let distance = Infinity;
    for (let e = 0; e < cells.edges.length; e++) {
      const candidate = distanceToEdge(cells.edges[e], u, cells.vs[i]);
      if (candidate < distance) {
        distance = candidate;
        edge = e;
      }
    }
    return { edge, distance };
  });
}

/**
 * What the roof does at each stretch of wall, weighted by wall length.
 *
 * A roof surface either falls towards the wall it meets — an eaves wall — or
 * runs along it, which is a gable end, or falls away from it, which is the
 * high wall of a single-pitch roof. Reading the walls rather than the roof as
 * a whole is what lets a courtyard block be understood: its wings point every
 * way, so their aspects taken together say nothing, while every wing's own
 * walls still say plainly that the roof drains over them.
 */
function wallKinds(cells: ElementCells, walls: NearestWall[]): Map<WallKind, number> {
  const votes = cells.edges.map(() => ({ sum: 0, count: 0 }));
  for (let i = 0; i < cells.us.length; i++) {
    if (cells.slopes[i] <= SLOPED_CELL_RAD) continue;
    if (walls[i].distance > WALL_BAND_M) continue;
    const nearest = walls[i].edge;
    const edge = cells.edges[nearest];
    // +1 where the surface falls straight out over the wall, -1 where it
    // climbs away from it, 0 where it runs along it.
    votes[nearest].sum +=
      Math.cos(cells.aspects[i]) * edge.normalU + Math.sin(cells.aspects[i]) * edge.normalV;
    votes[nearest].count += 1;
  }

  const shares = new Map<WallKind, number>([
    ["eaves", 0],
    ["gable", 0],
    ["high", 0],
  ]);
  let measured = 0;
  for (let e = 0; e < cells.edges.length; e++) {
    if (votes[e].count < MIN_WALL_CELLS) continue;
    const facing = votes[e].sum / votes[e].count;
    const kind: WallKind = facing > 0.45 ? "eaves" : facing < -0.45 ? "high" : "gable";
    shares.set(kind, (shares.get(kind) ?? 0) + cells.edges[e].length);
    measured += cells.edges[e].length;
  }
  if (measured > 0) {
    for (const [kind, length] of shares) shares.set(kind, length / measured);
  }
  return shares;
}

/** Cells within the top slice of the roof's own height range: its ridge. */
function ridgeCells(cells: ElementCells): number[] {
  const sorted = [...cells.heights].sort((a, b) => a - b);
  const peak = percentile(sorted, 0.98);
  const base = percentile(sorted, 0.1);
  const floor = peak - (peak - base) * RIDGE_BAND_SHARE;
  const ridge: number[] = [];
  for (let i = 0; i < cells.heights.length; i++) {
    if (cells.heights[i] >= floor) ridge.push(i);
  }
  return ridge;
}

/**
 * The roof's shape, read from what it does at each of its walls: a roof that
 * falls over every wall is hipped, one that runs along a pair of them is
 * gabled, and one that climbs away from a wall is a single pitch. A pyramid is
 * a hip whose ridge has closed to a point.
 *
 * Three other readings were measured against Hammarby Sjöstad's tags and
 * dropped, all of them worse. An aspect histogram over the whole roof cannot
 * see a courtyard block, whose wings point every way at once. Fitting the cell
 * heights to idealised surfaces — and then to the real roof geometry the 3D
 * view extrudes, every shape placed at its own best fit, robustly, with the
 * model blurred to match the measurement — scored worse still: at two points
 * per square metre a gable, a hip and a barrel vault leave height residuals
 * within centimetres of each other, well inside the noise that roof equipment
 * and the fit window put there. Direction survives that noise where height
 * does not, which is why the walls are what get read.
 */
function classifyShape(cells: ElementCells, squarish: boolean): string | null {
  const sloped = cells.slopes.filter((slope) => slope > SLOPED_CELL_RAD).length;
  if (sloped < cells.slopes.length * 0.18) return "flat";

  const walls = nearestWalls(cells);
  const kinds = wallKinds(cells, walls);
  const gable = kinds.get("gable") ?? 0;
  const high = kinds.get("high") ?? 0;
  if ((kinds.get("eaves") ?? 0) === 0 && gable === 0 && high === 0) return null;

  if (high >= MIN_HIGH_WALL_SHARE) return "skillion";

  // A gable is where the ridge runs out to a wall instead of turning down into
  // a hip. Either the wall it reaches is broad enough to read as a gable end,
  // or the ridge itself is seen touching the outline.
  const ridge = ridgeCells(cells);
  const reach = Math.min(...ridge.map((i) => walls[i].distance));
  if (gable >= MIN_GABLE_SHARE || reach < RIDGE_REACH_M) return "gabled";

  // Every wall is eaves and the ridge stops short of all of them. A ridge that
  // has closed to a point rather than run as a line is a pyramid.
  if (!squarish) return "hipped";
  const spread = Math.max(
    Math.max(...ridge.map((i) => cells.us[i])) - Math.min(...ridge.map((i) => cells.us[i])),
    Math.max(...ridge.map((i) => cells.vs[i])) - Math.min(...ridge.map((i) => cells.vs[i])),
  );
  const across = Math.max(
    Math.max(...cells.us) - Math.min(...cells.us),
    Math.max(...cells.vs) - Math.min(...cells.vs),
  );
  return spread < across * PYRAMID_RIDGE_SHARE ? "pyramidal" : "hipped";
}

/**
 * The grid frame's (u, v) in the plan coordinates roof geometry is built in:
 * east metres and southward metres, the same projection the 3D scene puts a
 * footprint through before extruding it.
 */
function toPlan(frame: GridFrame, u: number, v: number): [number, number] {
  const east = u * Math.cos(frame.theta) - v * Math.sin(frame.theta);
  const north = u * Math.sin(frame.theta) + v * Math.cos(frame.theta);
  return [east, -north];
}

function planFootprints(frame: GridFrame, polygons: Footprint[]): RoofFootprint[] {
  const ring = (points: [number, number][]) =>
    points.slice(0, -1).map(([lon, lat]): [number, number] => {
      const [u, v] = lonLatToGrid(frame, lon, lat);
      return toPlan(frame, u, v);
    });
  return polygons.map((polygon) => ({
    outer: ring(polygon.outer),
    holes: polygon.holes.map(ring),
  }));
}

/**
 * The modelled roof height over every point the survey left inside the
 * element, NaN where the surface does not reach it.
 *
 * The surface arrives as triangles of `[x, height, y]`, and each is dropped on
 * the points beneath it. Measuring against the returns themselves is what
 * removes the correction this used to need: a cell height is a plane fitted
 * across a 2.5 m window, so a model had to be passed through the same window
 * before the two were comparable, and the pair of roundings did not cancel
 * evenly — a ridge lost more of itself than the broad surfaces around it did,
 * which biased every rise the fit was asked to choose. Points have no window
 * to match.
 */
function sampleSurface(
  surface: RoofSurface,
  points: ElementPoints,
  frame: GridFrame,
): Float64Array {
  const modelled = new Float64Array(points.count).fill(Number.NaN);
  if (points.count === 0) return modelled;

  // Points bucketed coarsely, so each triangle only visits what could lie
  // under it rather than the whole element.
  let uMin = Infinity;
  let vMin = Infinity;
  let uMax = -Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < points.count; i++) {
    if (points.us[i] < uMin) uMin = points.us[i];
    if (points.us[i] > uMax) uMax = points.us[i];
    if (points.vs[i] < vMin) vMin = points.vs[i];
    if (points.vs[i] > vMax) vMax = points.vs[i];
  }
  const columns = Math.max(1, Math.ceil((uMax - uMin + 1) / BUCKET_M));
  const rows = Math.max(1, Math.ceil((vMax - vMin + 1) / BUCKET_M));
  const buckets: number[][] = Array.from({ length: columns * rows }, () => []);
  const columnOf = (u: number) => Math.min(columns - 1, Math.max(0, ((u - uMin) / BUCKET_M) | 0));
  const rowOf = (v: number) => Math.min(rows - 1, Math.max(0, ((v - vMin) / BUCKET_M) | 0));
  for (let i = 0; i < points.count; i++) {
    buckets[rowOf(points.vs[i]) * columns + columnOf(points.us[i])].push(i);
  }

  const { positions, indices } = surface;
  const triangles = indices ? indices.length / 3 : positions.length / 9;
  for (let t = 0; t < triangles; t++) {
    const at = (corner: number) => (indices ? indices[t * 3 + corner] * 3 : t * 9 + corner * 3);
    const corners = [at(0), at(1), at(2)].map((base): [number, number, number] => {
      const east = positions[base];
      const north = -positions[base + 2];
      return [
        east * Math.cos(frame.theta) + north * Math.sin(frame.theta),
        -east * Math.sin(frame.theta) + north * Math.cos(frame.theta),
        positions[base + 1],
      ];
    });
    const area =
      (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]) -
      (corners[2][0] - corners[0][0]) * (corners[1][1] - corners[0][1]);
    if (Math.abs(area) < 1e-9) continue;

    const us = corners.map((corner) => corner[0]);
    const vs = corners.map((corner) => corner[1]);
    const minColumn = columnOf(Math.min(...us));
    const maxColumn = columnOf(Math.max(...us));
    const minRow = rowOf(Math.min(...vs));
    const maxRow = rowOf(Math.max(...vs));
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        for (const index of buckets[row * columns + column]) {
          const u = points.us[index];
          const v = points.vs[index];
          const w0 =
            ((corners[1][0] - u) * (corners[2][1] - v) -
              (corners[2][0] - u) * (corners[1][1] - v)) /
            area;
          const w1 =
            ((corners[2][0] - u) * (corners[0][1] - v) -
              (corners[0][0] - u) * (corners[2][1] - v)) /
            area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const height = w0 * corners[0][2] + w1 * corners[1][2] + w2 * corners[2][2];
          // A roof folds back over itself at a valley or a dome's far side, so
          // the surface the laser saw is the highest one above the point.
          if (!(modelled[index] >= height)) modelled[index] = height;
        }
      }
    }
  }
  return modelled;
}

/**
 * How far a fitted roof misses, in metres: the mean over the closest-fitting
 * cells only. Every roof carries lift housings, dormers and stair towers that
 * no shape describes, and counting those in full lets a few metres of clutter
 * stand for the whole roof.
 */
function trimmedError(residuals: number[]): number {
  const sorted = [...residuals].sort((a, b) => a - b);
  const counted = Math.max(1, Math.floor(sorted.length * TRIMMED_SHARE));
  let total = 0;
  for (let i = 0; i < counted; i++) total += sorted[i];
  return total / counted;
}

/** The mean downslope bearing of the roof's cells, for a single-pitch roof. */
function downslopeBearing(cells: ElementCells): number {
  let east = 0;
  let north = 0;
  for (let i = 0; i < cells.aspects.length; i++) {
    const world = cells.aspects[i] + cells.theta;
    east += Math.cos(world) * cells.slopes[i];
    north += Math.sin(world) * cells.slopes[i];
  }
  const bearing = (90 - (Math.atan2(north, east) * 180) / Math.PI) % 360;
  return bearing < 0 ? bearing + 360 : bearing;
}

/**
 * How far the roof this advice describes actually sits from the laser, in
 * metres: build the surface the 3D view would extrude from the suggested
 * shape, eaves and ridge, and measure it against the points.
 *
 * It chooses one thing and reports on the rest. `roof:height` is settled by
 * minimizing it, because the eaves have no direct reading to beat. `height`
 * and `roof:shape` are not: reading the ridge off the raw maxima beats fitting
 * it, and brute-forcing every shape, orientation, height and rise against
 * these same points scores 42 of 108 tagged roofs against the walls' 67, since
 * a gambrel or a barrel vault has the freedom to bend onto anything at two
 * points per square metre. What the number is good for otherwise is telling a
 * mapper when to look twice: a roof within 0.2 m of the points is the one that
 * is there, and one adrift by a metre has something on it that no roof shape
 * describes.
 */
function sampledRoof(
  cells: ElementCells,
  points: ElementPoints,
  grid: SurfaceGrid,
  polygons: Footprint[],
  shape: string,
  eaves: number,
  ridge: number,
): Float64Array | undefined {
  if (ridge - eaves <= 0) return undefined;
  const footprints = planFootprints(grid.frame, polygons);
  if (footprints.length === 0) return undefined;
  // Without the skeleton engine a hipped roof builds as a pyramid, and the
  // number would belong to a roof nobody is being offered.
  if (shape === "hipped" && !hippedRoofGeometryReady()) return undefined;

  let best: Float64Array | undefined;
  let bestMiss = Number.POSITIVE_INFINITY;
  for (const orientation of ["along", "across"] as RoofOrientation[]) {
    // Only an axial roof has two ways round; the outline does not say which,
    // so the roof is credited with the one that fits.
    if (orientation === "across" && !["gabled", "gambrel", "round"].includes(shape)) continue;
    const plan: RoofPlan = {
      shape: shape as RoofShape,
      orientation,
      direction: shape === "skillion" ? downslopeBearing(cells) : undefined,
      directionFromCompass: false,
      eaves,
      top: ridge,
    };
    const surface = roofSurface(plan, footprints, footprints, 0);
    if (!surface) continue;
    const modelled = sampleSurface(surface, points, grid.frame);
    const miss = surfaceMiss(modelled, points);
    if (miss !== undefined && miss < bestMiss) {
      bestMiss = miss;
      best = modelled;
    }
  }
  return best;
}

/** Mean miss of a sampled surface, or undefined where it covered too little. */
function surfaceMiss(modelled: Float64Array, points: ElementPoints): number | undefined {
  const residuals: number[] = [];
  for (let i = 0; i < modelled.length; i++) {
    if (Number.isNaN(modelled[i])) continue;
    residuals.push(Math.abs(modelled[i] - points.zs[i]));
  }
  if (residuals.length < points.count * MIN_MODEL_COVERAGE) return undefined;
  return trimmedError(residuals);
}

/**
 * The same roof raised to a different eaves and ridge.
 *
 * Every roof this offers is built by interpolating between its eaves and its
 * apex, so moving either is an affine transform of the heights it produced —
 * no need to rebuild and re-rasterise the surface for each candidate.
 */
function raised(
  modelled: Float64Array,
  from: { eaves: number; ridge: number },
  to: { eaves: number; ridge: number },
): Float64Array {
  const scale = (to.ridge - to.eaves) / (from.ridge - from.eaves);
  const moved = new Float64Array(modelled.length);
  for (let i = 0; i < modelled.length; i++) {
    moved[i] = to.eaves + (modelled[i] - from.eaves) * scale;
  }
  return moved;
}

/** One candidate placement of the roof, in both written and raw forms. */
interface Placement {
  eaves: number;
  ridge: number;
  miss: number;
  rise: number;
  height: number;
}

/**
 * The `roof:height`, in the half-metres a tag is written in, whose roof sits
 * closest to the points — every rise the building could have, not a nudge
 * around the measured one.
 *
 * The ridge stays where the percentile put it. `height` names the highest
 * point of the building and a high percentile of raw cell maxima reads that
 * directly, while a mean residual moves it down: the broad surfaces near the
 * eaves are most of the roof and they outvote the ridge line. Letting the fit
 * choose the height as well costs `height` half a metre of median bias and
 * takes its mean error from 1.10 m to 1.67 m over the calibration area.
 *
 * The rise is the opposite case. Nothing reads the eaves directly — the low
 * percentile of roof cells is a guess at where the roof starts, and dormers,
 * parapets and a lower wing all move it — so the surface that fits is the
 * better answer, and searching the whole range rather than a window around
 * that guess takes `roof:height` from 0.89 m to 0.73 m.
 *
 * This used to be gated on the roof already fitting within half a metre,
 * because an unrestricted search made the rise worse. That was an artefact of
 * scoring against the fitted cells: the model had to be blurred to match them,
 * and the blur cost a ridge more than it cost the eaves, so the fit paid for
 * rises it should not have. Against the points there is nothing to gate.
 */
function bestRise(
  modelled: Float64Array,
  points: ElementPoints,
  seed: { eaves: number; ridge: number },
  ground: number,
): Placement | undefined {
  const height = seed.ridge - ground;
  const limit = Math.min(MAX_ROOF_RISE_SHARE * height, MAX_ROOF_RISE_M);
  let best: Placement | undefined;
  for (let rise = MIN_ROOF_RISE_M; rise <= limit + 1e-6; rise += RISE_STEP_M) {
    const eaves = seed.ridge - rise;
    const miss = surfaceMiss(raised(modelled, seed, { eaves, ridge: seed.ridge }), points);
    if (miss === undefined) continue;
    if (!best || miss < best.miss) best = { eaves, ridge: seed.ridge, miss, rise, height };
  }
  return best;
}

/** Parse an OSM length: a bare number of metres, or one with `m` after it. */
function parseMetres(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*m?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(amount) ? amount : undefined;
}

/** The combination of tags the laser recommends, and how well each roof fits. */
export interface RoofReading {
  /** Advice per tag: only the keys OSM is missing or disagrees with. */
  advice: Suggestion[];
  /** Fitted cells the reading was taken from. */
  cells: number;
  /** The whole recommendation, whether or not OSM already agrees with it. */
  recommended: { height: string; roofHeight?: string; shape: string };
  /** The building's height above its own ground, metres — the scale a miss is worth reading against. */
  scale: number;
  /** Mean distance from the points to the recommended roof, metres. */
  miss?: number;
  /**
   * The same measurement for the roof the element's own tags describe, so the
   * two can be compared. Absent when those tags do not describe one — no
   * shape, or no height to raise it to.
   */
  currentMiss?: number;
}

/** Laser advice for one element's `height`, `roof:height` and `roof:shape`. */
export function roofAdviceFor(
  grid: SurfaceGrid,
  polygons: Footprint[],
  tags: Record<string, string>,
): RoofReading | null {
  const rings = gridRings(grid.frame, polygons);
  const cells = elementCells(grid, rings);
  const points = elementPoints(grid, rings);
  if (cells.heights.length < MIN_CELLS) return null;
  const confident = cells.coverage >= 0.5;

  // Ridge and eaves from raw per-cell maxima: the smoothed fit erodes a
  // ridge by up to a metre, while a high percentile of the maxima rides just
  // under the chimneys.
  const sorted = [...(cells.peaks.length >= MIN_PEAK_CELLS ? cells.peaks : cells.heights)].sort(
    (a, b) => a - b,
  );
  const ridge = percentile(sorted, 0.99);
  // Eaves from the roof's own low cells: courtyards, terraces and ground
  // showing through the outline would otherwise drag the estimate down and
  // read as a phantom two-storey roof.
  const floor = grid.ground + ROOF_FLOOR_SHARE * (ridge - grid.ground);
  const aboveFloor = sorted.filter((h) => h >= floor);
  const eaves =
    aboveFloor.length >= Math.max(10, sorted.length * MIN_ROOF_CELL_SHARE)
      ? percentile(aboveFloor, 0.15)
      : ridge;

  let uSpanMin = Infinity;
  let uSpanMax = -Infinity;
  let vSpanMin = Infinity;
  let vSpanMax = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon.outer) {
      const [u, v] = lonLatToGrid(grid.frame, point[0], point[1]);
      if (u < uSpanMin) uSpanMin = u;
      if (u > uSpanMax) uSpanMax = u;
      if (v < vSpanMin) vSpanMin = v;
      if (v > vSpanMax) vSpanMax = v;
    }
  }
  const spans = [uSpanMax - uSpanMin, vSpanMax - vSpanMin];
  const squarish = Math.max(...spans) < 1.6 * Math.min(...spans);

  const shape = classifyShape(cells, squarish);
  const shaped = shape !== null && shape !== "flat";
  // The ridge is written from the measurement, rounded to the half metre a tag
  // is written in: the reported miss has to be the one the mapper gets after
  // pressing apply, or it will not match what the tags then report.
  const advisedTop = grid.ground + Number(formatHeight(ridge - grid.ground));
  // The eaves only seed a reference placement to rasterise once. Moving a roof
  // between eaves and apex is affine, so every rise the search tries is a
  // rescaling of this one surface.
  const seedRise = Math.max(
    MIN_ROOF_RISE_M,
    Math.min(Number(formatHeight(ridge - eaves)), MAX_ROOF_RISE_M),
  );
  const seedEaves = advisedTop - seedRise;
  // Only ever needed for a flat roof, and sorting every return of a large
  // building is not worth doing for the rest.
  const flatMiss = () => {
    const sorted = [...points.zs].sort((a, b) => a - b);
    const level = sorted[sorted.length >> 1];
    return trimmedError(sorted.map((height) => Math.abs(height - level)));
  };
  const modelled = shaped
    ? sampledRoof(cells, points, grid, polygons, shape, seedEaves, advisedTop)
    : undefined;
  const searched = modelled
    ? bestRise(modelled, points, { eaves: seedEaves, ridge: advisedTop }, grid.ground)
    : undefined;
  const offerRise = shaped && searched !== undefined;
  const advisedEaves = searched?.eaves ?? advisedTop;
  const miss =
    shape === "flat"
      ? flatMiss()
      : searched
        ? searched.miss
        : modelled && surfaceMiss(modelled, points);
  const note =
    `laser, ${cells.heights.length} cells of this element` +
    (miss === undefined
      ? ""
      : ` — the ${shape} roof it describes sits within ${miss.toFixed(2)} m of the points`);

  // What the element's own tags describe, measured the same way, so a mapper
  // can see whether the recommendation is actually an improvement on it.
  const taggedHeight = parseMetres(tags.height);
  const taggedRise = parseMetres(tags["roof:height"]);
  const tagged =
    tags["roof:shape"] === "flat"
      ? undefined
      : tags["roof:shape"] && taggedHeight !== undefined
        ? sampledRoof(
            cells,
            points,
            grid,
            polygons,
            tags["roof:shape"],
            grid.ground + taggedHeight - (taggedRise ?? 0),
            grid.ground + taggedHeight,
          )
        : undefined;
  const currentMiss =
    tags["roof:shape"] === "flat" && taggedHeight !== undefined
      ? flatMiss()
      : tagged && surfaceMiss(tagged, points);

  const advice: Suggestion[] = [];
  const height = compare(
    "height",
    formatHeight(advisedTop - grid.ground),
    tags,
    note,
    confident,
    miss,
  );
  if (height) advice.push(height);
  if (shape === null) {
    return {
      advice,
      cells: cells.heights.length,
      recommended: { height: formatHeight(advisedTop - grid.ground), shape: "" },
      scale: advisedTop - grid.ground,
      miss,
      currentMiss,
    };
  }

  // The shape is the one reading here that is a judgement rather than a
  // measurement — idealised roofs fit these points within centimetres of each
  // other — so it never claims the confidence the heights do, and carries its
  // miss for the mapper to weigh against the roof itself.
  const shapeAdvice = compare("roof:shape", shape, tags, note, false, miss);
  if (shapeAdvice) advice.push(shapeAdvice);

  if (offerRise) {
    const roofHeight = compare(
      "roof:height",
      formatHeight(advisedTop - advisedEaves),
      tags,
      note,
      confident,
      miss,
    );
    if (roofHeight) advice.push(roofHeight);
  }
  return {
    advice,
    cells: cells.heights.length,
    recommended: {
      height: formatHeight(advisedTop - grid.ground),
      roofHeight: offerRise ? formatHeight(advisedTop - advisedEaves) : undefined,
      shape,
    },
    scale: advisedTop - grid.ground,
    miss,
    currentMiss,
  };
}
