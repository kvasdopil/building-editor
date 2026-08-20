import * as THREE from "three";
import { levelHeight, verticalExtent } from "./heights";
import type { LidarCloud } from "./lidar";
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
  const roofMaterial = new THREE.MeshLambertMaterial({ color });
  const wallMaterial = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color).multiplyScalar(0.68),
    // Interior-ring winding varies between OSM and locally drawn geometry.
    // Two-sided walls keep the inside of every cut visible from the courtyard.
    side: THREE.DoubleSide,
  });
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
    // ExtrudeGeometry assigns caps to material 0 and every vertical face,
    // including hole walls, to material 1.
    const mesh = new THREE.Mesh(geometry, [roofMaterial, wallMaterial]);
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
  colorFor: (element: BuildingElement, index: number) => number,
  edgeOpacity: number,
): { group: THREE.Group; elements: Map<string, THREE.Object3D> } {
  const group = new THREE.Group();
  const objects = new Map<string, THREE.Object3D>();
  // One level height for the whole building, so its parts stack on each other.
  const metersPerLevel = levelHeight(building.properties);
  const outlineIsAuthoritative = building.properties.geometry_modified === true;
  const covered =
    !outlineIsAuthoritative && partsCoverage(building, parts) >= OUTLINE_REPLACED_ABOVE;
  // A cut belongs to the outline geometry. Rendering covering parts instead
  // would fill the opening again, so the edited outline becomes the solid.
  const elements = outlineIsAuthoritative ? [building] : covered ? parts : [building, ...parts];
  elements.forEach((element, index) => {
    const object = extrudeElement(
      element,
      projector,
      metersPerLevel,
      colorFor(element, index),
      edgeOpacity,
    );
    objects.set(element.id, object);
    group.add(object);
  });
  return { group, elements: objects };
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
  /** Lon/lat the local metric frame is centered on, for anything added later. */
  origin: LngLat;
}

/** Dot size in meters. Roughly the spacing of a 16 points/m² scan. */
const POINT_SIZE_M = 0.28;

/**
 * The laser cloud as dots in the same local frame as the buildings, so a roof
 * that disagrees with its `height` tag reads as dots floating above or sunk
 * into the extruded solid.
 *
 * Cloud heights are RH2000 levels while buildings stand on a zero ground plane,
 * so every dot drops by the cloud's own ground level. That is one level for the
 * whole neighborhood: on a slope the far side of the view sits slightly off,
 * which is the same simplification the extruded buildings already make.
 */
export function buildPointCloud(cloud: LidarCloud, origin: LngLat): THREE.Points {
  const projector = makeProjector(origin);
  const positions = new Float32Array(cloud.count * 3);
  for (let i = 0; i < cloud.count; i++) {
    const [x, y] = projector.toLocal([cloud.lon[i], cloud.lat[i]]);
    positions[i * 3] = x;
    positions[i * 3 + 1] = cloud.z[i] - cloud.groundZ;
    // Three's local axes are east (+X), up (+Y), south (+Z), so north is -Z.
    positions[i * 3 + 2] = -y;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(cloud.colours, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size: POINT_SIZE_M, sizeAttenuation: true, vertexColors: true }),
  );
}

/**
 * Build the Three.js scene for a selection: the selected building in color
 * (from its parts when it has any, else its outline), adjacent buildings in
 * gray for context, and a flat ground disc under everything.
 */
export function buildScene(selection: BuildingSelection): BuildingScene {
  const origin = footprintCenter(selection.building);
  const projector = makeProjector(origin);

  const root = new THREE.Group();
  const selected = extrudeBuildingWithParts(
    selection,
    projector,
    (_element, index) => PART_COLORS[index % PART_COLORS.length],
    0.35,
  );
  root.add(selected.group);
  const focusTarget =
    selection.selected.id === selection.building.id
      ? selected.group
      : (selected.elements.get(selection.selected.id) ?? selected.group);
  const focus = new THREE.Box3().setFromObject(focusTarget);

  for (const neighbor of selection.neighbors) {
    root.add(extrudeBuildingWithParts(neighbor, projector, () => NEIGHBOR_COLOR, 0.18).group);
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

  return { root, focus, origin };
}
