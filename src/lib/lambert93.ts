/**
 * RGF93 v1 / Lambert-93 (EPSG:2154), both directions.
 *
 * IGN's metropolitan LiDAR HD COPC files use this metre grid. The formulas are
 * the ellipsoidal Lambert Conformal Conic (2SP) projection on GRS80, using the
 * parameters published for EPSG:2154.
 */

const AXIS = 6378137;
const FLATTENING = 1 / 298.257222101;
const ECCENTRICITY = Math.sqrt(FLATTENING * (2 - FLATTENING));

const degrees = (value: number) => (value * 180) / Math.PI;
const radians = (value: number) => (value * Math.PI) / 180;

const FALSE_EASTING = 700000;
const FALSE_NORTHING = 6600000;
const CENTRAL_MERIDIAN = radians(3);
const LATITUDE_OF_ORIGIN = radians(46.5);
const FIRST_PARALLEL = radians(44);
const SECOND_PARALLEL = radians(49);

function m(latitude: number): number {
  const sin = Math.sin(latitude);
  return Math.cos(latitude) / Math.sqrt(1 - ECCENTRICITY ** 2 * sin ** 2);
}

function t(latitude: number): number {
  const sin = Math.sin(latitude);
  const eccentricityRatio =
    ((1 - ECCENTRICITY * sin) / (1 + ECCENTRICITY * sin)) ** (ECCENTRICITY / 2);
  return Math.tan(Math.PI / 4 - latitude / 2) / eccentricityRatio;
}

const N =
  (Math.log(m(FIRST_PARALLEL)) - Math.log(m(SECOND_PARALLEL))) /
  (Math.log(t(FIRST_PARALLEL)) - Math.log(t(SECOND_PARALLEL)));
const F = m(FIRST_PARALLEL) / (N * t(FIRST_PARALLEL) ** N);
const RHO_ORIGIN = AXIS * F * t(LATITUDE_OF_ORIGIN) ** N;

/** Longitude/latitude to Lambert-93 easting/northing. */
export function projectLambert93(longitude: number, latitude: number): [number, number] {
  const longitudeRadians = radians(longitude);
  const latitudeRadians = radians(latitude);
  const rho = AXIS * F * t(latitudeRadians) ** N;
  const theta = N * (longitudeRadians - CENTRAL_MERIDIAN);
  return [
    FALSE_EASTING + rho * Math.sin(theta),
    FALSE_NORTHING + RHO_ORIGIN - rho * Math.cos(theta),
  ];
}

/** Lambert-93 easting/northing back to longitude/latitude. */
export function unprojectLambert93(easting: number, northing: number): [number, number] {
  const dx = easting - FALSE_EASTING;
  const dy = RHO_ORIGIN - (northing - FALSE_NORTHING);
  const rho = Math.sign(N) * Math.hypot(dx, dy);
  const theta = Math.atan2(dx, dy);
  const projectedT = (rho / (AXIS * F)) ** (1 / N);

  // Invert the ellipsoidal latitude iteratively. Lambert-93 is comfortably
  // away from the poles, and this converges to sub-millimetre precision in a
  // handful of iterations.
  let latitude = Math.PI / 2 - 2 * Math.atan(projectedT);
  for (let iteration = 0; iteration < 12; iteration++) {
    const sin = Math.sin(latitude);
    const ratio = ((1 - ECCENTRICITY * sin) / (1 + ECCENTRICITY * sin)) ** (ECCENTRICITY / 2);
    const next = Math.PI / 2 - 2 * Math.atan(projectedT * ratio);
    if (Math.abs(next - latitude) < 1e-13) {
      latitude = next;
      break;
    }
    latitude = next;
  }

  return [degrees(CENTRAL_MERIDIAN + theta / N), degrees(latitude)];
}
