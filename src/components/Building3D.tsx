"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildScene } from "@/lib/extrude";
import type { BuildingSelection } from "@/lib/buildings";

/** Interactive 3D view of the selected building (orbit to rotate, wheel to zoom). */
export function Building3D({ selection }: { selection: BuildingSelection }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f6f9);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4ae, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.2);
    scene.add(sun);

    const { root, focus } = buildScene(selection);
    scene.add(root);

    // Frame the selected building; neighbors stay visible around it.
    const center = focus.getCenter(new THREE.Vector3());
    const size = focus.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 10);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, radius * 40);
    camera.position.set(center.x + radius * 1.8, center.y + radius * 1.4, center.z + radius * 1.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = radius * 0.3;
    controls.maxDistance = radius * 8;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.update();

    let frame = 0;
    const renderLoop = () => {
      frame = requestAnimationFrame(renderLoop);
      controls.update();
      renderer.render(scene, camera);
    };
    renderLoop();

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((m) => m.dispose());
        }
      });
    };
  }, [selection]);

  return <div ref={containerRef} className="h-full w-full" />;
}
