# Repository Structure

Status: Draft (2026-03-26)

This document is the starter map for the repository and for where memory bank docs should describe behavior. It stays intentionally high-level so specs, ADRs, and plans can own the details for their topics.

Related documents:

- [Memory Bank index](index.md): Entry point for the full memory bank. Read this to navigate the system from the top.
- [Memory Bank principles](mbb/principles.md): Governing rules such as single source of truth and one file per concept. Read this before adding new docs so the structure does not decay.
- [Project specs](spec/project/index.md): Project-level context and shared repo facts. Read this when expanding the initial repository map into deeper specs.

## Repository map

- TO BE FILLED

## Memory bank boundaries

- `memory/spec/` is the source of truth for product and engineering requirements.
- `memory/adr/` is the source of truth for durable architectural and policy decisions.
- `memory/plans/` is the source of truth for delivery sequencing and verification planning.
- Code is the source of truth for implementation details.

## Placement rules

- Put stable behavior, invariants, and contracts in `spec/`.
- Put rationale and tradeoffs in `adr/`.
- Put execution sequence and acceptance checklists in `plans/`.
- Update the nearest `index.md` whenever you add, rename, split, or remove a document.
