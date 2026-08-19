# Authoring Workflows

These workflows turn the memory bank from a static folder into an operating system for the project.

## 1. Bootstrap a new memory bank

Use this when creating the system in a fresh repository.

1. Create `memory/` with `index.md`, `structure.md`, `mbb/`, `spec/`, `adr/`, and `plans/`.
2. Add `index.md` files for each top-level folder.
3. Write the MBB rules first so future documents follow a stable convention.
4. Add a small `spec/project/` section with system overview, scope, stack, and architectural layers.
5. Add `plans/how-we-plan.md` so planning and verification start with a repeatable model.
6. Add `spec/testing/index.md`, even if seeds and scenarios will come later.

## 2. Add a new requirement or domain rule

Use this when the product behavior changes.

1. Find the existing canonical spec file for the topic.
2. Update that file instead of creating a duplicate.
3. If no canonical file exists, create a focused spec file in the correct section.
4. Add or update annotated links from the relevant index.
5. If the new rule affects tests, update scenarios, seeds, or traceability.
6. If the rule exists because of a major tradeoff, add or update an ADR and link it from the spec.

## 3. Record an architectural decision

Use this when the team makes a stable, meaningful choice that should not be rediscovered later.

1. Create the next numbered file under `adr/`.
2. Capture the decision in one sentence.
3. Explain the reason and the tradeoffs.
4. Link the relevant spec docs that depend on the decision.
5. Update `adr/index.md`.

Good ADR topics:

- choosing a core architecture,
- introducing a security policy,
- locking in a lifecycle rule,
- selecting one contract model over another.

Bad ADR topics:

- temporary implementation notes,
- routine refactors with no lasting design consequence.

## 4. Plan a new epic

Use this when a large initiative needs sequencing.

1. Create a new epic folder under `plans/epics/EP-XXX-name/`.
2. Add `index.md` for the epic.
3. State the goal, scope, main features, dependencies, risks, and definition of done.
4. Link the relevant spec docs.
5. Add or update the roadmap if the epic changes sequencing.
6. Update `plans/epics/index.md`.

## 5. Plan a new feature as a vertical slice

Use this when breaking an epic into a deliverable that can be verified.

1. Create `plans/epics/<epic>/features/FT-XXXX-name/index.md`.
2. Document user value.
3. List deliverables across layers, such as contract, core, data, CLI, UI, and tests.
4. Add a `Context` section linking the exact specs this feature depends on.
5. Write at least one acceptance scenario with `Setup`, `Action`, `Assert`, and covered operations.
6. List the tests that must exist before the feature is done.
7. Update the feature catalog index for the epic.

The default slice model in this repo is:

`contract -> core -> db -> cli -> tests -> docs`

You can adapt the layers, but the slice should remain end to end and verifiable.

## 6. Add or update a seed

Use this when tests need a deterministic starting state.

1. Create or update a file under `spec/testing/seeds/`.
2. Document purpose, prerequisites, created data, and returned handles.
3. Keep seed docs stable enough that tests can treat them as a contract.
4. Update the seed index.
5. Reference the seed from the scenarios that use it.

Prefer handles over hard-coded database IDs.

## 7. Add or update a golden scenario

Use this when a critical system flow must be testable from setup to assertion.

1. Create or update a file under `spec/testing/scenarios/`.
2. Write deterministic `Setup`, `Action`, and `Assertions`.
3. Name the operations or commands that the scenario covers.
4. Link the relevant specs and seeds.
5. Update the scenario index and traceability matrix.

Good scenarios focus on business risk:

- lifecycle transitions,
- permission boundaries,
- privacy rules,
- idempotency,
- locking or immutability,
- cross-system flows.

## 8. Implement a feature and keep docs in sync

Use this during active delivery.

1. Start from the feature plan.
2. Read the linked spec files before coding.
3. Implement the slice across the intended layers.
4. Add or update automated tests to match the acceptance scenario.
5. If behavior changed, update the spec instead of leaving the plan to drift.
6. If rationale changed, write an ADR.
7. Mark the plan, scenario, or verification docs as needed after the implementation lands.

## 9. Split a bloated document

Use this when one file becomes difficult to maintain.

1. Keep the original file as the overview if the title is still the best topic name.
2. Move detailed sections into new `topic-aspect.md` files.
3. Replace the removed detail with annotated links.
4. Add or update `index.md` if several related files now exist.
5. Check that only one file remains normative for each rule.

## 10. Review checklist for every documentation change

Before merging:

1. Is the document in the right top-level section?
2. Is there one clear owner concept per file?
3. Are annotated links present?
4. Is the parent index updated?
5. Did you avoid duplicating requirements, rationale, or implementation details?
6. If a feature changed, are testing and traceability docs updated too?
