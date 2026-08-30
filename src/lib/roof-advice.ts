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
import { type GridFrame, type SurfaceGrid, WINDOW_CELLS, lonLatToGrid } from "./surface-grid";

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

/** Suggest `roof:height` only when the roof actually rises this much. */
const MIN_ROOF_RISE_M = 0.75;

/**
 * Where the roof starts, as a share of the building's height above ground.
 * Everything below is a courtyard, a lower wing, or ground seen through a gap
 * in the outline, and reading eaves from those puts the join at ankle height.
 * A share rather than a fixed clearance, or a garden shed has no roof left.
 */
const ROOF_FLOOR_SHARE = 0.5;

/** The roof has to be this much of the element before its eaves are believed. */
const MIN_ROOF_CELL_SHARE = 0.25;

/** The written half-metre steps the search moves the roof height by. */
const SEARCH_STEPS_M = [-1, -0.5, 0, 0.5, 1];

/** Re-centrings allowed while the best combination is still on an edge. */
const SEARCH_ROUNDS = 6;

/**
 * How far the search may end up from the reading that seeded it. Beyond a few
 * metres it has stopped refining a measurement and started inventing one, and
 * whatever it has found is a property of the roof model rather than of the
 * building.
 */
const SEARCH_REACH_M = 3;

/** A modelled roof this close to the points is describing the actual roof. */
const TRUSTED_FIT_M = 0.5;

/** A fitted candidate must reach this share of the element's cells to count. */
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

function elementCells(grid: SurfaceGrid, polygons: Footprint[]): ElementCells {
  const rings = polygons
    .flatMap((polygon) => [polygon.outer, ...polygon.holes])
    .map((ring) => ring.map(([lon, lat]) => lonLatToGrid(grid.frame, lon, lat)));

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
 * The modelled roof height over every cell the laser filled, NaN where the
 * surface does not reach, blurred the way the measurement already is.
 *
 * The surface arrives as triangles of `[x, height, y]`, and each is rasterised
 * over the cells beneath it: the roof is sampled where the laser looked rather
 * than the other way round, so nothing has to be interpolated between points.
 * A cell's measured height then comes from a plane fitted across a 2.5 m
 * window, which rounds off a ridge however sharp it really is — passing the
 * model through the same window is what puts both sides in the same state.
 */
function sampleSurface(
  surface: RoofSurface,
  cells: ElementCells,
  columns: number,
  rows: number,
  cell: number,
  frame: GridFrame,
): Float64Array {
  const lookup = new Int32Array(columns * rows).fill(-1);
  for (let i = 0; i < cells.columns.length; i++) {
    lookup[cells.rows[i] * columns + cells.columns[i]] = i;
  }
  const modelled = new Float64Array(cells.heights.length).fill(Number.NaN);

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
    const minColumn = Math.max(0, Math.floor((Math.min(...us) - frame.uMin) / cell));
    const maxColumn = Math.min(columns - 1, Math.ceil((Math.max(...us) - frame.uMin) / cell));
    const minRow = Math.max(0, Math.floor((Math.min(...vs) - frame.vMin) / cell));
    const maxRow = Math.min(rows - 1, Math.ceil((Math.max(...vs) - frame.vMin) / cell));
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const index = lookup[row * columns + column];
        if (index < 0) continue;
        const u = frame.uMin + (column + 0.5) * cell;
        const v = frame.vMin + (row + 0.5) * cell;
        const w0 =
          ((corners[1][0] - u) * (corners[2][1] - v) - (corners[2][0] - u) * (corners[1][1] - v)) /
          area;
        const w1 =
          ((corners[2][0] - u) * (corners[0][1] - v) - (corners[0][0] - u) * (corners[2][1] - v)) /
          area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const height = w0 * corners[0][2] + w1 * corners[1][2] + w2 * corners[2][2];
        // A roof folds back over itself at a valley or a dome's far side, so
        // the surface the laser saw is the highest one above the cell.
        if (!(modelled[index] >= height)) modelled[index] = height;
      }
    }
  }
  return blurLikeMeasured(modelled, cells, columns, rows);
}

function blurLikeMeasured(
  modelled: Float64Array,
  cells: ElementCells,
  columns: number,
  rows: number,
): Float64Array {
  const grid = new Float64Array(columns * rows).fill(Number.NaN);
  for (let i = 0; i < modelled.length; i++) {
    grid[cells.rows[i] * columns + cells.columns[i]] = modelled[i];
  }
  const half = (WINDOW_CELLS / 2) | 0;
  const blurred = new Float64Array(modelled.length).fill(Number.NaN);
  for (let i = 0; i < modelled.length; i++) {
    let total = 0;
    let counted = 0;
    for (let row = cells.rows[i] - half; row <= cells.rows[i] + half; row++) {
      if (row < 0 || row >= rows) continue;
      for (let column = cells.columns[i] - half; column <= cells.columns[i] + half; column++) {
        if (column < 0 || column >= columns) continue;
        const value = grid[row * columns + column];
        if (!Number.isNaN(value)) {
          total += value;
          counted += 1;
        }
      }
    }
    if (counted > 0) blurred[i] = total / counted;
  }
  return blurred;
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
 * shape, eaves and ridge, and measure it against the cells.
 *
 * This is reported, never used to choose. Choosing by it was measured twice
 * and is worse both times — see `classifyShape` for why the shapes cannot be
 * told apart this way, and note that fitting the heights to the model rather
 * than reading them off the points costs a factor of two in `height` as well.
 * What the number is good for is telling a mapper when to look twice: a roof
 * within 0.2 m of the points is the one that is there, and one adrift by a
 * metre has something on it that no roof shape describes.
 */
function sampledRoof(
  cells: ElementCells,
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
    const modelled = sampleSurface(surface, cells, grid.columns, grid.rows, grid.cell, grid.frame);
    const miss = surfaceMiss(modelled, cells);
    if (miss !== undefined && miss < bestMiss) {
      bestMiss = miss;
      best = modelled;
    }
  }
  return best;
}

/** Mean miss of a sampled surface, or undefined where it covered too little. */
function surfaceMiss(modelled: Float64Array, cells: ElementCells): number | undefined {
  const residuals: number[] = [];
  for (let i = 0; i < modelled.length; i++) {
    if (Number.isNaN(modelled[i])) continue;
    residuals.push(Math.abs(modelled[i] - cells.heights[i]));
  }
  if (residuals.length < cells.heights.length * MIN_MODEL_COVERAGE) return undefined;
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

/**
 * The eaves and ridge, in the half-metres a tag is written in, whose roof sits
 * closest to the laser.
 *
 * The percentiles that seed this read the ridge off the points directly, which
 * is the right way to find it and the wrong way to place a whole roof: a ridge
 * is a thin line of cells and the rest of the surface has a say too. Searching
 * half a metre either way costs one rebuild — the same shape at another height
 * is an affine transform of the one already rasterised — and the result is the
 * combination a mapper would otherwise find by nudging the number themselves.
 */
/** One candidate placement of the roof, in both written and raw forms. */
interface Placement {
  eaves: number;
  ridge: number;
  miss: number;
  rise: number;
  height: number;
}

/**
 * The `height` and `roof:height`, in the half-metres a tag is written in, whose
 * roof sits closest to the laser.
 *
 * Only called where the roof at the measured heights already fits, and that
 * condition is what makes minimizing safe rather than the search itself.
 * Segmenting the calibration area by fit shows the two regimes plainly, as
 * mean error against the tagged heights:
 *
 * | model fit | measured ridge | least error |
 * | --------- | -------------- | ----------- |
 * | <= 0.5 m  | 0.66 m         | 0.63 m      |
 * | 0.5-1 m   | 0.57 m         | 0.93 m      |
 * | > 1 m     | 0.94 m         | 2.17 m, and 1.5 m low |
 *
 * Where the model describes the roof, the closest-fitting combination is the
 * truer one. Where it cannot — a bridge pier read as a hip, a mansard, a roof
 * behind dormers — the surface still has a minimum, and it sits well below the
 * ridge, because a model that cannot represent what is up there compensates by
 * sinking the whole roof into the points it can reach.
 *
 * The window re-centres while its minimum sits on an edge, because the seed
 * can start well outside it, and stops once the minimum is interior or the
 * walk has gone as far as it is allowed from the measurement it started at.
 */
function bestRise(
  modelled: Float64Array,
  cells: ElementCells,
  seed: { eaves: number; ridge: number },
  ground: number,
): Placement | undefined {
  const seedHeight = seed.ridge - ground;
  const seedRise = seed.ridge - seed.eaves;
  const at = (height: number, rise: number): Placement | undefined => {
    if (rise < MIN_ROOF_RISE_M || rise > 0.6 * height) return undefined;
    const ridge = ground + height;
    const eaves = ridge - rise;
    const miss = surfaceMiss(raised(modelled, seed, { eaves, ridge }), cells);
    return miss === undefined ? undefined : { eaves, ridge, miss, rise, height };
  };

  let best = at(seedHeight, seedRise);
  if (!best) return undefined;
  for (let round = 0; round < SEARCH_ROUNDS; round++) {
    const centre: Placement = best;
    for (const dHeight of SEARCH_STEPS_M) {
      for (const step of SEARCH_STEPS_M) {
        const height = centre.height + dHeight;
        const rise = centre.rise + step;
        if (Math.abs(height - seedHeight) > SEARCH_REACH_M) continue;
        if (Math.abs(rise - seedRise) > SEARCH_REACH_M) continue;
        const candidate = at(height, rise);
        if (candidate && candidate.miss < best.miss) best = candidate;
      }
    }
    if (best === centre) break;
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
  const cells = elementCells(grid, polygons);
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
  const rise = ridge - eaves;
  const shaped = shape !== null && shape !== "flat";
  const offerRise = shaped && rise >= MIN_ROOF_RISE_M && rise <= 0.6 * (ridge - grid.ground);
  // Measured from the rounded values this advice would actually write, not
  // from the reading behind them: the number has to be the one the mapper gets
  // after pressing apply, or it will not match what the tags then report. The
  // percentiles only seed it — a half metre either way is then searched for
  // the roof that actually sits closest to the points.
  const seedTop = grid.ground + Number(formatHeight(ridge - grid.ground));
  const seedEaves = offerRise ? seedTop - Number(formatHeight(rise)) : seedTop;
  const flatLevel = [...cells.heights].sort((a, b) => a - b)[cells.heights.length >> 1];
  const flatMiss = trimmedError(cells.heights.map((height) => Math.abs(height - flatLevel)));
  const modelled =
    shape === null || shape === "flat"
      ? undefined
      : sampledRoof(cells, grid, polygons, shape, seedEaves, seedTop);
  // Refining is only worth it where the model is a roof this building actually
  // has. That is judged on the fit at the measured heights, before anything
  // moves: judging it on the refined fit lets a roof the model cannot describe
  // wander until it happens to land within the limit and be trusted for it.
  // Where nothing fits — a bridge pier read as a hip, a roof under canopy —
  // the ridge read straight off the points is the better answer.
  const seedMiss = modelled ? surfaceMiss(modelled, cells) : undefined;
  const searched =
    modelled && offerRise && seedMiss !== undefined && seedMiss <= TRUSTED_FIT_M
      ? bestRise(modelled, cells, { eaves: seedEaves, ridge: seedTop }, grid.ground)
      : undefined;
  const advisedTop = searched?.ridge ?? seedTop;
  const advisedEaves = searched?.eaves ?? seedEaves;
  const miss =
    shape === "flat"
      ? flatMiss
      : searched
        ? searched.miss
        : modelled &&
          surfaceMiss(
            raised(
              modelled,
              { eaves: seedEaves, ridge: seedTop },
              { eaves: advisedEaves, ridge: advisedTop },
            ),
            cells,
          );
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
            grid,
            polygons,
            tags["roof:shape"],
            grid.ground + taggedHeight - (taggedRise ?? 0),
            grid.ground + taggedHeight,
          )
        : undefined;
  const currentMiss =
    tags["roof:shape"] === "flat" && taggedHeight !== undefined
      ? flatMiss
      : tagged && surfaceMiss(tagged, cells);

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
