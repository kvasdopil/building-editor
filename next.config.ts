import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OSM OAuth requires a loopback IP callback rather than localhost, so local
  // development is intentionally opened through http://127.0.0.1:<port>.
  allowedDevOrigins: ["127.0.0.1"],
  /**
   * laz-perf is a WebAssembly build that loads its own `.wasm` from disk beside
   * itself, so bundling it rewrites the path and the load fails at runtime with
   * ENOENT on `/ROOT/node_modules/...`. Keep it and its wrapper external so the
   * Skog point cloud route requires them from node_modules instead.
   */
  serverExternalPackages: ["copc", "laz-perf"],
};

export default nextConfig;
