import { useEffect, useRef } from "react";
import { buildHash, hashRef, parseView, writeHash } from "./map-hash";
import { type OsmRef, osmRefId, parseOsmRef } from "./osm/ref";

/**
 * Keeps the URL hash and the selected element in step, so a building can be
 * linked to: `/#way/42764754` opens the app on that building, and selecting one
 * puts its id in the address bar. The hash also carries the view (see
 * `map-hash.ts`); this hook owns only the reference segment and rebuilds the
 * rest from whatever is already there.
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
      writeHash(buildHash(wanted, parseView(window.location.hash)));
      return;
    }
    // Deselected: drop the reference, unless it is a deep link still being
    // resolved or a local part that never wrote one. Any view stays.
    if (resolving.current || selectedId !== null || !hashRef(window.location.hash)) return;
    writeHash(buildHash("", parseView(window.location.hash)));
  }, [selectedId]);
}
