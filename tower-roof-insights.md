# Tower roof support insights

- The overlap fix used the lower part's total height, although the rendered roof can be lower everywhere beneath an offset tower.
- Reuse the rendered roof triangles and inherited roof frame; rebuilding a roof on the overlap changes its centre and profile. Include triangle/footprint intersections so roof valleys and bends between footprint corners are considered.
- A flat tower base reaching the lowest supporting roof necessarily intersects its higher portions. Keep that overlap reviewable, but never offer the same minimum-height fix again.

Processed into the overlapping-volumes rule in `memory/spec/domain/osm-submission.md`.
