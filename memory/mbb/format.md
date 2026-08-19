# Writing Format

This memory bank uses plain markdown with lightweight conventions. The goal is consistency, not elaborate metadata.

## Standard document shape

Recommended baseline:

```md
# Document title

Status: Draft (YYYY-MM-DD)

Short opening statement that says what this document is for.

Related documents (annotated links):

- [Some linked doc](relative/path.md): What is inside. Why this link matters.

## Section

Content...
```

The exact section names can vary by artifact type, but the opening structure should stay easy to recognize.

## Status line

Use a short status line near the top:

```md
Status: Draft (2026-03-03)
```

You can use states such as:

- `Draft`
- `Active`
- `Template`
- `Deprecated`

Keep the date explicit.

## Annotated links

Every markdown link should include a short explanation of:

1. what the destination contains;
2. why the reader should open it.

Recommended pattern:

```md
- [Layers & vertical slices](spec/project/layers-and-vertical-slices.md): Explains the layer boundaries and the definition of a vertical slice. Read this to keep business rules out of UI and CLI code.
```

## Naming rules

Use names that describe one concept clearly.

- Good: `campaign-lifecycle.md`
- Good: `auth-and-identity.md`
- Good: `outbox-and-retries.md`
- Bad: `misc.md`
- Bad: `stuff-to-remember.md`

For ADRs, prefer numeric prefixes:

- `0001-core-client-cli-first.md`
- `0002-anonymity-threshold.md`

For epics and features, prefer stable IDs:

- `EP-004-campaigns-questionnaires/`
- `FT-0044-lock-on-draft-save/`

## Index format

Indexes should be short, scannable, and link outward.

Recommended pattern:

```md
# Section Index

Status: Draft (YYYY-MM-DD)

One short paragraph explaining what this folder is for.

- [Child document](child.md): What is inside. Why it matters.
- [Another child](subfolder/index.md): What is inside. Why it matters.
```

## Duo pattern

When a document grows too large, split it deliberately.

- `<topic>.md` becomes the overview.
- `<topic>-<aspect>.md` holds the detail.
- `index.md` is added when there are several related files.

Example:

- `notifications.md`
- `notifications-templates.md`
- `notifications-outbox.md`

Do not duplicate full explanations across all three files. Keep the overview short and let the details own the specifics.

## Optional frontmatter

Frontmatter is optional. If you want machine-readable metadata, keep it minimal.

Example:

```yaml
---
description: "State machine for campaign lifecycle."
purpose: "Defines valid transitions and lock behavior."
status: "ACTIVE"
date: "2026-03-03"
---
```

Do not add frontmatter just for decoration. Use it only if you actually plan to validate or process it.

## Writing style

Prefer:

- concrete statements,
- small sections,
- stable terminology,
- normative language in spec docs,
- checklists in plan docs,
- deterministic steps in scenario docs.

Avoid:

- vague placeholders with no owner,
- mixing rationale into normative requirements,
- copying code for no reason,
- long paragraphs that hide the actual rule.

## Before saving a new document

Check these points:

1. Does the title clearly name one concept?
2. Is the file in the right section: `spec`, `adr`, `plans`, or `mbb`?
3. Did you add annotated links where needed?
4. Did you update the parent `index.md`?
5. If the file is large, should it be split now rather than later?
