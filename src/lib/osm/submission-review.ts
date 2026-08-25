import type { FeatureCollection } from "geojson";
import {
  buildChangeset,
  type ChangesetInput,
  type ChangesetPlan,
  toOsmChangeXml,
} from "./changeset";
import { validateChangeset } from "./validate";

export interface SubmissionReviewInput {
  input: ChangesetInput;
  /** Features with pending edits applied, used by the geometry checks. */
  displayed: FeatureCollection;
}

export interface SubmissionReviewResult {
  plan: ChangesetPlan;
  validation: ReturnType<typeof validateChangeset>;
  xml: string;
}

/**
 * The complete static submission review: assemble the exact OSM elements, run
 * structural/tag/boolean-geometry checks, and render the downloadable
 * osmChange. The comment rule remains separate because it is intentionally
 * cheap enough to run on each keystroke without rebuilding this result.
 */
export function buildSubmissionReview({
  input,
  displayed,
}: SubmissionReviewInput): SubmissionReviewResult {
  const plan = buildChangeset(input);
  return {
    plan,
    validation: validateChangeset({ displayed, plan }),
    xml: toOsmChangeXml(plan),
  };
}
