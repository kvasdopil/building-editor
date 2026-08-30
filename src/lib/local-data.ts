import path from "node:path";

/**
 * Where the imported local datasets live — `lod1/` and `lidar/`, both produced
 * by the scripts in `scripts/` and both gitignored.
 *
 * `data/` under the working directory by default. `BUILDING_DATA_DIR` points
 * somewhere else, which is what a git worktree needs: the import is tens of
 * megabytes and belongs to the checkout, not to the branch. Symlinking the
 * directory into the tree looks like the obvious alternative and is not one —
 * Tailwind's source scan follows it, computes a project-relative path to a
 * target above the project root, and Turbopack fails the whole build with
 * `FileSystemPath("").join("../../../data") leaves the filesystem root`.
 *
 * Server-side only: nothing here is reachable from the browser bundle.
 */
function localDataDir(): string {
  return process.env.BUILDING_DATA_DIR ?? path.join(process.cwd(), "data");
}

/** The file holding one imported tile of `dataset`, with its own extension. */
export function localTilePath(
  dataset: "lod1" | "lidar",
  tile: { z: number; x: number; y: number },
  extension: string,
): string {
  return path.join(
    localDataDir(),
    dataset,
    String(tile.z),
    String(tile.x),
    `${tile.y}${extension}`,
  );
}
