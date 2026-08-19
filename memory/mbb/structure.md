# Recommended Structure

The working memory bank in this repository lives in `memory/` at the repository root.

## Recommended tree

```text
memory/
  index.md
  structure.md
  mbb/
    index.md
    principles.md
    indexing.md
    duo-pattern.md
    frontmatter.md
    templates/
      index.md
      epic.md
      feature.md
  spec/
    index.md
    project/
    domain/
    data/
    security/
    engineering/
    client-api/
    cli/
    ui/
    operations/
    testing/
      index.md
      scenarios/
      seeds/
  adr/
    index.md
    0001-some-decision.md
  plans/
    index.md
    roadmap.md
    how-we-plan.md
    implementation-playbook.md
    verification-matrix.md
    epics/
      index.md
      EP-001-some-epic/
        index.md
        features/
          index.md
          FT-0011-some-feature/
            index.md
```

## Top-level sections

### `index.md`

The entry point for the entire system.

- Explains what the memory bank contains.
- Links to the major sections.
- Acts as the first navigation page for humans and agents.

### `structure.md`

Describes the repository layout and architectural boundaries.

- Explains where code belongs.
- Helps separate core logic from clients and adapters.
- Prevents business rules from leaking into UI or CLI layers.

### `mbb/`

The "Memory Bank Bible": governance for the documentation system itself.

Use it for:

- principles,
- indexing rules,
- document splitting rules,
- optional metadata conventions,
- templates.

This section explains how to maintain the memory bank, not how the product works.

### `spec/`

Normative requirements. This is the `WHAT`.

Typical subfolders:

- `project/` for overview, scope, stack, and layers
- `domain/` for business rules and invariants
- `data/` for ERD and data model meaning
- `security/` for auth, RBAC, RLS, and webhook safety
- `client-api/` for operations, DTOs, errors, and transport rules
- `cli/` for command behavior and CLI contracts
- `ui/` for sitemap, flows, and thin-client expectations
- `operations/` for runbooks, retention, and observability
- `testing/` for seeds, scenarios, traceability, and strategy

### `adr/`

Architecture decision records. This is the `WHY`.

Use numeric prefixes so decisions are ordered and easy to reference:

- `0001-core-client-cli-first.md`
- `0002-anonymity-threshold.md`

### `plans/`

Execution guidance. This is the delivery plan and verification model.

Use it for:

- roadmap and sequencing,
- epic and feature slicing,
- implementation playbooks,
- verification matrices,
- acceptance scenarios at the feature level.

## Index rules

Every folder that matters should have an `index.md`.

Use one of three styles:

- Shallow index: only lists files in the current folder.
- Deep index: also points one or two levels downward.
- Hybrid index: combines both when the folder mixes files and subfolders.

Indexes should always use annotated links.

## How to adapt this structure to another project

Keep the meaning of the top-level sections stable even if you rename subfolders.

- Preserve the separation between `spec`, `adr`, and `plans`.
- Preserve `testing/scenarios` and `testing/seeds` if you want reproducible acceptance coverage.
- Add domain-specific folders only when they represent a real cluster of concepts.
- Avoid creating deep taxonomies before the project needs them.

Start small, but keep the boundaries clear from day one.
