# Operations Specs - Index

Status: Active (2026-08-28)

This section is the source of truth for how the deployed system is configured and what its hosting
environment can and cannot promise. Use it when a rule is about running the app rather than about
what the app does.

Related documents:

- [Specifications index](../index.md): Parent catalog for spec docs. Read this to navigate between project, domain, testing, and operations specs.
- [Repository structure](../../structure.md): High-level repo layout and section boundaries. Read this when deciding whether a topic belongs here or in a domain spec.

- [production-deployment.md](production-deployment.md) — Where production runs, how its secrets are configured, and what its filesystem does not guarantee. Read this before changing deployment configuration or relying on server-side persistence.
- [local-datasets-and-tools.md](local-datasets-and-tools.md) — Where imported LOD1 and laser tiles live, the `BUILDING_DATA_DIR` override and the symlink that breaks Turbopack, and how `yarn advice` measures the roof readings against a calibration area. Read this before moving the datasets or changing a reading threshold.
