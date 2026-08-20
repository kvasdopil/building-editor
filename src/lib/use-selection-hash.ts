import { useEffect, useRef } from "react";
import { type OsmRef, osmRefId, parseOsmRef } from "./osm/ref";

/**
 * Keeps the URL hash and the selected element in step, so a building can be
 * linked to: `/#way/42764754` opens the app on that building, and selecting one
 * puts its id in the address bar.
 *
 * Writes use `replaceState`: a selection is map state rather than a page, and
 * clicking around a neighborhood should not fill the back button with buildings.
 * That also means writing the hash raises no `hashchange`, so the two effects
 * here cannot drive each other in a loop.
 *
 * Only real OSM ids appear. A drawn part carries a negative placeholder id
 * (`way/-1`), which is nothing anybody can look up, so it leaves the hash alone.
 */
export function useSelectionHash(
  selectedId: string | null,
  ready: boolean,
  select: (ref: OsmRef) => void,
): void {
  // Read during render, before any effect runs: the effect that writes the hash
  // would otherwise erase the deep link before the one that follows it.
  const deepLink = useRef<OsmRef | null | undefined>(undefined);
  if (deepLink.current === undefined) {
    deepLink.current = typeof window === "undefined" ? null : parseOsmRef(window.location.hash);
  }
  // A deep link is in flight: the lookup needs a network round trip and the
  // tile it lands in, and nothing is selected until then.
  const resolving = useRef(deepLink.current !== null);

  useEffect(() => {
    if (!ready) return;
    if (deepLink.current) select(deepLink.current);
    const onHashChange = () => {
      const ref = parseOsmRef(window.location.hash);
      if (!ref) return;
      resolving.current = true;
      select(ref);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [ready, select]);

  useEffect(() => {
    const wanted = selectedId === null ? null : osmRefId(selectedId);
    if (wanted) {
      resolving.current = false;
      if (window.location.hash.slice(1) !== wanted) {
        window.history.replaceState(null, "", `#${wanted}`);
      }
      return;
    }
    // Deselected: drop the hash, unless it is a deep link still being resolved
    // or a local part that never wrote one.
    if (resolving.current || selectedId !== null || !window.location.hash) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [selectedId]);
}
