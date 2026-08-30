import type { LidarColourMode } from "./lidar-map-layer";
import { parseOsmRef } from "./osm/ref";

/**
 * The URL hash carries both what is selected and how the map is being looked
 * at, as `&`-separated segments: `#way/42764754&surface&lines=1&lod1=0`.
 *
 * The selection is the segment that parses as an OSM reference; everything else
 * describes the view. Only settings that differ from the defaults are written,
 * so an ordinary link stays `#way/42764754` and the extra segments appear only
 * once somebody has actually changed something worth sending to someone else.
 *
 * Two hooks write this hash — one owns the reference, the other the view — so
 * both rebuild it from whatever is currently there and replace only their own
 * half. That keeps them from clobbering each other whichever order they run in.
 */

/**
 * How the map is being looked at, as one word. The three LiDAR entries are the
 * point cloud under its three colourings: the underlay and the colour it is
 * drawn in are one choice to a reader, so they are one word in the URL too.
 */
type ViewMode = "map" | "photos" | "lidar" | "height" | "surface" | "diff";

const VIEW_MODES: ViewMode[] = ["map", "photos", "lidar", "height", "surface", "diff"];

/** Hash words from before renames, still honoured in links already shared. */
const LEGACY_VIEW_MODES: Record<string, ViewMode> = { normals: "surface", grid: "surface" };

/** Everything about the view that the hash carries. */
export interface ViewHash {
  mode: ViewMode;
  /** Draw the links between consecutively recorded points. */
  lines: boolean;
  /** Draw the matched LOD1 outline. */
  lod1: boolean;
}

export const DEFAULT_VIEW: ViewHash = { mode: "map", lines: false, lod1: true };

function segmentsOf(hash: string): string[] {
  return hash.replace(/^#/, "").split("&").filter(Boolean);
}

/** The selection segment of a hash, or `""` when nothing is selected. */
export function hashRef(hash: string): string {
  return segmentsOf(hash).find((segment) => parseOsmRef(segment) !== null) ?? "";
}

/** The view a hash asks for, with anything absent or unrecognized left default. */
export function parseView(hash: string): ViewHash {
  const segments = segmentsOf(hash);
  return {
    mode:
      VIEW_MODES.find((mode) => segments.includes(mode)) ??
      segments.map((segment) => LEGACY_VIEW_MODES[segment]).find(Boolean) ??
      DEFAULT_VIEW.mode,
    lines: segments.includes("lines=1") ? true : DEFAULT_VIEW.lines,
    lod1: segments.includes("lod1=0") ? false : DEFAULT_VIEW.lod1,
  };
}

/**
 * The view a hash asks for, reduced to what can actually be shown. A LiDAR
 * colouring needs a building to read, so a hash that names no element falls
 * back to the plain map rather than opening an empty cloud whose own switch is
 * disabled.
 */
export function effectiveView(hash: string): ViewHash {
  const view = parseView(hash);
  if (viewState(view.mode).lidar && !hashRef(hash)) return { ...view, mode: "map" };
  return view;
}

/** The hash for a reference and a view, without the leading `#`. */
export function buildHash(ref: string, view: ViewHash): string {
  const segments = [ref];
  if (view.mode !== DEFAULT_VIEW.mode) segments.push(view.mode);
  if (view.lines !== DEFAULT_VIEW.lines) segments.push(view.lines ? "lines=1" : "lines=0");
  if (view.lod1 !== DEFAULT_VIEW.lod1) segments.push(view.lod1 ? "lod1=1" : "lod1=0");
  return segments.filter(Boolean).join("&");
}

/** Replace the hash, keeping the half this caller does not own. */
export function writeHash(hash: string): void {
  const next = hash ? `#${hash}` : "";
  if (window.location.hash === next) return;
  // A view or a selection is map state rather than a page: clicking around a
  // neighbourhood should not fill the back button.
  window.history.replaceState(null, "", next || window.location.pathname + window.location.search);
}

/** The underlay and LiDAR colouring a mode stands for. */
export function viewState(mode: ViewMode): {
  photos: boolean;
  lidar: boolean;
  colour: LidarColourMode | null;
} {
  switch (mode) {
    case "photos":
      return { photos: true, lidar: false, colour: null };
    case "lidar":
      return { photos: false, lidar: true, colour: "colour" };
    case "height":
      return { photos: false, lidar: true, colour: "height" };
    case "surface":
      return { photos: false, lidar: true, colour: "surface" };
    case "diff":
      return { photos: false, lidar: true, colour: "diff" };
    default:
      return { photos: false, lidar: false, colour: null };
  }
}

/** The mode word for the current underlay and colouring. */
export function viewMode(photos: boolean, lidar: boolean, colour: LidarColourMode): ViewMode {
  if (photos) return "photos";
  if (!lidar) return "map";
  if (colour === "height") return "height";
  if (colour === "surface") return "surface";
  if (colour === "diff") return "diff";
  return "lidar";
}
