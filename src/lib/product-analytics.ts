import { track } from "@vercel/analytics";

/**
 * Small, deliberately finite product funnel. Event properties must stay
 * aggregate or categorical: never add OSM ids, coordinates, account names,
 * changeset comments or other user-entered text here.
 */
type ProductAnalyticsEvent =
  | "Building Selected"
  | "Changes Present"
  | "Submission Review Opened"
  | "Photos View Opened"
  | "LiDAR View Opened"
  | "LiDAR Query Completed"
  | "Google 3D Preview Opened";

type ProductAnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

export function trackProductEvent(
  name: ProductAnalyticsEvent,
  properties?: ProductAnalyticsProperties,
): void {
  track(name, properties);
}
