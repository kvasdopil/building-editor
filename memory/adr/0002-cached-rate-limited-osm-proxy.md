# ADR 0002 - All upstream OSM traffic goes through a cached, rate-limited proxy

Status: Draft (2026-08-19)

Records the non-negotiable access policy for OpenStreetMap and Overpass requests. Getting the project's IP banned halts all development, so throttling and caching are treated as correctness requirements, not optimizations.

Related documents:

- [Live OSM data for editing](0001-live-osm-data-for-editing.md): Why live OSM reads are needed at all. Read it for the data-source rationale.
- [EP-001 OSM editing](../plans/epics/EP-001-osm-editing/index.md): The delivery slices that implement this policy. Read it for sequencing and acceptance.

## Decision

1. **No browser talks to an upstream API.** Every OSM/Overpass request goes through this app's own route handler, so limiting, coalescing, identification and caching are enforced in exactly one place.
2. **Quantized keys.** Reads are addressed by a fixed z16 tile grid (~600 m), never by raw viewport bboxes. Arbitrary bboxes produce unique keys that never hit cache.
3. **Three cache layers.** Client IndexedDB (pans and reloads cost nothing), server in-memory LRU, server persistent store. Empty results are cached too, or blank countryside is re-queried forever.
4. **Single-flight.** Concurrent requests for the same key collapse into one upstream fetch.
5. **Hard budget.** Token bucket: one upstream request in flight, minimum ~1 s spacing, bounded queue. Exponential backoff honoring `Retry-After` on 429/504, plus a circuit breaker that serves stale data rather than retrying.
6. **Fetch on intent only.** Only at map zoom z >= 15.5, only on debounced map idle, only for uncached fixed-grid z16 tiles. No speculative prefetch. The half-step threshold keeps a typical viewport within the 12-tile client cap while exposing live data sooner.
7. **Identify the client.** A descriptive `User-Agent` with contact info on every upstream call, per OSM and Overpass usage policy.
8. **Stale-while-revalidate.** Cached tiles are served immediately; refresh is bounded per tile. A local edit invalidates its own tile.

Repository-local disk writes are best-effort at runtime. Read-only or ephemeral hosts retain the
in-memory layer instead of failing an otherwise successful upstream request. Such a fallback does not
satisfy the persistent-store or global hard-budget decisions across horizontally scaled instances;
production serverless hosting therefore needs a shared durable cache and distributed limiter before
those guarantees can be claimed.

## Why

- Overpass advertises **2 slots per IP** and its fair-use policy explicitly discourages backing interactive applications. Per-pan queries would exhaust it immediately.
- The OSM API is editor-facing but still shared infrastructure; `/map` calls are capped at 0.25 sq° and are expensive to serve.
- A ban is not a degraded experience, it is a full stop — so the limiter must make abuse structurally impossible rather than merely unlikely.

## Trade-offs

- The app gains a server component and is no longer a purely static build.
- Users may see data that is minutes old; acceptable for reads, and edits always re-read their target before upload.
- More moving parts (limiter, cache, invalidation) than direct fetching, justified entirely by the ban risk.
- A read-only serverless deployment can run with per-instance memory only, but loses persistence and
  cross-instance coordination until backed by a shared store.
