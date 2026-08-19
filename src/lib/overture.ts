/**
 * Overture is the wide-area overview layer only: it lags OSM by weeks and its
 * geometry carries no OSM node identity, so it is never selected or edited.
 * See memory/adr/0001-live-osm-data-for-editing.md.
 */
export const BUILDINGS_PMTILES_URL =
  "https://tiles.overturemaps.org/2026-07-22.0/buildings.pmtiles";
