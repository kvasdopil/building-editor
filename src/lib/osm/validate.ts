import area from "@turf/area";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import union from "@turf/union";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BuildingElement, LngLat } from "../buildings";
import {
  boundsOverlap,
  closestPointOnSegment,
  elementBounds,
  elementFeature,
  openRing,
  padBounds,
  ringCenter,
} from "../geometry";
import { localBacktrackRepair, ringIntersections, ringIsSimple } from "../geometry-edits";
import { levelHeight, verticalExtent } from "../heights";
import { overlapFraction } from "../parts";
import {
  type ChangesetPlan,
  changesetSize,
  MAX_CHANGESET_ELEMENTS,
  MAX_WAY_NODES,
} from "./changeset";
import { hasErrors, issue, type Issue, sortIssues } from "./issues";
import { metersBetween } from "./precision";
import { OsmBuildingLookup } from "./building-lookup";

/**
 * The checks that run before an upload. Errors block it, warnings are for a
 * reviewer to accept or fix — the same split JOSM's validator uses.
 *
 * Where a rule exists upstream we follow it rather than inventing one: the
 * numeric formats come from JOSM's `numeric.mapcss`, the geometry rules from its
 * `geometry.mapcss` and validation tests, and the coverage rule from Simple 3D
 * Buildings ("the entire building outline should be filled with building:part
 * areas", which "may overlap each other or may be disjunct", while overlapping
 * 3D volumes are to be avoided).
 *
 * Deliberately absent: any winding-order rule. OSM has none for buildings — "the
 * direction of the ways does not matter" — and rewriting a way to satisfy one
 * would bump its version for nothing.
 */

/** JOSM: `*[building:levels]` must be a non-negative count, halves allowed. */
const LEVELS_VALUE = /^(([0-9]|[1-9][0-9]*)(\.5)?)$/;
/** JOSM's preferred length format: a number, optionally followed by " m". */
const LENGTH_VALUE = /^-?\d+(\.\d+)?( m)?$/;
/** Feet and inches, which JOSM also accepts: `40'`, `5'11"`. */
const LENGTH_IMPERIAL = /^\d+'(\d{1,2}(\.\d+)?")?$/;
const LENGTH_LOOSE = /^-?\d+([.,]\d+)?\s*(metres?|meters?|m|ft|feet|')?$/i;

const LENGTH_KEYS = ["height", "min_height", "roof:height"] as const;

/** JOSM's `deprecated.mapcss`, limited to the keys this editor can produce. */
const DEPRECATED_KEYS: Record<string, string> = {
  "building:min_levels": "building:min_level",
  min_levels: "building:min_level",
  levels: "building:levels",
  "building:height": "height",
};

/** JOSM `geometry.mapcss`: "Too large building". */
const MAX_BUILDING_AREA_M2 = 920_000;

/** Above this a building is rare enough worldwide to be worth a second look. */
const IMPLAUSIBLE_HEIGHT_M = 300;

/** A part this small is almost always a slice artefact rather than a structure. */
const MIN_PART_AREA_M2 = 1;

/** A part is at ground level when its base is within this of zero. */
const GROUND_BASE_M = 0.5;

/**
 * How close two part footprints must come to count as touching. A shared wall is
 * usually shared nodes, but parts that merely abut are still one structure, and a
 * node's worth of slack absorbs the grid.
 */
const PART_TOUCH_METERS = 0.05;

/** Coverage gaps below both thresholds are rounding, not missing parts. */
const COVERAGE_GAP_FRACTION = 0.02;
const COVERAGE_GAP_M2 = 2;

/**
 * Shortest changeset comment worth having. Long enough that "ok" or a stray
 * keystroke does not pass as a description of what changed.
 */
export const COMMENT_MIN_LENGTH = 5;

/** The comment rule, shared so the field and the blocking check cannot disagree. */
export function isUsableComment(comment: string): boolean {
  return comment.trim().length >= COMMENT_MIN_LENGTH;
}

/**
 * The comment's own findings, kept apart from `validateChangeset` because they are
 * the only ones that change while somebody types. Folding them in would mean
 * re-running boolean geometry over every part on each keystroke.
 */
export function commentIssues(comment: string): Issue[] {
  return isUsableComment(comment)
    ? []
    : [
        issue(
          "error",
          "changeset-comment-missing",
          "A changeset needs a comment saying what changed and where the data came from.",
          [],
        ),
      ];
}

interface ValidationInput {
  /** Features with the pending edits applied: what an upload would produce. */
  displayed: FeatureCollection;
  plan: ChangesetPlan;
}

interface ValidationResult {
  issues: Issue[];
  errors: number;
  warnings: number;
  /** False when an upload must not be attempted. */
  submittable: boolean;
}

type Polygonal = Feature<Polygon | MultiPolygon>;

function polygonal(element: BuildingElement): Polygonal {
  return elementFeature(element);
}

function safeArea(feature: Polygonal | null): number {
  if (!feature) return 0;
  try {
    return area(feature);
  } catch {
    return 0;
  }
}

function safeIntersect(a: Polygonal, b: Polygonal): Polygonal | null {
  try {
    return intersect(featureCollection([a, b])) as Polygonal | null;
  } catch {
    return null;
  }
}

/** Structural checks on the elements the changeset would write. */
function checkPlan(plan: ChangesetPlan): Issue[] {
  const issues: Issue[] = [...plan.issues];
  const size = changesetSize(plan);

  if (size === 0) {
    issues.push(
      issue(
        "error",
        "changeset-empty",
        plan.dropped.length > 0
          ? "Every pending change already matches OSM, so there is nothing to upload."
          : "There is nothing to upload.",
        plan.dropped,
      ),
    );
  }
  if (size > MAX_CHANGESET_ELEMENTS) {
    issues.push(
      issue(
        "error",
        "changeset-too-large",
        `${size} elements exceeds the API limit of ${MAX_CHANGESET_ELEMENTS} per changeset; it has to be split.`,
        [],
      ),
    );
  }
  for (const node of plan.nodes) {
    // A node modify without a version cannot be sent: the API has no way to
    // detect a conflict, so it would overwrite whatever is there now.
    if (node.action === "modify" && (node.version === undefined || node.version <= 0)) {
      issues.push(
        issue(
          "error",
          "missing-version",
          "A node being moved has no version, so moving it would risk overwriting a newer edit.",
          [],
          node.coordinates,
        ),
      );
    }
  }

  for (const way of plan.ways) {
    if (way.nodes.length > MAX_WAY_NODES) {
      issues.push(
        issue(
          "error",
          "way-too-many-nodes",
          `${way.ref} would have ${way.nodes.length} nodes, over the API limit of ${MAX_WAY_NODES}.`,
          [way.ref],
        ),
      );
    }
    if (!way.area) {
      if (way.nodes.length < 2) {
        issues.push(
          issue("error", "degenerate-way", `${way.ref} has fewer than two nodes.`, [way.ref]),
        );
      }
      continue;
    }
    if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) {
      issues.push(issue("error", "way-not-closed", `${way.ref} is not a closed area.`, [way.ref]));
      continue;
    }
    const ring = way.nodes.slice(0, -1);
    for (let i = 1; i < ring.length; i++) {
      if (ring[i] === ring[i - 1]) {
        issues.push(
          issue("error", "duplicated-way-nodes", `${way.ref} lists the same node twice in a row.`, [
            way.ref,
          ]),
        );
        break;
      }
    }
    if (new Set(ring).size !== ring.length) {
      issues.push(
        issue(
          "error",
          "self-touching-way",
          `${way.ref} visits the same node twice, so its outline touches itself.`,
          [way.ref],
        ),
      );
    }
  }

  for (const relation of plan.relations) {
    if (relation.tags.type !== "multipolygon") continue;
    if (!relation.members.some((member) => member.role === "outer")) {
      issues.push(
        issue("error", "multipolygon-without-outer", `${relation.ref} has no outer member.`, [
          relation.ref,
        ]),
      );
    }
    if (relation.members.some((member) => member.role !== "outer" && member.role !== "inner")) {
      issues.push(
        issue(
          "error",
          "multipolygon-member-role",
          `${relation.ref} has a member whose role is neither outer nor inner.`,
          [relation.ref],
        ),
      );
    }
  }

  return issues;
}

/**
 * JOSM-derived tag checks, scoped to the keys this changeset writes.
 *
 * An element we only resend — the outline of a sliced building, say — keeps its
 * tags byte for byte, and reporting on those means lecturing the user about
 * somebody else's tagging in a dialog about their own edit. The cross-tag
 * consistency rules below still read the element's full effective state, because
 * that state is what the upload produces, but they only run when we are writing
 * its tags at all.
 */
function checkTags(element: BuildingElement, changedKeys: Set<string>): Issue[] {
  if (changedKeys.size === 0) return [];
  const issues: Issue[] = [];
  const tags = (element.properties.tags ?? {}) as Record<string, string>;
  const at = element.polygons[0] ? ringCenter(element.polygons[0].outer) : undefined;
  const report = (level: Issue["level"], check: string, message: string) =>
    issues.push(issue(level, check, `${element.id}: ${message}`, [element.id], at));

  for (const key of changedKeys) {
    const value = tags[key];
    if (value === undefined) continue;
    const replacement = DEPRECATED_KEYS[key];
    if (replacement && replacement !== key) {
      report("warning", "deprecated-key", `\`${key}\` is deprecated; use \`${replacement}\`.`);
    }
    // Uppercase alone is not suspicious: `ref:SE:raa` and `name:en` are ordinary
    // OSM keys. Whitespace in a key never is.
    if (/\s/.test(key)) {
      report("warning", "suspicious-key", `\`${key}\` has whitespace in the key.`);
    }
    if (value !== value.trim()) {
      report("warning", "value-whitespace", `\`${key}\` has leading or trailing whitespace.`);
    }
  }

  const levels = changedKeys.has("building:levels") ? tags["building:levels"] : undefined;
  if (levels !== undefined && !LEVELS_VALUE.test(levels)) {
    report(
      "error",
      levels.startsWith("-") ? "negative-levels" : "levels-format",
      levels.startsWith("-")
        ? `negative \`building:levels\` value \`${levels}\`.`
        : `\`building:levels=${levels}\` is not a level count (whole numbers, or .5).`,
    );
  }

  for (const key of LENGTH_KEYS) {
    const value = tags[key];
    if (value === undefined || !changedKeys.has(key)) continue;
    if (LENGTH_VALUE.test(value) || LENGTH_IMPERIAL.test(value)) continue;
    if (value.includes(",")) {
      report(
        "warning",
        "decimal-separator",
        `\`${key}=${value}\`: use . instead of , for decimals.`,
      );
    } else if (LENGTH_LOOSE.test(value)) {
      report(
        "warning",
        "unusual-length-format",
        `\`${key}=${value}\`: use the abbreviation m with a space between value and unit.`,
      );
    } else {
      report("error", "length-format", `\`${key}=${value}\` is not a length.`);
    }
  }

  const height = element.properties.height;
  const minHeight = element.properties.min_height;
  const roofHeight = Number.parseFloat(tags["roof:height"] ?? "");
  const minLevel = element.properties.min_floor;
  const levelCount = element.properties.num_floors;

  if (typeof height === "number" && height <= 0) {
    report("error", "height-not-positive", `\`height=${tags.height}\` must be above zero.`);
  }
  if (typeof height === "number" && height > IMPLAUSIBLE_HEIGHT_M) {
    report("warning", "implausible-height", `\`height=${tags.height}\` is unusually tall.`);
  }
  if (typeof height === "number" && typeof minHeight === "number" && minHeight >= height) {
    report(
      "error",
      "min-height-above-height",
      `\`min_height=${tags.min_height}\` is not below \`height=${tags.height}\`.`,
    );
  }
  if (typeof height === "number" && Number.isFinite(roofHeight) && roofHeight > height) {
    report(
      "error",
      "roof-height-above-height",
      `\`roof:height=${tags["roof:height"]}\` is taller than the whole building.`,
    );
  }
  if (typeof minLevel === "number" && typeof levelCount === "number" && minLevel >= levelCount) {
    report(
      "error",
      "min-level-above-levels",
      `\`building:min_level=${tags["building:min_level"]}\` skips every level of \`building:levels=${tags["building:levels"]}\`.`,
    );
  }

  return issues;
}

function ringIssues(element: BuildingElement): Issue[] {
  const issues: Issue[] = [];
  for (const [polygonIndex, footprint] of element.polygons.entries()) {
    for (const [ringIndex, ring] of [footprint.outer, ...footprint.holes].entries()) {
      const open = openRing(ring);
      if (open.length < 3) {
        issues.push(
          issue(
            "error",
            "degenerate-ring",
            `${element.id} has a ring with fewer than three corners.`,
            [element.id],
            open[0],
          ),
        );
        continue;
      }
      if (ringIsSimple(open)) continue;

      const intersections = ringIntersections(open);
      const repair = localBacktrackRepair(open);
      if (intersections.length === 0) {
        issues.push(
          issue(
            "error",
            "self-intersecting-way",
            `${element.id} repeats a corner in its outline.`,
            [element.id],
            ringCenter(open),
          ),
        );
        continue;
      }
      for (const crossing of intersections) {
        const found = issue(
          "error",
          "self-intersecting-way",
          `${element.id} has outline edges ${crossing.segments[0] + 1} and ${crossing.segments[1] + 1} crossing or touching.`,
          [element.id],
          crossing.at,
        );
        issues.push(
          repair && repair.at[0] === crossing.at[0] && repair.at[1] === crossing.at[1]
            ? {
                ...found,
                fix: {
                  kind: "remove-ring-node",
                  entity: element.id,
                  polygonIndex,
                  ringIndex,
                  nodeIndex: repair.nodeIndex,
                  coordinate: repair.coordinate,
                },
              }
            : found,
        );
      }
    }
  }
  return issues;
}

/**
 * The part of the outline no ground-level part covers. Parts are unioned rather
 * than summed: overlapping parts are legal, so summing their areas hides gaps
 * (which is why `partsCoverage` is a rendering threshold, not a check).
 */
function groundCoverageGap(
  building: BuildingElement,
  parts: BuildingElement[],
): { gap: number; fraction: number; at?: LngLat } | null {
  const footprint = safeArea(polygonal(building));
  if (footprint <= 0) return null;
  const metersPerLevel = levelHeight(building.properties);
  const atGround = parts.filter(
    (part) =>
      verticalExtent(part.properties, metersPerLevel, building.properties).base <= GROUND_BASE_M,
  );
  if (atGround.length === 0) {
    return { gap: footprint, fraction: 1, at: ringCenter(building.polygons[0].outer) };
  }

  let merged: Polygonal | null = null;
  for (const part of atGround) {
    const next = polygonal(part);
    if (!merged) {
      merged = next;
      continue;
    }
    try {
      merged = (union(featureCollection([merged, next])) as Polygonal | null) ?? merged;
    } catch {
      // Touching walls can defeat the boolean op; keep what merged so far and
      // let the gap read high rather than claiming full coverage.
    }
  }
  if (!merged) return null;

  let remainder: Polygonal | null = null;
  try {
    remainder = difference(featureCollection([polygonal(building), merged])) as Polygonal | null;
  } catch {
    return null;
  }
  const gap = safeArea(remainder);
  if (gap <= 0 || !remainder) return null;
  const first =
    remainder.geometry.type === "Polygon"
      ? remainder.geometry.coordinates[0]
      : remainder.geometry.coordinates[0][0];
  return {
    gap,
    fraction: gap / footprint,
    at: first ? ringCenter(first.map((p): LngLat => [p[0], p[1]])) : undefined,
  };
}

/** Every ring of an element, as plain coordinate lists. */
function ringsOf(element: BuildingElement): LngLat[][] {
  return element.polygons.flatMap((footprint) => [footprint.outer, ...footprint.holes]);
}

/** Distance from a point to a segment, in meters. */
function distanceToSegment(point: LngLat, start: LngLat, end: LngLat): number {
  return metersBetween(point, closestPointOnSegment(point, start, end).closest);
}

/**
 * Whether two parts are part of the same structure: they overlap, or a wall of one
 * runs along a wall of the other. Testing vertices against segments rather than
 * only shared nodes means parts that abut without being glued still count — the
 * question here is whether the building holds together, not whether it is glued.
 */
function partsTouch(a: BuildingElement, b: BuildingElement): boolean {
  if (!boundsOverlap(padBounds(elementBounds(a), PART_TOUCH_METERS), elementBounds(b)))
    return false;
  if (safeArea(safeIntersect(polygonal(a), polygonal(b))) > 0) return true;
  const ringsA = ringsOf(a);
  const ringsB = ringsOf(b);
  for (const [from, to] of [
    [ringsA, ringsB],
    [ringsB, ringsA],
  ] as const) {
    for (const ring of from) {
      for (const point of ring) {
        for (const other of to) {
          for (let i = 1; i < other.length; i++) {
            if (distanceToSegment(point, other[i - 1], other[i]) <= PART_TOUCH_METERS) return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Parts that touch nothing else in the building. Simple 3D Buildings allows parts
 * to "be disjunct, depending on the building", so this is a warning, not a rule:
 * a wing across a courtyard is legitimately separate, while a part sitting on its
 * own is more often one that was drawn in the wrong place.
 */
function disconnectedPartGroups(parts: BuildingElement[]): BuildingElement[][] {
  if (parts.length < 2) return [];
  const remaining = new Set(parts.keys());
  const groups: BuildingElement[][] = [];
  while (remaining.size > 0) {
    const [seed] = remaining;
    remaining.delete(seed);
    const group = [seed];
    // Breadth-first over "touches", so a chain of parts counts as one structure.
    for (let head = 0; head < group.length; head++) {
      // Deleting from a Set while iterating it only skips entries not yet reached,
      // which is exactly what claiming a part into this group should do.
      for (const candidate of remaining) {
        if (!partsTouch(parts[group[head]], parts[candidate])) continue;
        remaining.delete(candidate);
        group.push(candidate);
      }
    }
    groups.push(group.map((index) => parts[index]));
  }
  return groups.length > 1 ? groups : [];
}

/** Simple 3D Buildings checks across one building and its parts. */
function checkBuilding(
  building: BuildingElement,
  parts: BuildingElement[],
  written: Set<string>,
): Issue[] {
  const issues: Issue[] = [];
  const footprint = safeArea(polygonal(building));

  if (footprint > MAX_BUILDING_AREA_M2) {
    issues.push(
      issue(
        "warning",
        "too-large-building",
        `${building.id} covers ${Math.round(footprint / 1000)} 000 m², which is larger than any real building.`,
        [building.id],
      ),
    );
  }

  const metersPerLevel = levelHeight(building.properties);
  const buildingTop = verticalExtent(building.properties, metersPerLevel).top;
  const hasBuildingHeight =
    typeof building.properties.height === "number" ||
    typeof building.properties.num_floors === "number";
  const partTops = new Map(
    parts.map((part) => [
      part.id,
      verticalExtent(part.properties, metersPerLevel, building.properties).top,
    ]),
  );
  const maximumPartTop = parts.reduce(
    (maximum, part) => Math.max(maximum, partTops.get(part.id) ?? 0),
    0,
  );
  // Avoid exposing floating-point multiplication noise in an OSM length tag.
  const maximumPartHeight = String(Number(maximumPartTop.toFixed(6)));

  for (const part of parts) {
    const inside = overlapFraction(part, building);
    if (inside < 0.999) {
      issues.push(
        issue(
          // Only block on a part this changeset writes. The same defect on a part
          // we merely happen to sit next to is somebody else's, and pre-existing.
          written.has(part.id) ? "error" : "warning",
          "part-outside-outline",
          `${part.id} has ${Math.round((1 - inside) * 100)}% of its footprint outside ${building.id}; a part must stay within its outline.`,
          [part.id, building.id],
          ringCenter(part.polygons[0].outer),
        ),
      );
    }
    const partArea = safeArea(polygonal(part));
    if (partArea > 0 && partArea < MIN_PART_AREA_M2) {
      issues.push(
        issue(
          "warning",
          "tiny-part",
          `${part.id} is only ${partArea.toFixed(1)} m²; check whether it is a slice artefact.`,
          [part.id],
          ringCenter(part.polygons[0].outer),
        ),
      );
    }
    const top = partTops.get(part.id) ?? 0;
    if (hasBuildingHeight && top > buildingTop + 0.5) {
      issues.push({
        ...issue(
          "warning",
          "part-above-building",
          `${part.id} reaches ${top.toFixed(1)} m, above the ${buildingTop.toFixed(1)} m of ${building.id}; the outline should carry the overall height.`,
          [part.id, building.id],
        ),
        fix: {
          kind: "set-tag",
          entity: building.id,
          key: "height",
          value: maximumPartHeight,
        },
      });
    }
  }

  // 2D overlap between parts is explicitly allowed; overlapping *volumes* are
  // what Simple 3D Buildings tells us to avoid.
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = verticalExtent(parts[i].properties, metersPerLevel, building.properties);
      const b = verticalExtent(parts[j].properties, metersPerLevel, building.properties);
      const overlapTop = Math.min(a.top, b.top);
      const overlapBase = Math.max(a.base, b.base);
      if (overlapTop - overlapBase <= 0.01) continue;
      const shared = safeIntersect(polygonal(parts[i]), polygonal(parts[j]));
      const sharedArea = safeArea(shared);
      if (sharedArea < MIN_PART_AREA_M2) continue;
      const lower = a.top < b.top ? { part: parts[i], extent: a } : { part: parts[j], extent: b };
      const higher = a.top < b.top ? { part: parts[j], extent: b } : { part: parts[i], extent: a };
      const canStack =
        Math.abs(lower.extent.base) <= 0.01 &&
        higher.extent.top - lower.extent.top > 0.01 &&
        higher.extent.base < lower.extent.top - 0.01;
      const finding = issue(
        "warning",
        "overlapping-volumes",
        `${parts[i].id} and ${parts[j].id} share ${sharedArea.toFixed(1)} m² between ${overlapBase.toFixed(1)} m and ${overlapTop.toFixed(1)} m, so their 3D volumes overlap.`,
        [parts[i].id, parts[j].id],
      );
      if (canStack) {
        finding.fix = {
          kind: "set-tag",
          entity: higher.part.id,
          key: "min_height",
          value: String(Number(lower.extent.top.toFixed(6))),
        };
      }
      issues.push(finding);
    }
  }

  for (const group of disconnectedPartGroups(parts)) {
    // Name the smaller groups: with one big structure and one stray part, the
    // stray is what the reviewer needs to look at.
    if (group.length > parts.length / 2) continue;
    issues.push(
      issue(
        "warning",
        "disconnected-parts",
        `${group.map((part) => part.id).join(", ")} ${group.length === 1 ? "touches" : "touch"} no other part of ${building.id}. Disjunct parts are allowed, so check this is deliberate rather than a part in the wrong place.`,
        [...group.map((part) => part.id), building.id],
        ringCenter(group[0].polygons[0].outer),
      ),
    );
  }

  if (parts.length > 0) {
    const coverage = groundCoverageGap(building, parts);
    if (coverage && coverage.fraction > COVERAGE_GAP_FRACTION && coverage.gap > COVERAGE_GAP_M2) {
      issues.push(
        issue(
          "warning",
          "outline-not-covered",
          `${Math.round(coverage.fraction * 100)}% of ${building.id} (${Math.round(coverage.gap)} m²) is not covered by any ground-level part; the whole outline should be filled.`,
          [building.id],
          coverage.at,
        ),
      );
    }
  }

  return issues;
}

/** Run every pre-upload check over the plan and the geometry it would produce. */
export function validateChangeset(input: ValidationInput): ValidationResult {
  const { displayed, plan } = input;
  const issues = checkPlan(plan);
  const buildingLookup = new OsmBuildingLookup(displayed);

  const buildings = new Map<string, { building: BuildingElement; parts: BuildingElement[] }>();
  /** Elements this changeset writes: only their own defects are ours to block on. */
  const written = new Set(plan.entries.map((entry) => entry.ref));

  for (const entry of plan.entries) {
    const selection = buildingLookup.select(entry.ref);
    if (!selection) {
      issues.push(
        issue(
          "error",
          "element-not-found",
          `${entry.ref} is not in the loaded data, so it cannot be checked — pan back to it.`,
          [entry.ref],
        ),
      );
      continue;
    }
    buildings.set(selection.building.id, {
      building: selection.building,
      parts: selection.parts,
    });
    // The element the entry is about, and nothing else: a neighbouring part with
    // a ring OSM has carried for years must not block this upload.
    issues.push(...ringIssues(selection.selected));
    issues.push(...checkTags(selection.selected, new Set(entry.tagChanges.map((c) => c.key))));
  }

  for (const { building, parts } of buildings.values()) {
    issues.push(...checkBuilding(building, parts, written));
  }

  const sorted = sortIssues(issues);
  return {
    issues: sorted,
    errors: sorted.filter((found) => found.level === "error").length,
    warnings: sorted.filter((found) => found.level === "warning").length,
    submittable: !hasErrors(sorted),
  };
}
