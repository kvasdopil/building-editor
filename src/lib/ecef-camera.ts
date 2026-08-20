import type { Ellipsoid } from "3d-tiles-renderer/three";
import * as THREE from "three";

/**
 * Camera placement for earth-centred tilesets.
 *
 * Google's 3D tiles live in ECEF, so a viewpoint expressed the way a map thinks
 * of one — compass heading, tilt from straight down, distance to the subject —
 * has to be rebuilt in the local east/north/up frame at that spot. Anchoring to
 * the surface elevation matters: at ellipsoid height 0 the camera ends up below
 * ground anywhere the terrain is above sea level.
 */

const DEG = Math.PI / 180;

interface EcefViewpoint {
  ellipsoid: Ellipsoid;
  lon: number;
  lat: number;
  /** Ellipsoid height of the surface under the subject, meters. */
  surfaceHeight: number;
  /** Compass direction the camera faces, clockwise from north. */
  heading: number;
  /** 0 looks straight down, 90 toward the horizon. */
  tilt: number;
  /** Straight-line camera-to-target distance, meters. */
  range: number;
}

interface EcefPlacement {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** Local up at the subject, for the camera's up vector. */
  up: THREE.Vector3;
}

export function placeEcefCamera({
  ellipsoid,
  lon,
  lat,
  surfaceHeight,
  heading,
  tilt,
  range,
}: EcefViewpoint): EcefPlacement {
  const target = ellipsoid.getCartographicToPosition(
    lat * DEG,
    lon * DEG,
    surfaceHeight,
    new THREE.Vector3(),
  );
  const frame = ellipsoid.getEastNorthUpFrame(
    lat * DEG,
    lon * DEG,
    surfaceHeight,
    new THREE.Matrix4(),
  );

  // Facing `heading` means standing on the opposite side of the target.
  const horizontal = range * Math.sin(tilt * DEG);
  const position = new THREE.Vector3(
    -Math.sin(heading * DEG) * horizontal,
    -Math.cos(heading * DEG) * horizontal,
    range * Math.cos(tilt * DEG),
  ).applyMatrix4(frame);

  return { position, target, up: new THREE.Vector3(0, 0, 1).transformDirection(frame) };
}
