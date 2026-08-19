# Examples And Templates

These examples are intentionally short. They are meant to be copied and adapted.

## 1. Root index example

```md
# Memory Bank - Index

Status: Draft (2026-03-03)

- [Memory Bank Bible](mbb/index.md): Rules for maintaining the memory bank itself, including indexing and writing conventions. Read this before adding documents so the system stays coherent.
- [Specifications](spec/index.md): Normative product and engineering requirements. Read this to understand what the system must do.
- [Plans](plans/index.md): Epic and feature plans with acceptance and verification expectations. Read this to understand what will be built and how completion is measured.
- [ADR](adr/index.md): Architecture decisions and rationale. Read this to understand why important choices were made.
- [Project structure](structure.md): Repository layout and architectural boundaries. Read this to know where code and responsibilities belong.
```

## 2. Spec document example

```md
# Campaign lifecycle

Status: Draft (2026-03-03)

Defines the campaign state machine and the lock behavior that protects assignment and weight integrity.

Related documents:

- [Freeze on first draft save](../../adr/0003-freeze-on-draft-save.md): Decision record explaining why the lock happens on the first draft save. Read this for rationale and tradeoffs.

## States

- `draft`
- `started`
- `ended`
- `processing_ai`
- `ai_failed`
- `completed`

## Rules

- A campaign becomes locked when the first questionnaire draft is saved.
- After lock, assignment matrix and weight changes are forbidden.
- After end, questionnaires are read-only.
```

## 3. ADR example

```md
# ADR 0003 - Freeze on first draft save

Status: Draft (2026-03-03)

## Decision

Set `campaign.locked_at` when the first questionnaire draft is saved.

## Why

- Prevents changing assignment groups or weights after answers begin to appear.
- Matches the product rule that the first saved answer is the start of evaluation activity.

## Trade-offs

- Risk: an accidental early draft can lock a campaign sooner than expected.
- Mitigation: warn in the UI and make the rule explicit in HR-facing flows.
```

## 4. Epic example

```md
# EP-004 - Models, campaigns, and questionnaires

Status: Draft (2026-03-03)

## Goal

Deliver the end-to-end evaluation flow without relying on UI first.

## Scope

- In scope: models, campaigns, assignment matrix, questionnaires, lock behavior
- Out of scope: advanced reporting UX

## Features

- [FT-0044 Lock on first draft save](features/FT-0044-lock-on-draft-save/index.md): Locks matrix and weights after the first draft answer. Read this to see the exact slice and acceptance criteria.

## Risks

- Lock timing may be misunderstood by users.
```

## 5. Feature example

```md
# FT-0044 - Lock on first draft save

Status: Draft (2026-03-03)

## User value

HR can trust that assignment groups and weights do not change after answers start.

## Deliverables

- Lock is set on the first `questionnaire.saveDraft`
- Matrix and weight updates fail after lock

## Context

- [Campaign lifecycle](../../../../../spec/domain/campaign-lifecycle.md): Defines lock behavior. Read this to implement the same rule everywhere.
- [GS5 Lock semantics](../../../../../spec/testing/scenarios/gs5-lock-semantics.md): Golden scenario for this rule. Read this to align implementation and verification.

## Acceptance

### Setup

- Seed: `S5_campaign_started_no_answers --json`

### Action

1. Update weights before lock.
2. Save the first questionnaire draft.
3. Attempt the same weight update after lock.

### Assert

- `campaign.locked_at` is set after the first draft.
- The post-lock update fails with `code=campaign_locked`.

## Tests

- Integration test covering the flow above.
```

## 6. Seed example

```md
# Seed S5_campaign_started_no_answers

Status: Draft (2026-03-03)

## Purpose

A started campaign with assignments present but no questionnaire drafts or submissions yet.

## Requires

- `S4_campaign_draft`

## Creates

- campaign with `status=started`
- assignment matrix rows
- questionnaires for assigned participants

## Handles

- `campaign.main`
```

## 7. Scenario example

```md
# GS5 - Lock semantics

Status: Draft (2026-03-03)

## Setup

- Seed: `S5_campaign_started_no_answers`
- Actors: HR admin, employee rater

## Action

1. HR updates campaign weights.
2. Employee saves the first questionnaire draft.
3. HR tries to update campaign weights again.

## Assertions

- The first update succeeds.
- The draft save sets the campaign lock.
- The second update fails with `campaign_locked`.

## Operations

- `campaign.weights.set`
- `questionnaire.saveDraft`
```

## 8. Feature template

```md
# FT-XXXX - Feature name

Status: Draft (YYYY-MM-DD)

## User value

What changes for the user and why it matters.

## Deliverables

- Contract or operation changes
- Core policy or use-case changes
- Data or migration changes
- CLI or UI surface changes

## Context

- [Relevant spec](path.md): What it contains. Why it matters.

## Acceptance

### Setup

- Seed: `Sx_name --json`

### Action

1. Deterministic step
2. Deterministic step

### Assert

- Expected state
- Expected restriction or error code

## Tests

- Unit:
- Integration:
- E2E:

## Docs updates

- Which specs, ADRs, or indexes must change
```
