import * as THREE from "three";
import { levelHeight, verticalExtent } from "./heights";
import { partsCoverage } from "./parts";
import type {
  BuildingElement,
  BuildingSelection,
  BuildingWithParts,
  Footprint,
  LngLat,
} from "./buildings";

const EARTH_METERS_PER_DEG_LAT = 111320;

const PART_COLORS = [0xd97757, 0x6a9bcc, 0x8fbf7f, 0xc4a25a, 0xa384c9, 0x5fb3a1];

/** Adjacent buildings are drawn as flat gray context. */
const NEIGHBOR_COLOR = 0xc3cbd4;

/**
 * Parts replace the outline only when they actually cover it. Partial part
 * coverage is common in OSM, and dropping the outline then makes most of the
 * building disappear from the view.
 */
const OUTLINE_REPLACED_ABOVE = 0.85;

interface Projector {
  toLocal(point: LngLat): [number, number];
}

function makeProjector(origin: LngLat): Projector {
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);
  return {
    toLocal([lon, lat]) {
      return [
        (lon - origin[0]) * EARTH_METERS_PER_DEG_LAT * cosLat,
        (lat - origin[1]) * EARTH_METERS_PER_DEG_LAT,
      ];
    },
  };
}

function footprintShape(footprint: Footprint, projector: Projector): THREE.Shape {
  const toPoints = (ring: LngLat[]) =>
    ring.slice(0, -1).map((p) => {
      const [x, y] = projector.toLocal(p);
      return new THREE.Vector2(x, y);
    });
  const shape = new THREE.Shape(toPoints(footprint.outer));
  for (const hole of footprint.holes) {
    shape.holes.push(new THREE.Path(toPoints(hole)));
  }
  return shape;
}

function extrudeElement(
  element: BuildingElement,
  projector: Projector,
  metersPerLevel: number,
  color: number,
  edgeOpacity: number,
): THREE.Object3D {
  const { top, base } = verticalExtent(element.properties, metersPerLevel);
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color });
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x1f2937,
    transparent: true,
    opacity: edgeOpacity,
  });
  for (const footprint of element.polygons) {
    const shape = footprintShape(footprint, projector);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: top - base, bevelEnabled: false });
    // Shape lies in the XY plane extruded along +Z; rotate so height runs along +Y.
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, base, 0);
    const mesh = new THREE.Mesh(geometry, material);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edgeMaterial);
    group.add(mesh, edges);
  }
  return group;
}

/**
 * Extrude a building from its parts, falling back to the outline when it has
 * none — or drawing the outline underneath when the parts leave most of the
 * footprint uncovered.
 */
function extrudeBuildingWithParts(
  { building, parts }: BuildingWithParts,
  projector: Projector,
  colorFor: (index: number) => number,
  edgeOpacity: number,
): THREE.Group {
  const group = new THREE.Group();
  // One level height for the whole building, so its parts stack on each other.
  const metersPerLevel = levelHeight(building.properties);
  const covered = partsCoverage(building, parts) >= OUTLINE_REPLACED_ABOVE;
  const elements = covered ? parts : [building, ...parts];
  elements.forEach((element, index) => {
    group.add(extrudeElement(element, projector, metersPerLevel, colorFor(index), edgeOpacity));
  });
  return group;
}

function footprintCenter(element: BuildingElement): LngLat {
  let count = 0;
  let lon = 0;
  let lat = 0;
  for (const polygon of element.polygons) {
    for (const point of polygon.outer) {
      lon += point[0];
      lat += point[1];
      count++;
    }
  }
  return count > 0 ? [lon / count, lat / count] : [0, 0];
}

interface BuildingScene {
  root: THREE.Group;
  /** Bounds of the selected building alone, so the camera frames it. */
  focus: THREE.Box3;
}

/**
 * Build the Three.js scene for a selection: the selected building in color
 * (from its parts when it has any, else its outline), adjacent buildings in
 * gray for context, and a flat ground disc under everything.
 */
export function buildScene(selection: BuildingSelection): BuildingScene {
  const projector = makeProjector(footprintCenter(selection.building));

  const root = new THREE.Group();
  const selected = extrudeBuildingWithParts(
    selection,
    projector,
    (index) => PART_COLORS[index % PART_COLORS.length],
    0.35,
  );
  root.add(selected);
  const focus = new THREE.Box3().setFromObject(selected);

  for (const neighbor of selection.neighbors) {
    root.add(extrudeBuildingWithParts(neighbor, projector, () => NEIGHBOR_COLOR, 0.18));
  }

  // Ground spans the half-diagonal of everything drawn, so no building
  // overhangs it however the neighborhood is shaped.
  const solids = new THREE.Box3().setFromObject(root);
  const size = solids.getSize(new THREE.Vector3());
  const center = solids.getCenter(new THREE.Vector3());
  const radius = Math.max(Math.hypot(size.x, size.z) / 2, 15) * 1.25;

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64),
    new THREE.MeshLambertMaterial({ color: 0xdde3ea }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, -0.05, center.z);
  root.add(ground);

  const grid = new THREE.GridHelper(radius * 2, 32, 0xb8c2cc, 0xcdd5dd);
  grid.position.set(center.x, -0.04, center.z);
  root.add(grid);

  return { root, focus };
}
