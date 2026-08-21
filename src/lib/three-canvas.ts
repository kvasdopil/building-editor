import * as THREE from "three";

/**
 * The WebGL canvas lifecycle both 3D views need: a renderer sized to its
 * container, a camera kept in sync with that size, a render loop, and a
 * teardown that leaves nothing attached.
 */

interface MountedCanvas {
  renderer: THREE.WebGLRenderer;
  /** Run `draw` once per frame until disposed. */
  start(draw: () => void): void;
  dispose(): void;
}

export function mountCanvas(
  container: HTMLElement,
  camera: THREE.PerspectiveCamera,
  parameters: THREE.WebGLRendererParameters = {},
): MountedCanvas {
  const renderer = new THREE.WebGLRenderer({ antialias: true, ...parameters });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const resize = () => {
    const { clientWidth, clientHeight } = container;
    // A collapsed container would set an invalid aspect ratio.
    if (clientWidth === 0 || clientHeight === 0) return;
    renderer.setSize(clientWidth, clientHeight);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  let frame = 0;
  return {
    renderer,
    start(draw) {
      const loop = () => {
        frame = requestAnimationFrame(loop);
        draw();
      };
      loop();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
      // Removing a canvas does not guarantee that browsers release its WebGL
      // context before the next renderer is created. Explicitly release it on
      // real viewer teardown so MapLibre and the persistent Google renderer
      // cannot be evicted by a burst of stale local contexts.
      renderer.forceContextLoss();
      container.removeChild(renderer.domElement);
    },
  };
}
