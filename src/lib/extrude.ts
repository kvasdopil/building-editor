import * as THREE from "three";
import { levelHeight, verticalExtent } from "./heights";
import type { LidarCloud } from "./lidar";
import { classOf } from "./lidar-format";
import { partsCoverage } from "./parts";
import { minimumTerrainElevation, terrainElevation, type TerrainModel } from "./terrain";
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
  groundOffset: number,
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
    geometry.translate(0, base + groundOffset, 0);
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
  groundOffset: number,
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
      groundOffset,
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

/**
 * Dot size follows the cloud's own point spacing, so both sources read as a
 * surface rather than the denser one looking solid and the sparser one vanishing.
 * The floor keeps dense city data from turning into mush, and the ceiling keeps
 * a thin cloud from covering the building it is meant to measure.
 */
const POINT_SIZE_MIN_M = 0.2;
const POINT_SIZE_MAX_M = 1;

/**
 * The laser cloud as dots in the same local frame as the buildings, so a roof
 * that disagrees with its `height` tag reads as dots floating above or sunk
 * into the extruded solid.
 *
 * With terrain available, ground-class returns measure a robust offset for each
 * survey and Mapterhorn supplies the scene datum. The cloud's own ground level
 * is only a flat-scene fallback while terrain is still unavailable.
 */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Survey-to-terrain offsets from ground returns. Mapterhorn remains the datum:
 * LiDAR is translated to it, never used to move the terrain or buildings.
 */
function lidarTerrainBiases(cloud: LidarCloud, terrain: TerrainModel): [number, number] {
  const residuals: [number[], number[]] = [[], []];
  // A few thousand evenly distributed ground pairs are enough for a robust
  // median and keep sorting cost bounded on a dense million-point city tile.
  const step = Math.max(1, Math.floor(cloud.count / 20_000));
  for (let i = 0; i < cloud.count; i += step) {
    if (classOf(cloud.classes[i]) !== 2) continue;
    const ground = terrainElevation(terrain, [cloud.lon[i], cloud.lat[i]]);
    if (ground === null) continue;
    residuals[cloud.surveys[i]].push(cloud.z[i] - ground);
  }
  const combined = [...residuals[0], ...residuals[1]];
  const fallback = combined.length > 0 ? median(combined) : 0;
  return [
    residuals[0].length >= 3 ? median(residuals[0]) : fallback,
    residuals[1].length >= 3 ? median(residuals[1]) : fallback,
  ];
}

export function buildPointCloud(
  cloud: LidarCloud,
  origin: LngLat,
  terrain: TerrainModel | null = null,
): THREE.Points {
  const projector = makeProjector(origin);
  const positions = new Float32Array(cloud.count * 3);
  const biases = terrain ? lidarTerrainBiases(cloud, terrain) : ([0, 0] as const);
  const datum = terrain?.referenceZ ?? cloud.groundZ;
  for (let i = 0; i < cloud.count; i++) {
    const [x, y] = projector.toLocal([cloud.lon[i], cloud.lat[i]]);
    positions[i * 3] = x;
    const survey = cloud.surveys[i] === 0 ? 0 : 1;
    positions[i * 3 + 1] = cloud.z[i] - biases[survey] - datum;
    // Three's local axes are east (+X), up (+Y), south (+Z), so north is -Z.
    positions[i * 3 + 2] = -y;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(cloud.colours, 3));
  const size = Math.min(Math.max(cloud.spacing * 0.9, POINT_SIZE_MIN_M), POINT_SIZE_MAX_M);
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size, sizeAttenuation: true, vertexColors: true }),
  );
}

/** Mapterhorn elevation mesh, expressed relative to the selected footprint. */
function buildTerrainSurface(model: TerrainModel, projector: Projector): THREE.Mesh {
  const [west, south, east, north] = model.bounds;
  const middleLat = (south + north) / 2;
  const width = (east - west) * EARTH_METERS_PER_DEG_LAT * Math.cos((middleLat * Math.PI) / 180);
  const depth = (north - south) * EARTH_METERS_PER_DEG_LAT;
  const columns = Math.min(96, Math.max(8, Math.ceil(width / 5)));
  const rows = Math.min(96, Math.max(8, Math.ceil(depth / 5)));
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const indices: number[] = [];

  for (let row = 0; row <= rows; row++) {
    const lat = north - (row / rows) * (north - south);
    for (let column = 0; column <= columns; column++) {
      const lon = west + (column / columns) * (east - west);
      const vertex = row * (columns + 1) + column;
      const [x, y] = projector.toLocal([lon, lat]);
      positions[vertex * 3] = x;
      positions[vertex * 3 + 1] =
        (terrainElevation(model, [lon, lat]) ?? model.referenceZ) - model.referenceZ - 0.04;
      positions[vertex * 3 + 2] = -y;
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const topLeft = row * (columns + 1) + column;
      const bottomLeft = topLeft + columns + 1;
      indices.push(topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0xdde3ea, side: THREE.DoubleSide }),
  );
  mesh.userData.terrain = true;
  return mesh;
}

/**
 * Build the Three.js scene for a selection: the selected building in color
 * (from its parts when it has any, else its outline), adjacent buildings in
 * gray for context, and Mapterhorn terrain (or a temporary flat fallback).
 */
export function buildScene(
  selection: BuildingSelection,
  terrain: TerrainModel | null = null,
): BuildingScene {
  const origin = footprintCenter(selection.building);
  const projector = makeProjector(origin);
  const groundOffset = (building: BuildingElement) =>
    terrain ? minimumTerrainElevation(terrain, building) - terrain.referenceZ : 0;

  const root = new THREE.Group();
  const selected = extrudeBuildingWithParts(
    selection,
    projector,
    (_element, index) => PART_COLORS[index % PART_COLORS.length],
    0.35,
    groundOffset(selection.building),
  );
  root.add(selected.group);
  const focusTarget =
    selection.selected.id === selection.building.id
      ? selected.group
      : (selected.elements.get(selection.selected.id) ?? selected.group);
  const focus = new THREE.Box3().setFromObject(focusTarget);

  for (const neighbor of selection.neighbors) {
    root.add(
      extrudeBuildingWithParts(
        neighbor,
        projector,
        () => NEIGHBOR_COLOR,
        0.18,
        groundOffset(neighbor.building),
      ).group,
    );
  }

  if (terrain) {
    root.add(buildTerrainSurface(terrain, projector));
    return { root, focus, origin };
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
