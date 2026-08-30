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
- [0003 - LOD1 is advice, never an import](0003-lod1-as-advice-not-import.md): Why Stockholm's laser-measured heights are offered as per-building suggestions a mapper accepts individually. Read this before adding another reference dataset.
- [0004 - The laser point cloud is raw evidence, shown not summarized](0004-laser-point-cloud-as-raw-evidence.md): Why the 2023 laser survey is imported as points and drawn as dots in 3D rather than reduced to heights. Read this before deriving numbers from the cloud.
- [0005 - National laser data is read on demand, never imported](0005-national-laser-data-read-on-demand.md): Why Lantmäteriet's country-wide point cloud is range-read from COPC behind a server cache instead of imported. Read this before adding another upstream data source.
- [0006 - Mapterhorn defines the 3D ground datum](0006-mapterhorn-defines-3d-ground.md): Why z13 terrain supplies every building and scene elevation while LiDAR stays a vertically aligned overlay. Read this before changing 3D ground or point-cloud alignment.
- [0007 - The laser measures roof tags, and shows how far off it is](0007-laser-roof-advice.md): Why the point cloud now advises `height`, `roof:height` and `roof:shape` per element, and which of those the fit error is allowed to choose. Read this before changing how a tag is derived from the cloud.
