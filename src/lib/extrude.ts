import * as THREE from "three";
import { elementBounds, pointInRing, type Bounds } from "./geometry";
import { levelHeight, verticalExtent } from "./heights";
import type { LidarCloud } from "./lidar";
import { classOf } from "./lidar-format";
import { partsCoverage } from "./parts";
import { resolvedRoofPlan, roofSurface, type RoofFootprint, type RoofSurface } from "./roofs";
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

/**
 * Above-roof discrepancy colours, expressed in sRGB. Repeated colour-family
 * stops keep each requested band recognisable while softly blending at its
 * upper edge instead of drawing hard contour stripes through the point cloud.
 */
const ROOF_DISTANCE_STOPS = [
  { distance: 0, colour: [22, 163, 74] },
  { distance: 0.75, colour: [34, 197, 94] },
  { distance: 1, colour: [249, 115, 22] },
  { distance: 4.5, colour: [251, 146, 60] },
  { distance: 5, colour: [250, 204, 21] },
  { distance: 9, colour: [253, 224, 71] },
  { distance: 10, colour: [239, 68, 68] },
] as const;
type RoofDistanceStop = (typeof ROOF_DISTANCE_STOPS)[number];

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

function pointInFootprint(point: LngLat, footprint: Footprint): boolean {
  return (
    pointInRing(point, footprint.outer) && !footprint.holes.some((hole) => pointInRing(point, hole))
  );
}

function pointInElement(point: LngLat, element: BuildingElement): boolean {
  return element.polygons.some((footprint) => pointInFootprint(point, footprint));
}

function pointInBounds([lon, lat]: LngLat, [west, south, east, north]: Bounds): boolean {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function roofFootprints(element: BuildingElement, projector: Projector): RoofFootprint[] {
  const ring = (points: LngLat[]) =>
    points.slice(0, -1).map((point): [number, number] => {
      const [x, y] = projector.toLocal(point);
      return [x, -y];
    });
  return element.polygons.map((footprint) => ({
    outer: ring(footprint.outer),
    holes: footprint.holes.map(ring),
  }));
}

function addRoofSurface(
  group: THREE.Group,
  surface: RoofSurface,
  roofMaterial: THREE.Material,
  wallMaterial: THREE.Material,
  edgeMaterial: THREE.LineBasicMaterial,
  renderTop: boolean,
): void {
  if (renderTop) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(surface.positions, 3));
    if (surface.indices) geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, roofMaterial);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edgeMaterial);
    group.add(mesh, edges);
  }
  if (surface.wallPositions) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(surface.wallPositions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, wallMaterial);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edgeMaterial);
    group.add(mesh, edges);
  }
}

function extrudeElement(
  element: BuildingElement,
  parent: BuildingElement,
  projector: Projector,
  metersPerLevel: number,
  color: number,
  edgeOpacity: number,
  groundOffset: number,
): THREE.Object3D {
  const extent = verticalExtent(
    element.properties,
    metersPerLevel,
    element.id === parent.id ? undefined : parent.properties,
  );
  const resolvedRoof = resolvedRoofPlan(element, parent, metersPerLevel);
  const facadeTop = resolvedRoof?.plan.eaves ?? extent.top;
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
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(facadeTop - extent.base, 0.001),
      bevelEnabled: false,
    });
    // Shape lies in the XY plane extruded along +Z; rotate so height runs along +Y.
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, extent.base + groundOffset, 0);
    // ExtrudeGeometry assigns caps to material 0 and every vertical face,
    // including hole walls, to material 1.
    const mesh = new THREE.Mesh(geometry, [roofMaterial, wallMaterial]);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edgeMaterial);
    group.add(mesh, edges);
  }
  if (resolvedRoof) {
    const surface = roofSurface(
      resolvedRoof.plan,
      roofFootprints(element, projector),
      roofFootprints(resolvedRoof.frameElement, projector),
      groundOffset,
    );
    if (surface) {
      addRoofSurface(
        group,
        surface,
        roofMaterial,
        wallMaterial,
        edgeMaterial,
        !resolvedRoof.shared,
      );
    }
  }
  return group;
}

/** Render one parent roof shell when its covered outline solid is omitted. */
function sharedParentRoof(
  building: BuildingElement,
  projector: Projector,
  metersPerLevel: number,
  color: number,
  edgeOpacity: number,
  groundOffset: number,
): THREE.Object3D | null {
  const resolved = resolvedRoofPlan(building, building, metersPerLevel);
  if (!resolved) return null;
  const footprints = roofFootprints(building, projector);
  const surface = roofSurface(resolved.plan, footprints, footprints, groundOffset);
  if (!surface) return null;
  const group = new THREE.Group();
  const roofMaterial = new THREE.MeshLambertMaterial({ color });
  const wallMaterial = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color).multiplyScalar(0.68),
    side: THREE.DoubleSide,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x1f2937,
    transparent: true,
    opacity: edgeOpacity,
  });
  addRoofSurface(group, surface, roofMaterial, wallMaterial, edgeMaterial, true);
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
): {
  group: THREE.Group;
  elements: Map<string, THREE.Object3D>;
  pickTargets: THREE.Object3D[];
} {
  const group = new THREE.Group();
  const objects = new Map<string, THREE.Object3D>();
  const pickTargets: THREE.Object3D[] = [];
  // One level height for the whole building, so its parts stack on each other.
  const metersPerLevel = levelHeight(building.properties);
  const covered = partsCoverage(building, parts) >= OUTLINE_REPLACED_ABOVE;
  const elements = covered ? parts : [building, ...parts];
  const outlineRendered = elements.some((element) => element.id === building.id);
  elements.forEach((element, index) => {
    const object = extrudeElement(
      element,
      building,
      projector,
      metersPerLevel,
      colorFor(element, index),
      edgeOpacity,
      groundOffset,
    );
    object.userData.entityId = element.id;
    objects.set(element.id, object);
    pickTargets.push(object);
    group.add(object);
  });
  const hasSharedParts = parts.some((part) => {
    const shape = part.properties.roof_shape;
    return typeof shape !== "string" || shape.trim() === "";
  });
  if (!outlineRendered && hasSharedParts) {
    const roof = sharedParentRoof(
      building,
      projector,
      metersPerLevel,
      colorFor(building, 0),
      edgeOpacity,
      groundOffset,
    );
    if (roof) {
      roof.userData.entityId = building.id;
      pickTargets.push(roof);
      group.add(roof);
    }
  }
  return { group, elements: objects, pickTargets };
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
  /** Existing scene objects that can become camera focus without re-extruding. */
  focusTargets: Map<string, THREE.Object3D>;
  /** Visible building and part objects that the 3D viewer can raycast. */
  pickTargets: THREE.Object3D[];
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
const lidarBiasCache = new WeakMap<LidarCloud, WeakMap<TerrainModel, number[]>>();

function lidarTerrainBiases(cloud: LidarCloud, terrain: TerrainModel): number[] {
  const cached = lidarBiasCache.get(cloud)?.get(terrain);
  if (cached) return cached;
  let highestSurvey = 0;
  for (const survey of cloud.surveys) highestSurvey = Math.max(highestSurvey, survey);
  const surveyCount = highestSurvey + 1;
  const residuals = Array.from({ length: surveyCount }, () => [] as number[]);
  // A few thousand evenly distributed ground pairs are enough for a robust
  // median and keep sorting cost bounded on a dense million-point city tile.
  const step = Math.max(1, Math.floor(cloud.count / 20_000));
  for (let i = 0; i < cloud.count; i += step) {
    if (classOf(cloud.classes[i]) !== 2) continue;
    const ground = terrainElevation(terrain, [cloud.lon[i], cloud.lat[i]]);
    if (ground === null) continue;
    residuals[cloud.surveys[i]].push(cloud.z[i] - ground);
  }
  const combined = residuals.flat();
  const fallback = combined.length > 0 ? median(combined) : 0;
  const biases = residuals.map((values) => (values.length >= 3 ? median(values) : fallback));
  let byTerrain = lidarBiasCache.get(cloud);
  if (!byTerrain) {
    byTerrain = new WeakMap();
    lidarBiasCache.set(cloud, byTerrain);
  }
  byTerrain.set(terrain, biases);
  return biases;
}

interface RoofProfile {
  bounds: Bounds;
  topAt(point: LngLat): number | null;
}

/**
 * Roof height above the selected building's flat terrain base at one point.
 * This follows the solids in the scene: a selected part uses its own roof,
 * while an outline follows covering parts and falls back to the outline across
 * any small coverage gaps.
 */
function selectedRoofProfile(selection: BuildingSelection): RoofProfile {
  const target = selection.selected;
  const metersPerLevel = levelHeight(selection.building.properties);
  const topFor = (element: BuildingElement) =>
    verticalExtent(
      element.properties,
      metersPerLevel,
      element.id === selection.building.id ? undefined : selection.building.properties,
    ).top;

  if (target.id !== selection.building.id) {
    const top = topFor(target);
    return {
      bounds: elementBounds(target),
      topAt: (point) => (pointInElement(point, target) ? top : null),
    };
  }

  return wholeBuildingProfile(selection);
}

/**
 * Roof height above a building's own flat base, across its whole footprint:
 * covering parts where there are any, and the outline everywhere else.
 */
function wholeBuildingProfile(entity: BuildingWithParts): RoofProfile {
  const metersPerLevel = levelHeight(entity.building.properties);
  const topFor = (element: BuildingElement) =>
    verticalExtent(
      element.properties,
      metersPerLevel,
      element.id === entity.building.id ? undefined : entity.building.properties,
    ).top;

  const outlineTop = topFor(entity.building);
  const parts = entity.parts.map((part) => ({
    element: part,
    bounds: elementBounds(part),
    top: topFor(part),
  }));
  const partsReplaceOutline =
    partsCoverage(entity.building, entity.parts) >= OUTLINE_REPLACED_ABOVE;

  return {
    bounds: elementBounds(entity.building),
    topAt(point) {
      if (!pointInElement(point, entity.building)) return null;
      let top = partsReplaceOutline ? -Infinity : outlineTop;
      for (const part of parts) {
        if (
          pointInBounds(point, part.bounds) &&
          pointInElement(point, part.element) &&
          part.top > top
        ) {
          top = part.top;
        }
      }
      return Number.isFinite(top) ? top : outlineTop;
    },
  };
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Continuous green -> orange -> yellow -> red colour for height above a roof. */
function roofDistanceColour(distance: number): [number, number, number] {
  const last = ROOF_DISTANCE_STOPS[ROOF_DISTANCE_STOPS.length - 1];
  let lower: RoofDistanceStop = ROOF_DISTANCE_STOPS[0];
  let upper: RoofDistanceStop = last;
  for (let index = 1; index < ROOF_DISTANCE_STOPS.length; index++) {
    upper = ROOF_DISTANCE_STOPS[index];
    if (distance <= upper.distance) break;
    lower = upper;
  }
  const span = upper.distance - lower.distance;
  const mix = span > 0 ? Math.max(0, Math.min(1, (distance - lower.distance) / span)) : 1;
  return [0, 1, 2].map((channel) =>
    linearChannel(lower.colour[channel] + (upper.colour[channel] - lower.colour[channel]) * mix),
  ) as [number, number, number];
}

interface PointCloudAlignment {
  biases: readonly number[];
  datum: number;
  buildingGround: number;
}

function pointCloudAlignment(
  cloud: LidarCloud,
  selection: BuildingSelection,
  terrain: TerrainModel | null,
): PointCloudAlignment {
  const biases = terrain ? lidarTerrainBiases(cloud, terrain) : [];
  const datum = terrain?.referenceZ ?? cloud.groundZ;
  return {
    biases,
    datum,
    buildingGround: terrain ? minimumTerrainElevation(terrain, selection.building) - datum : 0,
  };
}

/**
 * One point's height on the scene datum, with its own survey's terrain bias
 * removed. Both the 3D view's discrepancy colours and the map's difference
 * mode measure against this, and they have to measure against the same thing:
 * two copies of the formula would let the two views quietly disagree about
 * where a point is.
 */
function alignedHeight(cloud: LidarCloud, index: number, alignment: PointCloudAlignment): number {
  return cloud.z[index] - (alignment.biases[cloud.surveys[index]] ?? 0) - alignment.datum;
}

/** The lon/lat of one cloud point. */
function cloudPoint(cloud: LidarCloud, index: number): LngLat {
  return [cloud.lon[index], cloud.lat[index]];
}

function recolourPointCloud(
  colours: Float32Array,
  cloud: LidarCloud,
  selection: BuildingSelection,
  alignment: PointCloudAlignment,
): void {
  colours.set(cloud.colours);
  const roof = selectedRoofProfile(selection);

  for (let i = 0; i < cloud.count; i++) {
    const point = cloudPoint(cloud, i);
    if (!pointInBounds(point, roof.bounds)) continue;
    const roofTop = roof.topAt(point);
    if (roofTop === null) continue;
    const distance = alignedHeight(cloud, i, alignment) - (alignment.buildingGround + roofTop);
    if (distance <= 0) continue;
    colours.set(roofDistanceColour(distance), i * 3);
  }
}

/**
 * Mapterhorn elevation under each laser point, kept for as long as the cloud
 * and the terrain both live.
 *
 * Sampling it is four raster lookups and a bilinear blend, paid for every point
 * that no building covers — which in an ordinary view is most of them. It also
 * cannot change: a fixed point over a fixed terrain has one elevation. Editing
 * a height re-runs the difference pass on every frame of the drag, so computing
 * this once instead of per frame is the difference between a smooth drag and a
 * juddering one.
 */
const terrainUnderCloud = new WeakMap<LidarCloud, WeakMap<TerrainModel, Float32Array>>();

function terrainUnderPoints(cloud: LidarCloud, terrain: TerrainModel): Float32Array {
  let byTerrain = terrainUnderCloud.get(cloud);
  if (!byTerrain) {
    byTerrain = new WeakMap();
    terrainUnderCloud.set(cloud, byTerrain);
  }
  const cached = byTerrain.get(terrain);
  if (cached) return cached;

  const elevations = new Float32Array(cloud.count);
  for (let i = 0; i < cloud.count; i++) {
    // Plain allocation here: this runs once per cloud, not once per frame, and
    // the raster sampling dwarfs it.
    // NaN marks a point past the edge of the loaded tiles, which stays unknown.
    elevations[i] = terrainElevation(terrain, cloudPoint(cloud, i)) ?? Number.NaN;
  }
  byTerrain.set(terrain, elevations);
  return elevations;
}

/** One modelled building, ready to be asked its roof height at a point. */
interface ModelledBuilding {
  profile: RoofProfile;
  /** The building's flat base, on the scene datum. */
  ground: number;
}

/**
 * Which buildings can possibly cover each cell of a coarse grid.
 *
 * Testing every point against every building is 60 footprints times half a
 * million points, and it is redone whenever the terrain or the selected part
 * settles. Bucketing footprints by bounding box first turns that into a lookup
 * plus a test against the one or two buildings actually near the point.
 */
const MODEL_INDEX_CELL_M = 25;

const NO_BUILDINGS: ModelledBuilding[] = [];

class BuildingIndex {
  // A flat array addressed by row * columns + column. This is looked up once
  // per laser point, so it avoids both the string key and the Map hash that an
  // earlier version paid half a million times per rebuild.
  private cells: (ModelledBuilding[] | undefined)[];
  private columns: number;
  private rows: number;
  private west: number;
  private south: number;
  private cosLat: number;

  constructor(buildings: ModelledBuilding[], bounds: Bounds) {
    const [west, south, east, north] = bounds;
    this.west = west;
    this.south = south;
    this.cosLat = Math.cos((((south + north) / 2) * Math.PI) / 180);
    this.columns = Math.max(1, this.column(east) + 1);
    this.rows = Math.max(1, this.row(north) + 1);
    this.cells = Array.from({ length: this.columns * this.rows });

    for (const building of buildings) {
      const [bWest, bSouth, bEast, bNorth] = building.profile.bounds;
      const firstRow = Math.max(0, this.row(bSouth));
      const lastRow = Math.min(this.rows - 1, this.row(bNorth));
      const firstColumn = Math.max(0, this.column(bWest));
      const lastColumn = Math.min(this.columns - 1, this.column(bEast));
      for (let row = firstRow; row <= lastRow; row++) {
        for (let column = firstColumn; column <= lastColumn; column++) {
          const at = row * this.columns + column;
          const cell = this.cells[at];
          if (cell) cell.push(building);
          else this.cells[at] = [building];
        }
      }
    }
  }

  private column(longitude: number): number {
    return Math.floor(
      ((longitude - this.west) * EARTH_METERS_PER_DEG_LAT * this.cosLat) / MODEL_INDEX_CELL_M,
    );
  }

  private row(latitude: number): number {
    return Math.floor(((latitude - this.south) * EARTH_METERS_PER_DEG_LAT) / MODEL_INDEX_CELL_M);
  }

  at(longitude: number, latitude: number): ModelledBuilding[] {
    const column = this.column(longitude);
    if (column < 0 || column >= this.columns) return NO_BUILDINGS;
    const row = this.row(latitude);
    if (row < 0 || row >= this.rows) return NO_BUILDINGS;
    return this.cells[row * this.columns + column] ?? NO_BUILDINGS;
  }
}

/**
 * How far each laser point sits above what this app models for it, in metres,
 * paired with a flag for the points nothing is modelled under.
 *
 * This is the same subtraction the 3D view colours discrepancies with, lifted
 * out so the flat map can show it too, and widened from the selected footprint
 * to everything on screen. The model a point is measured against is whichever
 * building covers it — the selected one or any of the neighbours the 3D view
 * draws as context — and Mapterhorn terrain everywhere else. Both sides are
 * brought onto the scene datum through the same per-survey alignment the 3D
 * view uses, so a point over open ground is compared against the ground and a
 * point over a roof against that roof.
 *
 * Positive means the survey found something above what is modelled: an
 * unrecorded storey, a roof taller than its tags, a building nobody has mapped,
 * or a tree, which is modelled nowhere and so reads as a large disagreement.
 * Negative means the model stands above the scan.
 *
 * Returned as `(difference, known)` pairs because a shader cannot be handed a
 * missing value; NaN through a vertex attribute is not portable enough to rely
 * on. Only points beyond the terrain tiles are left unknown.
 */
export function roofDifferences(
  cloud: LidarCloud,
  selection: BuildingSelection,
  terrain: TerrainModel | null = null,
): Float32Array {
  const differences = new Float32Array(cloud.count * 2);
  const alignment = pointCloudAlignment(cloud, selection, terrain);

  const ground = (entity: BuildingWithParts) =>
    terrain ? minimumTerrainElevation(terrain, entity.building) - alignment.datum : 0;
  const modelled: ModelledBuilding[] = [selection, ...selection.neighbors].map((entity) => ({
    profile: wholeBuildingProfile(entity),
    ground: ground(entity),
  }));
  const index = new BuildingIndex(modelled, cloudBounds(cloud));
  const under = terrain ? terrainUnderPoints(cloud, terrain) : null;
  // One tuple reused for every point. The polygon tests read it and keep no
  // reference, and allocating half a million short-lived pairs is a measurable
  // share of a drag frame.
  const point: LngLat = [0, 0];

  for (let i = 0; i < cloud.count; i++) {
    point[0] = cloud.lon[i];
    point[1] = cloud.lat[i];

    let surface: number | null = null;
    for (const building of index.at(point[0], point[1])) {
      if (!pointInBounds(point, building.profile.bounds)) continue;
      const top = building.profile.topAt(point);
      if (top === null) continue;
      const roof = building.ground + top;
      // Footprints can overlap where an outline and a neighbouring part share a
      // wall; the higher roof is the one the 3D view would draw there.
      if (surface === null || roof > surface) surface = roof;
    }
    if (surface === null) {
      // Open ground: the model here is the terrain the buildings stand on.
      const elevation = under ? under[i] : alignment.datum;
      if (Number.isNaN(elevation)) continue;
      surface = elevation - alignment.datum;
    }

    differences[i * 2] = alignedHeight(cloud, i, alignment) - surface;
    differences[i * 2 + 1] = 1;
  }

  return differences;
}

/** The lon/lat extent of a cloud, for indexing what is modelled beneath it. */
function cloudBounds(cloud: LidarCloud): Bounds {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < cloud.count; i++) {
    if (cloud.lon[i] < west) west = cloud.lon[i];
    if (cloud.lon[i] > east) east = cloud.lon[i];
    if (cloud.lat[i] < south) south = cloud.lat[i];
    if (cloud.lat[i] > north) north = cloud.lat[i];
  }
  return cloud.count > 0 ? [west, south, east, north] : [0, 0, 0, 0];
}

/** Reuse static LiDAR positions and update only selection-sensitive colours. */
export function updatePointCloudSelection(
  points: THREE.Points,
  cloud: LidarCloud,
  selection: BuildingSelection,
  terrain: TerrainModel | null = null,
): void {
  const attribute = points.geometry.getAttribute("color");
  if (!(attribute instanceof THREE.BufferAttribute) || !(attribute.array instanceof Float32Array))
    return;
  recolourPointCloud(
    attribute.array,
    cloud,
    selection,
    pointCloudAlignment(cloud, selection, terrain),
  );
  attribute.needsUpdate = true;
}

export function buildPointCloud(
  cloud: LidarCloud,
  selection: BuildingSelection,
  origin: LngLat,
  terrain: TerrainModel | null = null,
): THREE.Points {
  const projector = makeProjector(origin);
  const positions = new Float32Array(cloud.count * 3);
  const alignment = pointCloudAlignment(cloud, selection, terrain);
  for (let i = 0; i < cloud.count; i++) {
    const point: LngLat = [cloud.lon[i], cloud.lat[i]];
    const [x, y] = projector.toLocal(point);
    positions[i * 3] = x;
    const pointHeight = cloud.z[i] - (alignment.biases[cloud.surveys[i]] ?? 0) - alignment.datum;
    positions[i * 3 + 1] = pointHeight;
    // Three's local axes are east (+X), up (+Y), south (+Z), so north is -Z.
    positions[i * 3 + 2] = -y;
  }

  const colours = cloud.colours.slice();
  recolourPointCloud(colours, cloud, selection, alignment);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
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
  /**
   * Local origin to project against. Every rebuild of the same building passes
   * the one the first build chose, because the origin is only a reference for
   * the scene's own coordinates and letting it follow the footprint centre
   * would shift every laser point each time a corner was dragged — forcing the
   * whole position buffer to be rewritten for an edit that never moved a point.
   */
  fixedOrigin?: LngLat,
): BuildingScene {
  const origin = fixedOrigin ?? footprintCenter(selection.building);
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
  const pickTargets = [...selected.pickTargets];
  const focusTarget =
    selection.selected.id === selection.building.id
      ? selected.group
      : (selected.elements.get(selection.selected.id) ?? selected.group);
  const focus = new THREE.Box3().setFromObject(focusTarget);
  const focusTargets = new Map<string, THREE.Object3D>(selected.elements);
  focusTargets.set(selection.building.id, selected.group);

  for (const neighbor of selection.neighbors) {
    const context = extrudeBuildingWithParts(
      neighbor,
      projector,
      () => NEIGHBOR_COLOR,
      0.18,
      groundOffset(neighbor.building),
    );
    root.add(context.group);
    pickTargets.push(...context.pickTargets);
  }

  if (terrain) {
    root.add(buildTerrainSurface(terrain, projector));
    return { root, focus, focusTargets, pickTargets, origin };
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

  return { root, focus, focusTargets, pickTargets, origin };
}
