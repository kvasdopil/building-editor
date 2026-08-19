# ADR - Index

Status: Draft (2026-03-26)

This section stores durable architectural and policy decisions. Create a numbered ADR when a tradeoff should not have to be rediscovered later.

Related documents:

- [Artifact types](../mbb/artifacts.md): Explains what belongs in an ADR versus a spec or plan. Read this before creating a new decision record.
- [Authoring workflows](../mbb/workflows.md): Step-by-step guidance for recording a new architectural decision. Read this when adding the next ADR.
- [Examples](../mbb/examples.md): Short ADR example and template. Read this if you want a concrete starting point.

## Records

- [0001 - Live OSM data for editing, Overture for overview](0001-live-osm-data-for-editing.md): Why editable geometry comes from the live OSM API while Overture stays a zoomed-out overview, with the staleness and node-identity evidence. Read this before changing a data source.
- [0002 - All upstream OSM traffic goes through a cached, rate-limited proxy](0002-cached-rate-limited-osm-proxy.md): The mandatory caching and throttling policy that keeps the project from being banned. Read this before adding any upstream request.
