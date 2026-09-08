# Drawing snap insights

- Slice completion and Add part attachments depend on boundary identity. Directional snaps must remain a distinct kind, or an interior helper point can accidentally complete a path.
- Preview and click previously used separate policies (especially Add part references and Slice loops). Both now call a shared resolver.
- Durable behavior is recorded in [the building explorer specification](memory/spec/domain/building-explorer.md); implementation details stay in code. No new memory bank document was needed.

- Combined axis/edge snaps require all eligible boundary segments, not just the nearest projected edge: the nearest edge may be parallel or have no intersection within its endpoints. Boundary projection and candidate priority now live with directional snapping in the shared module.
- Cursor preview must update even when no snap exists; the former snap-only early return suppressed free drawing feedback. The cursor is transient state, separate from committed vertices.
