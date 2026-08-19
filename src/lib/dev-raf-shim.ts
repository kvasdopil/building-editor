/**
 * Dev-only: headless/hidden tabs (automated previews, background tabs)
 * suspend requestAnimationFrame, which stalls MapLibre's style load and
 * render loop. Fall back to setTimeout while the document is hidden.
 */
export function installDevRafShim(): void {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return;
  const marker = "__rafShimInstalled";
  const scope = window as unknown as Record<string, unknown>;
  if (scope[marker]) return;
  scope[marker] = true;

  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    if (!document.hidden) return raf(callback);
    return window.setTimeout(() => callback(performance.now()), 16);
  };
  window.cancelAnimationFrame = (id: number): void => {
    caf(id);
    window.clearTimeout(id);
  };
}
