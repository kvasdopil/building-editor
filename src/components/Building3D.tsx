"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildPointCloud, buildScene } from "@/lib/extrude";
import { fetchLidarCloud, type LidarCloud } from "@/lib/lidar";
import { mountCanvas } from "@/lib/three-canvas";
import type { BuildingSelection } from "@/lib/buildings";

/** Camera values shared with external 3D map links. */
export interface CameraView {
  /** Compass direction the camera faces, clockwise from north. */
  heading: number;
  /** 0 looks straight down and 90 looks toward the horizon. */
  tilt: number;
  /** Straight-line distance from the camera to its target, meters. */
  range: number;
  /** Camera height above the scene's ground plane, meters. */
  eyeHeight: number;
}

/** Interactive 3D view of the selected building (orbit to rotate, wheel to zoom). */
export function Building3D({
  selection,
  initialHeading = 315,
  onCameraChange,
}: {
  selection: BuildingSelection;
  /** Initial compass direction, copied from the map when selection changes. */
  initialHeading?: number;
  onCameraChange?: (view: CameraView) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Decoded laser cloud for the building on screen. Kept in a ref, not state,
  // so it arriving never re-renders — the scene is built once and the dots are
  // added to it — and so a camera-only rebuild reuses it instead of refetching.
  const cloudRef = useRef<{ id: string; cloud: LidarCloud } | null>(null);
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
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f6f9);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4ae, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.2);
    scene.add(sun);

    const { root, focus, origin } = buildScene(selection);
    scene.add(root);

    // Laser dots are added to the standing scene rather than awaited, so the
    // buildings appear at once and the cloud follows when its tiles land.
    // Outside the imported area there is no cloud and the view is unchanged.
    let disposed = false;
    const addLidar = async () => {
      const id = selection.building.id;
      const cached = cloudRef.current?.id === id ? cloudRef.current : null;
      const cloud = cached?.cloud ?? (await fetchLidarCloud(selection.building));
      if (!cloud) return;
      // Cache before bailing out: a torn-down run still decoded a valid cloud,
      // and the remount that replaced it should not fetch the tiles again.
      cloudRef.current = { id, cloud };
      if (disposed) return;
      root.add(buildPointCloud(cloud, origin));
    };
    void addLidar();

    // Frame the selected building; neighbors stay visible around it.
    const center = focus.getCenter(new THREE.Vector3());
    const size = focus.getSize(new THREE.Vector3());
    // Orbit the centre of the base, not the building's mid-height: rotating
    // around the footprint keeps it planted on the ground plane instead of
    // swinging the ground up and down.
    const target = new THREE.Vector3(center.x, focus.min.y, center.z);
    // Floor the framing distance and look down more steeply: a small building
    // ringed by tall neighbours would otherwise start with the camera inside a
    // neighbour's wall.
    const radius = Math.max(size.length() / 2, 18);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, radius * 40);

    // Default three-quarter framing, used until the user orbits.
    const defaultHorizontal = radius * 1.8 * Math.SQRT2;
    const defaultVertical = radius * 2.0;
    const minDistance = radius * 0.3;
    const maxDistance = radius * 8;
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
      controls.update();
      canvas.renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      controls.removeEventListener("change", reportCamera);
      controls.dispose();
      canvas.dispose();
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.LineSegments ||
          object instanceof THREE.Points
        ) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((m) => m.dispose());
        }
      });
    };
  }, [initialHeading, onCameraChange, selection]);

  return <div ref={containerRef} className="h-full w-full" />;
}
