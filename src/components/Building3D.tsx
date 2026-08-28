"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildPointCloud,
  buildScene,
  roofDifferences,
  updatePointCloudSelection,
} from "@/lib/extrude";
import { levelHeight, verticalExtent } from "@/lib/heights";
import { fetchLidarCloud, type LidarCloud, type LidarSource } from "@/lib/lidar";
import { fetchTerrain, type TerrainModel } from "@/lib/terrain";
import { mountCanvas } from "@/lib/three-canvas";
import { initializeHippedRoofGeometry } from "@/lib/roofs";
import type { BuildingSelection } from "@/lib/buildings";

/**
 * What the laser cloud fetch found. Reported to the inspector because a
 * building with no dots is otherwise ambiguous: a tile assembled on demand can
 * take a second or two, and "still reading" looks exactly like "nothing here".
 */
export interface CloudStatus {
  /**
   * The building the status belongs to. Selecting another building takes a
   * lookup and a fetch, and without this the inspector would keep showing the
   * previous building's point count as though it were this one's.
   */
  buildingId: string;
  state: "loading" | "loaded" | "empty";
  points?: number;
  source?: LidarSource;
}

/** Mapterhorn ground datum lookup shown beside the LiDAR overlay status. */
export interface TerrainStatus {
  buildingId: string;
  state: "loading" | "loaded" | "empty";
  /** Lowest z13 elevation inside the building footprint, in meters. */
  groundZ?: number;
}

/**
 * Vertical field of view, in degrees, matched to the `35y` this app hands to
 * Google Earth in External3DLinks. It is the same scene either way, so the lens
 * has to be the same too: at 50° the building read about 1.5x further away than
 * the view the Google link opens. That gap is a ratio, not an offset, so it could
 * not have been corrected by starting closer — it would return on the first
 * scroll.
 */
export const FIELD_OF_VIEW = 35;

/** Camera values shared with external 3D map links. */
export interface CameraView {
  /** Compass direction the camera faces, clockwise from north. */
  heading: number;
  /** 0 looks straight down and 90 looks toward the horizon. */
  tilt: number;
  /** Straight-line distance from the camera to its target, meters. */
  range: number;
  /** Camera height above the selected building's Mapterhorn reference, meters. */
  eyeHeight: number;
}

interface SceneRuntime {
  buildingId: string;
  updateSelection(selection: BuildingSelection): void;
}

function disposeRoot(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.LineSegments ||
      object instanceof THREE.Points
    ) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

/**
 * LiDAR positions and discrepancy colours only depend on footprint geometry,
 * the selected element and each solid's total top. Changing roof:height keeps
 * the apex fixed, so rebuilding a million-point buffer for that edit is wasted.
 */
function pointCloudProfileChanged(previous: BuildingSelection, next: BuildingSelection): boolean {
  if (
    previous.building.id !== next.building.id ||
    previous.selected.id !== next.selected.id ||
    previous.building.polygons !== next.building.polygons ||
    previous.building.properties.geometry_edit_kind !==
      next.building.properties.geometry_edit_kind ||
    previous.parts.length !== next.parts.length
  )
    return true;

  const previousLevelHeight = levelHeight(previous.building.properties);
  const nextLevelHeight = levelHeight(next.building.properties);
  const previousElements = new Map(
    [previous.building, ...previous.parts].map((element) => [element.id, element] as const),
  );
  for (const element of [next.building, ...next.parts]) {
    const old = previousElements.get(element.id);
    const previousParent =
      old?.id === previous.building.id ? undefined : previous.building.properties;
    const nextParent = element.id === next.building.id ? undefined : next.building.properties;
    if (
      !old ||
      old.polygons !== element.polygons ||
      verticalExtent(old.properties, previousLevelHeight, previousParent).top !==
        verticalExtent(element.properties, nextLevelHeight, nextParent).top
    )
      return true;
  }
  return false;
}

/** Interactive 3D view of the selected building (orbit to rotate, wheel to zoom). */
export function Building3D({
  selection,
  initialHeading = 315,
  onCameraChange,
  onCloudStatus,
  onCloudChange,
  onCloudDifferences,
  onTerrainStatus,
}: {
  selection: BuildingSelection;
  /** Initial compass direction, copied from the map when selection changes. */
  initialHeading?: number;
  onCameraChange?: (view: CameraView) => void;
  onCloudStatus?: (status: CloudStatus) => void;
  /** Shares the decoded cloud with the map's XY-only LiDAR mode. */
  onCloudChange?: (buildingId: string, cloud: LidarCloud | null) => void;
  /**
   * Per-point height difference against the modelled roof, for the map's diff
   * colouring. Separate from the cloud because it depends on terrain and on
   * which part is selected, both of which settle after the points arrive.
   */
  onCloudDifferences?: (buildingId: string, differences: Float32Array | null) => void;
  onTerrainStatus?: (status: TerrainStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hippedRoofsReady, setHippedRoofsReady] = useState(false);
  const selectionRef = useRef(selection);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  selectionRef.current = selection;
  // Decoded laser cloud for the building on screen. Kept in a ref, not state,
  // so it arriving never re-renders — the scene is built once and the dots are
  // added to it — and so a camera-only rebuild reuses it instead of refetching.
  const cloudRef = useRef<{ id: string; cloud: LidarCloud } | null>(null);
  const terrainRef = useRef<{ id: string; terrain: TerrainModel } | null>(null);
  /**
   * Last orbit the user set. Switching building or part rebuilds the scene, and
   * restoring this keeps the viewpoint instead of snapping back to the default
   * three-quarter view — the Google pane follows it too, since it mirrors this
   * camera.
   */
  const orbitRef = useRef<CameraView | null>(null);
  /** Map bearing behind the last render, to tell a map rotation from a reselect. */
  const bearingRef = useRef(initialHeading);

  useEffect(() => {
    let active = true;
    void initializeHippedRoofGeometry().then((ready) => {
      if (active && ready) setHippedRoofsReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let activeSelection = selectionRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f6f9);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4ae, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.2);
    scene.add(sun);

    const id = activeSelection.building.id;
    let terrain = terrainRef.current?.id === id ? terrainRef.current.terrain : null;
    let cloud = cloudRef.current?.id === id ? cloudRef.current.cloud : null;
    let built = buildScene(activeSelection, terrain);
    scene.add(built.root);

    let cloudPoints = cloud ? buildPointCloud(cloud, activeSelection, built.origin, terrain) : null;
    if (cloudPoints) scene.add(cloudPoints);
    let refocus: ((focus: THREE.Box3) => void) | null = null;

    // The difference depends on the cloud, the terrain alignment and the
    // selected part, so it is published from every place any of those settle
    // rather than once when the points arrive.
    const publishDifferences = () => {
      onCloudDifferences?.(id, cloud ? roofDifferences(cloud, activeSelection, terrain) : null);
    };

    const replacePointCloud = () => {
      if (cloudPoints) {
        scene.remove(cloudPoints);
        disposeRoot(cloudPoints);
      }
      cloudPoints = cloud ? buildPointCloud(cloud, activeSelection, built.origin, terrain) : null;
      if (cloudPoints) scene.add(cloudPoints);
      publishDifferences();
    };
    // A cached cloud is already in the scene and never reaches the rebuild
    // above, so the opening state is published here.
    publishDifferences();

    // Rebuilding changes terrain and neighbor base elevations, but never the
    // selected building's zero: its lowest Mapterhorn sample is the scene datum.
    const rebuild = (nextSelection: BuildingSelection, forcePointCloud = false) => {
      if (
        nextSelection.building.id === activeSelection.building.id &&
        nextSelection.selected.id !== activeSelection.selected.id
      ) {
        // A sibling selection changes camera focus and discrepancy colours, not
        // the parent's solids, neighbors, terrain, or point positions.
        activeSelection = nextSelection;
        const focusTarget =
          built.focusTargets.get(nextSelection.selected.id) ??
          built.focusTargets.get(nextSelection.building.id);
        if (focusTarget) built.focus.setFromObject(focusTarget);
        if (cloud && cloudPoints) {
          updatePointCloudSelection(cloudPoints, cloud, activeSelection, terrain);
          publishDifferences();
        }
        refocus?.(built.focus);
        return;
      }
      const rebuildPointCloud =
        forcePointCloud || pointCloudProfileChanged(activeSelection, nextSelection);
      const previous = built.root;
      activeSelection = nextSelection;
      const next = buildScene(activeSelection, terrain);
      scene.remove(previous);
      built = next;
      scene.add(next.root);
      disposeRoot(previous);
      if (cloud && rebuildPointCloud) replacePointCloud();
    };

    let pendingSelection: BuildingSelection | null = null;
    const runtime: SceneRuntime = {
      buildingId: activeSelection.building.id,
      updateSelection(nextSelection) {
        if (nextSelection !== activeSelection) pendingSelection = nextSelection;
      },
    };
    runtimeRef.current = runtime;

    const { focus } = built;

    // Laser dots are added to the standing scene rather than awaited, so the
    // buildings appear at once and the cloud follows when its tiles land.
    // Outside the imported area there is no cloud and the view is unchanged.
    let disposed = false;
    const controller = new AbortController();
    const addTerrain = async () => {
      if (!terrain) onTerrainStatus?.({ buildingId: id, state: "loading" });
      const loaded = terrain ?? (await fetchTerrain(activeSelection, controller.signal));
      if (!loaded) {
        if (!disposed) onTerrainStatus?.({ buildingId: id, state: "empty" });
        return;
      }
      terrainRef.current = { id, terrain: loaded };
      terrain = loaded;
      if (disposed) return;
      onTerrainStatus?.({ buildingId: id, state: "loaded", groundZ: loaded.referenceZ });
      // A cached model was already part of the initial scene.
      if (built.root.children.some((child) => child.userData.terrain === true)) return;
      rebuild(activeSelection, true);
    };
    void addTerrain();

    const addLidar = async () => {
      if (!cloud) {
        onCloudStatus?.({ buildingId: id, state: "loading" });
        onCloudChange?.(id, null);
        onCloudDifferences?.(id, null);
      }
      const loaded = cloud ?? (await fetchLidarCloud(activeSelection.building, controller.signal));
      if (!loaded) {
        if (!disposed) {
          onCloudStatus?.({ buildingId: id, state: "empty" });
          onCloudChange?.(id, null);
          onCloudDifferences?.(id, null);
        }
        return;
      }
      if (!disposed) {
        onCloudStatus?.({
          buildingId: id,
          state: "loaded",
          points: loaded.count,
          source: loaded.source,
        });
        onCloudChange?.(id, loaded);
      }
      // Cache before bailing out: a torn-down run still decoded a valid cloud,
      // and the remount that replaced it should not fetch the tiles again.
      cloudRef.current = { id, cloud: loaded };
      cloud = loaded;
      if (disposed) return;
      // Cached points were already added to the initial scene.
      if (cloudPoints) return;
      replacePointCloud();
    };
    void addLidar();

    // Frame the selected building; neighbors stay visible around it.
    const center = focus.getCenter(new THREE.Vector3());
    const size = focus.getSize(new THREE.Vector3());
    // Orbit the centre of the base, not the building's mid-height: rotating
    // around the footprint keeps it planted on its terrain reference instead
    // of swinging the terrain up and down.
    const target = new THREE.Vector3(center.x, focus.min.y, center.z);
    // Floor the framing distance and look down more steeply: a small building
    // ringed by tall neighbours would otherwise start with the camera inside a
    // neighbour's wall.
    const radius = Math.max(size.length() / 2, 18);

    const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, radius * 40);

    // Default three-quarter framing, used until the user orbits.
    const defaultHorizontal = radius * 1.8 * Math.SQRT2;
    const defaultVertical = radius * 2.0;
    const minDistance = radius * 0.3;
    // Reach further out than the framing needs, so the context neighbours stay
    // reachable at this narrower field of view.
    const maxDistance = radius * 12;
    const maxTilt = 90 - 0.03 * (180 / Math.PI);

    const orbit = orbitRef.current;
    // Rotating the map is an explicit request to re-aim, so it wins over the
    // preserved orbit; merely picking another building does not.
    const mapRotated = bearingRef.current !== initialHeading;
    bearingRef.current = initialHeading;
    const heading =
      ((mapRotated ? initialHeading : (orbit?.heading ?? initialHeading)) * Math.PI) / 180;
    // A preserved distance can fall outside what the new building allows, so it
    // is clamped to the same limits the controls enforce.
    const distance = orbit
      ? Math.min(Math.max(orbit.range, minDistance), maxDistance)
      : Math.hypot(defaultHorizontal, defaultVertical);
    const tilt = orbit
      ? Math.min(orbit.tilt, maxTilt) * (Math.PI / 180)
      : Math.atan2(defaultHorizontal, defaultVertical);

    const horizontalDistance = distance * Math.sin(tilt);
    camera.position.set(
      target.x - Math.sin(heading) * horizontalDistance,
      target.y + distance * Math.cos(tilt),
      target.z + Math.cos(heading) * horizontalDistance,
    );

    const canvas = mountCanvas(container, camera);

    const controls = new OrbitControls(camera, canvas.renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = minDistance;
    controls.maxDistance = maxDistance;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;

    refocus = (nextFocus) => {
      const nextCenter = nextFocus.getCenter(new THREE.Vector3());
      const nextSize = nextFocus.getSize(new THREE.Vector3());
      const nextTarget = new THREE.Vector3(nextCenter.x, nextFocus.min.y, nextCenter.z);
      const nextRadius = Math.max(nextSize.length() / 2, 18);
      const nextMinDistance = nextRadius * 0.3;
      const nextMaxDistance = nextRadius * 12;
      const view = orbitRef.current;
      const nextDistance = view
        ? Math.min(Math.max(view.range, nextMinDistance), nextMaxDistance)
        : Math.hypot(nextRadius * 1.8 * Math.SQRT2, nextRadius * 2.0);
      const nextTilt = view
        ? Math.min(view.tilt, maxTilt) * (Math.PI / 180)
        : Math.atan2(nextRadius * 1.8 * Math.SQRT2, nextRadius * 2.0);
      const nextHeading = ((view?.heading ?? initialHeading) * Math.PI) / 180;
      const nextHorizontal = nextDistance * Math.sin(nextTilt);

      controls.target.copy(nextTarget);
      controls.minDistance = nextMinDistance;
      controls.maxDistance = nextMaxDistance;
      camera.far = nextRadius * 40;
      camera.position.set(
        nextTarget.x - Math.sin(nextHeading) * nextHorizontal,
        nextTarget.y + nextDistance * Math.cos(nextTilt),
        nextTarget.z + Math.cos(nextHeading) * nextHorizontal,
      );
      camera.updateProjectionMatrix();
      controls.update();
    };

    // Three's local axes are east (+X), up (+Y), and south (+Z). Translate
    // that orbit into the north-based camera convention used by map links.
    let lastReported = "";
    const reportCamera = () => {
      const offset = camera.position.clone().sub(controls.target);
      const heading = (Math.atan2(-offset.x, offset.z) * 180) / Math.PI;
      const view: CameraView = {
        heading: Math.round(((heading + 360) % 360) * 10) / 10,
        tilt: Math.round(controls.getPolarAngle() * (1800 / Math.PI)) / 10,
        range: Math.round(offset.length() * 10) / 10,
        eyeHeight: Math.round(camera.position.y * 10) / 10,
      };
      const key = `${view.heading}/${view.tilt}/${view.range}/${view.eyeHeight}`;
      if (key === lastReported) return;
      lastReported = key;
      orbitRef.current = view;
      onCameraChange?.(view);
    };
    controls.addEventListener("change", reportCamera);
    controls.update();
    reportCamera();

    canvas.start(() => {
      // Pointer drags may publish several tag states before the browser paints.
      // Render only the newest state, while still providing a live preview.
      if (pendingSelection) {
        const nextSelection = pendingSelection;
        pendingSelection = null;
        rebuild(nextSelection);
      }
      controls.update();
      canvas.renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      controller.abort();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      controls.removeEventListener("change", reportCamera);
      controls.dispose();
      canvas.dispose();
      disposeRoot(built.root);
      if (cloudPoints) disposeRoot(cloudPoints);
    };
  }, [
    initialHeading,
    onCameraChange,
    onCloudChange,
    onCloudDifferences,
    onCloudStatus,
    onTerrainStatus,
    hippedRoofsReady,
    selection.building.id,
  ]);

  // Tag edits replace the effective selection object. Keep the standing
  // renderer, camera, controls and async data; only swap its scene geometry.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime?.buildingId === selection.building.id) runtime.updateSelection(selection);
  }, [selection]);

  return <div ref={containerRef} className="h-full w-full" />;
}
