# Memory Bank Principles

The memory bank is not a notes folder. It is a documentation system with explicit ownership, navigation, and traceability rules.

## 1. Single source of truth

Each rule, decision, or plan should have one normative home.

- `spec/` is the source of truth for what the system must do.
- `adr/` is the source of truth for why an important decision was made.
- `plans/` is the source of truth for how work is sliced and verified.
- Code is the source of truth for implementation details.

If two files try to define the same rule, merge them and keep one canonical document.

## 2. One file = one concept

Each file should explain one concept clearly.

- Good: `campaign-lifecycle.md`, `rls.md`, `webhooks-ai.md`
- Bad: one giant file mixing auth rules, ERD, CLI commands, and rollout steps

When a topic becomes too large, split it into an overview plus detail files.

## 3. Progressive disclosure

Documents should read from general to specific.

- Start with the purpose, the boundary, or the rule.
- Follow with the details needed to act on it.
- End with links for deeper reading instead of copying the same information again.

This makes the memory bank usable by both humans and agents.

## 4. Separate WHAT, WHY, and HOW

Do not mix fundamentally different kinds of knowledge in one place.

- `spec/` answers "What must the system do?"
- `adr/` answers "Why did we choose this?"
- `plans/` answers "How will we deliver and verify this?"
- Code answers "How is it implemented today?"

That separation prevents requirement drift and avoids design rationale being buried in code comments.

## 5. Do not duplicate code

The memory bank should capture intent, invariants, contracts, and relationships, not copy source files.

- Prefer explaining the rule behind a table or field rather than listing schema details with no context.
- Link to code, migrations, or handlers when needed.
- Document meaning and constraints, not boilerplate implementation.

## 6. Index-first navigation

Every meaningful folder should have an `index.md`.

Indexes should:

- explain the purpose of the folder,
- list the documents inside it,
- use annotated links,
- make orphan files unacceptable.

If a document cannot be reached from an index, navigation is broken.

## 7. Annotated links are mandatory

Links should never be naked. Each link should tell the reader:

1. what is at the destination;
2. why it is worth opening.

Recommended format:

```md
- [Campaign lifecycle](domain/campaign-lifecycle.md): State machine for campaign status and lock behavior. Read this to implement transitions and prevent hidden side effects.
```

## 8. Keep documents small

Shorter, focused documents are easier to maintain than encyclopedic ones.

Use the duo pattern when needed:

- `<topic>.md` for the overview
- `<topic>-<aspect>.md` for details
- `index.md` when there are several related files

## 9. Trace plans to tests and code

A memory bank becomes operational when planning, testing, and implementation stay linked.

- Feature plans should reference the specs they rely on.
- Acceptance scenarios should name the operations they cover.
- Seed files should define deterministic test setup.
- Commits can carry feature or epic tags such as `[FT-0044]` or `[EP-004]` to make history searchable.

## 10. Update documentation as part of delivery

Documentation is not a cleanup step for later.

When a feature changes system behavior:

- update the relevant `spec/` file if the rule changed,
- update `plans/` if scope or verification changed,
- add an `adr/` if a new architectural decision was made,
- update the nearest `index.md` so the new file is discoverable.

## Quick decision rules

Use this checklist before creating a file:

1. Is there already a canonical document for this topic?
2. Is this a rule, a decision, a plan, or an implementation detail?
3. Can this fit into an existing file without making it multi-topic?
4. Have you updated the parent index?
5. Did you add annotated links instead of bare links?
