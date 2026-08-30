import type { Footprint, LngLat } from "./buildings";
import type { LidarCloud } from "./lidar";
import { classOf, isSingleReturn } from "./lidar-format";

/**
 * The selected building's roof as a half-metre cell raster, aligned to the
 * footprint's dominant edge direction and clipped to the outline.
 *
 * Each cell carries the surface read from the points around it — the facing
 * direction, the steepness and the height — and the companion image function
 * folds all three into one picture: hue is where the surface faces, saturation
 * how steeply it falls, brightness how high it sits. Ridges, courtyards and
 * roof steps separate at a glance where any single channel stays mute.
 *
 * Deliberately free of map and DOM dependencies: the map layer draws the image
 * as a texture, and a CLI tool can write the same bytes to a PNG.
 */

/** Cell edge, metres. */
export const GRID_CELL_M = 0.5;

/** Plane-fit window edge, cells; 5 half-metre cells reads ~2.5 m patches. */
const WINDOW_CELLS = 5;

/** A window must hold this many points before its plane is believed. */
const MIN_FIT_POINTS = 6;

/**
 * Points closer than this to the outline are left out of the fits: facade
 * echoes and overhanging trees sit on the boundary and would tilt every rim
 * cell into a phantom cliff.
 */
const EDGE_MARGIN_M = 0.4;

/** The slope at which saturation tops out. */
const FULL_SLOPE = Math.PI / 6;

/** A pathological footprint cannot allocate without bound. */
const MAX_CELLS = 1_000_000;

/**
 * The ring of ground that counts as this building's own: what its walls stand
 * in, not what the neighbourhood sits at. `height` is read against this, so on
 * a slope the choice of ring is the whole error, and it fails in both
 * directions. The cloud's level for its entire 200 m box put a Hammarby
 * waterfront house 4 m above its own ground; a wide skirt then over-corrected
 * a shed on the Kastellet cliff, whose walls meet ground at 3.3 m while the
 * shoreline six metres away is at sea level, reading it 3 m too tall.
 *
 * Two metres is close enough that only ground touching the building is in it.
 * The search widens outwards, and only outwards, when that ring is too thin to
 * measure from — a sparse survey over a small footprint.
 */
const GROUND_SKIRT_M = 2;
const GROUND_SKIRT_MAX_M = 20;

/** Fewer ground returns than this anywhere near, and the cloud's level stands. */
const MIN_GROUND_POINTS = 25;

/**
 * Where in the adjacent ground's sorted levels the building's datum sits. OSM
 * measures a height from the lowest ground the building stands on, so this is
 * low — but not the very lowest return, which is a doorway well or the survey's
 * own noise rather than the ground the facade meets.
 */
const GROUND_SHARE = 0.1;

const GROUND_CLASS = 2;

const METERS_PER_DEG_LAT = 111320;

/**
 * Only returns that bounce off something solid describe a surface. Vegetation
 * scatters the beam into several returns, so a multi-return unclassified point
 * is a canopy point, and water's sparse specular returns fit wild planes that
 * would paint a calm bay in loud colours.
 */
function isSurfaceReturn(stored: number): boolean {
  const cls = classOf(stored);
  if (cls === 1) return isSingleReturn(stored);
  // Ground, buildings where the survey labels them, and bridge decks.
  return cls === 2 || cls === 6 || cls === 17;
}

export interface SurfaceGrid {
  columns: number;
  rows: number;
  /** Cell edge, metres; `GRID_CELL_M` unless the guard had to coarsen it. */
  cell: number;
  /** Downslope compass direction per cell, radians from east; NaN unfitted. */
  aspect: Float32Array;
  /** Surface slope per cell, radians from level; NaN where unfitted. */
  slope: Float32Array;
  /** Mean surface height per cell, metres RH2000; NaN where unfitted. */
  height: Float32Array;
  /**
   * Highest raw return per cell, metres RH2000; NaN where the cell itself
   * holds no point. Unsmoothed on purpose: the plane-fit window erodes ridge
   * peaks by up to a metre, and ridge reads need the points themselves.
   */
  heightMax: Float32Array;
  /** 1 where the cell centre lies inside the outline. */
  inside: Uint8Array;
  /** Brightness normalisation range, from the fitted cells' heights. */
  heightRange: [number, number];
  /** The cloud's ground level, metres RH2000, for heights above ground. */
  ground: number;
  /**
   * The raster's corners as lon/lat, in image order — top-left, top-right,
   * bottom-right, bottom-left for a texture whose first row is the top.
   */
  corners: [LngLat, LngLat, LngLat, LngLat];
  /** The grid's frame, for mapping cell coordinates back to the world. */
  frame: GridFrame;
  /** The outline's rings in the grid frame, for the separation-line search. */
  rings: [number, number][][];
  /**
   * The surface returns the cell fits were built from, kept in the grid frame.
   *
   * The cells are a summary — a plane over a 2.5 m window — and a summary is
   * the wrong thing to measure a candidate roof against: matching a model to
   * it means blurring the model the same way first, and the two roundings do
   * not cancel evenly at a ridge. `roof-advice` scores roofs against these
   * points instead, which is both simpler and closer to the survey.
   */
  points: GridPoints;
}

/** Surface returns inside the outline, in the grid frame. */
interface GridPoints {
  count: number;
  us: Float32Array;
  vs: Float32Array;
  /** Absolute height, metres RH2000. */
  zs: Float32Array;
}

/** Everything needed to turn a grid-frame (u, v) back into lon/lat. */
export interface GridFrame {
  lon0: number;
  lat0: number;
  cosLat: number;
  /** Rotation from east/north metres into the grid frame, radians. */
  theta: number;
  uMin: number;
  vMin: number;
}

/** A lon/lat coordinate in the grid frame. */
export function lonLatToGrid(frame: GridFrame, lon: number, lat: number): [number, number] {
  const east = (lon - frame.lon0) * METERS_PER_DEG_LAT * frame.cosLat;
  const north = (lat - frame.lat0) * METERS_PER_DEG_LAT;
  return [
    east * Math.cos(frame.theta) + north * Math.sin(frame.theta),
    -east * Math.sin(frame.theta) + north * Math.cos(frame.theta),
  ];
}

/** A grid-frame coordinate back in lon/lat. */
export function gridToLonLat(frame: GridFrame, u: number, v: number): LngLat {
  const east = u * Math.cos(frame.theta) - v * Math.sin(frame.theta);
  const north = u * Math.sin(frame.theta) + v * Math.cos(frame.theta);
  return [
    frame.lon0 + east / (METERS_PER_DEG_LAT * frame.cosLat),
    frame.lat0 + north / METERS_PER_DEG_LAT,
  ];
}

/** Length-weighted circular mean of ring edge orientations, mod 90 degrees. */
function dominantAxis(rings: [number, number][][]): number {
  let c = 0;
  let s = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      const length = Math.hypot(x1 - x0, y1 - y0);
      const angle = Math.atan2(y1 - y0, x1 - x0) * 4;
      c += length * Math.cos(angle);
      s += length * Math.sin(angle);
    }
  }
  return Math.atan2(s, c) / 4;
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

function distanceToRings(rings: [number, number][][], u: number, v: number): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ui, vi] = ring[i];
      const [uj, vj] = ring[j];
      const du = uj - ui;
      const dv = vj - vi;
      const t = Math.max(
        0,
        Math.min(1, ((u - ui) * du + (v - vi) * dv) / (du * du + dv * dv || 1)),
      );
      const d = Math.hypot(u - ui - t * du, v - vi - t * dv);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Sum each cell's `WINDOW_CELLS`-square neighbourhood, linear in cells. */
function boxSum(grid: Float64Array, columns: number, rows: number): Float64Array {
  const half = (WINDOW_CELLS / 2) | 0;
  const alongRows = new Float64Array(grid.length);
  for (let row = 0; row < rows; row++) {
    const start = row * columns;
    let running = 0;
    for (let column = 0; column < Math.min(columns, half); column++)
      running += grid[start + column];
    for (let column = 0; column < columns; column++) {
      const entering = column + half;
      if (entering < columns) running += grid[start + entering];
      const leaving = column - half - 1;
      if (leaving >= 0) running -= grid[start + leaving];
      alongRows[start + column] = running;
    }
  }
  const result = new Float64Array(grid.length);
  for (let column = 0; column < columns; column++) {
    let running = 0;
    for (let row = 0; row < Math.min(rows, half); row++)
      running += alongRows[row * columns + column];
    for (let row = 0; row < rows; row++) {
      const entering = row + half;
      if (entering < rows) running += alongRows[entering * columns + column];
      const leaving = row - half - 1;
      if (leaving >= 0) running -= alongRows[leaving * columns + column];
      result[row * columns + column] = running;
    }
  }
  return result;
}

/**
 * Build the aligned cell raster for one building's outline over its cloud.
 * Returns null when there is nothing to grid — no rings, or no points.
 */
export function buildSurfaceGrid(cloud: LidarCloud, polygons: Footprint[]): SurfaceGrid | null {
  const lonLatRings = polygons.flatMap((polygon) => [polygon.outer, ...polygon.holes]);
  if (lonLatRings.length === 0 || cloud.count === 0) return null;

  const lon0 = lonLatRings[0][0][0];
  const lat0 = lonLatRings[0][0][1];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const toEast = (lon: number) => (lon - lon0) * METERS_PER_DEG_LAT * cosLat;
  const toNorth = (lat: number) => (lat - lat0) * METERS_PER_DEG_LAT;

  const enRings = lonLatRings.map((ring) =>
    ring.map(([lon, lat]): [number, number] => [toEast(lon), toNorth(lat)]),
  );
  const theta = dominantAxis(enRings);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const rings = enRings.map((ring) =>
    ring.map(([e, n]): [number, number] => [e * cosT + n * sinT, -e * sinT + n * cosT]),
  );

  let uMin = Infinity;
  let vMin = Infinity;
  let uMax = -Infinity;
  let vMax = -Infinity;
  for (const ring of rings) {
    for (const [u, v] of ring) {
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }

  let cell = GRID_CELL_M;
  while (((uMax - uMin) / cell) * ((vMax - vMin) / cell) > MAX_CELLS) cell *= 2;
  const columns = Math.max(1, Math.ceil((uMax - uMin) / cell));
  const rows = Math.max(1, Math.ceil((vMax - vMin) / cell));
  const cells = columns * rows;

  const inside = new Uint8Array(cells);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const u = uMin + (column + 0.5) * cell;
      const v = vMin + (row + 0.5) * cell;
      if (insideRings(rings, u, v)) inside[row * columns + column] = 1;
    }
  }

  // Nine plane-fit moments per cell: n, Σu, Σv, Σz, Σuu, Σvv, Σuv, Σuz, Σvz.
  // Heights enter relative to the cloud's ground level to keep the sums small.
  const moments = Array.from({ length: 9 }, () => new Float64Array(cells));
  const heightMax = new Float32Array(cells).fill(Number.NaN);
  // Ground returns near the outline, kept with their distance from it so the
  // search can widen when the near ring holds too few.
  const groundLevels: { distance: number; z: number }[] = [];
  // The same returns that feed the moments, kept for the roof fitting.
  const pointUs: number[] = [];
  const pointVs: number[] = [];
  const pointZs: number[] = [];
  for (let i = 0; i < cloud.count; i++) {
    if (!isSurfaceReturn(cloud.classes[i])) continue;
    const e = toEast(cloud.lon[i]);
    const n = toNorth(cloud.lat[i]);
    const u = e * cosT + n * sinT;
    const v = -e * sinT + n * cosT;
    if (
      classOf(cloud.classes[i]) === GROUND_CLASS &&
      u > uMin - GROUND_SKIRT_MAX_M &&
      u < uMax + GROUND_SKIRT_MAX_M &&
      v > vMin - GROUND_SKIRT_MAX_M &&
      v < vMax + GROUND_SKIRT_MAX_M
    ) {
      groundLevels.push({ distance: distanceToRings(rings, u, v), z: cloud.z[i] });
    }
    if (u < uMin || u >= uMin + columns * cell || v < vMin || v >= vMin + rows * cell) continue;
    if (!insideRings(rings, u, v) || distanceToRings(rings, u, v) < EDGE_MARGIN_M) continue;
    pointUs.push(u);
    pointVs.push(v);
    pointZs.push(cloud.z[i]);
    const z = cloud.z[i] - cloud.groundZ;
    const at = (((v - vMin) / cell) | 0) * columns + (((u - uMin) / cell) | 0);
    if (!(heightMax[at] >= cloud.z[i])) heightMax[at] = cloud.z[i];
    moments[0][at] += 1;
    moments[1][at] += u;
    moments[2][at] += v;
    moments[3][at] += z;
    moments[4][at] += u * u;
    moments[5][at] += v * v;
    moments[6][at] += u * v;
    moments[7][at] += u * z;
    moments[8][at] += v * z;
  }
  const [n, su, sv, sz, suu, svv, suv, suz, svz] = moments.map((m) => boxSum(m, columns, rows));

  // This building's own ground, not the cloud's. Heights above ground are read
  // against it, so on a slope the difference is the whole error. Only the ring
  // of ground beside the outline counts, widened outwards just far enough to
  // hold a usable sample.
  groundLevels.sort((a, b) => a.distance - b.distance);
  const near = groundLevels.filter((point) => point.distance <= GROUND_SKIRT_M);
  const sample = (
    near.length >= MIN_GROUND_POINTS ? near : groundLevels.slice(0, MIN_GROUND_POINTS)
  )
    .map((point) => point.z)
    .sort((a, b) => a - b);
  const ground =
    sample.length >= MIN_GROUND_POINTS
      ? sample[Math.floor(sample.length * GROUND_SHARE)]
      : cloud.groundZ;

  const aspect = new Float32Array(cells).fill(Number.NaN);
  const slope = new Float32Array(cells).fill(Number.NaN);
  const height = new Float32Array(cells).fill(Number.NaN);
  let low = Infinity;
  let high = -Infinity;
  for (let at = 0; at < cells; at++) {
    if (!inside[at] || n[at] < MIN_FIT_POINTS) continue;
    const det =
      suu[at] * (svv[at] * n[at] - sv[at] * sv[at]) -
      suv[at] * (suv[at] * n[at] - sv[at] * su[at]) +
      su[at] * (suv[at] * sv[at] - svv[at] * su[at]);
    if (Math.abs(det) < 1e-9) continue;
    const a =
      (suz[at] * (svv[at] * n[at] - sv[at] * sv[at]) -
        suv[at] * (svz[at] * n[at] - sv[at] * sz[at]) +
        su[at] * (svz[at] * sv[at] - svv[at] * sz[at])) /
      det;
    const b =
      (suu[at] * (svz[at] * n[at] - sv[at] * sz[at]) -
        suz[at] * (suv[at] * n[at] - sv[at] * su[at]) +
        su[at] * (suv[at] * sz[at] - svz[at] * su[at])) /
      det;
    slope[at] = Math.atan(Math.hypot(a, b));
    // Downslope in the grid frame, rotated back to a compass direction so the
    // hue means the same thing here as in the per-point surface colouring.
    aspect[at] = Math.atan2(-b, -a) + theta;
    height[at] = sz[at] / n[at] + cloud.groundZ;
    if (height[at] < low) low = height[at];
    if (height[at] > high) high = height[at];
  }
  if (low === Infinity) return null;

  const frame: GridFrame = { lon0, lat0, cosLat, theta, uMin, vMin };
  const cornerLonLat = (u: number, v: number): LngLat => gridToLonLat(frame, u, v);

  return {
    columns,
    rows,
    cell,
    aspect,
    slope,
    height,
    heightMax,
    inside,
    heightRange: [low, Math.max(high, low + 0.5)],
    ground,
    // Image row 0 is the top of the picture, which is the grid's far v edge.
    corners: [
      cornerLonLat(uMin, vMin + rows * cell),
      cornerLonLat(uMin + columns * cell, vMin + rows * cell),
      cornerLonLat(uMin + columns * cell, vMin),
      cornerLonLat(uMin, vMin),
    ],
    frame,
    rings,
    points: {
      count: pointUs.length,
      us: Float32Array.from(pointUs),
      vs: Float32Array.from(pointVs),
      zs: Float32Array.from(pointZs),
    },
  };
}

/** A pure hue as RGB 0-1, with the angle given in sixths of a turn from red. */
function hueToRgb(sixths: number): [number, number, number] {
  const channel = (shift: number) =>
    Math.min(1, Math.max(0, Math.abs(((sixths + shift) % 6) - 3) - 1));
  return [channel(0), channel(4), channel(2)];
}

/**
 * The grid as sRGB pixels, top row first: hue = facing direction, saturation =
 * steepness, brightness = height. Cells outside the outline are transparent;
 * cells inside with no readable surface are a dark, honest gap.
 */
export function surfaceGridImage(grid: SurfaceGrid): Uint8ClampedArray {
  const data = new Uint8ClampedArray(grid.columns * grid.rows * 4);
  const [low, high] = grid.heightRange;
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const at = (grid.rows - 1 - row) * grid.columns + column;
      const px = (row * grid.columns + column) * 4;
      if (!grid.inside[at]) continue;
      if (Number.isNaN(grid.slope[at])) {
        data[px] = 18;
        data[px + 1] = 18;
        data[px + 2] = 26;
        data[px + 3] = 255;
        continue;
      }
      const saturation = Math.min(grid.slope[at] / FULL_SLOPE, 1);
      const value = 0.2 + (0.8 * (grid.height[at] - low)) / (high - low);
      const turns = (grid.aspect[at] / (2 * Math.PI) + 1) % 1;
      const hue = hueToRgb(turns * 6);
      for (let ch = 0; ch < 3; ch++) {
        data[px + ch] = Math.round(255 * ((hue[ch] - 1) * saturation + 1) * Math.min(value, 1));
      }
      data[px + 3] = 255;
    }
  }
  return data;
}
