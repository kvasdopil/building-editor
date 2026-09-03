/**
 * Stockholm LOD1 remains a local development reference until the city confirms
 * explicit redistribution and OSM-compatible reuse terms. Production builds
 * must neither expose its UI nor serve its generated tiles.
 */
export const LOD1_ENABLED = process.env.NODE_ENV !== "production";
