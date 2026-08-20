import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * laz-perf is a WebAssembly build that loads its own `.wasm` from disk beside
   * itself, so bundling it rewrites the path and the load fails at runtime with
   * ENOENT on `/ROOT/node_modules/...`. Keep it and its wrapper external so the
   * Skog point cloud route requires them from node_modules instead.
   */
  serverExternalPackages: ["copc", "laz-perf"],
};

export default nextConfig;
