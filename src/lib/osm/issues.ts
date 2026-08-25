import type { LngLat } from "../buildings";

/**
 * One finding from the pre-upload checks. Errors block an upload; warnings are
 * things a reviewer should look at but may knowingly accept, which is how JOSM's
 * validator splits its own tests.
 */
export interface Issue {
  level: "error" | "warning";
  /** Stable check id, e.g. `self-intersecting-way`. */
  check: string;
  message: string;
  /** App element ids the finding is about, for navigation from the review list. */
  entities: string[];
  /** Where to look, when the finding is about one spot. */
  at?: LngLat;
  /** A deterministic correction the reviewer can apply without leaving the dialog. */
  fix?: IssueFix;
}

export interface TagIssueFix {
  kind: "set-tag";
  entity: string;
  key: string;
  value: string;
}

export interface GeometryIssueFix {
  kind: "remove-ring-node";
  entity: string;
  polygonIndex: number;
  ringIndex: number;
  nodeIndex: number;
  /** Guards against applying a suggestion after the geometry has changed. */
  coordinate: LngLat;
}

export type IssueFix = TagIssueFix | GeometryIssueFix;

export function issue(
  level: Issue["level"],
  check: string,
  message: string,
  entities: string[],
  at?: LngLat,
): Issue {
  return at ? { level, check, message, entities, at } : { level, check, message, entities };
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((found) => found.level === "error");
}

/** Errors first, then by check id, so the review list is stable between runs. */
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      Number(b.level === "error") - Number(a.level === "error") ||
      a.check.localeCompare(b.check) ||
      (a.entities[0] ?? "").localeCompare(b.entities[0] ?? ""),
  );
}
