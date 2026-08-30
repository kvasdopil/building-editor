import type { SurfaceGrid } from "./surface-grid";

/**
 * Candidate building:part separation lines over a surface grid, each with a
 * calibrated probability of being a real part boundary.
 *
 * A port of the segment-building CLI prototype's recommender, kept free of map
 * and DOM dependencies like the grid itself. Every recommended line is
 * parallel to some footprint edge by construction: footprint edge bearings are
 * clustered into orientation families and lines are only searched within them.
 * Per family, the per-cell edge strength — a height step read as the
 * disagreement of the two sides' extrapolations, plus a surface-normal crease
 * — is projected onto the family's normal, Radon-style. A candidate's z-score
 * against the family profile's own median/MAD (what a line scores in THIS
 * building where there is no wall: dome curvature and scan stripes included)
 * goes through a logistic, and known evidence shifts the log-odds: collinear
 * with a footprint edge, a genuine height step, or a response confined to a
 * sliver of the line.
 *
 * Calibration (2026-08-29, CLI): Nationalmuseum — 8 of 9 accepts are real
 * walls; Tullhuset and the museum annex — every real wall accepted at 0.98,
 * every noise line ignored.
 */

/** Cells the extrapolation reaches past the attribute window's ramp. */
const NEAR = 2;
const FAR = 4;

/** Cell shift for the normal-crease comparison. */
const CREASE_SHIFT = 3;

/** A family must hold this much footprint edge length to be searched. */
const MIN_FAMILY_LENGTH_M = 6;

/** Free-floating peaks need at least this z; snapped lines have no floor. */
const MIN_PEAK_Z = 1.5;

export interface SeparationLine {
  id: string;
  /** Line direction in the grid frame, degrees. */
  phiDeg: number;
  /** Normal offset of the line in the grid frame, metres. */
  t: number;
  probability: number;
  recommendation: "accept" | "review" | "ignore";
  provenance: string[];
  /** Along-line intervals (grid-frame s) where the evidence sits. */
  spans: [number, number][];
  /** The full measured extent of the line inside the outline. */
  extent: [number, number];
}

interface Family {
  phi: number;
  /** Normal offsets of this family's own footprint edges. */
  edgeOffsets: number[];
}

/** Footprint edge directions, clustered mod 180 deg, length-weighted. */
function orientationFamilies(rings: [number, number][][]): Family[] {
  const clusters: { phi: number; length: number; segs: [number, number, number][] }[] = [];
  const segments: [number, number, [number, number]][] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [u0, v0] = ring[i];
      const [u1, v1] = ring[(i + 1) % ring.length];
      const length = Math.hypot(u1 - u0, v1 - v0);
      if (length < 3) continue;
      const phi = ((Math.atan2(v1 - v0, u1 - u0) * 180) / Math.PI + 180) % 180;
      segments.push([phi, length, [(u0 + u1) / 2, (v0 + v1) / 2]]);
    }
  }
  segments.sort((a, b) => b[1] - a[1]);
  for (const [phi, length, mid] of segments) {
    const home = clusters.find((c) => Math.abs(((phi - c.phi + 90) % 180) - 90) < 5);
    if (home) {
      const delta = ((phi - home.phi + 90) % 180) - 90;
      home.phi = (home.phi + (delta * length) / (home.length + length) + 180) % 180;
      home.length += length;
      home.segs.push([mid[0], mid[1], length]);
    } else {
      clusters.push({ phi, length, segs: [[mid[0], mid[1], length]] });
    }
  }
  const families: Family[] = [];
  for (const cluster of clusters) {
    if (cluster.length < MIN_FAMILY_LENGTH_M) continue;
    let phi = cluster.phi;
    // The grid frame was built from the dominant axes, so families near them
    // are them.
    for (const axis of [0, 90]) {
      if (Math.abs(((phi - axis + 90) % 180) - 90) < 4) phi = axis;
    }
    const rad = (phi * Math.PI) / 180;
    families.push({
      phi,
      edgeOffsets: cluster.segs.map(([u, v]) => -u * Math.sin(rad) + v * Math.cos(rad)),
    });
  }
  for (const axis of [0, 90]) {
    if (!families.some((f) => f.phi === axis)) families.push({ phi: axis, edgeOffsets: [] });
  }
  return families.sort((a, b) => a.phi - b.phi);
}

/**
 * Per-cell edge strength from height and surface-normal comparisons,
 * slope-invariant by construction: each side's own trend is extrapolated to
 * the centre cell and the two estimates compared, so a continuous sloped roof
 * scores zero and a wall scores its jump once, at its centre.
 */
function edgeMaps(grid: SurfaceGrid): { step: Float32Array; crease: Float32Array } {
  const { columns, rows, cell } = grid;
  const cells = columns * rows;
  const nx = new Float32Array(cells).fill(Number.NaN);
  const ny = new Float32Array(cells).fill(Number.NaN);
  const nz = new Float32Array(cells).fill(Number.NaN);
  for (let at = 0; at < cells; at++) {
    if (Number.isNaN(grid.slope[at])) continue;
    const sinSlope = Math.sin(grid.slope[at]);
    nx[at] = sinSlope * Math.cos(grid.aspect[at]);
    ny[at] = sinSlope * Math.sin(grid.aspect[at]);
    nz[at] = Math.cos(grid.slope[at]);
  }

  const at = (row: number, column: number) =>
    row >= 0 && row < rows && column >= 0 && column < columns ? row * columns + column : -1;
  const sample = (field: Float32Array, index: number) => (index >= 0 ? field[index] : Number.NaN);

  const step = new Float32Array(cells);
  const crease = new Float32Array(cells);
  const shifts: [number, number][] = [
    [1, 0],
    [0, 1],
  ];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const here = row * columns + column;
      if (!grid.inside[here]) {
        step[here] = Number.NaN;
        crease[here] = Number.NaN;
        continue;
      }
      let stepSq = 0;
      let creaseSq = 0;
      for (const [dr, dc] of shifts) {
        const ahead =
          2 * sample(grid.height, at(row + dr * NEAR, column + dc * NEAR)) -
          sample(grid.height, at(row + dr * FAR, column + dc * FAR));
        const behind =
          2 * sample(grid.height, at(row - dr * NEAR, column - dc * NEAR)) -
          sample(grid.height, at(row - dr * FAR, column - dc * FAR));
        const disagreement = ahead - behind;
        if (!Number.isNaN(disagreement)) stepSq += disagreement * disagreement;
        for (const component of [nx, ny, nz]) {
          const d =
            sample(component, at(row + dr * CREASE_SHIFT, column + dc * CREASE_SHIFT)) -
            sample(component, at(row - dr * CREASE_SHIFT, column - dc * CREASE_SHIFT));
          if (!Number.isNaN(d)) creaseSq += d * d;
        }
      }
      step[here] = Math.sqrt(stepSq);
      crease[here] = Math.sqrt(creaseSq);
    }
  }
  // The grid's cell may have been coarsened by the size guard; the step and
  // shift distances assume half-metre cells, which GRID_CELL_M guarantees for
  // any building small enough to matter here.
  void cell;
  return { step, crease };
}

interface Profile {
  t0: number;
  bins: number;
  count: Float64Array;
  mean: Float64Array;
  meanStep: Float64Array;
  valid: Uint8Array;
  typical: number;
  median: number;
  mad: number;
  sMin: Float64Array;
  sMax: Float64Array;
}

/** Radon-style projection of the edge maps onto a family's normal. */
function lineProfile(
  grid: SurfaceGrid,
  step: Float32Array,
  crease: Float32Array,
  phiDeg: number,
): Profile {
  const rad = (phiDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const { columns, rows, cell, frame } = grid;

  let tLow = Infinity;
  let tHighest = -Infinity;
  const tOf = (row: number, column: number) => {
    const u = frame.uMin + (column + 0.5) * cell;
    const v = frame.vMin + (row + 0.5) * cell;
    return -u * sin + v * cos;
  };
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (!grid.inside[row * columns + column]) continue;
      const t = tOf(row, column);
      if (t < tLow) tLow = t;
      if (t > tHighest) tHighest = t;
    }
  }
  const bins = Math.max(1, Math.ceil((tHighest - tLow) / cell) + 1);
  const count = new Float64Array(bins);
  const sum = new Float64Array(bins);
  const sumStep = new Float64Array(bins);
  const sMin = new Float64Array(bins).fill(Infinity);
  const sMax = new Float64Array(bins).fill(-Infinity);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const here = row * columns + column;
      if (!grid.inside[here]) continue;
      const u = frame.uMin + (column + 0.5) * cell;
      const v = frame.vMin + (row + 0.5) * cell;
      const k = Math.min(bins - 1, Math.max(0, Math.floor((-u * sin + v * cos - tLow) / cell)));
      const s = u * cos + v * sin;
      count[k] += 1;
      const stepHere = Number.isNaN(step[here]) ? 0 : step[here];
      const creaseHere = Number.isNaN(crease[here]) ? 0 : crease[here];
      sum[k] += stepHere + 1.2 * creaseHere;
      sumStep[k] += stepHere;
      if (s < sMin[k]) sMin[k] = s;
      if (s > sMax[k]) sMax[k] = s;
    }
  }
  const mean = new Float64Array(bins);
  const meanStep = new Float64Array(bins);
  const valid = new Uint8Array(bins);
  const sample: number[] = [];
  const supported: number[] = [];
  for (let k = 0; k < bins; k++) {
    if (count[k] === 0) continue;
    mean[k] = sum[k] / count[k];
    meanStep[k] = sumStep[k] / count[k];
    if (count[k] >= 8) {
      valid[k] = 1;
      sample.push(mean[k]);
      supported.push(count[k]);
    }
  }
  sample.sort((a, b) => a - b);
  const median = sample.length > 0 ? sample[sample.length >> 1] : 0;
  const deviations = sample.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = Math.max(
    deviations.length > 0 ? deviations[deviations.length >> 1] * 1.4826 : 0.02,
    0.02,
  );
  supported.sort((a, b) => a - b);
  const typical = supported.length > 0 ? supported[supported.length >> 1] : 8;
  return { t0: tLow, bins, count, mean, meanStep, valid, typical, median, mad, sMin, sMax };
}

/** Support-adjusted z-score of one line against its family's noise floor. */
function profileZ(profile: Profile, k: number): number {
  if (k < 0 || k >= profile.bins || !profile.valid[k]) return 0;
  const shrink = Math.min(1, Math.sqrt(profile.count[k] / profile.typical));
  return ((profile.mean[k] - profile.median) / profile.mad) * shrink;
}

/**
 * Where along one line the evidence actually is: contiguous runs of strong
 * cells in the along-line coordinate, and the responding fraction.
 */
function lineSpans(
  grid: SurfaceGrid,
  step: Float32Array,
  crease: Float32Array,
  phiDeg: number,
  profile: Profile,
  k: number,
): { spans: [number, number][]; coverage: number } {
  const rad = (phiDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const { columns, rows, cell, frame } = grid;
  const strong: number[] = [];
  let total = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const here = row * columns + column;
      if (!grid.inside[here]) continue;
      const u = frame.uMin + (column + 0.5) * cell;
      const v = frame.vMin + (row + 0.5) * cell;
      if (Math.floor((-u * sin + v * cos - profile.t0) / cell) !== k) continue;
      total += 1;
      const response =
        (Number.isNaN(step[here]) ? 0 : step[here]) +
        1.2 * (Number.isNaN(crease[here]) ? 0 : crease[here]);
      if (response > 0.8) strong.push(u * cos + v * sin);
    }
  }
  strong.sort((a, b) => a - b);
  const spans: [number, number][] = [];
  let start = Number.NaN;
  let previous = Number.NaN;
  for (const s of strong) {
    if (Number.isNaN(start)) {
      start = s;
    } else if (s - previous > 2) {
      if (previous - start >= 1) spans.push([start - cell / 2, previous + cell / 2]);
      start = s;
    }
    previous = s;
  }
  if (!Number.isNaN(start) && previous - start >= 1)
    spans.push([start - cell / 2, previous + cell / 2]);
  return { spans, coverage: total > 0 ? strong.length / total : 0 };
}

/** Calibrated belief that a candidate line is a real part boundary. */
function lineProbability(z: number, snapped: boolean, stepScore: number, coverage: number): number {
  const base = 1 / (1 + Math.exp(-0.9 * (z - 2.5)));
  let logit = Math.log(base / (1 - base));
  if (snapped) logit += 1.4;
  if (stepScore >= 1.0) logit += 1.0;
  else if (stepScore >= 0.45) logit += 0.4;
  if (coverage < 0.25) logit -= 0.7;
  return Math.min(0.98, Math.max(0.02, 1 / (1 + Math.exp(-logit))));
}

/** Recommend separation lines for the grid's building, strongest first. */
export function recommendSeparationLines(grid: SurfaceGrid): SeparationLine[] {
  const { step, crease } = edgeMaps(grid);
  const lines: SeparationLine[] = [];
  for (const family of orientationFamilies(grid.rings)) {
    const profile = lineProfile(grid, step, crease, family.phi);
    const rad = (family.phi * Math.PI) / 180;
    const tRing = grid.rings.flat().map(([u, v]) => -u * Math.sin(rad) + v * Math.cos(rad));
    const tLow = Math.min(...tRing);
    const tHigh = Math.max(...tRing);

    interface Candidate {
      t: number;
      k: number;
      snapped: boolean;
    }
    const candidates: Candidate[] = [];
    // Free-floating peaks only along the dominant axes: a minor family is
    // evidence for continuing its own edges, not for arbitrary parallel cuts.
    if (family.phi === 0 || family.phi === 90) {
      for (let k = 0; k < profile.bins; k++) {
        if (profileZ(profile, k) < MIN_PEAK_Z) continue;
        let isPeak = true;
        for (let j = Math.max(0, k - 4); j < Math.min(profile.bins, k + 5); j++) {
          if (profile.valid[j] && profile.mean[j] > profile.mean[k]) isPeak = false;
        }
        if (isPeak) candidates.push({ t: profile.t0 + (k + 0.5) * grid.cell, k, snapped: false });
      }
    }
    for (const tOffset of family.edgeOffsets) {
      if (tOffset - tLow < 1.5 || tHigh - tOffset < 1.5) continue; // the facade itself
      candidates.push({
        t: tOffset,
        k: Math.floor((tOffset - profile.t0) / grid.cell),
        snapped: true,
      });
    }

    candidates.sort((a, b) => a.t - b.t);
    const merged: Candidate[] = [];
    for (const candidate of candidates) {
      const last = merged[merged.length - 1];
      if (last && candidate.t - last.t < 1.2) {
        if (candidate.snapped && !last.snapped) {
          last.t = candidate.t; // snap the cluster to the footprint line
          last.k = candidate.k;
        }
        last.snapped ||= candidate.snapped;
      } else {
        merged.push({ ...candidate });
      }
    }

    for (const candidate of merged) {
      const z = profileZ(profile, candidate.k);
      const stepScore =
        candidate.k >= 0 && candidate.k < profile.bins ? profile.meanStep[candidate.k] : 0;
      const { spans, coverage } = lineSpans(grid, step, crease, family.phi, profile, candidate.k);
      const probability = lineProbability(z, candidate.snapped, stepScore, coverage);
      if (probability < 0.1 && !candidate.snapped) continue;
      const provenance: string[] = [];
      if (candidate.snapped) provenance.push("footprint-continuation");
      if (stepScore > 0.45) provenance.push("height-step");
      const extent: [number, number] =
        candidate.k >= 0 && candidate.k < profile.bins && profile.count[candidate.k] > 0
          ? [profile.sMin[candidate.k], profile.sMax[candidate.k]]
          : [0, 0];
      lines.push({
        id: "",
        phiDeg: family.phi,
        t: candidate.t,
        probability,
        recommendation: probability >= 0.75 ? "accept" : probability >= 0.35 ? "review" : "ignore",
        provenance,
        spans,
        extent,
      });
    }
  }
  lines.sort((a, b) => b.probability - a.probability);
  for (const [index, line] of lines.entries()) line.id = `E${index + 1}`;
  return lines;
}
