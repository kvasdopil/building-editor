/**
 * SWEREF 99 projections, both directions, following Lantmäteriet's published
 * Gauss conformal (Transverse Mercator) Krüger series on the GRS80 ellipsoid.
 *
 * Lantmäteriet's national products, including the Skog point cloud, use SWEREF
 * 99 TM (EPSG:3006). Reading them needs both directions: the query box goes from
 * lon/lat into metres, and every returned point comes back.
 *
 * Stockholm's own data is in the neighbouring SWEREF 99 18 00 zone (EPSG:3011),
 * the same projection with a different central meridian. Only the importers
 * touch that one, so its inverse lives in scripts/lib/sweref99.mjs; the two
 * were cross-checked against each other to 1e-9 degrees.
 */

interface ProjectionParameters {
  /** Central meridian, degrees. */
  lon0: number;
  /** Scale factor on the central meridian. */
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}

export const SWEREF99_TM: ProjectionParameters = {
  lon0: 15,
  k0: 0.9996,
  falseEasting: 500000,
  falseNorthing: 0,
};

const AXIS = 6378137.0;
const FLATTENING = 1 / 298.257222101;

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (value: number) => (value * Math.PI) / 180;

/** Series coefficients shared by both directions. */
function series() {
  const e2 = FLATTENING * (2 - FLATTENING);
  const n = FLATTENING / (2 - FLATTENING);
  const aRoof = (AXIS / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  return { e2, n, aRoof };
}

/** Longitude/latitude to easting/northing. */
export function project(
  { lon0, k0, falseEasting, falseNorthing }: ProjectionParameters,
  lon: number,
  lat: number,
): [number, number] {
  const { e2, n, aRoof } = series();

  const a = e2;
  const b = (5 * e2 ** 2 - e2 ** 3) / 6;
  const c = (104 * e2 ** 3 - 45 * e2 ** 4) / 120;
  const d = (1237 * e2 ** 4) / 1260;

  const beta1 = n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180;
  const beta2 = (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440;
  const beta3 = (61 * n ** 3) / 240 - (103 * n ** 4) / 140;
  const beta4 = (49561 * n ** 4) / 161280;

  const phi = radians(lat);
  const sinPhi2 = Math.sin(phi) ** 2;
  const phiStar =
    phi - Math.sin(phi) * Math.cos(phi) * (a + b * sinPhi2 + c * sinPhi2 ** 2 + d * sinPhi2 ** 3);

  const deltaLambda = radians(lon - lon0);
  const xiPrim = Math.atan(Math.tan(phiStar) / Math.cos(deltaLambda));
  const etaPrim = Math.atanh(Math.cos(phiStar) * Math.sin(deltaLambda));

  const northing =
    k0 *
      aRoof *
      (xiPrim +
        beta1 * Math.sin(2 * xiPrim) * Math.cosh(2 * etaPrim) +
        beta2 * Math.sin(4 * xiPrim) * Math.cosh(4 * etaPrim) +
        beta3 * Math.sin(6 * xiPrim) * Math.cosh(6 * etaPrim) +
        beta4 * Math.sin(8 * xiPrim) * Math.cosh(8 * etaPrim)) +
    falseNorthing;
  const easting =
    k0 *
      aRoof *
      (etaPrim +
        beta1 * Math.cos(2 * xiPrim) * Math.sinh(2 * etaPrim) +
        beta2 * Math.cos(4 * xiPrim) * Math.sinh(4 * etaPrim) +
        beta3 * Math.cos(6 * xiPrim) * Math.sinh(6 * etaPrim) +
        beta4 * Math.cos(8 * xiPrim) * Math.sinh(8 * etaPrim)) +
    falseEasting;

  return [easting, northing];
}

/** Easting/northing back to longitude/latitude. */
export function unproject(
  { lon0, k0, falseEasting, falseNorthing }: ProjectionParameters,
  easting: number,
  northing: number,
): [number, number] {
  const { e2, n, aRoof } = series();

  const delta1 = n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96 - n ** 4 / 360;
  const delta2 = n ** 2 / 48 + n ** 3 / 15 - (437 * n ** 4) / 1440;
  const delta3 = (17 * n ** 3) / 480 - (37 * n ** 4) / 840;
  const delta4 = (4397 * n ** 4) / 161280;

  const aStar = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const bStar = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const cStar = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const dStar = -(4279 * e2 ** 4) / 1260;

  const xi = (northing - falseNorthing) / (k0 * aRoof);
  const eta = (easting - falseEasting) / (k0 * aRoof);

  const xiPrim =
    xi -
    delta1 * Math.sin(2 * xi) * Math.cosh(2 * eta) -
    delta2 * Math.sin(4 * xi) * Math.cosh(4 * eta) -
    delta3 * Math.sin(6 * xi) * Math.cosh(6 * eta) -
    delta4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaPrim =
    eta -
    delta1 * Math.cos(2 * xi) * Math.sinh(2 * eta) -
    delta2 * Math.cos(4 * xi) * Math.sinh(4 * eta) -
    delta3 * Math.cos(6 * xi) * Math.sinh(6 * eta) -
    delta4 * Math.cos(8 * xi) * Math.sinh(8 * eta);

  const phiStar = Math.asin(Math.sin(xiPrim) / Math.cosh(etaPrim));
  const deltaLambda = Math.atan(Math.sinh(etaPrim) / Math.cos(xiPrim));

  const sinPhi2 = Math.sin(phiStar) ** 2;
  const latitude =
    phiStar +
    Math.sin(phiStar) *
      Math.cos(phiStar) *
      (aStar + bStar * sinPhi2 + cStar * sinPhi2 ** 2 + dStar * sinPhi2 ** 3);

  return [lon0 + degrees(deltaLambda), degrees(latitude)];
}
